import type {
    RiverSpline,
    RoadProfile,
    RoadSpline,
    SplineFootprint,
    SplinePoint,
} from '../../shared/types';
import type { Foliage } from '../../world/Foliage';
import type { GridRect, Heightfield } from '../../world/Heightfield';
import { polylineLength, sampleSpline } from '../../world/Splines';
import type { SplatMap } from '../../world/SplatMap';
import { SimplexNoise } from '../../util/noise';

/**
 * Carving roads and rivers from their splines, and taking them out again. Each carve records its
 * footprint (see SplineFootprint): the height it added per grid sample and the paint / water it
 * replaced. Re-carving an edited spline first subtracts the old heights (keeping any sculpting done
 * since) and puts the old paint and water back, then carves the new course.
 */

/** Defaults per road profile. */
export const ROAD_PROFILES: Record<
    RoadProfile,
    {
        width: number;
        shoulder: number;
        bank: number;
        smoothing: number;
        /** Share of the natural ground kept in the grade (0 = fully even). */
        follow: number;
    }
> = {
    path: { width: 2.5, shoulder: 2, bank: 0, smoothing: 16, follow: 0.45 },
    road: { width: 8, shoulder: 6, bank: 0.4, smoothing: 60, follow: 0 },
    track: { width: 4.5, shoulder: 3, bank: 0.1, smoothing: 30, follow: 0.2 },
};

export type SplineWorld = {
    heights: Heightfield;
    splat: SplatMap;
    water: Heightfield;
    foliage: Foliage;
};

/** Grid samples near a centre line, with their signed distance from it and position along it. */
type Corridor = {
    cells: number[];
    /** Signed distance (m) from the centre line (positive on the left of the direction of travel). */
    side: number[];
    /** Distance (m) along the line of the nearest point. */
    along: number[];
    rect: GridRect;
};

/** The grid rectangle a course (plus `reach` metres on each side) covers. */
export function courseRect(
    hf: Heightfield,
    points: SplinePoint[],
    reach: number,
): GridRect {
    const line = sampleSpline(points, 4);
    const max = hf.resolution - 1;
    const xs = line.map((p) => p.x);
    const zs = line.map((p) => p.z);
    const a = hf.toGrid(
        Math.min(...xs) - reach - 4,
        Math.min(...zs) - reach - 4,
    );
    const b = hf.toGrid(
        Math.max(...xs) + reach + 4,
        Math.max(...zs) + reach + 4,
    );

    return {
        x0: clampInt(Math.floor(a.gx), 0, max),
        z0: clampInt(Math.floor(a.gz), 0, max),
        x1: clampInt(Math.ceil(b.gx), 0, max),
        z1: clampInt(Math.ceil(b.gz), 0, max),
    };
}

/** The grid rectangle of a recorded footprint (null when there is none). */
export function footprintRect(
    hf: Heightfield,
    footprint: SplineFootprint | null | undefined,
): GridRect | null {
    if (!footprint) {
        return null;
    }

    const cells = decodeU32(footprint.cells);

    if (!cells.length) {
        return null;
    }

    const res = hf.resolution;
    let x0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let z1 = -Infinity;

    for (const i of cells) {
        const col = i % res;
        const row = (i - col) / res;
        x0 = Math.min(x0, col);
        x1 = Math.max(x1, col);
        z0 = Math.min(z0, row);
        z1 = Math.max(z1, row);
    }

    return { x0, z0, x1, z1 };
}

/**
 * Takes a carve out again: subtracts the heights it added (later sculpting stays) and restores the
 * paint and water it replaced. Placed foliage it cleared does not come back.
 */
