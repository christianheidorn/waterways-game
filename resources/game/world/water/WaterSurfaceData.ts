import * as THREE from 'three/webgpu';
import { NO_WATER } from '../../shared/types';
import type { GridRect, Heightfield } from '../Heightfield';

const isWet = (v: number) => v > NO_WATER + 1;

/**
 * The water grid resampled at the water mesh resolution (every `step`-th sample), as CPU arrays and GPU
 * textures shared by every water mesh (map chunks, the camera-centred fine mesh, the ocean ring):
 *
 * - levelTexture (RG32F): surface level per sample (extrapolated under the shore from the lowest wet
 *   neighbour, so the surface tucks under the land) and the cell mask (1 where the cell whose lower corner
 *   is this sample is drawn: some corner wet, no level jump bigger than the wall limit);
 * - dataTexture (RGBA16F): water depth (m), flow (x, z) and the water body row (see WaterBodies).
 *
 * Shading reads depth / flow / body per pixel from here, so the fine mesh needs no per-vertex data.
 */
export class WaterSurfaceData {
    /** Samples per side. */
    readonly size: number;
    readonly spacing: number;
    readonly level: Float32Array;
    readonly mask: Uint8Array;
    readonly depth: Float32Array;
    readonly flow: Float32Array;
    readonly body: Uint8Array;
    readonly wallLimit: number;
    readonly levelTexture: THREE.DataTexture;
    readonly dataTexture: THREE.DataTexture;
    private readonly levelPixels: Float32Array;
    private readonly dataPixels: Uint16Array;

    constructor(
        readonly surface: Heightfield,
        readonly terrain: Heightfield,
        readonly step: number,
    ) {
        const n = (surface.resolution - 1) / step + 1;
        this.size = n;
        this.spacing = surface.cell * step;
        this.wallLimit = Math.max(1.5, this.spacing * 0.5);
        this.level = new Float32Array(n * n);
        this.mask = new Uint8Array(n * n);
        this.depth = new Float32Array(n * n);
        this.flow = new Float32Array(n * n * 2);
        this.body = new Uint8Array(n * n);
        this.levelPixels = new Float32Array(n * n * 2);
        this.dataPixels = new Uint16Array(n * n * 4);

        this.levelTexture = new THREE.DataTexture(
            this.levelPixels,
            n,
            n,
            THREE.RGFormat,
            THREE.FloatType,
        );
        this.levelTexture.minFilter = this.levelTexture.magFilter =
            THREE.NearestFilter;
        this.levelTexture.generateMipmaps = false;
        this.levelTexture.name = 'Water level';
        this.dataTexture = new THREE.DataTexture(
            this.dataPixels,
            n,
            n,
            THREE.RGBAFormat,
            THREE.HalfFloatType,
        );
        this.dataTexture.minFilter = this.dataTexture.magFilter =
            THREE.LinearFilter;
        this.dataTexture.generateMipmaps = false;
        this.dataTexture.name = 'Water data';
    }

    /** World x / z of a sample. */
    x(i: number): number {
        return this.surface.colToX(i * this.step);
    }

    z(j: number): number {
        return this.surface.rowToZ(j * this.step);
    }

    /** Recomputes the samples covering a rect of the full-resolution water grid (+ a margin). */
    update(rect: GridRect, riverFlow: Float32Array | null): void {
        const s = this.step;
        const n = this.size;
        const hf = this.surface;
        const res = hf.resolution;
        const i0 = Math.max(0, Math.floor(rect.x0 / s) - 2);
        const j0 = Math.max(0, Math.floor(rect.z0 / s) - 2);
        const i1 = Math.min(n - 1, Math.ceil(rect.x1 / s) + 2);
        const j1 = Math.min(n - 1, Math.ceil(rect.z1 / s) + 2);
        const wet = new Uint8Array((i1 - i0 + 1) * (j1 - j0 + 1));

        for (let j = j0; j <= j1; j++) {
            for (let i = i0; i <= i1; i++) {
                const c = i * s;
                const r = j * s;
                const k = j * n + i;
                let h = hf.get(c, r);
                const w = isWet(h);

                if (!w) {
                    // Extrapolate from the lowest wet neighbour so the surface tucks under the shore
                    // without climbing up towards a higher neighbouring pool.
                    let lowest = Infinity;

                    for (let dz = -s; dz <= s; dz += s) {
                        for (let dx = -s; dx <= s; dx += s) {
                            const v = hf.get(c + dx, r + dz);

                            if (isWet(v)) {
                                lowest = Math.min(lowest, v);
                            }
                        }
                    }

                    h = Number.isFinite(lowest)
                        ? lowest
                        : this.terrain.get(c, r) - 2;
                }

                wet[(j - j0) * (i1 - i0 + 1) + (i - i0)] = w ? 1 : 0;
                this.level[k] = h;
                this.depth[k] = w ? Math.max(0, h - this.terrain.get(c, r)) : 0;
            }
        }

        const wetAt = (i: number, j: number) => {
            if (i >= i0 && i <= i1 && j >= j0 && j <= j1) {
                return wet[(j - j0) * (i1 - i0 + 1) + (i - i0)] === 1;
            }

            return isWet(
                hf.get(Math.min(n - 1, i) * s, Math.min(n - 1, j) * s),
            );
        };

        for (let j = j0; j <= j1; j++) {
            for (let i = i0; i <= i1; i++) {
                const k = j * n + i;
                // Cell mask (this sample is the cell's lower corner).
                let drawn = 0;

                if (i < n - 1 && j < n - 1) {
                    const a = this.level[k];
                    const b = this.level[k + 1];
                    const c = this.level[k + n];
                    const d = this.level[k + n + 1];
                    const any =
                        wetAt(i, j) ||
                        wetAt(i + 1, j) ||
                        wetAt(i, j + 1) ||
                        wetAt(i + 1, j + 1);
                    const spread = Math.max(a, b, c, d) - Math.min(a, b, c, d);
                    drawn = any && spread <= this.wallLimit ? 1 : 0;
                }

                this.mask[k] = drawn;

                // Flow: the river splines (downstream along the course), elsewhere the downhill surface
                // gradient; on a river a steep run speeds the current up.
                const l = this.level[j * n + Math.max(0, i - 1)];
                const rr = this.level[j * n + Math.min(n - 1, i + 1)];
                const u = this.level[Math.max(0, j - 1) * n + i];
                const dd = this.level[Math.min(n - 1, j + 1) * n + i];
                const gx = (l - rr) / (2 * this.spacing);
                const gz = (u - dd) / (2 * this.spacing);
                const mag = Math.hypot(gx, gz);
                const speed = Math.min(1, mag * 40);
                let fx = mag > 1e-5 && mag < 2 ? (gx / mag) * speed : 0;
                let fz = mag > 1e-5 && mag < 2 ? (gz / mag) * speed : 0;

                if (riverFlow) {
                    const g =
                        Math.min(res - 1, j * s) * res +
                        Math.min(res - 1, i * s);
                    const rx = riverFlow[g * 2];
                    const rz = riverFlow[g * 2 + 1];
                    const base = Math.hypot(rx, rz);

                    if (base > 1e-5) {
                        const total = Math.min(1, Math.max(base, speed));
                        fx = (rx / base) * total;
                        fz = (rz / base) * total;
                    }
                }

                this.flow[k * 2] = fx;
                this.flow[k * 2 + 1] = fz;
            }
        }

        this.upload(i0, j0, i1, j1);
    }

