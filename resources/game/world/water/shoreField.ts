import { NO_WATER } from '../../shared/types';
import type { GridRect, Heightfield } from '../Heightfield';
import type { WaterSurfaceData } from './WaterSurfaceData';

/** How far from the shoreline the field reaches (m): the surf zone and the swash on the sand. */
export const SHORE_REACH = 150;

/** Beach slopes (rise / run) that surf breaks on fully, and above which it fades out (cliffs). */
export const GENTLE_SLOPE = 0.1;
export const STEEP_SLOPE = 0.32;

const isWet = (v: number) => v > NO_WATER + 1;

/** Painted surf strength (surf.u8: 0 = automatic, 1-255 = painted 0-1). */
export function paintedStrength(v: number): number | null {
    return v === 0 ? null : (v - 1) / 254;
}

export function encodePainted(strength: number | null): number {
    return strength === null
        ? 0
        : 1 + Math.round(Math.min(1, Math.max(0, strength)) * 254);
}

/** Surf from the body flag and the beach slope (auto), or the painted strength (gentler on steep shores). */
export function shoreStrength(
    bodySurf: boolean,
    painted: number | null,
    slope: number,
): number {
    const t = Math.min(
        1,
        Math.max(0, (STEEP_SLOPE - slope) / (STEEP_SLOPE - GENTLE_SLOPE)),
    );
    const beach = t * t * (3 - 2 * t);

    return painted === null
        ? bodySurf
            ? beach
            : 0
        : painted * (0.4 + 0.6 * beach);
}

/**
 * Distance to the nearest shoreline for every sample of the water data grid (WaterSurfaceData), on
 * both sides of it, within SHORE_REACH:
 *
 * - `dist` (m): positive in the water, negative on land; the shoreline is placed between a wet and a
 *   dry sample where the still level meets the ground (sub-sample);
 * - `dirX/dirZ`: the direction waves travel there (towards the shore in the water, on up the beach
 *   on land) — crests run perpendicular to it, so they bend parallel to the coast;
 * - per sample, the nearest shore point's still level, beach slope, water sample (→ body) and painted
 *   surf (surf.u8 there).
 *
 * Seeds are the wet/dry crossings, spread by vector propagation (two raster sweeps each way, ~exact
 * Euclidean). Recomputed in a window around each edit (the reach plus a margin).
 */
export class ShoreField {
    readonly size: number;
    readonly spacing: number;
    readonly dist: Float32Array;
    readonly dirX: Float32Array;
    readonly dirZ: Float32Array;
    readonly level: Float32Array;
    readonly slope: Float32Array;
    /** Data-grid index of the nearest shore's wet sample (-1: none within reach). */
    readonly wetIndex: Int32Array;
    /** Painted surf at the nearest shore (-1 = automatic). */
    readonly paint: Float32Array;

    constructor(
        private readonly data: WaterSurfaceData,
        private readonly surface: Heightfield,
        private readonly terrain: Heightfield,
        /** Painted surf per full-resolution sample (surf.u8). */
        readonly mask: Uint8Array,
    ) {
        const n = data.size;
        this.size = n;
        this.spacing = data.spacing;
        this.dist = new Float32Array(n * n).fill(-SHORE_REACH);
        this.dirX = new Float32Array(n * n);
        this.dirZ = new Float32Array(n * n);
        this.level = new Float32Array(n * n);
        this.slope = new Float32Array(n * n);
        this.wetIndex = new Int32Array(n * n).fill(-1);
        this.paint = new Float32Array(n * n).fill(-1);
    }

    /** Samples (data grid, inclusive) whose values change after an edit of `rect` (full-res grid). */
    affected(rect?: GridRect): {
        i0: number;
        j0: number;
        i1: number;
        j1: number;
    } {
        const n = this.size;

        if (!rect) {
            return { i0: 0, j0: 0, i1: n - 1, j1: n - 1 };
        }

        const s = this.data.step;
        const reach = Math.ceil(SHORE_REACH / this.spacing) + 2;

        return {
            i0: Math.max(0, Math.floor(rect.x0 / s) - reach),
            j0: Math.max(0, Math.floor(rect.z0 / s) - reach),
            i1: Math.min(n - 1, Math.ceil(rect.x1 / s) + reach),
            j1: Math.min(n - 1, Math.ceil(rect.z1 / s) + reach),
        };
    }

