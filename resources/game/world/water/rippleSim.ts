/**
 * Interactive ripples (docs/ROADMAP.md phase 12): a damped 2D wave equation on a square height field that
 * follows the player / camera. This file holds the model shared by both implementations and the CPU
 * version (WebGL 2, and the unit tests); Ripples.ts runs the same step as WebGPU compute.
 *
 * Per fixed step (RIPPLE_DT), for each cell with mask m (0 dry / shore wall, 1 open water):
 *
 *   h' = m · damp · (2h − hPrev + k · (h_E + h_W + h_N + h_S − 4h)),   k = (c · dt / dx)²
 *
 * Dry cells stay at 0, so rings reflect off shores (and lose energy there through the extra shallow-water
 * damping). Foam is a third field: it decays, is raised where the surface moves fast (strong impacts) and
 * by sources that bring their own (splashes).
 */

/** Simulation step (s): fixed, a frame runs 0-3 of them. */
export const RIPPLE_DT = 1 / 60;
/** Most steps per frame (slow frames drop time rather than spiral). */
export const RIPPLE_MAX_STEPS = 3;
/** Ripple speed (m/s): short gravity waves of a few decimetres. */
export const RIPPLE_SPEED = 1.1;
/** Amplitude damping (1/s) in open water. */
export const RIPPLE_DAMPING = 0.45;
/** Foam fades over about this many seconds. */
export const RIPPLE_FOAM_DECAY = 1.4;
/** Vertical surface speed (m/s) above which foam forms. */
export const RIPPLE_FOAM_SPEED = 0.6;
/** The field re-centres in jumps of this many cells (the shore mask is rebuilt then). */
export const RIPPLE_SNAP = 16;
/** Most disturbances per frame. */
export const RIPPLE_MAX_SOURCES = 16;

export type RippleQuality = 'off' | 'low' | 'medium' | 'high';

/** Cells per side for each quality (graphics water_ripples); the field always covers RIPPLE_EXTENT. */
export const RIPPLE_RESOLUTION: Record<RippleQuality, number> = {
    off: 0,
    low: 128,
    medium: 192,
    high: 256,
};
/** Side of the simulated square (m). */
export const RIPPLE_EXTENT = 40;

/** One disturbance: a Gaussian bump (amount m, negative pushes down) of `radius` m, plus foam (0-1). */
export type RippleSource = {
    x: number;
    z: number;
    radius: number;
    amount: number;
    foam: number;
};

/** Wave-equation coefficient k = (c·dt/dx)², clamped to the stable range. */
export function rippleCoefficient(cell: number): number {
    const k = ((RIPPLE_SPEED * RIPPLE_DT) / cell) ** 2;

    return Math.min(0.45, k);
}

/** Per-step amplitude factor in open water and the extra loss in very shallow water (depth m). */
export function rippleDamping(depth: number): number {
    const shallow = Math.min(1, Math.max(0, (0.25 - depth) / 0.22));

    return Math.exp(-RIPPLE_DT * (RIPPLE_DAMPING + shallow * 4));
}

/** Shore mask value for a water depth (m; ≤ 0 dry): 0 is a wall, otherwise the per-step damping. */
export function rippleMask(depth: number | null): number {
    return depth === null || depth <= 0.02 ? 0 : rippleDamping(depth);
}

/** Cell origin snapped so the field moves in RIPPLE_SNAP-cell jumps; returns the field's min corner (m). */
export function rippleOrigin(
    centre: number,
    cell: number,
    size: number,
): number {
    const snap = cell * RIPPLE_SNAP;

    return Math.round(centre / snap) * snap - (size * cell) / 2;
}

/**
 * CPU ripple field (WebGL 2 and tests): size² cells of `cell` m, min corner at (originX, originZ).
 * `output` holds (height, ∂h/∂x, ∂h/∂z, foam) per cell, ready to upload as an RGBA texture.
 */
