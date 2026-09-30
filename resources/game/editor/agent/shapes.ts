import type { GridRect, Heightfield } from '../../world/Heightfield';

/** A world position in metres (x west → east, z north → south). */
export type Point = { x: number; z: number };

/**
 * Where a scripted edit applies (world metres). The edit has full effect inside the shape and fades
 * out over `falloff` metres outside it (a soft edge).
 */
export type ShapeSpec =
    | { type: 'map' }
    | { type: 'circle'; center: Point; radius: number; falloff?: number }
    | { type: 'rect'; min: Point; max: Point; falloff?: number }
    | { type: 'polygon'; points: Point[]; falloff?: number }
    | { type: 'path'; points: Point[]; width: number; falloff?: number };

/**
 * A shape rasterised onto the height grid: per sample, the weight of the edit (0-1), a relief
 * coordinate `t` (1 at the centre / centre line / deepest inside, 0 at the outer edge of the falloff;
 * used for hills and valleys) and, for paths, the distance along the path of the nearest point.
 */
export class ShapeMask {
    /** Grid rectangle covered (inclusive), clamped to the map. */
    readonly rect: GridRect;
    readonly width: number;
    readonly height: number;
    readonly weight: Float32Array;
    readonly relief: Float32Array;
    /** Paths: distance (m) along the path of the nearest centre-line point; empty otherwise. */
    readonly along: Float32Array;
    /** Paths: total length (m). */
    readonly length: number;
    /** Samples with full effect. */
    readonly coreSamples: number;

    constructor(
        readonly hf: Heightfield,
        readonly spec: ShapeSpec,
    ) {
        const falloff = 'falloff' in spec ? Math.max(0, spec.falloff ?? 0) : 0;
        const bounds = worldBounds(spec, hf, falloff);
        const a = hf.toGrid(bounds.x0, bounds.z0);
        const b = hf.toGrid(bounds.x1, bounds.z1);
        const max = hf.resolution - 1;
        this.rect = {
            x0: clampInt(Math.floor(a.gx), 0, max),
            z0: clampInt(Math.floor(a.gz), 0, max),
            x1: clampInt(Math.ceil(b.gx), 0, max),
            z1: clampInt(Math.ceil(b.gz), 0, max),
        };
        this.width = this.rect.x1 - this.rect.x0 + 1;
        this.height = this.rect.z1 - this.rect.z0 + 1;
        const n = this.width * this.height;
        this.weight = new Float32Array(n);
        this.relief = new Float32Array(n);
        this.along = new Float32Array(spec.type === 'path' ? n : 0);
        this.length = spec.type === 'path' ? pathLength(spec.points) : 0;

        switch (spec.type) {
            case 'map':
                this.weight.fill(1);
                this.relief.fill(1);
                break;
            case 'circle':
                this.rasterCircle(spec.center, spec.radius, falloff);
                break;
            case 'rect':
                this.rasterPolygon(
                    [
                        spec.min,
                        { x: spec.max.x, z: spec.min.z },
                        spec.max,
                        { x: spec.min.x, z: spec.max.z },
                    ],
                    falloff,
                );
                break;
            case 'polygon':
                this.rasterPolygon(spec.points, falloff);
                break;
            case 'path':
                this.rasterPath(spec.points, spec.width / 2, falloff);
                break;
        }

        let core = 0;

        for (let i = 0; i < n; i++) {
            core += this.weight[i] >= 0.999 ? 1 : 0;
        }

        this.coreSamples = core;
    }

    /** Index into the mask arrays of a grid sample (inside `rect`). */
    index(col: number, row: number): number {
        return (row - this.rect.z0) * this.width + (col - this.rect.x0);
    }

    /** Calls fn for every grid sample with weight > 0. */
    forEach(
        fn: (col: number, row: number, weight: number, i: number) => void,
    ): void {
        for (let row = this.rect.z0; row <= this.rect.z1; row++) {
            for (let col = this.rect.x0; col <= this.rect.x1; col++) {
                const i = this.index(col, row);

                if (this.weight[i] > 0) {
                    fn(col, row, this.weight[i], i);
                }
            }
        }
    }

    /** Weight at a world position (nearest sample; 0 outside the rect). */
    weightAt(x: number, z: number): number {
        const { gx, gz } = this.hf.toGrid(x, z);
        const col = Math.round(gx);
        const row = Math.round(gz);

        if (
            col < this.rect.x0 ||
            col > this.rect.x1 ||
            row < this.rect.z0 ||
            row > this.rect.z1
        ) {
            return 0;
        }

        return this.weight[this.index(col, row)];
    }

    /** Area (m²) with any effect, weighted. */
    get area(): number {
        let sum = 0;

        for (const w of this.weight) {
            sum += w;
        }

        return sum * this.hf.cell * this.hf.cell;
    }

    private rasterCircle(c: Point, radius: number, falloff: number): void {
        const outer = radius + falloff;

        this.eachSample((x, z, i) => {
            const d = Math.hypot(x - c.x, z - c.z);
            this.weight[i] = edgeWeight(d - radius, falloff);
            this.relief[i] = Math.max(0, 1 - d / Math.max(1e-6, outer));
        });
    }

