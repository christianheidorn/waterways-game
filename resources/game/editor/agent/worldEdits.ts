import { NO_WATER } from '../../shared/types';
import type { FoliageType } from '../../shared/types';
import type { Foliage, FoliagePlacementContext } from '../../world/Foliage';
import {
    clusterFactor,
    clusterNoise,
    clusterScale,
    typeSeed,
} from '../../world/foliage/groundCover';
import type { Heightfield } from '../../world/Heightfield';
import type { Props } from '../../world/Props';
import type { SplatMap } from '../../world/SplatMap';
import { mulberry32, SimplexNoise } from '../../util/noise';
import { hydraulicErosion, thermalErosion } from '../tools/terrainOps';
import type { Point, ShapeMask } from './shapes';

/**
 * Scripted world edits for AI agents: whole-shape terrain, paint, water and foliage operations in
 * world metres (see ShapeMask), each one undo step in the editor (Editor.scriptedEdit). They are the
 * engine side of the MCP tools sculpt_terrain, paint_terrain, edit_water and edit_foliage.
 */

export type SculptParams =
    | { op: 'raise'; amount: number }
    | { op: 'set_height'; height: number }
    | { op: 'flatten' }
    | { op: 'smooth'; strength?: number; iterations?: number }
    | { op: 'noise'; amplitude: number; scale?: number; seed?: number }
    | { op: 'terrace'; step: number; sharpness?: number }
    | {
          op: 'hill';
          height: number;
          profile?: 'dome' | 'peak' | 'plateau';
          roughness?: number;
          seed?: number;
      }
    | { op: 'erode'; kind?: 'hydraulic' | 'thermal'; strength?: number }
    | { op: 'grade'; smoothing?: number };

export class EditError extends Error {}

/** Applies a terrain operation inside the mask; returns a short summary. */
export function sculptTerrain(
    hf: Heightfield,
    mask: ShapeMask,
    p: SculptParams,
): Record<string, number | string> {
    const data = hf.data;
    const res = hf.resolution;
    const before = heightRange(hf, mask);

    switch (p.op) {
        case 'raise':
            mask.forEach((col, row, w) => {
                data[row * res + col] += p.amount * w;
            });
            break;
        case 'set_height':
            blendTo(hf, mask, () => p.height);
            break;
        case 'flatten': {
            const target = before.coreMean;
            blendTo(hf, mask, () => target);
            break;
        }
        case 'smooth': {
            const strength = clamp01(p.strength ?? 0.8);
            const passes = Math.max(1, Math.min(50, p.iterations ?? 6));

            for (let k = 0; k < passes; k++) {
                const src = data.slice();
                mask.forEach((col, row, w) => {
                    const avg = average3x3(src, res, col, row);
                    const i = row * res + col;
                    data[i] += (avg - data[i]) * w * strength;
                });
            }

            break;
        }
        case 'noise': {
            const noise = new SimplexNoise(p.seed ?? 4217);
            const scale = Math.max(1, p.scale ?? 40);
            mask.forEach((col, row, w) => {
                const n = noise.fbm(
                    hf.colToX(col) / scale,
                    hf.rowToZ(row) / scale,
                    4,
                );
                data[row * res + col] += p.amplitude * n * w;
            });
            break;
        }
        case 'terrace': {
            const step = Math.max(0.2, p.step);
            const exponent = 1 + clamp01(p.sharpness ?? 0.7) * 8;
            blendTo(hf, mask, (h) => {
                const t = h / step;
                const f = Math.floor(t);

                return step * (f + Math.pow(t - f, exponent));
            });
            break;
        }
        case 'hill': {
            const profile = p.profile ?? 'dome';
            const rough = clamp01(p.roughness ?? 0.25);
            const noise = new SimplexNoise(p.seed ?? 911);
            const scale = Math.max(8, Math.sqrt(mask.area) / 4);
            mask.forEach((col, row, _w, i) => {
                const t = mask.relief[i];
                const shape =
                    profile === 'plateau'
                        ? smoothstep(0, 0.45, t)
                        : profile === 'peak'
                          ? Math.pow(0.5 - 0.5 * Math.cos(Math.PI * t), 2)
                          : 0.5 - 0.5 * Math.cos(Math.PI * t);
                const n = noise.fbm(
                    hf.colToX(col) / scale,
                    hf.rowToZ(row) / scale,
                    4,
                );
                data[row * res + col] += p.height * shape * (1 + rough * n);
            });
            break;
        }
        case 'erode':
            erode(hf, mask, p.kind ?? 'hydraulic', clamp01(p.strength ?? 0.5));
            break;
        case 'grade':
            grade(hf, mask, Math.max(0, p.smoothing ?? 40));
            break;
    }

    const after = heightRange(hf, mask);

    return {
        operation: p.op,
        samples: mask.width * mask.height,
        height_before: `${round1(before.min)} … ${round1(before.max)} m (core mean ${round1(before.coreMean)})`,
        height_after: `${round1(after.min)} … ${round1(after.max)} m (core mean ${round1(after.coreMean)})`,
    };
}

