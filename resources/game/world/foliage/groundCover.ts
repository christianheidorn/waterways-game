import * as THREE from 'three/webgpu';
import type { FoliageKind, FoliageType } from '../../shared/types';
import type { Heightfield } from '../Heightfield';
import type { SplatMap } from '../SplatMap';

/**
 * Ground cover ("landscape grass"): foliage that grows by itself on terrain layers instead of being
 * painted. Each terrain layer lists foliage types with a density multiplier; wherever the layer is
 * painted, its types appear in proportion to the layer's paint weight, subject to each type's slope,
 * altitude and water rules. Nothing is stored: tiles around the camera are generated deterministically
 * (the same tile always grows the same instances), so repainting the terrain, editing a type or a
 * layer's ground cover shows up immediately and there is nothing to erase and repaint.
 */

/** One terrain layer's use of a foliage type. */
export type GroundCoverSource = {
    /** Splat channel (terrain layer slot). */
    slot: number;
    /** Multiplier on the type's density (instances per 100 m² at full paint weight). */
    density: number;
    /** 0 = even spread … 1 = groves and clearings (see clusterFactor). */
    clustering: number;
    /** Minimum distance between instances of the type (m); 0 = only what the density implies. */
    spacing: number;
};

export type GroundCoverContext = {
    heights: Heightfield;
    splat: SplatMap;
    waterLevelAt: (x: number, z: number) => number | null;
    /**
     * Water surface grid (NO_WATER where dry) that waterLevelAt reads: with it, tiles grow on the GPU
     * on WebGPU (see GroundCoverGpu.ts).
     */
    water?: Heightfield;
    /** The type's own placement rules (slope, altitude, underwater). */
    allowed: (type: FoliageType, x: number, z: number) => boolean;
};

/** Upper bound of instances per tile (a very dense type on a large tile). */
const MAX_PER_TILE = 24000;

const _normal = new THREE.Vector3();

/** Paint weight (0-1) of a splat channel at a world position, bilinear between samples. */
export function splatWeight(
    splat: SplatMap,
    heights: Heightfield,
    slot: number,
    x: number,
    z: number,
): number {
    const { gx, gz } = heights.toGrid(x, z);
    const res = splat.resolution;
    const x0 = Math.min(res - 1, Math.max(0, Math.floor(gx)));
    const z0 = Math.min(res - 1, Math.max(0, Math.floor(gz)));
    const x1 = Math.min(res - 1, x0 + 1);
    const z1 = Math.min(res - 1, z0 + 1);
    const fx = Math.min(1, Math.max(0, gx - x0));
    const fz = Math.min(1, Math.max(0, gz - z0));
    const d = splat.data;
    const at = (col: number, row: number) => d[(row * res + col) * 8 + slot];
    const top = at(x0, z0) * (1 - fx) + at(x1, z0) * fx;
    const bottom = at(x0, z1) * (1 - fx) + at(x1, z1) * fx;

    return (top * (1 - fz) + bottom * fz) / 255;
}

/** Whether any source layer has paint on the splat samples covering a tile (cheap early-out). */
export function tilePainted(
    size: number,
    cx: number,
    cz: number,
    sources: GroundCoverSource[],
    ctx: GroundCoverContext,
): boolean {
    const { heights, splat } = ctx;
    const res = splat.resolution;
    const a = heights.toGrid(cx * size, cz * size);
    const b = heights.toGrid((cx + 1) * size, (cz + 1) * size);
    const x0 = Math.max(0, Math.floor(a.gx));
    const z0 = Math.max(0, Math.floor(a.gz));
    const x1 = Math.min(res - 1, Math.ceil(b.gx));
    const z1 = Math.min(res - 1, Math.ceil(b.gz));
    const d = splat.data;

    for (let row = z0; row <= z1; row++) {
        for (let col = x0; col <= x1; col++) {
            const i = (row * res + col) * 8;

            for (const s of sources) {
                if (d[i + s.slot] > 0) {
                    return true;
                }
            }
        }
    }

    return false;
}

/**
 * Integer hash (lowbias32). Candidates are placed with stateless hashes rather than a random
 * stream, so any candidate can be evaluated on its own — in any order, or on the GPU — and always
 * comes out the same. Keep in sync with the GPU generator.
 */
export function hash32(x: number): number {
    x ^= x >>> 16;
    x = Math.imul(x, 0x7feb352d);
    x ^= x >>> 15;
    x = Math.imul(x, 0x846ca68b);
    x ^= x >>> 16;

    return x >>> 0;
}

/** Hash of a type's grid cell and a salt, as a float in [0, 1) (24 bits, exact on the GPU too). */
export function cellRandom(
    typeSeed: number,
    gx: number,
    gz: number,
    salt: number,
): number {
    const h = hash32(typeSeed ^ hash32((gx | 0) ^ hash32((gz | 0) ^ salt)));

    return (h >>> 8) / 16777216;
}