    /** Body row per sample (labels: full-resolution body label + 1, 0 = dry; rows: label → texture row). */
    setBodies(labels: Int32Array, rowOf: (label: number) => number): void {
        const n = this.size;
        const s = this.step;
        const res = this.surface.resolution;

        for (let j = 0; j < n; j++) {
            for (let i = 0; i < n; i++) {
                const c = i * s;
                const r = j * s;
                let label = labels[r * res + c];

                // Dry samples under the shore take a wet neighbour's body.
                for (let d = 1; label === 0 && d <= s * 2; d++) {
                    for (const [dx, dz] of [
                        [d, 0],
                        [-d, 0],
                        [0, d],
                        [0, -d],
                        [d, d],
                        [-d, -d],
                        [d, -d],
                        [-d, d],
                    ]) {
                        const cc = c + dx;
                        const rr = r + dz;

                        if (
                            cc >= 0 &&
                            rr >= 0 &&
                            cc < res &&
                            rr < res &&
                            labels[rr * res + cc] > 0
                        ) {
                            label = labels[rr * res + cc];
                            break;
                        }
                    }
                }

                this.body[j * n + i] = label > 0 ? rowOf(label) : 0;
            }
        }

        this.upload(0, 0, n - 1, n - 1);
    }

    /** Bilinear water depth (m) at a world position (0 outside the water). */
    depthAt(x: number, z: number): number {
        return this.bilinear(this.depth, x, z, 1, 0);
    }

    /** Flow (x, z, 0-1 speed) at a world position. */
    flowAt(
        x: number,
        z: number,
        out: { x: number; z: number },
    ): { x: number; z: number } {
        out.x = this.bilinear(this.flow, x, z, 2, 0);
        out.z = this.bilinear(this.flow, x, z, 2, 1);

        return out;
    }

    /** Body row at a world position (nearest sample). */
    bodyRowAt(x: number, z: number): number {
        const n = this.size;
        const i = Math.round((x + this.surface.half) / this.spacing);
        const j = Math.round((z + this.surface.half) / this.spacing);

        return i < 0 || j < 0 || i >= n || j >= n ? 0 : this.body[j * n + i];
    }

    private bilinear(
        arr: Float32Array,
        x: number,
        z: number,
        stride: number,
        offset: number,
    ): number {
        const n = this.size;
        const gx = Math.min(
            n - 1.0001,
            Math.max(0, (x + this.surface.half) / this.spacing),
        );
        const gz = Math.min(
            n - 1.0001,
            Math.max(0, (z + this.surface.half) / this.spacing),
        );
        const i = Math.floor(gx);
        const j = Math.floor(gz);
        const fx = gx - i;
        const fz = gz - j;
        const at = (a: number, b: number) => arr[(b * n + a) * stride + offset];

        return (
            (at(i, j) * (1 - fx) + at(i + 1, j) * fx) * (1 - fz) +
            (at(i, j + 1) * (1 - fx) + at(i + 1, j + 1) * fx) * fz
        );
    }

    private upload(i0: number, j0: number, i1: number, j1: number): void {
        const n = this.size;
        const half = (v: number) => THREE.DataUtils.toHalfFloat(v);

        for (let j = j0; j <= j1; j++) {
            for (let i = i0; i <= i1; i++) {
                const k = j * n + i;
                this.levelPixels[k * 2] = this.level[k];
                this.levelPixels[k * 2 + 1] = this.mask[k];
                this.dataPixels[k * 4] = half(Math.min(60000, this.depth[k]));
                this.dataPixels[k * 4 + 1] = half(this.flow[k * 2]);
                this.dataPixels[k * 4 + 2] = half(this.flow[k * 2 + 1]);
                this.dataPixels[k * 4 + 3] = half(this.body[k]);
            }
        }

        this.levelTexture.needsUpdate = true;
        this.dataTexture.needsUpdate = true;
    }

    dispose(): void {
        this.levelTexture.dispose();
        this.dataTexture.dispose();
    }
}