export type PaintParams = {
    slot: number;
    /** Share of the layer at full effect (0-1). */
    strength?: number;
    mode?: 'paint' | 'erase';
    min_slope?: number;
    max_slope?: number;
    min_height?: number;
    max_height?: number;
    /** 0-1: natural, noisy edges and patches instead of a uniform fill. */
    breakup?: number;
};

/** Paints (or removes) a terrain layer inside the mask, optionally only where slope / height rules hold. */
export function paintLayer(
    splat: SplatMap,
    hf: Heightfield,
    mask: ShapeMask,
    p: PaintParams,
): Record<string, number> {
    const strength = clamp01(p.strength ?? 1);
    const breakup = clamp01(p.breakup ?? 0);
    const noise = new SimplexNoise(7331 + p.slot);
    const res = splat.resolution;
    const d = splat.data;
    let painted = 0;
    let skipped = 0;

    mask.forEach((col, row, w) => {
        const x = hf.colToX(col);
        const z = hf.rowToZ(row);
        const h = hf.data[row * res + col];
        const rule =
            band(hf.slope(x, z), p.min_slope, p.max_slope, 3) *
            band(h, p.min_height, p.max_height, 2);

        if (rule <= 0) {
            skipped++;

            return;
        }

        const n = breakup > 0 ? (noise.fbm(x / 14, z / 14, 3) + 1) * 0.5 : 0;
        const amount = w * rule * strength * (1 - breakup * n);
        const current = d[(row * res + col) * 8 + p.slot] / 255;

        if (p.mode === 'erase') {
            if (current > 0) {
                splat.paint(col, row, p.slot, -current * amount);
                painted++;
            }
        } else if (amount > current) {
            splat.paint(col, row, p.slot, amount - current);
            painted++;
        }
    });

    const area = hf.cell * hf.cell;

    return {
        changed_m2: Math.round(painted * area),
        excluded_by_rules_m2: Math.round(skipped * area),
    };
}

export type LakeParams = {
    point: Point;
    /** Water surface height (m). */
    level?: number;
    /** Without a level: this far above the ground at the point (default 3 m). */
    depth?: number;
    /** Fill the basin as high as it holds water (just below its lowest rim point). */
    fill_to_rim?: boolean;
};

/**
 * Floods the basin around `point` up to a water level (connected ground below it), optionally
 * limited to the mask. Refuses when the water would spill over the map edge.
 */
