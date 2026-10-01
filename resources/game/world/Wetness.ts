import * as THREE from 'three/webgpu';
import { claimHeavySlot } from '../core/stagger';
import { NO_WATER } from '../shared/types';
import type { GridRect, Heightfield } from './Heightfield';

/** Metres of water the depth channel covers (G = depth / WATER_DEPTH_RANGE). */
export const WATER_DEPTH_RANGE = 12;

/**
 * Ground state next to and under water, per terrain sample, uploaded as an RGBA8 texture on the splat
 * grid and sampled by the terrain shader:
 *
 * - R: wetness (0..1) of the ground next to water: high right at the waterline and fading with
 *   horizontal distance and height above the water level (darker, glossier soil along shores);
 * - G: depth of the water over the ground (/ WATER_DEPTH_RANGE m, 0 = dry): caustics on shallow beds;
 * - B: puddle potential (0..1): how far the ground lies below its surroundings (local hollows,
 *   from the height minus a blurred height at two radii) on flat, dry ground — where rain collects.
 */
export class Wetness {
    readonly texture: THREE.DataTexture;
    private readonly data: Uint8Array;
    /** Grid rect still to recompute (union of the invalidated ones); null: nothing pending. */
    private pending: GridRect | null = null;
    private timer = 0;

    constructor(
        private readonly heights: Heightfield,
        private readonly water: Heightfield,
        private readonly reach = 7,
        private readonly rise = 1.4,
    ) {
        const res = heights.resolution;
        this.data = new Uint8Array(res * res * 4);
        this.texture = new THREE.DataTexture(
            this.data,
            res,
            res,
            THREE.RGBAFormat,
            THREE.UnsignedByteType,
        );
        this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter;
        this.texture.generateMipmaps = false;
        this.texture.needsUpdate = true;
        this.pending = this.full();
    }

    /** Water or ground changed inside `rect` (grid cells; everything without one). */
    invalidate(rect?: GridRect | null): void {
        const r = rect ?? this.full();
        const p = this.pending;
        this.pending = p
            ? {
                  x0: Math.min(p.x0, r.x0),
                  z0: Math.min(p.z0, r.z0),
                  x1: Math.max(p.x1, r.x1),
                  z1: Math.max(p.z1, r.z1),
              }
            : { ...r };
    }

    /** Recomputes what changed, at most every 0.5 s. */
    update(dt: number): void {
        this.timer -= dt;

        // Shares the frame's heavy-work slot with the other low-rate uploads (see core/stagger).
        if (this.pending && this.timer <= 0 && claimHeavySlot()) {
            this.compute(this.pending);
            this.timer = 0.5;
        }
    }