    private rasterPolygon(points: Point[], falloff: number): void {
        const inside = new Uint8Array(this.weight.length);
        const dist = new Float32Array(this.weight.length);
        let deepest = 0;

        this.eachSample((x, z, i) => {
            let d = Infinity;
            let odd = false;

            for (let k = 0, j = points.length - 1; k < points.length; j = k++) {
                const p = points[k];
                const q = points[j];
                d = Math.min(d, segmentDistance(x, z, q, p).d);

                if (
                    p.z > z !== q.z > z &&
                    x < ((q.x - p.x) * (z - p.z)) / (q.z - p.z) + p.x
                ) {
                    odd = !odd;
                }
            }

            inside[i] = odd ? 1 : 0;
            dist[i] = d;

            if (odd) {
                deepest = Math.max(deepest, d);
            }
        });

        const span = deepest + falloff;

        this.eachSample((_x, _z, i) => {
            const d = dist[i];

            if (inside[i]) {
                this.weight[i] = 1;
                this.relief[i] = span > 0 ? (d + falloff) / span : 1;
            } else {
                this.weight[i] = edgeWeight(d, falloff);
                this.relief[i] =
                    span > 0 ? Math.max(0, (falloff - d) / span) : 0;
            }
        });
    }

    private rasterPath(points: Point[], half: number, falloff: number): void {
        const n = this.weight.length;
        const best = new Float32Array(n).fill(Infinity);
        const outer = half + falloff;
        const hf = this.hf;
        let start = 0;

        // Segment by segment, only over each segment's own bounding box (long rivers stay cheap).
        for (let k = 0; k + 1 < points.length; k++) {
            const p = points[k];
            const q = points[k + 1];
            const segLen = Math.hypot(q.x - p.x, q.z - p.z);
            const a = hf.toGrid(
                Math.min(p.x, q.x) - outer,
                Math.min(p.z, q.z) - outer,
            );
            const b = hf.toGrid(
                Math.max(p.x, q.x) + outer,
                Math.max(p.z, q.z) + outer,
            );
            const c0 = Math.max(this.rect.x0, Math.floor(a.gx));
            const c1 = Math.min(this.rect.x1, Math.ceil(b.gx));
            const r0 = Math.max(this.rect.z0, Math.floor(a.gz));
            const r1 = Math.min(this.rect.z1, Math.ceil(b.gz));

            for (let row = r0; row <= r1; row++) {
                for (let col = c0; col <= c1; col++) {
                    const i = this.index(col, row);
                    const s = segmentDistance(
                        hf.colToX(col),
                        hf.rowToZ(row),
                        p,
                        q,
                    );

                    if (s.d < best[i]) {
                        best[i] = s.d;
                        this.along[i] = start + s.t * segLen;
                    }
                }
            }

            start += segLen;
        }

        for (let i = 0; i < n; i++) {
            const d = best[i];

            if (Number.isFinite(d)) {
                this.weight[i] = edgeWeight(d - half, falloff);
                this.relief[i] = Math.max(0, 1 - d / Math.max(1e-6, outer));
            }
        }
    }

    private eachSample(fn: (x: number, z: number, i: number) => void): void {
        const hf = this.hf;

        for (let row = this.rect.z0; row <= this.rect.z1; row++) {
            const z = hf.rowToZ(row);

            for (let col = this.rect.x0; col <= this.rect.x1; col++) {
                fn(hf.colToX(col), z, this.index(col, row));
            }
        }
    }
}

/** 1 inside (d ≤ 0), smoothly down to 0 at `falloff` metres outside. */
function edgeWeight(d: number, falloff: number): number {
    if (d <= 0) {
        return 1;
    }

    if (falloff <= 0 || d >= falloff) {
        return 0;
    }

    const t = 1 - d / falloff;

    return t * t * (3 - 2 * t);
}

function segmentDistance(
    x: number,
    z: number,
    p: Point,
    q: Point,
): { d: number; t: number } {
    const dx = q.x - p.x;
    const dz = q.z - p.z;
    const len2 = dx * dx + dz * dz;
    const t =
        len2 > 0
            ? Math.min(1, Math.max(0, ((x - p.x) * dx + (z - p.z) * dz) / len2))
            : 0;

    return { d: Math.hypot(x - (p.x + dx * t), z - (p.z + dz * t)), t };
}

function pathLength(points: Point[]): number {
    let length = 0;

    for (let k = 0; k + 1 < points.length; k++) {
        length += Math.hypot(
            points[k + 1].x - points[k].x,
            points[k + 1].z - points[k].z,
        );
    }

    return length;
}

function worldBounds(
    spec: ShapeSpec,
    hf: Heightfield,
    falloff: number,
): { x0: number; z0: number; x1: number; z1: number } {
    if (spec.type === 'map') {
        return { x0: -hf.half, z0: -hf.half, x1: hf.half, z1: hf.half };
    }

    let points: Point[];
    let pad = falloff;

    if (spec.type === 'circle') {
        points = [spec.center];
        pad += spec.radius;
    } else if (spec.type === 'rect') {
        points = [spec.min, spec.max];
    } else {
        points = spec.points;
        pad += spec.type === 'path' ? spec.width / 2 : 0;
    }

    const xs = points.map((p) => p.x);
    const zs = points.map((p) => p.z);

    return {
        x0: Math.min(...xs) - pad,
        z0: Math.min(...zs) - pad,
        x1: Math.max(...xs) + pad,
        z1: Math.max(...zs) + pad,
    };
}

function clampInt(v: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, v));
}
