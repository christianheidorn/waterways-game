import * as THREE from 'three/webgpu';
import { FOLIAGE_STRIDE } from '../../shared/types';
import type { FoliageType } from '../../shared/types';
import { mulberry32 } from '../../util/noise';
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
};

export type GroundCoverContext = {
    heights: Heightfield;
    splat: SplatMap;
    waterLevelAt: (x: number, z: number) => number | null;
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
function tilePainted(
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

/** Deterministic seed of a tile of a type. */
function tileSeed(typeId: number, cx: number, cz: number): number {
    let h = Math.imul(typeId + 0x9e37, 0x85ebca6b);
    h = Math.imul(h ^ (cx + 0x7f4a), 0xc2b2ae35);
    h = Math.imul(h ^ (cz - 0x2c1b), 0x27d4eb2f);

    return (h ^ (h >>> 15)) >>> 0;
}

/**
 * Instances of one tile (`size` m square at cx, cz), in the foliage file layout
 * ([x, y, z, yaw, scale, tiltX, tiltZ] per instance). Candidates are spread uniformly at the highest
 * density any source asks for and kept in proportion to the painted weights, so the count follows the
 * paint smoothly (a half-painted border gets half the grass).
 */
export function generateGroundCoverTile(
    type: FoliageType,
    size: number,
    cx: number,
    cz: number,
    sources: GroundCoverSource[],
    ctx: GroundCoverContext,
): number[] {
    const out: number[] = [];
    const peak = Math.max(0, ...sources.map((s) => s.density));

    if (peak <= 0 || type.density <= 0) {
        return out;
    }

    if (!tilePainted(size, cx, cz, sources, ctx)) {
        return out;
    }

    const rand = mulberry32(tileSeed(type.id, cx, cz));
    const expected = (size * size * type.density * peak) / 100;
    const count = Math.min(MAX_PER_TILE, Math.floor(expected + rand()));
    const hf = ctx.heights;
    const scaleRange = type.max_scale - type.min_scale;

    for (let i = 0; i < count; i++) {
        const x = (cx + rand()) * size;
        const z = (cz + rand()) * size;
        const keep = rand();
        const scale = type.min_scale + rand() * scaleRange;
        const yaw = rand() * Math.PI * 2;

        if (!hf.contains(x, z)) {
            continue;
        }

        let weight = 0;

        for (const s of sources) {
            weight += splatWeight(ctx.splat, hf, s.slot, x, z) * s.density;
        }

        if (keep >= Math.min(1, weight / peak) || !ctx.allowed(type, x, z)) {
            continue;
        }

        const y = hf.sample(x, z);
        let tiltX = 0;
        let tiltZ = 0;

        if (type.align_to_normal) {
            hf.normal(x, z, _normal);
            tiltX = Math.atan2(_normal.z, _normal.y);
            tiltZ = -Math.atan2(_normal.x, _normal.y);
        }

        out.push(
            x,
            y - 0.05 * scale,
            z,
            type.random_yaw ? yaw : 0,
            scale,
            tiltX,
            tiltZ,
        );
    }

    return out.length % FOLIAGE_STRIDE === 0 ? out : [];
}