/** Per-type seed (different types never share placements or groves). */
export function typeSeed(typeId: number): number {
    return hash32(typeId * 0x9e3779b1);
}

/** Salts of the per-candidate random values. */
export const SALT = {
    x: 0x1b873593,
    z: 0x68e31da4,
    keep: 0x2c1b3c6d,
    scale: 0x297a2d39,
    yaw: 0x5bd1e995,
    cluster: 0x61c88647,
    rank: 0x3c6ef372,
} as const;

/** Size (m) of the groves and clearings clustering produces, by kind (trees form larger groves). */
export function clusterScale(kind: FoliageKind): number {
    return kind === 'conifer' || kind === 'broadleaf' || kind === 'palm'
        ? 70
        : kind === 'bush' || kind === 'rock'
          ? 30
          : 14;
}

/** Smooth value noise in [0, 1] from lattice hashes (the grove / clearing field). */
export function clusterNoise(
    seed: number,
    x: number,
    z: number,
    scale: number,
): number {
    const fx = x / scale;
    const fz = z / scale;
    const x0 = Math.floor(fx);
    const z0 = Math.floor(fz);
    const tx = smooth(fx - x0);
    const tz = smooth(fz - z0);
    const at = (gx: number, gz: number) =>
        cellRandom(seed, gx, gz, SALT.cluster);
    const top = at(x0, z0) * (1 - tx) + at(x0 + 1, z0) * tx;
    const bottom = at(x0, z0 + 1) * (1 - tx) + at(x0 + 1, z0 + 1) * tx;

    return top * (1 - tz) + bottom * tz;
}

function smooth(t: number): number {
    return t * t * (3 - 2 * t);
}

/**
 * Density multiplier of clustering (1 - c … 1 + c, about 1 on average): more plants in groves,
 * fewer in clearings.
 */
export function clusterFactor(noise: number, clustering: number): number {
    const t = Math.min(1, Math.max(0, (noise - 0.3) / 0.4));

    return 1 + clustering * (2 * smooth(t) - 1);
}

/**
 * Candidate grid of a type: one candidate per cell, placed uniformly inside its cell (stratified
 * sampling: even but natural, never clumped by chance), or with a margin when a minimum spacing is set.
 */
export function candidateGrid(
    type: FoliageType,
    sources: GroundCoverSource[],
): { cell: number; margin: number; peak: number } {
    let peak = 0;
    let spacing = 0;

    for (const s of sources) {
        peak = Math.max(peak, s.density * (1 + s.clustering));
        spacing = Math.max(spacing, s.spacing);
    }

    // Instances per m² at the highest local density any source asks for.
    const perM2 = (type.density * peak) / 100;
    const cell = Math.max(perM2 > 0 ? 1 / Math.sqrt(perM2) : Infinity, spacing);

    return { cell, margin: Math.min(spacing, cell) / 2, peak };
}

/** Candidate grid cells of one tile (every candidate that can land in it). */
export type TileGrid = {
    /** Grid cell size (m), the margin kept from its edges and the span candidates are placed in. */
    cell: number;
    margin: number;
    span: number;
    /** Highest local density any source asks for (the keep probability's denominator). */
    peak: number;
    /** First grid cell and the number of cells across / down. */
    g0: number;
    h0: number;
    columns: number;
    rows: number;
};

/** Candidate grid of a tile (`size` m square at cx, cz); null when the type grows nothing. */
export function tileGrid(
    type: FoliageType,
    sources: GroundCoverSource[],
    size: number,
    cx: number,
    cz: number,
): TileGrid | null {
    const grid = candidateGrid(type, sources);

    if (type.density <= 0 || grid.peak <= 0 || !Number.isFinite(grid.cell)) {
        return null;
    }

    // Very dense types on large tiles: coarser candidates, same density (see MAX_PER_TILE).
    const cell = Math.max(grid.cell, size / Math.sqrt(MAX_PER_TILE));
    const g0 = Math.floor((cx * size) / cell);
    const h0 = Math.floor((cz * size) / cell);

    return {
        cell,
        margin: grid.margin,
        span: cell - grid.margin * 2,
        peak: grid.peak,
        g0,
        h0,
        columns: Math.floor(((cx + 1) * size) / cell) - g0 + 1,
        rows: Math.floor(((cz + 1) * size) / cell) - h0 + 1,
    };
}

/**
 * Expected number of instances of a tile before the placement rules (which only remove more): its
 * area in candidates × the mean keep probability, integrated over the splat samples covering it
 * (trapezoid rule, exact for the bilinear paint weights of a tile on sample lines), with clustering
 * taken at the samples.
 */