export function revertFootprint(
    w: SplineWorld,
    footprint: SplineFootprint | null | undefined,
): void {
    if (!footprint) {
        return;
    }

    const cells = decodeU32(footprint.cells);
    const dh = decodeF32(footprint.heights);
    const splat = footprint.splat ? decodeU8(footprint.splat) : null;
    const water = footprint.water ? decodeF32(footprint.water) : null;

    for (let k = 0; k < cells.length; k++) {
        const i = cells[k];
        w.heights.data[i] -= dh[k];

        if (splat) {
            w.splat.data.set(splat.subarray(k * 8, k * 8 + 8), i * 8);
        }

        if (water) {
            w.water.data[i] = water[k];
        }
    }
}

/** Grades, paints and clears a road along its spline; returns its footprint and a summary. */
export function carveRoad(
    w: SplineWorld,
    road: RoadSpline,
): { footprint: SplineFootprint; summary: Record<string, number> } {
    const hf = w.heights;
    const defaults = ROAD_PROFILES[road.profile] ?? ROAD_PROFILES.road;
    const step = Math.max(0.75, hf.cell * 0.75);
    const line = sampleSpline(road.points, step);
    const half = Math.max(0.5, road.width / 2);
    const shoulder = Math.max(0.5, road.shoulder);
    const paintEdge = Math.min(shoulder, 1 + half * 0.35);
    const reach = half + shoulder;
    const corridor = buildCorridor(hf, line, reach);
    const n = corridor.cells.length;

    // Grade: the ground across the bed along the line, evened out over `smoothing` metres.
    const lengths = cumulative(line);
    const ground = line.map((p, k) => {
        const t = tangent(line, k);
        let sum = 0;

        for (const o of [-0.7, 0, 0.7]) {
            sum += hf.sample(p.x - t.z * half * o, p.z + t.x * half * o);
        }

        return sum / 3;
    });
    const radius = Math.max(
        0,
        Math.round(Math.max(0, road.smoothing) / 2 / step),
    );
    let grade = boxBlur(boxBlur(ground, radius), radius);
    grade = grade.map((g, k) => g + (ground[k] - g) * defaults.follow);
    const curvature = boxBlur(
        line.map((_p, k) => signedCurvature(line, k)),
        Math.max(1, Math.round(8 / step)),
    );
    const at = (values: number[], s: number) => {
        const f = locate(lengths, s);

        return values[f.i] + (values[f.j] - values[f.i]) * f.t;
    };

    const cells = new Uint32Array(n);
    const dh = new Float32Array(n);
    const splatBefore = new Uint8Array(n * 8);
    const noise = new SimplexNoise(911 + road.points.length);
    const slot = road.layer;
    const roughEdge =
        road.profile === 'road' ? 0.15 : road.profile === 'track' ? 0.45 : 0.6;
    let painted = 0;

    for (let k = 0; k < n; k++) {
        const i = corridor.cells[k];
        const d = corridor.side[k];
        const a = Math.abs(d);
        const s = corridor.along[k];
        cells[k] = i;
        splatBefore.set(w.splat.data.subarray(i * 8, i * 8 + 8), k * 8);

        // Bed height across the road at this distance from the centre (edge value on the banks).
        const across = Math.min(a, half);
        const signed = Math.sign(d) * across;
        let bed = at(grade, s);
        // Lean into curves: the inner side lower (bank 1 ≈ 8 % cross fall at a tight bend).
        const lean = clamp(at(curvature, s) * 40 * road.bank, -0.08, 0.08);
        bed -= lean * signed;

        if (road.profile === 'road') {
            // Crown so rain runs off.
            bed += 0.1 * (1 - (across / half) ** 2);
        } else if (road.profile === 'track') {
            // Two wheel ruts.
            bed -= 0.07 * Math.exp(-(((across - half * 0.45) / 0.35) ** 2));
        } else {
            bed -= 0.04 * (1 - (across / half) ** 2);
        }

        const weight = a <= half ? 1 : smoothFade((a - half) / shoulder);
        const h = hf.data[i];
        const next = h + (bed - h) * weight;
        hf.data[i] = next;
        dh[k] = next - h;

        if (slot !== null && slot >= 0 && slot < 8) {
            const x = hf.colToX(i % hf.resolution);
            const z = hf.rowToZ(Math.floor(i / hf.resolution));
            const wobble =
                noise.fbm(x / 6, z / 6, 3) *
                roughEdge *
                Math.max(1, half * 0.3);
            const edge = a + wobble - half;
            const amount = edge <= 0 ? 1 : smoothFade(edge / paintEdge);
            const current = w.splat.data[i * 8 + slot] / 255;

            if (amount > current) {
                const col = i % hf.resolution;
                w.splat.paint(
                    col,
                    (i - col) / hf.resolution,
                    slot,
                    amount - current,
                );
                painted++;
            }
        }
    }

    let cleared = 0;

    if (road.clear_foliage) {
        cleared = clearAlong(w, corridor, half + 1);
    }

    return {
        footprint: {
            cells: encode(cells),
            heights: encode(dh),
            splat: encode(splatBefore),
        },
        summary: {
            length_m: Math.round(polylineLength(line)),
            graded_m2: Math.round(n * hf.cell * hf.cell),
            painted_m2: Math.round(painted * hf.cell * hf.cell),
            foliage_removed: cleared,
            height_start_m: round1(grade[0]),
            height_end_m: round1(grade[grade.length - 1]),
            steepest_grade_pct: round1(steepest(grade, step) * 100),
        },
    };
}