export function fillLake(
    hf: Heightfield,
    water: Heightfield,
    limit: ShapeMask | null,
    p: LakeParams,
): Record<string, number> {
    const res = hf.resolution;
    const { gx, gz } = hf.toGrid(p.point.x, p.point.z);
    const start = Math.round(gz) * res + Math.round(gx);

    if (!hf.contains(p.point.x, p.point.z)) {
        throw new EditError('The lake point is outside the map.');
    }

    const rim = limit ? null : spillPoint(hf, start);
    const level = p.fill_to_rim
        ? (rim?.level ?? Infinity) - 0.3
        : (p.level ?? hf.data[start] + Math.max(0.5, p.depth ?? 3));

    if (!Number.isFinite(level) || hf.data[start] >= level) {
        if (p.fill_to_rim) {
            throw new EditError(
                'This point is not in a basin that can hold water (it drains straight off the map).',
            );
        }

        throw new EditError(
            `The ground at the point (${round1(hf.data[start])} m) is not below the water level (${round1(level)} m).`,
        );
    }

    const seen = new Uint8Array(res * res);
    const stack = [start];
    const cells: number[] = [];
    let touchesEdge = false;
    seen[start] = 1;

    while (stack.length) {
        const i = stack.pop()!;
        const col = i % res;
        const row = (i - col) / res;
        cells.push(i);

        if (col === 0 || row === 0 || col === res - 1 || row === res - 1) {
            touchesEdge = true;
        }

        for (const [dc, dr] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
        ]) {
            const c = col + dc;
            const r = row + dr;

            if (c < 0 || r < 0 || c >= res || r >= res) {
                continue;
            }

            const j = r * res + c;

            if (seen[j] || hf.data[j] >= level) {
                continue;
            }

            if (limit && limitWeight(limit, c, r) < 0.5) {
                continue;
            }

            seen[j] = 1;
            stack.push(j);
        }
    }

    if (touchesEdge && !limit) {
        const hint =
            !rim || rim.level <= hf.data[start] + 0.05
                ? ' The ground here drains downhill to the map edge: dig a basin first (sculpt_terrain hill with a negative height, deeper than the slope drops), or limit the lake with a shape.'
                : ` This basin holds water up to ${round1(rim.level)} m: it overflows at x ${Math.round(rim.x)}, z ${Math.round(rim.z)}. Use a level below that (or fill_to_rim), raise the rim there with sculpt_terrain, or limit the lake with a shape.`;

        throw new EditError(
            `At ${round1(level)} m the water would spill over the map edge.${hint}`,
        );
    }

    let deepest = 0;

    for (const i of cells) {
        water.data[i] = level;
        deepest = Math.max(deepest, level - hf.data[i]);
    }

    return {
        level: round1(level),
        area_m2: Math.round(cells.length * hf.cell * hf.cell),
        max_depth_m: round1(deepest),
    };
}

/**
 * Where a basin overflows: flooding outwards from `start` lowest ground first, the water level is the
 * highest ground crossed so far; when the flood reaches the map edge, that level is the basin's spill
 * height and the crossing its lowest rim point.
 */
function spillPoint(
    hf: Heightfield,
    start: number,
): { level: number; x: number; z: number } | null {
    const res = hf.resolution;
    const seen = new Uint8Array(res * res);
    const heap = new MinHeap();
    let level = -Infinity;
    let rimIndex = start;
    heap.push(start, hf.data[start]);
    seen[start] = 1;

    while (heap.size) {
        const i = heap.pop();
        const h = hf.data[i];

        if (h > level) {
            level = h;
            rimIndex = i;
        }

        const col = i % res;
        const row = (i - col) / res;

        if (col === 0 || row === 0 || col === res - 1 || row === res - 1) {
            return {
                level,
                x: hf.colToX(rimIndex % res),
                z: hf.rowToZ(Math.floor(rimIndex / res)),
            };
        }

        for (const j of [i + 1, i - 1, i + res, i - res]) {
            if (!seen[j]) {
                seen[j] = 1;
                heap.push(j, hf.data[j]);
            }
        }
    }

    return null;
}

/** Binary min-heap of grid indices by height. */
class MinHeap {
    private readonly items: number[] = [];
    private readonly keys: number[] = [];

    get size(): number {
        return this.items.length;
    }

    push(item: number, key: number): void {
        let i = this.items.length;
        this.items.push(item);
        this.keys.push(key);

        while (i > 0) {
            const parent = (i - 1) >> 1;

            if (this.keys[parent] <= key) {
                break;
            }

            this.swap(i, parent);
            i = parent;
        }
    }