    /**
     * The beach slope sets the travel time of the crests (τ ∝ 1/√slope): seed to seed noise would
     * break the crest lines up, so it is averaged over ~±12 m (separable box blur over the samples
     * that have a shore).
     */
    private smoothSlope(out: {
        i0: number;
        j0: number;
        i1: number;
        j1: number;
    }): void {
        const n = this.size;
        const r = Math.max(1, Math.round(12 / this.spacing));
        const w = out.i1 - out.i0 + 1;
        const h = out.j1 - out.j0 + 1;
        const tmp = new Float32Array(w * h);
        const has = (g: number) => this.wetIndex[g] >= 0;

        for (let j = 0; j < h; j++) {
            for (let i = 0; i < w; i++) {
                let sum = 0;
                let count = 0;

                for (let d = -r; d <= r; d++) {
                    const ii = out.i0 + i + d;

                    if (ii >= 0 && ii < n) {
                        const g = (out.j0 + j) * n + ii;

                        if (has(g)) {
                            sum += this.slope[g];
                            count++;
                        }
                    }
                }

                tmp[j * w + i] = count ? sum / count : 1;
            }
        }

        for (let j = 0; j < h; j++) {
            for (let i = 0; i < w; i++) {
                const g = (out.j0 + j) * n + out.i0 + i;

                if (!has(g)) {
                    continue;
                }

                let sum = 0;
                let count = 0;

                for (let d = -r; d <= r; d++) {
                    const jj = j + d;

                    if (
                        jj >= 0 &&
                        jj < h &&
                        has((out.j0 + jj) * n + out.i0 + i)
                    ) {
                        sum += tmp[jj * w + i];
                        count++;
                    }
                }

                this.slope[g] = count ? sum / count : this.slope[g];
            }
        }
    }

