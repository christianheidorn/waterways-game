import type { GridRect, Heightfield } from '../world/Heightfield';
import { SimplexNoise } from '../util/noise';

/**
 * Landscape stamps: procedural landforms (mountain, volcano, crater, mesa, dune field, ridge,
 * canyon, hills) put down at a position with a rotation, size, height and blend mode. Used by the
 * Sculpt tool's Stamp (with a live preview) and by the MCP tool apply_stamp.
 */

export const STAMP_SHAPES = [
    'mountain',
    'volcano',
    'crater',
    'mesa',
    'dunes',
    'ridge',
    'canyon',
    'hills',
] as const;

export type StampShape = (typeof STAMP_SHAPES)[number];

/**
 * add: on top of the ground · max: only raises the ground to the landform · min: only lowers it ·
 * replace: blends the ground into the landform.
 */
export type StampBlend = 'add' | 'max' | 'min' | 'replace';

export type StampParams = {
    shape: StampShape;
    x: number;
    z: number;
    /** Radius of the footprint (m); elongated shapes are `aspect` times longer. */
    radius: number;
    /** Height of the landform (m); craters and canyons use it as their depth. */
    height: number;
    /** Degrees; turns the landform (the long axis of ridges, canyons and dunes). */
    rotation?: number;
    blend?: StampBlend;
    /** 0-1: how strongly it is applied. */
    strength?: number;
    /** Length / width of elongated shapes (default per shape). */
    aspect?: number;
    /** 0-1: share of the radius over which the edge fades into the terrain. */
    falloff?: number;
    seed?: number;
};

/** Default aspect (length / width) per shape. */
const ASPECT: Record<StampShape, number> = {
    mountain: 1,
    volcano: 1,
    crater: 1,
    mesa: 1.2,
    dunes: 1.6,
    ridge: 3,
    canyon: 3,
    hills: 1.3,
};

/** Shapes carved into the ground (height = depth). */
const DIGS = new Set<StampShape>(['crater', 'canyon']);

export function defaultBlend(shape: StampShape): StampBlend {
    return DIGS.has(shape) ? 'add' : shape === 'mesa' ? 'max' : 'add';
}

/** A stamp ready to evaluate: its frame, noise and the reference ground level. */
export class Stamp {
    readonly rect: GridRect;
    readonly reach: number;
    private readonly cos: number;
    private readonly sin: number;
    private readonly aspect: number;
    private readonly falloff: number;
    private readonly noise: SimplexNoise;
    private readonly blend: StampBlend;
    private readonly strength: number;
    /** Ground level the landform is built on (max / min / replace). */
    readonly base: number;

    constructor(
        private readonly hf: Heightfield,
        readonly p: StampParams,
    ) {
        const rot = ((p.rotation ?? 0) * Math.PI) / 180;
        this.cos = Math.cos(rot);
        this.sin = Math.sin(rot);
        this.aspect = Math.max(1, p.aspect ?? ASPECT[p.shape]);
        this.falloff = clamp(p.falloff ?? 0.3, 0.02, 1);
        this.noise = new SimplexNoise(p.seed ?? 5173);
        this.blend = p.blend ?? defaultBlend(p.shape);
        this.strength = clamp(p.strength ?? 1, 0, 1);
        this.reach = Math.max(1, p.radius) * this.aspect;
        const a = hf.toGrid(p.x - this.reach, p.z - this.reach);
        const b = hf.toGrid(p.x + this.reach, p.z + this.reach);
        const max = hf.resolution - 1;
        this.rect = {
            x0: clampInt(Math.floor(a.gx), 0, max),
            z0: clampInt(Math.floor(a.gz), 0, max),
            x1: clampInt(Math.ceil(b.gx), 0, max),
            z1: clampInt(Math.ceil(b.gz), 0, max),
        };
        // The ground around the footprint's edge.
        let sum = 0;
        const ring = 24;

        for (let k = 0; k < ring; k++) {
            const t = (k / ring) * Math.PI * 2;
            const [x, z] = this.toWorld(Math.cos(t), Math.sin(t));
            sum += hf.sample(x, z);
        }

        this.base = sum / ring;
    }

    /** Ground height after the stamp at a world position whose current height is `h`. */
    heightAt(x: number, z: number, h: number): number {
        const { u, v } = this.toLocal(x, z);
        const r = Math.hypot(u, v);

        if (r >= 1) {
            return h;
        }

        const edge = fade((r - (1 - this.falloff)) / this.falloff);
        const f = this.shape(u, v, r);
        const k = edge * this.strength;
        const target = this.base + this.p.height * f;

        switch (this.blend) {
            case 'max':
                return h + (Math.max(h, target) - h) * k;
            case 'min':
                return h + (Math.min(h, target) - h) * k;
            case 'replace':
                return h + (target - h) * k;
            default:
                return h + this.p.height * f * k;
        }
    }

    /** Applies the stamp to the heightfield; returns a short summary. */
    apply(): Record<string, number | string> {
        const hf = this.hf;
        const res = hf.resolution;
        let raised = 0;
        let lowered = 0;
        let changed = 0;

        for (let row = this.rect.z0; row <= this.rect.z1; row++) {
            const z = hf.rowToZ(row);

            for (let col = this.rect.x0; col <= this.rect.x1; col++) {
                const i = row * res + col;
                const h = hf.data[i];
                const next = this.heightAt(hf.colToX(col), z, h);

                if (next !== h) {
                    hf.data[i] = next;
                    raised = Math.max(raised, next - h);
                    lowered = Math.max(lowered, h - next);
                    changed++;
                }
            }
        }

        return {
            shape: this.p.shape,
            blend: this.blend,
            base_height_m: round1(this.base),
            raised_up_to_m: round1(raised),
            lowered_up_to_m: round1(lowered),
            changed_m2: Math.round(changed * hf.cell * hf.cell),
        };
    }