    pop(): number {
        const top = this.items[0];
        const lastItem = this.items.pop()!;
        const lastKey = this.keys.pop()!;

        if (this.items.length) {
            this.items[0] = lastItem;
            this.keys[0] = lastKey;
            let i = 0;

            for (;;) {
                const l = 2 * i + 1;
                const r = l + 1;
                let m = i;

                if (l < this.keys.length && this.keys[l] < this.keys[m]) {
                    m = l;
                }

                if (r < this.keys.length && this.keys[r] < this.keys[m]) {
                    m = r;
                }

                if (m === i) {
                    break;
                }

                this.swap(i, m);
                i = m;
            }
        }

        return top;
    }

    private swap(a: number, b: number): void {
        [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
        [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
    }
}

/**
 * A river along a path shape: the water surface follows the ground downhill from the first point to
 * the last (never rising), the bed is carved `depth` metres below it across the path width and the
 * banks slope into it over the falloff.
 */
export function carveRiver(
    hf: Heightfield,
    water: Heightfield,
    mask: ShapeMask,
    depth: number,
): Record<string, number> {
    if (mask.spec.type !== 'path') {
        throw new EditError('A river needs a path shape.');
    }

    const surface = pathProfile(hf, mask, (heights) => {
        // Running minimum: the surface never rises downstream.
        let min = Infinity;

        return heights.map((h) => (min = Math.min(min, h - 0.3)));
    });
    const half = mask.spec.width / 2;
    const res = hf.resolution;
    const outer = half + (mask.spec.falloff ?? 0);
    let wet = 0;

    mask.forEach((col, row, w, i) => {
        const level = surface(mask.along[i]);
        const k = row * res + col;
        // Distance from the centre line, from the relief coordinate (1 at the line, 0 at the outer edge).
        const d = (1 - mask.relief[i]) * outer;

        if (d <= half) {
            const bed =
                level -
                depth * (1 - Math.pow(d / Math.max(half, 1e-6), 2) * 0.7);
            water.data[k] = level;
            hf.data[k] = Math.min(hf.data[k], bed);
            wet++;
        } else {
            // Banks: down to just above the water at the edge of the channel.
            hf.data[k] = Math.min(
                hf.data[k],
                hf.data[k] + (level + 0.2 - hf.data[k]) * w,
            );
        }
    });

    return {
        length_m: Math.round(mask.length),
        water_m2: Math.round(wet * hf.cell * hf.cell),
        surface_start_m: round1(surface(0)),
        surface_end_m: round1(surface(mask.length)),
    };
}

/** Removes water (surfaces) inside the mask. */
export function eraseWater(
    water: Heightfield,
    mask: ShapeMask,
): Record<string, number> {
    const res = water.resolution;
    let removed = 0;

    mask.forEach((col, row, w) => {
        const i = row * res + col;

        if (w >= 0.5 && water.data[i] > NO_WATER + 1) {
            water.data[i] = NO_WATER;
            removed++;
        }
    });

    return { removed_m2: Math.round(removed * water.cell * water.cell) };
}

export type ScatterParams = {
    types: FoliageType[];
    /** Multiplier on each type's own density (instances per 100 m²). */
    density?: number;
    /** 0 = even … 1 = groves and clearings. */
    clustering?: number;
    seed?: number;
};

/** Most instances one scatter places per type (hand-placed data is saved with the map). */
const SCATTER_MAX = 200000;

/**
 * Places foliage inside the mask following each type's rules (hand-placed data: saved with the map).
 * It fills up to the asked density: instances already there count, so scattering the same area again
 * does not stack layer upon layer (small kinds are placed without a spacing check, and would).
 */
export function scatterFoliage(
    foliage: Foliage,
    ctx: FoliagePlacementContext,
    mask: ShapeMask,
    p: ScatterParams,
): Record<string, number> {
    const random = mulberry32(p.seed ?? Date.now() & 0x7fffffff);
    const density = Math.max(0, p.density ?? 1);
    const clustering = clamp01(p.clustering ?? 0);
    const hf = mask.hf;
    const x0 = hf.colToX(mask.rect.x0);
    const z0 = hf.rowToZ(mask.rect.z0);
    const x1 = hf.colToX(mask.rect.x1);
    const z1 = hf.rowToZ(mask.rect.z1);
    const placed: Record<string, number> = {};
    const area = mask.area;
    const rect = { x0, z0, x1, z1 };
    const weight = (x: number, z: number) => mask.weightAt(x, z);

    for (const type of p.types) {
        const existing = foliage.countWhere(type.id, rect, weight);
        const target = Math.min(
            SCATTER_MAX,
            Math.max(
                0,
                Math.round((area * type.density * density) / 100 - existing),
            ),
        );
        const spacing =
            Math.sqrt(100 / Math.max(0.01, type.density * density)) * 0.45;
        const seed = typeSeed(type.id);
        const groves = clusterScale(type.kind);
        let count = 0;

        for (
            let attempt = 0;
            attempt < target * 4 && count < target;
            attempt++
        ) {
            const x = x0 + random() * (x1 - x0);
            const z = z0 + random() * (z1 - z0);
            let chance = mask.weightAt(x, z);

            if (clustering > 0) {
                chance *=
                    clusterFactor(
                        clusterNoise(seed, x, z, groves),
                        clustering,
                    ) /
                    (1 + clustering);
            }

            if (
                chance > 0 &&
                random() < chance &&
                foliage.placeAt(ctx, type.id, x, z, spacing)
            ) {
                count++;
            }
        }

        placed[type.name] = count;

        if (existing >= 1) {
            placed[`${type.name} (already there)`] = Math.round(existing);
        }
    }

    return placed;
}

/** Removes placed foliage of the given types (all when null) inside the mask. */
export function clearFoliage(
    foliage: Foliage,
    mask: ShapeMask,
    typeIds: number[] | null,
    strength = 1,
): Record<string, number> {
    const hf = mask.hf;
    const removed = foliage.eraseWhere(
        typeIds,
        {
            x0: hf.colToX(mask.rect.x0),
            z0: hf.rowToZ(mask.rect.z0),
            x1: hf.colToX(mask.rect.x1),
            z1: hf.rowToZ(mask.rect.z1),
        },
        (x, z) => mask.weightAt(x, z) * clamp01(strength),
    );

    return { removed };
}

// ---------------------------------------------------------------------------------------------- helpers

function blendTo(
    hf: Heightfield,
    mask: ShapeMask,
    target: (h: number) => number,
): void {
    const res = hf.resolution;
    mask.forEach((col, row, w) => {
        const i = row * res + col;
        hf.data[i] += (target(hf.data[i]) - hf.data[i]) * w;
    });
}

function heightRange(hf: Heightfield, mask: ShapeMask) {
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let n = 0;
    let coreSum = 0;
    let coreN = 0;
    const res = hf.resolution;

    mask.forEach((col, row, w) => {
        const h = hf.data[row * res + col];
        min = Math.min(min, h);
        max = Math.max(max, h);
        sum += h;
        n++;

        if (w >= 0.999) {
            coreSum += h;
            coreN++;
        }
    });

    return {
        min: n ? min : 0,
        max: n ? max : 0,
        coreMean: coreN ? coreSum / coreN : n ? sum / n : 0,
    };
}

function average3x3(
    src: Float32Array,
    res: number,
    col: number,
    row: number,
): number {
    let sum = 0;
    let n = 0;

    for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
            const c = col + dc;
            const r = row + dr;

            if (c >= 0 && r >= 0 && c < res && r < res) {
                sum += src[r * res + c];
                n++;
            }
        }
    }