    /** Recomputes the field after a water / terrain / surf paint edit of `rect` (full-res grid; all if absent). */
    update(rect?: GridRect): {
        i0: number;
        j0: number;
        i1: number;
        j1: number;
    } {
        const n = this.size;
        const out = this.affected(rect);
        const reach = Math.ceil(SHORE_REACH / this.spacing) + 2;
        // Seeds come from a window one reach wider than the samples written.
        const wi0 = Math.max(0, out.i0 - reach);
        const wj0 = Math.max(0, out.j0 - reach);
        const wi1 = Math.min(n - 1, out.i1 + reach);
        const wj1 = Math.min(n - 1, out.j1 + reach);
        const w = wi1 - wi0 + 1;
        const h = wj1 - wj0 + 1;
        const sp = this.spacing;
        const half = this.surface.half;
        const s = this.data.step;
        const wet = new Uint8Array(w * h);

        for (let j = 0; j < h; j++) {
            for (let i = 0; i < w; i++) {
                wet[j * w + i] = isWet(
                    this.surface.get((wi0 + i) * s, (wj0 + j) * s),
                )
                    ? 1
                    : 0;
            }
        }

        // Seeds: (x, z) of the crossing, normal (wet → dry), level, slope, wet sample, paint.
        const seeds: number[] = [];
        const best = new Int32Array(w * h).fill(-1);
        const bestD = new Float32Array(w * h).fill(Infinity);
        const px = (i: number) => (wi0 + i) * sp - half;
        const pz = (j: number) => (wj0 + j) * sp - half;
        const consider = (k: number, seed: number) => {
            const i = k % w;
            const j = (k - i) / w;
            const dx = px(i) - seeds[seed * 8];
            const dz = pz(j) - seeds[seed * 8 + 1];
            const d = dx * dx + dz * dz;

            if (d < bestD[k]) {
                bestD[k] = d;
                best[k] = seed;
            }
        };
        const res = this.surface.resolution;
        const addSeed = (a: number, b: number, ax: number, az: number) => {
            // a wet, b dry (window indices); (ax, az) unit step from a to b.
            const ia = a % w;
            const ja = (a - ia) / w;
            const ga = (wj0 + ja) * n + wi0 + ia;
            const level = this.data.level[ga];
            const depth = Math.max(
                0,
                level - this.terrain.sample(px(ia), pz(ja)),
            );
            const ib = b % w;
            const jb = (b - ib) / w;
            const above = this.terrain.sample(px(ib), pz(jb)) - level;
            const t =
                above > 0
                    ? Math.min(1, Math.max(0, depth / (depth + above)))
                    : 0.5;
            const x = px(ia) + ax * sp * t;
            const z = pz(ja) + az * sp * t;
            // Beach slope across the shoreline and out over the surf zone.
            const T = (d: number) =>
                this.terrain.sample(x + ax * d, z + az * d);
            const local = Math.abs(T(3) - T(-3)) / 6;
            const seaward = Math.max(0, level - T(-14)) / 14;
            const slope = local * 0.6 + seaward * 0.4;
            const c = Math.min(
                res - 1,
                Math.max(0, Math.round((x + half) / this.surface.cell)),
            );
            const r = Math.min(
                res - 1,
                Math.max(0, Math.round((z + half) / this.surface.cell)),
            );
            const painted = paintedStrength(this.mask[r * res + c]);
            const id = seeds.length / 8;
            seeds.push(x, z, ax, az, level, slope, ga, painted ?? -1);
            consider(a, id);
            consider(b, id);
        };

        for (let j = 0; j < h; j++) {
            for (let i = 0; i < w; i++) {
                const k = j * w + i;

                if (i + 1 < w && wet[k] !== wet[k + 1]) {
                    if (wet[k]) {
                        addSeed(k, k + 1, 1, 0);
                    } else {
                        addSeed(k + 1, k, -1, 0);
                    }
                }

                if (j + 1 < h && wet[k] !== wet[k + w]) {
                    if (wet[k]) {
                        addSeed(k, k + w, 0, 1);
                    } else {
                        addSeed(k + w, k, 0, -1);
                    }
                }
            }
        }

        // Vector propagation: each sample takes a neighbour's seed when that one is nearer.
        const sweep = (forward: boolean) => {
            const offsets = forward
                ? [
                      [-1, 0],
                      [0, -1],
                      [-1, -1],
                      [1, -1],
                  ]
                : [
                      [1, 0],
                      [0, 1],
                      [1, 1],
                      [-1, 1],
                  ];

            for (let jj = 0; jj < h; jj++) {
                const j = forward ? jj : h - 1 - jj;

                for (let ii = 0; ii < w; ii++) {
                    const i = forward ? ii : w - 1 - ii;
                    const k = j * w + i;

                    for (const [dx, dz] of offsets) {
                        const ni = i + dx;
                        const nj = j + dz;

                        if (ni < 0 || nj < 0 || ni >= w || nj >= h) {
                            continue;
                        }

                        const seed = best[nj * w + ni];

                        if (seed >= 0 && seed !== best[k]) {
                            consider(k, seed);
                        }
                    }
                }
            }
        };

        if (seeds.length) {
            sweep(true);
            sweep(false);
            sweep(true);
            sweep(false);
        }

        for (let j = out.j0; j <= out.j1; j++) {
            for (let i = out.i0; i <= out.i1; i++) {
                const g = j * n + i;
                const k = (j - wj0) * w + (i - wi0);
                const seed = best[k];
                const d = Math.sqrt(bestD[k]);
                const sign = wet[k] ? 1 : -1;

                if (seed < 0 || d > SHORE_REACH) {
                    this.dist[g] = sign * SHORE_REACH;
                    this.dirX[g] = 0;
                    this.dirZ[g] = 0;
                    this.level[g] = this.data.level[g];
                    this.slope[g] = 1;
                    this.wetIndex[g] = -1;
                    this.paint[g] = -1;
                    continue;
                }

                const o = seed * 8;
                // Travel direction: towards the seed in the water, away from it on land; the shore
                // normal right at the shoreline (no direction there).
                let dx = (seeds[o] - px(i - wi0)) * sign;
                let dz = (seeds[o + 1] - pz(j - wj0)) * sign;
                const len = Math.hypot(dx, dz);
                const blend = Math.min(1, len / (sp * 1.5));
                dx =
                    (len > 1e-4 ? dx / len : 0) * blend +
                    seeds[o + 2] * (1 - blend);
                dz =
                    (len > 1e-4 ? dz / len : 0) * blend +
                    seeds[o + 3] * (1 - blend);
                const dl = Math.hypot(dx, dz) || 1;
                this.dist[g] = sign * d;
                this.dirX[g] = dx / dl;
                this.dirZ[g] = dz / dl;
                this.level[g] = seeds[o + 4];
                this.slope[g] = seeds[o + 5];
                this.wetIndex[g] = seeds[o + 6];
                this.paint[g] = seeds[o + 7];
            }
        }

        this.smoothSlope(out);

        return out;
    }
}