    /** Local frame: u along the (rotated) long axis, v across; the footprint is u² + v² < 1. */
    private toLocal(x: number, z: number): { u: number; v: number } {
        const dx = x - this.p.x;
        const dz = z - this.p.z;
        const along = dx * this.cos - dz * this.sin;
        const across = dx * this.sin + dz * this.cos;
        const r = Math.max(1, this.p.radius);

        return { u: along / (r * this.aspect), v: across / r };
    }

    private toWorld(u: number, v: number): [number, number] {
        const r = Math.max(1, this.p.radius);
        const along = u * r * this.aspect;
        const across = v * r;

        return [
            this.p.x + along * this.cos + across * this.sin,
            this.p.z - along * this.sin + across * this.cos,
        ];
    }

    /** The landform's height (1 = `height`) at a local position. */
    private shape(u: number, v: number, r: number): number {
        const n = this.noise;

        switch (this.p.shape) {
            case 'mountain': {
                const body = Math.pow(1 - r, 1.7);
                const detail = n.ridged(u * 2.2 + 11, v * 2.2 - 7, 5);

                return body * (0.7 + 0.45 * detail);
            }
            case 'volcano': {
                const lip = 0.2;
                const cone =
                    Math.pow(1 - Math.max(r, lip), 1.25) /
                    Math.pow(1 - lip, 1.25);
                const crater = r < lip ? 0.35 * (1 - (r / lip) ** 2) : 0;
                const gullies = 0.06 * n.ridged(u * 6, v * 6, 3) * (1 - r);

                return cone - crater + gullies;
            }
            case 'crater': {
                const bowl = r < 0.72 ? -(1 - (r / 0.72) ** 2) : 0;
                const rim = 0.3 * Math.exp(-(((r - 0.74) / 0.12) ** 2));

                return bowl + rim + 0.04 * n.fbm(u * 5, v * 5, 3);
            }
            case 'mesa': {
                const wobble = 0.06 * n.fbm(u * 3 + 3, v * 3, 3);
                const cliff = fade((r + wobble - 0.62) / 0.18);
                // A little scree at the foot of the cliffs.
                const scree = 0.12 * fade((r + wobble - 0.8) / 0.2);

                return Math.max(cliff, scree) + 0.02 * n.fbm(u * 8, v * 8, 2);
            }
            case 'dunes': {
                const envelope = fade((r - 0.5) / 0.5);
                const waves = 5 * this.aspect;
                const phase = u * waves + 0.8 * n.fbm(u * 1.5, v * 1.5, 3);
                const p = phase - Math.floor(phase);
                // Gentle windward side, steep lee face.
                const profile =
                    p < 0.78 ? smooth(p / 0.78) : smooth((1 - p) / 0.22);
                const crests =
                    0.6 + 0.4 * (0.5 + 0.5 * n.fbm(v * 3, u * 0.8, 2));

                return profile * crests * envelope;
            }
            case 'ridge': {
                const bend = 0.18 * n.fbm(u * 1.5, 3.3, 3);
                const across = Math.abs(v - bend);
                const crest = Math.pow(Math.max(0, 1 - across), 1.6);
                const ends = Math.sqrt(Math.max(0, 1 - u * u));
                const detail = n.ridged(u * 4 * this.aspect, v * 4, 4);

                return crest * ends * (0.75 + 0.35 * detail);
            }
            case 'canyon': {
                const meander =
                    0.18 * Math.sin(u * 4 + (this.p.seed ?? 0)) +
                    0.08 * n.fbm(u * 2, 1.7, 3);
                const across = Math.abs(v - meander);
                const floor = 0.12;
                const wall = 0.42;
                let depth =
                    1 - smooth(clamp((across - floor) / (wall - floor), 0, 1));
                // Stepped walls.
                const steps = 4;
                const q = depth * steps;
                depth = (Math.floor(q) + smooth(q - Math.floor(q))) / steps;
                const ends = 1 - Math.pow(Math.abs(u), 6);

                return -depth * ends;
            }
            case 'hills': {
                const envelope = Math.pow(Math.max(0, 1 - r * r), 1.5);
                const rolling = 0.5 + 0.5 * n.fbm(u * 2.6 + 5, v * 2.6, 4);

                return envelope * rolling * rolling * 1.4;
            }
        }
    }
}

/**
 * The stamp's result on a coarse grid over its footprint (for the editor's preview): positions as
 * x, y, z triples, `n` × `n` of them, row by row.
 */
export function stampPreviewGrid(
    hf: Heightfield,
    stamp: Stamp,
    n: number,
): Float32Array {
    const out = new Float32Array(n * n * 3);
    const reach = stamp.reach;
    let k = 0;

    for (let j = 0; j < n; j++) {
        const z = stamp.p.z - reach + (2 * reach * j) / (n - 1);

        for (let i = 0; i < n; i++) {
            const x = stamp.p.x - reach + (2 * reach * i) / (n - 1);
            const h = hf.contains(x, z) ? hf.sample(x, z) : 0;
            out[k++] = x;
            out[k++] = stamp.heightAt(x, z, h) + 0.15;
            out[k++] = z;
        }
    }

    return out;
}

function fade(t: number): number {
    if (t <= 0) {
        return 1;
    }

    if (t >= 1) {
        return 0;
    }

    const u = 1 - t;

    return u * u * (3 - 2 * u);
}

function smooth(t: number): number {
    const c = clamp(t, 0, 1);

    return c * c * (3 - 2 * c);
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