    return sum / n;
}

/** Brush-based erosion stamped over the shape (the stamps' own falloff keeps the edges soft). */
function erode(
    hf: Heightfield,
    mask: ShapeMask,
    kind: 'hydraulic' | 'thermal',
    strength: number,
): void {
    const spanX = mask.width * hf.cell;
    const spanZ = mask.height * hf.cell;
    const radius = Math.min(80, Math.max(20, Math.min(spanX, spanZ) / 3));
    const step = radius * 0.8;
    const passes = 1 + Math.round(strength * 5);
    const brush = {
        radius,
        strength,
        falloff: 0.5,
        falloffType: 'smooth' as const,
    };
    const x0 = hf.colToX(mask.rect.x0);
    const z0 = hf.rowToZ(mask.rect.z0);

    for (let pass = 0; pass < passes; pass++) {
        for (let z = z0; z <= z0 + spanZ; z += step) {
            for (let x = x0; x <= x0 + spanX; x += step) {
                if (mask.weightAt(x, z) < 0.2) {
                    continue;
                }

                if (kind === 'thermal') {
                    thermalErosion(hf, x, z, brush, 0.05, {
                        talusAngle: 33,
                        iterations: 4,
                    });
                } else {
                    hydraulicErosion(hf, x, z, brush, 0.05, { droplets: 80 });
                }
            }
        }
    }
}

