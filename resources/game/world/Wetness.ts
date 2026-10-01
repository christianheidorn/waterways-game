import * as THREE from 'three/webgpu';
import { NO_WATER } from '../shared/types';
import type { Heightfield } from './Heightfield';

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
    private dirty = true;
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
    }

    invalidate(): void {
        this.dirty = true;
    }

    /** Recomputes at most every 0.5 s while dirty. */
    update(dt: number): void {
        this.timer -= dt;

        if (this.dirty && this.timer <= 0) {
            this.compute();
            this.timer = 0.5;
        }
    }

    compute(): void {
        this.dirty = false;
        const res = this.heights.resolution;
        const n = res * res;
        const cell = this.heights.cell;
        const maxSteps = Math.max(1, Math.ceil(this.reach / cell));
        const dist = new Float32Array(n).fill(Infinity);
        const level = new Float32Array(n).fill(NO_WATER);
        const w = this.water.data;
        const h = this.heights.data;
        const out = this.data;

        for (let i = 0; i < n; i++) {
            if (w[i] > NO_WATER + 1) {
                dist[i] = 0;
                level[i] = w[i];
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

        for (let r = 0; r < res; r++) {
            for (let c = 0; c < res; c++) {
                const i = r * res + c;

                if (c > 0) relax(i, i - 1, 1);
                if (r > 0) relax(i, i - res, 1);
                if (r > 0 && c > 0) relax(i, i - res - 1, diag);
                if (r > 0 && c < res - 1) relax(i, i - res + 1, diag);
            }
        }

        for (let r = res - 1; r >= 0; r--) {
            for (let c = res - 1; c >= 0; c--) {
                const i = r * res + c;

                if (c < res - 1) relax(i, i + 1, 1);
                if (r < res - 1) relax(i, i + res, 1);
                if (r < res - 1 && c < res - 1) relax(i, i + res + 1, diag);
                if (r < res - 1 && c > 0) relax(i, i + res - 1, diag);
            }
        }

        for (let i = 0; i < n; i++) {
            const d = dist[i];
            let wet = 0;

            if (d <= maxSteps) {
                const above = h[i] - level[i];
                const near = 1 - (d * cell) / this.reach;
                const low =
                    1 - Math.min(1, Math.max(0, (above - 0.15) / this.rise));
                wet = Math.max(0, Math.min(1, near * low));
            }

            out[i * 4] = Math.round(wet * 255);
            const depth = w[i] > NO_WATER + 1 ? Math.max(0, w[i] - h[i]) : 0;
            out[i * 4 + 1] = Math.round(
                Math.min(1, depth / WATER_DEPTH_RANGE) * 255,
            );
        }

        this.computeHollows();
        this.texture.needsUpdate = true;
    }

    dispose(): void {
        this.texture.dispose();
    }

    /** Puddle potential (B): local hollows on flat, dry ground. */
    private computeHollows(): void {
        const res = this.heights.resolution;
        const cell = this.heights.cell;
        const h = this.heights.data;
        const w = this.water.data;
        const out = this.data;
        const near = boxBlur(h, res, Math.max(1, Math.round(3 / cell)));
        const wide = boxBlur(h, res, Math.max(2, Math.round(10 / cell)));
        // Depth below the surroundings that counts as a full hollow (m).
        const full = 0.35;

        for (let r = 0; r < res; r++) {
            for (let c = 0; c < res; c++) {
                const i = r * res + c;

                if (w[i] > NO_WATER + 1) {
                    out[i * 4 + 2] = 0;
                    continue;
                }

                const l = h[r * res + Math.max(0, c - 1)];
                const rr = h[r * res + Math.min(res - 1, c + 1)];
                const u = h[Math.max(0, r - 1) * res + c];
                const d = h[Math.min(res - 1, r + 1) * res + c];
                const slope = Math.hypot(rr - l, d - u) / (2 * cell);
                // Water runs off slopes steeper than ~6-11°.
                const flat = 1 - smooth(0.1, 0.2, slope);
                const hollow = Math.max(near[i] - h[i], (wide[i] - h[i]) * 0.6);
                const v = Math.max(0, Math.min(1, hollow / full)) * flat;
                out[i * 4 + 2] = Math.round(v * 255);
            }
        }
    }
}

function smooth(a: number, b: number, x: number): number {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));

    return t * t * (3 - 2 * t);
}

/** Separable box blur with clamped edges (running sums, O(n) per radius). */
function boxBlur(src: Float32Array, res: number, radius: number): Float32Array {
    const tmp = new Float32Array(res * res);
    const out = new Float32Array(res * res);
    const width = radius * 2 + 1;
    const at = (v: number) => Math.min(res - 1, Math.max(0, v));

    for (let r = 0; r < res; r++) {
        const row = r * res;
        let sum = 0;

        for (let k = -radius; k <= radius; k++) {
            sum += src[row + at(k)];
        }

        for (let c = 0; c < res; c++) {
            tmp[row + c] = sum / width;
            sum += src[row + at(c + radius + 1)] - src[row + at(c - radius)];
        }
    }

    for (let c = 0; c < res; c++) {
        let sum = 0;

        for (let k = -radius; k <= radius; k++) {
            sum += tmp[at(k) * res + c];
        }

        for (let r = 0; r < res; r++) {
            out[r * res + c] = sum / width;
            sum +=
                tmp[at(r + radius + 1) * res + c] -
                tmp[at(r - radius) * res + c];
        }
    }

    return out;
}
