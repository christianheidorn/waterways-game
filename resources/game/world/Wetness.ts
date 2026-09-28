import * as THREE from 'three/webgpu';
import { NO_WATER } from '../shared/types';
import type { Heightfield } from './Heightfield';

/**
 * Per-sample wetness (0..1) of the ground next to water: high right at the waterline and fading
 * with horizontal distance and height above the water level. Uploaded as an R8 texture sampled
 * by the terrain shader (darker, glossier soil along shores and riverbanks).
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
        this.data = new Uint8Array(res * res);
        this.texture = new THREE.DataTexture(
            this.data,
            res,
            res,
            THREE.RedFormat,
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

        const h = this.heights.data;

        for (let i = 0; i < n; i++) {
            const d = dist[i];

            if (d > maxSteps) {
                this.data[i] = 0;
                continue;
            }

            const above = h[i] - level[i];
            const near = 1 - (d * cell) / this.reach;
            const low =
                1 - Math.min(1, Math.max(0, (above - 0.15) / this.rise));
            this.data[i] = Math.round(
                Math.max(0, Math.min(1, near * low)) * 255,
            );
        }

        this.texture.needsUpdate = true;
    }

    dispose(): void {
        this.texture.dispose();
    }
}
