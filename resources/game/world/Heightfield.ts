import * as THREE from 'three';

export type GridRect = { x0: number; z0: number; x1: number; z1: number };

/**
 * A square grid of floating point samples covering the map (heights, water levels, …).
 * See shared/types.ts for the world ↔ grid conventions.
 */
export class Heightfield {
    readonly resolution: number;
    readonly size: number;
    readonly cell: number;
    readonly half: number;
    readonly data: Float32Array;

    constructor(resolution: number, size: number, data?: Float32Array) {
        this.resolution = resolution;
        this.size = size;
        this.cell = size / (resolution - 1);
        this.half = size / 2;
        this.data = data ?? new Float32Array(resolution * resolution);

        if (this.data.length !== resolution * resolution) {
            throw new Error(
                `Heightfield data has ${this.data.length} samples, expected ${resolution * resolution}`,
            );
        }
    }

    index(col: number, row: number): number {
        return row * this.resolution + col;
    }

    get(col: number, row: number): number {
        const r = this.resolution - 1;
        const c = col < 0 ? 0 : col > r ? r : col;
        const w = row < 0 ? 0 : row > r ? r : row;

        return this.data[w * this.resolution + c];
    }

    set(col: number, row: number, value: number): void {
        this.data[row * this.resolution + col] = value;
    }

    /** World X/Z → fractional grid coordinates. */
    toGrid(x: number, z: number): { gx: number; gz: number } {
        return {
            gx: (x + this.half) / this.cell,
            gz: (z + this.half) / this.cell,
        };
    }

    colToX(col: number): number {
        return col * this.cell - this.half;
    }

    rowToZ(row: number): number {
        return row * this.cell - this.half;
    }

    contains(x: number, z: number): boolean {
        return Math.abs(x) <= this.half && Math.abs(z) <= this.half;
    }

    /** Bilinearly interpolated sample at world X/Z (clamped to the map edge). */
    sample(x: number, z: number): number {
        const max = this.resolution - 1;
        let gx = (x + this.half) / this.cell;
        let gz = (z + this.half) / this.cell;
        gx = gx < 0 ? 0 : gx > max ? max : gx;
        gz = gz < 0 ? 0 : gz > max ? max : gz;

        const c0 = Math.min(Math.floor(gx), max - 1);
        const r0 = Math.min(Math.floor(gz), max - 1);
        const fx = gx - c0;
        const fz = gz - r0;
        const i = r0 * this.resolution + c0;
        const d = this.data;
        const h00 = d[i];
        const h10 = d[i + 1];
        const h01 = d[i + this.resolution];
        const h11 = d[i + this.resolution + 1];

        return (
            (h00 * (1 - fx) + h10 * fx) * (1 - fz) +
            (h01 * (1 - fx) + h11 * fx) * fz
        );
    }

    /** Surface normal at world X/Z. */
    normal(x: number, z: number, target = new THREE.Vector3()): THREE.Vector3 {
        const e = this.cell;
        const hl = this.sample(x - e, z);
        const hr = this.sample(x + e, z);
        const hd = this.sample(x, z - e);
        const hu = this.sample(x, z + e);

        return target.set(hl - hr, 2 * e, hd - hu).normalize();
    }

    /** Normal at an exact grid sample (central differences), written into out[offset..offset+2]. */
    normalAtSample(
        col: number,
        row: number,
        out: Float32Array | number[],
        offset: number,
    ): void {
        const hl = this.get(col - 1, row);
        const hr = this.get(col + 1, row);
        const hd = this.get(col, row - 1);
        const hu = this.get(col, row + 1);
        const nx = hl - hr;
        const ny = 2 * this.cell;
        const nz = hd - hu;
        const len = Math.hypot(nx, ny, nz) || 1;
        out[offset] = nx / len;
        out[offset + 1] = ny / len;
        out[offset + 2] = nz / len;
    }

    /** Slope in degrees at world X/Z. */
    slope(x: number, z: number): number {
        const n = this.normal(x, z, _n);

        return THREE.MathUtils.radToDeg(
            Math.acos(THREE.MathUtils.clamp(n.y, -1, 1)),
        );
    }

    /** Grid rectangle (inclusive, clamped) covered by a world-space circle. */
    rectForCircle(x: number, z: number, radius: number, pad = 0): GridRect {
        const { gx, gz } = this.toGrid(x, z);
        const r = radius / this.cell + pad;
        const max = this.resolution - 1;

        return {
            x0: Math.max(0, Math.floor(gx - r)),
            z0: Math.max(0, Math.floor(gz - r)),
            x1: Math.min(max, Math.ceil(gx + r)),
            z1: Math.min(max, Math.ceil(gz + r)),
        };
    }

    minMax(): { min: number; max: number } {
        let min = Infinity;
        let max = -Infinity;

        for (let i = 0; i < this.data.length; i++) {
            const v = this.data[i];

            if (v < min) {
                min = v;
            }

            if (v > max) {
                max = v;
            }
        }

        return { min, max };
    }

    /**
     * Ray/heightfield intersection by marching then bisecting. Returns the hit point or null.
     */
    raycast(
        ray: THREE.Ray,
        maxDistance = 20000,
        target = new THREE.Vector3(),
    ): THREE.Vector3 | null {
        const step = Math.max(this.cell * 0.5, 0.25);
        const p = _p;
        let prevT = 0;
        let prevAbove = true;
        let t = 0;

        // Skip ahead to the map bounds on the horizontal plane.
        ray.at(0, p);

        if (!this.contains(p.x, p.z)) {
            const box = _box.set(
                _min.set(-this.half, -1e5, -this.half),
                _max.set(this.half, 1e5, this.half),
            );
            const hit = ray.intersectBox(box, _p2);

            if (!hit) {
                return null;
            }

            t = ray.origin.distanceTo(hit);
            prevT = t;
        }

        for (; t < maxDistance; t += step * (1 + t / 400)) {
            ray.at(t, p);

            if (!this.contains(p.x, p.z)) {
                if (t > prevT + step * 4) {
                    return null;
                }

                continue;
            }

            const above = p.y > this.sample(p.x, p.z);

            if (!above && prevAbove) {
                let lo = prevT;
                let hi = t;

                for (let i = 0; i < 24; i++) {
                    const mid = (lo + hi) / 2;
                    ray.at(mid, p);

                    if (p.y > this.sample(p.x, p.z)) {
                        lo = mid;
                    } else {
                        hi = mid;
                    }
                }

                ray.at(hi, target);
                target.y = this.sample(target.x, target.z);

                return target;
            }

            prevAbove = above;
            prevT = t;
        }

        return null;
    }

    clone(): Heightfield {
        return new Heightfield(
            this.resolution,
            this.size,
            new Float32Array(this.data),
        );
    }
}

const _n = new THREE.Vector3();
const _p = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _min = new THREE.Vector3();
const _max = new THREE.Vector3();
const _box = new THREE.Box3();