/**
 * Carves a river along its spline: the water surface follows the ground downhill from the first point
 * (never rising), the bed lies `depth` below it and the banks slope into it.
 */
export function carveRiver(
    w: SplineWorld,
    river: RiverSpline,
): { footprint: SplineFootprint; summary: Record<string, number> } {
    const hf = w.heights;
    const step = Math.max(1, hf.cell * 0.75);
    const line = sampleSpline(river.points, step);
    const half = Math.max(0.5, river.width / 2);
    const bank = Math.max(0, river.bank);
    const corridor = buildCorridor(hf, line, half + bank);
    const lengths = cumulative(line);
    let min = Infinity;
    const surface = line.map(
        (p) => (min = Math.min(min, hf.sample(p.x, p.z) - 0.3)),
    );
    const n = corridor.cells.length;
    const cells = new Uint32Array(n);
    const dh = new Float32Array(n);
    const waterBefore = new Float32Array(n);
    let wet = 0;

    for (let k = 0; k < n; k++) {
        const i = corridor.cells[k];
        const a = Math.abs(corridor.side[k]);
        const f = locate(lengths, corridor.along[k]);
        const level = surface[f.i] + (surface[f.j] - surface[f.i]) * f.t;
        const h = hf.data[i];
        cells[k] = i;
        waterBefore[k] = w.water.data[i];
        let next = h;

        if (a <= half) {
            const bed = level - river.depth * (1 - (a / half) ** 2 * 0.7);
            w.water.data[i] = level;
            next = Math.min(h, bed);
            wet++;
        } else {
            const weight = smoothFade((a - half) / Math.max(bank, 1e-3));
            next = Math.min(h, h + (level + 0.2 - h) * weight);
        }

        hf.data[i] = next;
        dh[k] = next - h;
    }

    return {
        footprint: {
            cells: encode(cells),
            heights: encode(dh),
            water: encode(waterBefore),
        },
        summary: {
            length_m: Math.round(polylineLength(line)),
            water_m2: Math.round(wet * hf.cell * hf.cell),
            surface_start_m: round1(surface[0]),
            surface_end_m: round1(surface[surface.length - 1]),
        },
    };
}

