/// <reference lib="webworker" />
/**
 * Editor work off the main thread (used on the WebGL 2 fallback, where the GPU compute paths don't
 * exist): erosion brush steps, the foliage scatter's candidates and ground cover tiles. Every job
 * runs the same pure functions the main thread would (terrainOps, scatter, groundCover), on copies
 * of the data it needs. See EditorWorkerClient for the protocol.
 */
import type { FoliageType } from '../../shared/types';
import type { GroundCoverSource } from '../../world/foliage/groundCover';
import { generateGroundCoverTile } from '../../world/foliage/groundCover';
import {
    gridWaterLevel,
    placementAllowed,
} from '../../world/foliage/placement';
import { scatterCandidates } from '../../world/foliage/scatter';
import type { ScatterType } from '../../world/foliage/scatter';
import type { SplatMap } from '../../world/SplatMap';
import { Heightfield } from '../../world/Heightfield';
import type { GridRect } from '../../world/Heightfield';
import type { BrushSettings } from '../Brush';
import { hydraulicErosion, thermalErosion } from '../tools/terrainOps';
import type { HydraulicOptions, ThermalOptions } from '../tools/terrainOps';
import { readRect, writeRect } from './gridRect';

export type WorkerRequest =
    | {
          op: 'erode';
          kind: 'hydraulic' | 'thermal';
          resolution: number;
          size: number;
          /** Grid region the step may read and write, and its heights (row by row). */
          region: GridRect;
          heights: Float32Array;
          x: number;
          z: number;
          brush: BrushSettings;
          dt: number;
          options: HydraulicOptions | ThermalOptions;
      }
    | {
          op: 'scatter';
          size: number;
          seed: number;
          types: ScatterType[];
          landCover: boolean;
      }
    | {
          op: 'world';
          resolution: number;
          size: number;
          heights: Float32Array;
          water: Float32Array;
          splatResolution: number;
          splat: Uint8Array;
      }
    | {
          op: 'patch';
          /** Grid rect (height grid = water grid resolution) and its rows of each grid. */
          rect: GridRect;
          heights: Float32Array;
          water: Float32Array;
          /** Splat rect (splat resolution) and its rows (8 channels). */
          splatRect: GridRect;
          splat: Uint8Array;
      }
    | {
          op: 'cover';
          type: FoliageType;
          size: number;
          cx: number;
          cz: number;
          sources: GroundCoverSource[];
      };

export type WorkerResponse =
    | { rect: GridRect | null; heights: Float32Array | null }
    | { candidates: [number, Float32Array][] }
    | { data: Float64Array | null }
    | { ok: true };

type World = {
    heights: Heightfield;
    water: Heightfield;
    splat: { resolution: number; data: Uint8Array };
};

let erosionField: Heightfield | null = null;
let world: World | null = null;

function erode(req: Extract<WorkerRequest, { op: 'erode' }>): WorkerResponse {
    if (
        !erosionField ||
        erosionField.resolution !== req.resolution ||
        erosionField.size !== req.size
    ) {
        erosionField = new Heightfield(req.resolution, req.size);
    }

    const hf = erosionField;
    writeRect(hf.data, hf.resolution, req.region, 1, req.heights);
    const rect =
        req.kind === 'hydraulic'
            ? hydraulicErosion(
                  hf,
                  req.x,
                  req.z,
                  req.brush,
                  req.dt,
                  req.options as HydraulicOptions,
              )
            : thermalErosion(
                  hf,
                  req.x,
                  req.z,
                  req.brush,
                  req.dt,
                  req.options as ThermalOptions,
              );

    if (!rect) {
        return { rect: null, heights: null };
    }

    const out = new Float32Array(
        (rect.x1 - rect.x0 + 1) * (rect.z1 - rect.z0 + 1),
    );

    return { rect, heights: readRect(hf.data, hf.resolution, rect, 1, out) };
}

function cover(req: Extract<WorkerRequest, { op: 'cover' }>): WorkerResponse {
    if (!world) {
        return { data: null };
    }

    const { heights, water, splat } = world;
    const waterLevelAt = (x: number, z: number) =>
        water.contains(x, z) ? gridWaterLevel(water, x, z) : null;
    const data = generateGroundCoverTile(
        req.type,
        req.size,
        req.cx,
        req.cz,
        req.sources,
        {
            heights,
            splat: splat as unknown as SplatMap,
            waterLevelAt,
            allowed: (type, x, z) =>
                placementAllowed({ heights, waterLevelAt }, type, x, z),
        },
    );

    return { data: Float64Array.from(data) };
}

function handle(req: WorkerRequest): WorkerResponse {
    switch (req.op) {
        case 'erode':
            return erode(req);
        case 'scatter':
            return {
                candidates: req.types.map((type) => [
                    type.id,
                    scatterCandidates(req.size, req.seed, type, req.landCover),
                ]),
            };
        case 'world':
            world = {
                heights: new Heightfield(req.resolution, req.size, req.heights),
                water: new Heightfield(req.resolution, req.size, req.water),
                splat: { resolution: req.splatResolution, data: req.splat },
            };

            return { ok: true };
        case 'patch':
            if (world) {
                const res = world.heights.resolution;
                writeRect(world.heights.data, res, req.rect, 1, req.heights);
                writeRect(world.water.data, res, req.rect, 1, req.water);
                writeRect(
                    world.splat.data,
                    world.splat.resolution,
                    req.splatRect,
                    8,
                    req.splat,
                );
            }

            return { ok: true };
        case 'cover':
            return cover(req);
    }
}

self.onmessage = (
    event: MessageEvent<{ id: number; request: WorkerRequest }>,
) => {
    const { id, request } = event.data;

    try {
        const response = handle(request);
        const transfer: Transferable[] = [];

        if ('heights' in response && response.heights) {
            transfer.push(response.heights.buffer);
        } else if ('data' in response && response.data) {
            transfer.push(response.data.buffer);
        } else if ('candidates' in response) {
            transfer.push(...response.candidates.map(([, c]) => c.buffer));
        }

        self.postMessage({ id, response }, { transfer });
    } catch (error) {
        self.postMessage({
            id,
            error: String((error as Error)?.message ?? error),
        });
    }
};