/** A path's ground turned into an even grade (roads, ramps, tracks). */
function grade(hf: Heightfield, mask: ShapeMask, smoothing: number): void {
    if (mask.spec.type !== 'path') {
        throw new EditError('grade needs a path shape.');
    }

    const profile = pathProfile(hf, mask, (heights, step) => {
        const radius = Math.max(0, Math.round(smoothing / 2 / step));

        return heights.map((_h, k) => {
            let sum = 0;
            let n = 0;

            for (
                let j = Math.max(0, k - radius);
                j <= Math.min(heights.length - 1, k + radius);
                j++
            ) {
                sum += heights[j];
                n++;
            }

            return sum / n;
        });
    });
    const res = hf.resolution;
    mask.forEach((col, row, w, i) => {
        const k = row * res + col;
        hf.data[k] += (profile(mask.along[i]) - hf.data[k]) * w;
    });
}

/**
 * Ground heights sampled along a path's centre line (every few metres), transformed, and returned as
 * a function of the distance along the path (linear between samples).
 */
function pathProfile(
    hf: Heightfield,
    mask: ShapeMask,
    transform: (heights: number[], step: number) => number[],
): (s: number) => number {
    const points = (mask.spec as { points: Point[] }).points;
    const step = Math.max(hf.cell, 2);
    const heights: number[] = [];
    let k = 0;
    let segStart = 0;

    for (let s = 0; s <= mask.length + 1e-6; s += step) {
        while (
            k + 1 < points.length - 1 &&
            s > segStart + segLength(points, k)
        ) {
            segStart += segLength(points, k);
            k++;
        }

        const len = segLength(points, k);
        const t = len > 0 ? Math.min(1, (s - segStart) / len) : 0;
        const p = points[k];
        const q = points[Math.min(k + 1, points.length - 1)];
        heights.push(hf.sample(p.x + (q.x - p.x) * t, p.z + (q.z - p.z) * t));
    }

    const values = transform(heights, step);

    return (s: number) => {
        const f = Math.min(values.length - 1, Math.max(0, s / step));
        const i = Math.floor(f);
        const j = Math.min(values.length - 1, i + 1);

        return values[i] + (values[j] - values[i]) * (f - i);
    };
}

function segLength(points: Point[], k: number): number {
    const p = points[k];
    const q = points[Math.min(k + 1, points.length - 1)];

    return Math.hypot(q.x - p.x, q.z - p.z);
}

function limitWeight(mask: ShapeMask, col: number, row: number): number {
    const r = mask.rect;

    return col < r.x0 || col > r.x1 || row < r.z0 || row > r.z1
        ? 0
        : mask.weight[mask.index(col, row)];
}

/** 1 inside [min, max], fading to 0 over `soft` outside; unbounded sides pass. */
function band(
    v: number,
    min: number | undefined,
    max: number | undefined,
    soft: number,
): number {
    let w = 1;

    if (min !== undefined && min !== null) {
        w = Math.min(w, clamp01((v - min) / soft + 1));
    }

    if (max !== undefined && max !== null) {
        w = Math.min(w, clamp01((max - v) / soft + 1));
    }

    return w;
}

function smoothstep(a: number, b: number, v: number): number {
    const t = clamp01((v - a) / (b - a));

    return t * t * (3 - 2 * t);
}

function clamp01(v: number): number {
    return Math.min(1, Math.max(0, v));
}

function round1(v: number): number {
    return Math.round(v * 10) / 10;
}

export type PropPlacement = {
    model: number;
    x: number;
    z: number;
    /** Degrees; random when omitted. */
    rotation?: number;
    scale?: number;
    offset?: number;
};