/** Removes placed foliage within `half` metres of the centre line. */
function clearAlong(w: SplineWorld, corridor: Corridor, half: number): number {
    const hf = w.heights;
    const res = hf.resolution;
    const r = corridor.rect;
    const width = r.x1 - r.x0 + 1;
    const near = new Uint8Array(width * (r.z1 - r.z0 + 1));

    for (let k = 0; k < corridor.cells.length; k++) {
        if (Math.abs(corridor.side[k]) <= half) {
            const i = corridor.cells[k];
            const col = i % res;
            const row = (i - col) / res;
            near[(row - r.z0) * width + (col - r.x0)] = 1;
        }
    }

    return w.foliage.eraseWhere(
        null,
        {
            x0: hf.colToX(r.x0),
            z0: hf.rowToZ(r.z0),
            x1: hf.colToX(r.x1),
            z1: hf.rowToZ(r.z1),
        },
        (x, z) => {
            const { gx, gz } = hf.toGrid(x, z);
            const col = Math.round(gx);
            const row = Math.round(gz);

            if (col < r.x0 || col > r.x1 || row < r.z0 || row > r.z1) {
                return 0;
            }

            return near[(row - r.z0) * width + (col - r.x0)];
        },
    );
}

/** Grid samples within `reach` metres of a polyline (segment by segment, over their own boxes). */
function buildCorridor(
    hf: Heightfield,
    line: SplinePoint[],
    reach: number,
): Corridor {
    const max = hf.resolution - 1;
    const xs = line.map((p) => p.x);
    const zs = line.map((p) => p.z);
    const a = hf.toGrid(Math.min(...xs) - reach, Math.min(...zs) - reach);
    const b = hf.toGrid(Math.max(...xs) + reach, Math.max(...zs) + reach);
    const rect = {
        x0: clampInt(Math.floor(a.gx), 0, max),
        z0: clampInt(Math.floor(a.gz), 0, max),
        x1: clampInt(Math.ceil(b.gx), 0, max),
        z1: clampInt(Math.ceil(b.gz), 0, max),
    };
    const width = rect.x1 - rect.x0 + 1;
    const size = width * (rect.z1 - rect.z0 + 1);
    const best = new Float32Array(size).fill(Infinity);
    const side = new Float32Array(size);
    const along = new Float32Array(size);
    let start = 0;

    for (let k = 0; k + 1 < line.length; k++) {
        const p = line[k];
        const q = line[k + 1];
        const dx = q.x - p.x;
        const dz = q.z - p.z;
        const len2 = dx * dx + dz * dz;
        const len = Math.sqrt(len2);
        const ga = hf.toGrid(
            Math.min(p.x, q.x) - reach,
            Math.min(p.z, q.z) - reach,
        );
        const gb = hf.toGrid(
            Math.max(p.x, q.x) + reach,
            Math.max(p.z, q.z) + reach,
        );

        for (
            let row = Math.max(rect.z0, Math.floor(ga.gz));
            row <= Math.min(rect.z1, Math.ceil(gb.gz));
            row++
        ) {
            const z = hf.rowToZ(row);

            for (
                let col = Math.max(rect.x0, Math.floor(ga.gx));
                col <= Math.min(rect.x1, Math.ceil(gb.gx));
                col++
            ) {
                const x = hf.colToX(col);
                const t =
                    len2 > 0
                        ? clamp(((x - p.x) * dx + (z - p.z) * dz) / len2, 0, 1)
                        : 0;
                const ex = x - (p.x + dx * t);
                const ez = z - (p.z + dz * t);
                const d = Math.hypot(ex, ez);
                const m = (row - rect.z0) * width + (col - rect.x0);

                if (d < best[m]) {
                    best[m] = d;
                    // Left of travel (x east, z south): cross(direction, offset) < 0.
                    side[m] = dx * ez - dz * ex > 0 ? -d : d;
                    along[m] = start + t * len;
                }
            }
        }

        start += len;
    }

    const out: Corridor = { cells: [], side: [], along: [], rect };

    for (let row = rect.z0; row <= rect.z1; row++) {
        for (let col = rect.x0; col <= rect.x1; col++) {
            const m = (row - rect.z0) * width + (col - rect.x0);

            if (best[m] <= reach) {
                out.cells.push(row * hf.resolution + col);
                out.side.push(side[m]);
                out.along.push(along[m]);
            }
        }
    }

    return out;
}