export class RippleSim {
    readonly size: number;
    readonly cell: number;
    originX = 0;
    originZ = 0;
    h: Float32Array;
    prev: Float32Array;
    foam: Float32Array;
    /** 0 dry, else the per-step damping (rippleMask). */
    readonly mask: Float32Array;
    readonly output: Float32Array;
    private scratch: Float32Array;
    private readonly k: number;

    constructor(size: number, extent = RIPPLE_EXTENT) {
        this.size = size;
        this.cell = extent / size;
        const n = size * size;
        this.h = new Float32Array(n);
        this.prev = new Float32Array(n);
        this.foam = new Float32Array(n);
        this.scratch = new Float32Array(n);
        this.mask = new Float32Array(n).fill(rippleDamping(10));
        this.output = new Float32Array(n * 4);
        this.k = rippleCoefficient(this.cell);
    }

    /** World position of cell (i, j)'s centre. */
    cellX(i: number): number {
        return this.originX + (i + 0.5) * this.cell;
    }

    cellZ(j: number): number {
        return this.originZ + (j + 0.5) * this.cell;
    }

    /**
     * Moves the field's min corner to (x, z) (a whole number of cells away): the state shifts with it and
     * cells that come in start flat. Returns whether it moved.
     */
    moveTo(x: number, z: number): boolean {
        const sx = Math.round((x - this.originX) / this.cell);
        const sz = Math.round((z - this.originZ) / this.cell);

        if (sx === 0 && sz === 0) {
            return false;
        }

        this.originX += sx * this.cell;
        this.originZ += sz * this.cell;

        for (const field of [this.h, this.prev, this.foam]) {
            shiftField(field, this.scratch, this.size, sx, sz);
            field.set(this.scratch);
        }

        return true;
    }

    /** Fills the shore mask from a water depth lookup (null / ≤ 0: dry). */
    buildMask(depthAt: (x: number, z: number) => number | null): void {
        const n = this.size;

        for (let j = 0; j < n; j++) {
            for (let i = 0; i < n; i++) {
                this.mask[j * n + i] = rippleMask(
                    depthAt(this.cellX(i), this.cellZ(j)),
                );
            }
        }
    }

    /** Adds a disturbance (applied at once). */
    disturb(s: RippleSource): void {
        const n = this.size;
        const r = Math.max(s.radius, this.cell * 0.75);
        const reach = r * 2.5;
        const ci = (s.x - this.originX) / this.cell - 0.5;
        const cj = (s.z - this.originZ) / this.cell - 0.5;
        const i0 = Math.max(0, Math.floor(ci - reach / this.cell));
        const i1 = Math.min(n - 1, Math.ceil(ci + reach / this.cell));
        const j0 = Math.max(0, Math.floor(cj - reach / this.cell));
        const j1 = Math.min(n - 1, Math.ceil(cj + reach / this.cell));

        for (let j = j0; j <= j1; j++) {
            for (let i = i0; i <= i1; i++) {
                const k = j * n + i;

                if (this.mask[k] === 0) {
                    continue;
                }

                const dx = (i - ci) * this.cell;
                const dz = (j - cj) * this.cell;
                const g = Math.exp(-(dx * dx + dz * dz) / (r * r));
                // Displaced at rest (h and hPrev): the bump falls back and spreads as a ring.
                this.h[k] += s.amount * g;
                this.prev[k] += s.amount * g;
                this.foam[k] = Math.max(this.foam[k], s.foam * g);
            }
        }
    }