export type PropScatterParams = {
    models: number[];
    count: number;
    /** Minimum distance between prop centres (m); default from the model size. */
    spacing?: number;
    /** Degrees of terrain slope above which no prop is placed. */
    max_slope?: number;
    scale_min?: number;
    scale_max?: number;
    avoid_water?: boolean;
    seed?: number;
};

/** Places props at exact positions. */
export function placeProps(
    props: Props,
    hf: Heightfield,
    items: PropPlacement[],
): { placed: number; ids: string[] } {
    const ids: string[] = [];

    for (const it of items) {
        if (!props.hasModel(it.model)) {
            throw new EditError(
                `There is no ready prop model with id ${it.model}. Use list_prop_models.`,
            );
        }

        if (!hf.contains(it.x, it.z)) {
            throw new EditError(`(${it.x}, ${it.z}) is outside the map.`);
        }
    }

    for (const it of items) {
        ids.push(
            props.add({
                model: it.model,
                x: it.x,
                z: it.z,
                yaw:
                    it.rotation === undefined
                        ? Math.random() * Math.PI * 2
                        : (it.rotation * Math.PI) / 180,
                scale: it.scale ?? 1,
                offset: it.offset ?? 0,
            }).id,
        );
    }

    return { placed: ids.length, ids };
}

/** Scatters props of the given models inside a shape, keeping them apart, off steep ground and water. */
export function scatterProps(
    props: Props,
    hf: Heightfield,
    water: Heightfield,
    mask: ShapeMask,
    p: PropScatterParams,
): { placed: number; ids: string[] } {
    for (const model of p.models) {
        if (!props.hasModel(model)) {
            throw new EditError(
                `There is no ready prop model with id ${model}. Use list_prop_models.`,
            );
        }
    }

    const random = mulberry32(p.seed ?? Date.now() & 0x7fffffff);
    const target = Math.max(0, Math.min(2000, Math.round(p.count)));
    const maxSlope = p.max_slope ?? 25;
    const scaleMin = p.scale_min ?? 1;
    const scaleMax = Math.max(scaleMin, p.scale_max ?? scaleMin);
    const x0 = hf.colToX(mask.rect.x0);
    const z0 = hf.rowToZ(mask.rect.z0);
    const x1 = hf.colToX(mask.rect.x1);
    const z1 = hf.rowToZ(mask.rect.z1);
    const taken = props.list().map((q) => ({
        x: q.x,
        z: q.z,
        r: props.modelRadius(q.model, q.scale),
    }));
    const ids: string[] = [];

    for (
        let attempt = 0;
        attempt < target * 40 && ids.length < target;
        attempt++
    ) {
        const x = x0 + random() * (x1 - x0);
        const z = z0 + random() * (z1 - z0);

        if (random() >= mask.weightAt(x, z) || hf.slope(x, z) > maxSlope) {
            continue;
        }

        if (
            p.avoid_water !== false &&
            water.sample(x, z) > hf.sample(x, z) - 0.2
        ) {
            continue;
        }

        const model = p.models[Math.floor(random() * p.models.length)];
        const scale = scaleMin + random() * (scaleMax - scaleMin);
        const r = props.modelRadius(model, scale);

        if (
            taken.some(
                (q) =>
                    Math.hypot(q.x - x, q.z - z) <
                    (p.spacing ?? (q.r + r) * 1.1),
            )
        ) {
            continue;
        }

        taken.push({ x, z, r });
        ids.push(
            props.add({
                model,
                x,
                z,
                yaw: random() * Math.PI * 2,
                scale,
                offset: 0,
            }).id,
        );
    }

    return { placed: ids.length, ids };
}

/** Removes props (optionally only some models) inside a shape, or by id. */
export function removeProps(
    props: Props,
    mask: ShapeMask | null,
    models: number[] | null,
    ids: string[] | null,
): { removed: number } {
    const doomed = props
        .list()
        .filter(
            (q) =>
                (ids ? ids.includes(q.id) : true) &&
                (models ? models.includes(q.model) : true) &&
                (mask ? mask.weightAt(q.x, q.z) >= 0.5 : true),
        )
        .map((q) => q.id);

    return { removed: props.remove(doomed) };
}