    /**
     * Recomputes the cells a change inside `rect` can affect (everything by default): wetness reaches
     * `reach` metres from the water and the hollows blur the heights over ~10 m, so only a window that
     * much larger than the edit is recomputed (from a window as much larger again, which keeps the
     * result identical to a full pass).
     */
    compute(rect: GridRect | null = null): void {
        this.pending = null;
        const res = this.heights.resolution;
        const cell = this.heights.cell;
        const maxSteps = Math.max(1, Math.ceil(this.reach / cell));
        const nearRadius = Math.max(1, Math.round(3 / cell));
        const wideRadius = Math.max(2, Math.round(10 / cell));
        const margin = Math.max(maxSteps, wideRadius) + 2;
        const clamp = (v: number) => Math.min(res - 1, Math.max(0, v));
        const r = rect ?? this.full();
        // Output window: everything the change can reach; input window: what those cells read.
        const ox0 = clamp(Math.floor(r.x0) - margin);
        const oz0 = clamp(Math.floor(r.z0) - margin);
        const ox1 = clamp(Math.ceil(r.x1) + margin);
        const oz1 = clamp(Math.ceil(r.z1) + margin);
        const ix0 = clamp(ox0 - margin);
        const iz0 = clamp(oz0 - margin);
        const ix1 = clamp(ox1 + margin);
        const iz1 = clamp(oz1 + margin);
        const w = ix1 - ix0 + 1;
        const hgt = iz1 - iz0 + 1;
        const n = w * hgt;
        const dist = new Float32Array(n).fill(Infinity);
        const level = new Float32Array(n).fill(NO_WATER);
        const heights = new Float32Array(n);
        const water = new Float32Array(n);
        const wd = this.water.data;
        const hd = this.heights.data;
        const out = this.data;

        for (let z = 0; z < hgt; z++) {
            const src = (z + iz0) * res + ix0;
            heights.set(hd.subarray(src, src + w), z * w);
            water.set(wd.subarray(src, src + w), z * w);
        }

        for (let i = 0; i < n; i++) {
            if (water[i] > NO_WATER + 1) {
                dist[i] = 0;
                level[i] = water[i];
            }
        }

        // Two-pass chamfer distance transform, carrying the nearest water level along.
        const diag = Math.SQRT2;
        const relax = (i: number, j: number, cost: number) => {
            if (dist[j] + cost < dist[i]) {
                dist[i] = dist[j] + cost;
                level[i] = level[j];
            }
        };

        for (let z = 0; z < hgt; z++) {
            for (let x = 0; x < w; x++) {
                const i = z * w + x;

                if (x > 0) relax(i, i - 1, 1);
                if (z > 0) relax(i, i - w, 1);
                if (z > 0 && x > 0) relax(i, i - w - 1, diag);
                if (z > 0 && x < w - 1) relax(i, i - w + 1, diag);
            }
        }

        for (let z = hgt - 1; z >= 0; z--) {
            for (let x = w - 1; x >= 0; x--) {
                const i = z * w + x;

                if (x < w - 1) relax(i, i + 1, 1);
                if (z < hgt - 1) relax(i, i + w, 1);
                if (z < hgt - 1 && x < w - 1) relax(i, i + w + 1, diag);
                if (z < hgt - 1 && x > 0) relax(i, i + w - 1, diag);
            }
        }

        const near = boxBlur(heights, w, hgt, nearRadius);
        const wide = boxBlur(heights, w, hgt, wideRadius);
        // Depth below the surroundings that counts as a full hollow (m).
        const full = 0.35;

        for (let gz = oz0; gz <= oz1; gz++) {
            for (let gx = ox0; gx <= ox1; gx++) {
                const x = gx - ix0;
                const z = gz - iz0;
                const i = z * w + x;
                const o = (gz * res + gx) * 4;
                const d = dist[i];
                let wet = 0;

                if (d <= maxSteps) {
                    const above = heights[i] - level[i];
                    const close = 1 - (d * cell) / this.reach;
                    const low =
                        1 -
                        Math.min(1, Math.max(0, (above - 0.15) / this.rise));
                    wet = Math.max(0, Math.min(1, close * low));
                }

                out[o] = Math.round(wet * 255);
                const wet0 = water[i] > NO_WATER + 1;
                const depth = wet0 ? Math.max(0, water[i] - heights[i]) : 0;
                out[o + 1] = Math.round(
                    Math.min(1, depth / WATER_DEPTH_RANGE) * 255,
                );

                // Puddle potential (B): local hollows on flat, dry ground.
                if (wet0) {
                    out[o + 2] = 0;
                    continue;
                }

                const l = heights[z * w + Math.max(0, x - 1)];
                const rr = heights[z * w + Math.min(w - 1, x + 1)];
                const u = heights[Math.max(0, z - 1) * w + x];
                const dn = heights[Math.min(hgt - 1, z + 1) * w + x];
                const slope = Math.hypot(rr - l, dn - u) / (2 * cell);
                // Water runs off slopes steeper than ~6-11°.
                const flat = 1 - smooth(0.1, 0.2, slope);
                const hollow = Math.max(
                    near[i] - heights[i],
                    (wide[i] - heights[i]) * 0.6,
                );
                const v = Math.max(0, Math.min(1, hollow / full)) * flat;
                out[o + 2] = Math.round(v * 255);
            }
        }

        this.texture.needsUpdate = true;
    }

    dispose(): void {
        this.texture.dispose();
    }

    private full(): GridRect {
        const last = this.heights.resolution - 1;

        return { x0: 0, z0: 0, x1: last, z1: last };
    }
}

function smooth(a: number, b: number, x: number): number {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));

    return t * t * (3 - 2 * t);
}

/** Separable box blur of a w × h grid with clamped edges (running sums, O(n) per radius). */
function boxBlur(
    src: Float32Array,
    w: number,
    h: number,
    radius: number,
): Float32Array {
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    const width = radius * 2 + 1;
    const atX = (v: number) => Math.min(w - 1, Math.max(0, v));
    const atZ = (v: number) => Math.min(h - 1, Math.max(0, v));

    for (let r = 0; r < h; r++) {
        const row = r * w;
        let sum = 0;

        for (let k = -radius; k <= radius; k++) {
            sum += src[row + atX(k)];
        }

        for (let c = 0; c < w; c++) {
            tmp[row + c] = sum / width;
            sum += src[row + atX(c + radius + 1)] - src[row + atX(c - radius)];
        }
    }

    for (let c = 0; c < w; c++) {
        let sum = 0;

        for (let k = -radius; k <= radius; k++) {
            sum += tmp[atZ(k) * w + c];
        }

        for (let r = 0; r < h; r++) {
            out[r * w + c] = sum / width;
            sum +=
                tmp[atZ(r + radius + 1) * w + c] - tmp[atZ(r - radius) * w + c];
        }
    }

    return out;
}