    /** One fixed step of the wave equation (RIPPLE_DT). */
    step(): void {
        const n = this.size;
        const h = this.h;
        const prev = this.prev;
        const next = this.scratch;
        const mask = this.mask;
        const foam = this.foam;
        const k = this.k;
        const foamDecay = Math.exp(-RIPPLE_DT / RIPPLE_FOAM_DECAY);

        for (let j = 0; j < n; j++) {
            for (let i = 0; i < n; i++) {
                const c = j * n + i;
                const m = mask[c];

                if (m === 0) {
                    next[c] = 0;
                    foam[c] = 0;
                    continue;
                }

                const hc = h[c];
                // Outside the field the surface is flat.
                const e = i < n - 1 ? h[c + 1] : 0;
                const w = i > 0 ? h[c - 1] : 0;
                const s = j < n - 1 ? h[c + n] : 0;
                const no = j > 0 ? h[c - n] : 0;
                const v =
                    m * (2 * hc - prev[c] + k * (e + w + s + no - 4 * hc));
                next[c] = v;
                const speed = Math.abs(v - hc) / RIPPLE_DT;
                foam[c] = Math.max(
                    foam[c] * foamDecay,
                    Math.min(1, (speed - RIPPLE_FOAM_SPEED) * 1.5),
                );
            }
        }

        // Rotate: prev ← h, h ← next.
        this.prev = h;
        this.h = next;
        this.scratch = prev;
    }

    /** Fills `output` (height, gradient, foam). */
    writeOutput(): Float32Array {
        const n = this.size;
        const h = this.h;
        const out = this.output;
        const inv = 1 / (2 * this.cell);

        for (let j = 0; j < n; j++) {
            for (let i = 0; i < n; i++) {
                const c = j * n + i;
                const e = i < n - 1 ? h[c + 1] : 0;
                const w = i > 0 ? h[c - 1] : 0;
                const s = j < n - 1 ? h[c + n] : 0;
                const no = j > 0 ? h[c - n] : 0;
                out[c * 4] = h[c];
                out[c * 4 + 1] = (e - w) * inv;
                out[c * 4 + 2] = (s - no) * inv;
                out[c * 4 + 3] = this.foam[c];
            }
        }

        return out;
    }

    /** Bilinear height and gradient at a world position (0 outside the field). */
    sample(
        x: number,
        z: number,
        out: { height: number; slopeX: number; slopeZ: number },
    ): void {
        const n = this.size;
        const fx = (x - this.originX) / this.cell - 0.5;
        const fz = (z - this.originZ) / this.cell - 0.5;
        const at = (i: number, j: number) =>
            i < 0 || j < 0 || i >= n || j >= n ? 0 : this.h[j * n + i];
        const i = Math.floor(fx);
        const j = Math.floor(fz);
        const tx = fx - i;
        const tz = fz - j;
        const h00 = at(i, j);
        const h10 = at(i + 1, j);
        const h01 = at(i, j + 1);
        const h11 = at(i + 1, j + 1);
        out.height =
            (h00 * (1 - tx) + h10 * tx) * (1 - tz) +
            (h01 * (1 - tx) + h11 * tx) * tz;
        out.slopeX = ((h10 - h00) * (1 - tz) + (h11 - h01) * tz) / this.cell;
        out.slopeZ = ((h01 - h00) * (1 - tx) + (h11 - h10) * tx) / this.cell;
    }

    /** Sum of squared heights (tests: the field's energy). */
    energy(): number {
        let e = 0;

        for (const v of this.h) {
            e += v * v;
        }

        return e;
    }

    clear(): void {
        this.h.fill(0);
        this.prev.fill(0);
        this.foam.fill(0);
    }
}

/** dst[i, j] = src[i + sx, j + sz] (0 where that falls outside). */
function shiftField(
    src: Float32Array,
    dst: Float32Array,
    n: number,
    sx: number,
    sz: number,
): void {
    dst.fill(0);

    if (Math.abs(sx) >= n || Math.abs(sz) >= n) {
        return;
    }

    for (let j = 0; j < n; j++) {
        const sj = j + sz;

        if (sj < 0 || sj >= n) {
            continue;
        }

        const i0 = Math.max(0, -sx);
        const i1 = Math.min(n, n - sx);

        if (i1 > i0) {
            dst.set(
                src.subarray(sj * n + i0 + sx, sj * n + i1 + sx),
                j * n + i0,
            );
        }
    }
}