export function expectedTileCount(
    type: FoliageType,
    size: number,
    cx: number,
    cz: number,
    sources: GroundCoverSource[],
    ctx: GroundCoverContext,
): number {
    const grid = tileGrid(type, sources, size, cx, cz);

    if (!grid) {
        return 0;
    }

    const { heights, splat } = ctx;
    const res = splat.resolution;
    const a = heights.toGrid(cx * size, cz * size);
    const b = heights.toGrid((cx + 1) * size, (cz + 1) * size);
    const x0 = Math.max(0, Math.floor(a.gx));
    const z0 = Math.max(0, Math.floor(a.gz));
    const x1 = Math.min(res - 1, Math.ceil(b.gx));
    const z1 = Math.min(res - 1, Math.ceil(b.gz));
    const seed = typeSeed(type.id);
    const groves = clusterScale(type.kind);
    const clustered = sources.some((s) => s.clustering > 0);
    const edge = (i: number, first: number, last: number) =>
        first < last && (i === first || i === last) ? 0.5 : 1;
    const d = splat.data;
    let sum = 0;
    let total = 0;

    for (let row = z0; row <= z1; row++) {
        for (let col = x0; col <= x1; col++) {
            const w = edge(row, z0, z1) * edge(col, x0, x1);
            const noise = clustered
                ? clusterNoise(
                      seed,
                      heights.colToX(col),
                      heights.rowToZ(row),
                      groves,
                  )
                : 0.5;
            let weight = 0;

            for (const s of sources) {
                weight +=
                    (d[(row * res + col) * 8 + s.slot] / 255) *
                    s.density *
                    clusterFactor(noise, s.clustering);
            }

            sum += w * Math.min(1, weight / grid.peak);
            total += w;
        }
    }

    return total > 0 ? ((size / grid.cell) ** 2 * sum) / total : 0;
}

/**
 * Instances of one tile (`size` m square at cx, cz), in the foliage file layout
 * ([x, y, z, yaw, scale, tiltX, tiltZ] per instance). Every grid cell whose candidate falls in the
 * tile is kept with probability (paint weight × density × clustering) / peak, so the count follows
 * the paint smoothly (a half-painted border gets half the grass). Instances come out ordered by a
 * per-candidate random rank (distance thinning draws a prefix), the order the GPU generator's ranks
 * give too.
 */
export function generateGroundCoverTile(
    type: FoliageType,
    size: number,
    cx: number,
    cz: number,
    sources: GroundCoverSource[],
    ctx: GroundCoverContext,
): number[] {
    const grid = tileGrid(type, sources, size, cx, cz);

    if (!grid || !tilePainted(size, cx, cz, sources, ctx)) {
        return [];
    }

    const { cell, margin, span, peak } = grid;
    const seed = typeSeed(type.id);
    const scaleRange = type.max_scale - type.min_scale;
    const groves = clusterScale(type.kind);
    const clustered = sources.some((s) => s.clustering > 0);
    const hf = ctx.heights;
    const x0 = cx * size;
    const z0 = cz * size;
    const kept: { rank: number; values: number[] }[] = [];

    for (let gz = grid.h0; gz < grid.h0 + grid.rows; gz++) {
        for (let gx = grid.g0; gx < grid.g0 + grid.columns; gx++) {
            const x =
                gx * cell + margin + cellRandom(seed, gx, gz, SALT.x) * span;
            const z =
                gz * cell + margin + cellRandom(seed, gx, gz, SALT.z) * span;

            // Each candidate belongs to exactly one tile (the one it lands in).
            if (x < x0 || x >= x0 + size || z < z0 || z >= z0 + size) {
                continue;
            }

            if (!hf.contains(x, z)) {
                continue;
            }

            const noise = clustered ? clusterNoise(seed, x, z, groves) : 0.5;
            let weight = 0;

            for (const s of sources) {
                const w = splatWeight(ctx.splat, hf, s.slot, x, z);

                if (w > 0) {
                    weight +=
                        w * s.density * clusterFactor(noise, s.clustering);
                }
            }

            if (
                cellRandom(seed, gx, gz, SALT.keep) >= weight / peak ||
                !ctx.allowed(type, x, z)
            ) {
                continue;
            }

            const scale =
                type.min_scale +
                cellRandom(seed, gx, gz, SALT.scale) * scaleRange;
            let tiltX = 0;
            let tiltZ = 0;

            if (type.align_to_normal) {
                hf.normal(x, z, _normal);
                tiltX = Math.atan2(_normal.z, _normal.y);
                tiltZ = -Math.atan2(_normal.x, _normal.y);
            }

            kept.push({
                rank: cellRandom(seed, gx, gz, SALT.rank),
                values: [
                    x,
                    hf.sample(x, z) - 0.05 * scale,
                    z,
                    type.random_yaw
                        ? cellRandom(seed, gx, gz, SALT.yaw) * Math.PI * 2
                        : 0,
                    scale,
                    tiltX,
                    tiltZ,
                ],
            });
        }
    }

    kept.sort((a, b) => a.rank - b.rank);

    return kept.flatMap((k) => k.values);
}