function cumulative(line: SplinePoint[]): number[] {
    const out = [0];

    for (let k = 1; k < line.length; k++) {
        out.push(
            out[k - 1] +
                Math.hypot(
                    line[k].x - line[k - 1].x,
                    line[k].z - line[k - 1].z,
                ),
        );
    }

    return out;
}

/** Index pair and blend factor for a distance along a line. */
function locate(
    lengths: number[],
    s: number,
): { i: number; j: number; t: number } {
    let lo = 0;
    let hi = lengths.length - 1;

    if (s <= 0 || hi <= 0) {
        return { i: 0, j: 0, t: 0 };
    }

    if (s >= lengths[hi]) {
        return { i: hi, j: hi, t: 0 };
    }

    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;

        if (lengths[mid] <= s) {
            lo = mid;
        } else {
            hi = mid;
        }
    }

    const span = lengths[hi] - lengths[lo];

    return { i: lo, j: hi, t: span > 0 ? (s - lengths[lo]) / span : 0 };
}

function tangent(line: SplinePoint[], k: number): SplinePoint {
    const a = line[Math.max(0, k - 1)];
    const b = line[Math.min(line.length - 1, k + 1)];
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;

    return { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
}

/** Turning per metre at a line point; positive when the line turns towards its left side. */
function signedCurvature(line: SplinePoint[], k: number): number {
    if (k === 0 || k === line.length - 1) {
        return 0;
    }

    const a = line[k - 1];
    const b = line[k];
    const c = line[k + 1];
    const ux = b.x - a.x;
    const uz = b.z - a.z;
    const vx = c.x - b.x;
    const vz = c.z - b.z;
    const angle = Math.atan2(ux * vz - uz * vx, ux * vx + uz * vz);
    const len = (Math.hypot(ux, uz) + Math.hypot(vx, vz)) / 2 || 1;

    // Same convention as the corridor's side: left of travel is where cross(direction, offset) < 0.
    return -angle / len;
}

function boxBlur(values: number[], radius: number): number[] {
    if (radius <= 0 || values.length < 3) {
        return values.slice();
    }

    const prefix = [0];

    for (const v of values) {
        prefix.push(prefix[prefix.length - 1] + v);
    }

    return values.map((_v, k) => {
        const lo = Math.max(0, k - radius);
        const hi = Math.min(values.length - 1, k + radius);

        return (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
    });
}

function steepest(grade: number[], step: number): number {
    let max = 0;

    for (let k = 1; k < grade.length; k++) {
        max = Math.max(max, Math.abs(grade[k] - grade[k - 1]) / step);
    }

    return max;
}

/** 1 at 0, smoothly to 0 at 1. */
function smoothFade(t: number): number {
    if (t <= 0) {
        return 1;
    }

    if (t >= 1) {
        return 0;
    }

    const u = 1 - t;

    return u * u * (3 - 2 * u);
}

function clamp(v: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, v));
}

function clampInt(v: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, v));
}

function round1(v: number): number {
    return Math.round(v * 10) / 10;
}

// ------------------------------------------------------------------------------ base64 typed arrays

function encode(array: Uint32Array | Float32Array | Uint8Array): string {
    const bytes = new Uint8Array(
        array.buffer,
        array.byteOffset,
        array.byteLength,
    );
    let binary = '';

    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }

    return btoa(binary);
}

function decodeBytes(text: string): Uint8Array {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }

    return bytes;
}

function decodeU8(text: string): Uint8Array {
    return decodeBytes(text);
}

function decodeU32(text: string): Uint32Array {
    const bytes = decodeBytes(text);

    return new Uint32Array(bytes.buffer, 0, bytes.byteLength >> 2);
}

function decodeF32(text: string): Float32Array {
    const bytes = decodeBytes(text);

    return new Float32Array(bytes.buffer, 0, bytes.byteLength >> 2);
}
