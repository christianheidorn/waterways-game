/**
 * Pure landscape sculpting operations. Every op mutates a Heightfield in place and returns the
 * (inclusive) grid rect it modified, or null when nothing changed. Strokes call these every frame
 * while the mouse is held, so rates are expressed per second and scaled by `dt`.
 */

import { GridRect, Heightfield } from '../../world/Heightfield';
import { mulberry32, SimplexNoise } from '../../util/noise';
import { BrushSettings, brushWeight } from '../Brush';

export type Vec3Like = { x: number; y: number; z: number };

export type FlattenMode = 'both' | 'raise' | 'lower';

export type FlattenOptions = {
    target: number;
    mode: FlattenMode;
    /** Flatten onto a tilted plane through (x, target, z) with the given normal instead of a level one. */
    useSlope?: boolean;
    normal?: Vec3Like;
};

export type NoiseOptions = { scale: number; seed: number };

export type ThermalOptions = { talusAngle: number; iterations: number };

export type HydraulicOptions = {
    droplets: number;
    seed?: number;
    /** Erosion radius in cells (default 3). */
    erosionRadius?: number;
    inertia?: number;
    capacity?: number;
    deposition?: number;
    erosion?: number;
    evaporation?: number;
    maxLifetime?: number;
    /** Global erosion/deposition multiplier per droplet step (default 0.15). */
    rate?: number;
};

export type TerraceOptions = { step: number; sharpness: number };

/** Longest frame step we honour, so a hitch doesn't produce a huge jump. */
const MAX_DT = 0.1;

// ---------------------------------------------------------------------------------------------
// Scratch buffers (grown on demand, reused between calls)
// ---------------------------------------------------------------------------------------------

let scratchA = new Float32Array(0);
let scratchB = new Float32Array(0);
let scratchC = new Float32Array(0);

function scratch(which: 0 | 1 | 2, size: number): Float32Array {
    if (which === 0) {
        if (scratchA.length < size) {
            scratchA = new Float32Array(size);
        }

        return scratchA;
    }

    if (which === 1) {
        if (scratchB.length < size) {
            scratchB = new Float32Array(size);
        }

        return scratchB;
    }

    if (scratchC.length < size) {
        scratchC = new Float32Array(size);
    }

    return scratchC;
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clampDt(dt: number): number {
    return Number.isFinite(dt) ? Math.min(Math.max(dt, 0), MAX_DT) : 0;
}

function validBrush(x: number, z: number, b: BrushSettings): boolean {
    return (
        Number.isFinite(x) &&
        Number.isFinite(z) &&
        Number.isFinite(b.radius) &&
        b.radius > 0 &&
        Number.isFinite(b.strength) &&
        b.strength > 0
    );
}

/** Tracks the bounding rect of cells actually changed. */
class DirtyRect {
    x0 = 0;
    z0 = 0;
    x1 = -1;
    z1 = -1;

    reset(): void {
        this.x0 = Infinity;
        this.z0 = Infinity;
        this.x1 = -1;
        this.z1 = -1;
    }

    add(col: number, row: number): void {
        if (col < this.x0) {
            this.x0 = col;
        }

        if (col > this.x1) {
            this.x1 = col;
        }

        if (row < this.z0) {
            this.z0 = row;
        }

        if (row > this.z1) {
            this.z1 = row;
        }
    }

    result(): GridRect | null {
        return this.x1 < 0
            ? null
            : { x0: this.x0, z0: this.z0, x1: this.x1, z1: this.z1 };
    }
}

const dirty = new DirtyRect();

/**
 * Shared per-cell brush loop: calls `fn(index, weight, worldX, worldZ, col, row)` for every cell
 * with weight > 0; `fn` returns the new height (or the old one). Tracks the changed rect.
 */
function forEachBrushCell(
    hf: Heightfield,
    x: number,
    z: number,
    brush: BrushSettings,
    fn: (
        h: number,
        w: number,
        px: number,
        pz: number,
        col: number,
        row: number,
    ) => number,
): GridRect | null {
    const rect = hf.rectForCircle(x, z, brush.radius);
    const data = hf.data;
    const res = hf.resolution;
    const strength = clamp01(brush.strength);
    dirty.reset();

    for (let row = rect.z0; row <= rect.z1; row++) {
        const pz = hf.rowToZ(row);
        const dz = pz - z;

        for (let col = rect.x0; col <= rect.x1; col++) {
            const px = hf.colToX(col);
            const dx = px - x;
            const w =
                brushWeight(Math.sqrt(dx * dx + dz * dz), brush) * strength;

            if (w <= 0) {
                continue;
            }

            const i = row * res + col;
            const h = data[i];
            const next = fn(h, w, px, pz, col, row);

            if (next !== h && Number.isFinite(next)) {
                data[i] = next;
                dirty.add(col, row);
            }
        }
    }

    return dirty.result();
}

// ---------------------------------------------------------------------------------------------
// Sculpt
// ---------------------------------------------------------------------------------------------

/** Raise (or lower when `invert`). Strength 1 moves ~radius * 0.5 m/s at the centre. */
export function sculpt(
    hf: Heightfield,
    x: number,
    z: number,
    brush: BrushSettings,
    dt: number,
    invert = false,
): GridRect | null {
    dt = clampDt(dt);

    if (!validBrush(x, z, brush) || dt <= 0) {
        return null;
    }

    const rate = brush.radius * 0.5 * dt * (invert ? -1 : 1);

    return forEachBrushCell(hf, x, z, brush, (h, w) => h + rate * w);
}

// ---------------------------------------------------------------------------------------------
// Smooth
// ---------------------------------------------------------------------------------------------

/** Separable blur of the region (read from a copy, so it is order independent), blended by brush weight. */
export function smooth(
    hf: Heightfield,
    x: number,
    z: number,
    brush: BrushSettings,
    dt: number,
): GridRect | null {
    dt = clampDt(dt);

    if (!validBrush(x, z, brush) || dt <= 0) {
        return null;
    }

    const radiusCells = brush.radius / hf.cell;
    const kr = Math.max(1, Math.min(4, Math.round(radiusCells / 8)));
    const inner = hf.rectForCircle(x, z, brush.radius);
    const pad = hf.rectForCircle(x, z, brush.radius, kr);
    const pw = pad.x1 - pad.x0 + 1;
    const ph = pad.z1 - pad.z0 + 1;
    const n = pw * ph;
    const src = scratch(0, n);
    const tmp = scratch(1, n);
    const res = hf.resolution;
    const data = hf.data;

    for (let r = 0; r < ph; r++) {
        const off = (pad.z0 + r) * res + pad.x0;
        src.set(data.subarray(off, off + pw), r * pw);
    }

    // Binomial-ish (triangle) kernel weights.
    const kw = (k: number): number => kr + 1 - Math.abs(k);

    // Horizontal pass over the padded region.
    for (let r = 0; r < ph; r++) {
        const base = r * pw;

        for (let c = 0; c < pw; c++) {
            let sum = 0;
            let wsum = 0;

            for (let k = -kr; k <= kr; k++) {
                let cc = c + k;
                cc = cc < 0 ? 0 : cc >= pw ? pw - 1 : cc;
                const w = kw(k);
                sum += src[base + cc] * w;
                wsum += w;
            }

            tmp[base + c] = sum / wsum;
        }
    }

    const alphaRate = Math.min(1, dt * 10);
    const strength = clamp01(brush.strength);
    dirty.reset();

    // Vertical pass only for the brush cells, blended in.
    for (let row = inner.z0; row <= inner.z1; row++) {
        const r = row - pad.z0;
        const dz = hf.rowToZ(row) - z;

        for (let col = inner.x0; col <= inner.x1; col++) {
            const dx = hf.colToX(col) - x;
            const w =
                brushWeight(Math.sqrt(dx * dx + dz * dz), brush) * strength;

            if (w <= 0) {
                continue;
            }

            const c = col - pad.x0;
            let sum = 0;
            let wsum = 0;

            for (let k = -kr; k <= kr; k++) {
                let rr = r + k;
                rr = rr < 0 ? 0 : rr >= ph ? ph - 1 : rr;
                const kwk = kw(k);
                sum += tmp[rr * pw + c] * kwk;
                wsum += kwk;
            }

            const blurred = sum / wsum;
            const h = src[r * pw + c];
            const next = h + (blurred - h) * Math.min(1, w * alphaRate);

            if (next !== h && Number.isFinite(next)) {
                data[row * res + col] = next;
                dirty.add(col, row);
            }
        }
    }

    return dirty.result();
}

// ---------------------------------------------------------------------------------------------
// Flatten / set height
// ---------------------------------------------------------------------------------------------

/** Move heights toward `target` (optionally a tilted plane). */
export function flatten(
    hf: Heightfield,
    x: number,
    z: number,
    brush: BrushSettings,
    dt: number,
    opts: FlattenOptions,
): GridRect | null {
    dt = clampDt(dt);

    if (!validBrush(x, z, brush) || dt <= 0 || !Number.isFinite(opts.target)) {
        return null;
    }

    const rate = Math.min(1, dt * 8);
    const target = opts.target;
    const mode = opts.mode;
    let sx = 0;
    let sz = 0;

    if (opts.useSlope && opts.normal && opts.normal.y > 1e-3) {
        // Plane: y = target - (nx (px - x) + nz (pz - z)) / ny
        sx = -opts.normal.x / opts.normal.y;
        sz = -opts.normal.z / opts.normal.y;

        if (!Number.isFinite(sx) || !Number.isFinite(sz)) {
            sx = 0;
            sz = 0;
        }
    }

    return forEachBrushCell(hf, x, z, brush, (h, w, px, pz) => {
        const t = target + sx * (px - x) + sz * (pz - z);

        if ((mode === 'raise' && t <= h) || (mode === 'lower' && t >= h)) {
            return h;
        }

        return h + (t - h) * Math.min(1, w * rate);
    });
}

/** Immediately blend heights toward `height` by brush weight * strength. */
export function setHeight(
    hf: Heightfield,
    x: number,
    z: number,
    brush: BrushSettings,
    height: number,
): GridRect | null {
    if (!validBrush(x, z, brush) || !Number.isFinite(height)) {
        return null;
    }

    return forEachBrushCell(hf, x, z, brush, (h, w) => h + (height - h) * w);
}

// ---------------------------------------------------------------------------------------------
// Ramp
// ---------------------------------------------------------------------------------------------

/**
 * One-shot straight ramp between two world points. `width` is the full width in metres and
 * `falloff` (0..1) the fraction of the half-width that blends into the existing terrain.
 */
export function ramp(
    hf: Heightfield,
    start: Vec3Like,
    end: Vec3Like,
    width: number,
    falloff: number,
): GridRect | null {
    const vals = [
        start.x,
        start.y,
        start.z,
        end.x,
        end.y,
        end.z,
        width,
        falloff,
    ];

    if (!vals.every(Number.isFinite) || width <= 0) {
        return null;
    }

    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const len2 = dx * dx + dz * dz;

    if (len2 < 1e-6) {
        return null;
    }

    const half = width / 2;
    const innerHalf = half * (1 - clamp01(falloff));
    const cx = (start.x + end.x) / 2;
    const cz = (start.z + end.z) / 2;
    const rect = hf.rectForCircle(cx, cz, Math.sqrt(len2) / 2 + half, 1);
    const data = hf.data;
    const res = hf.resolution;
    dirty.reset();

    for (let row = rect.z0; row <= rect.z1; row++) {
        const pz = hf.rowToZ(row);

        for (let col = rect.x0; col <= rect.x1; col++) {
            const px = hf.colToX(col);
            const t = ((px - start.x) * dx + (pz - start.z) * dz) / len2;

            if (t < 0 || t > 1) {
                continue;
            }

            const qx = start.x + dx * t;
            const qz = start.z + dz * t;
            const side = Math.hypot(px - qx, pz - qz);

            if (side >= half) {
                continue;
            }

            let w = 1;

            if (side > innerHalf) {
                const u = (side - innerHalf) / (half - innerHalf);
                w = 1 - u * u * (3 - 2 * u);
            }

            const i = row * res + col;
            const h = data[i];
            const y = start.y + (end.y - start.y) * t;
            const next = h + (y - h) * w;

            if (next !== h && Number.isFinite(next)) {
                data[i] = next;
                dirty.add(col, row);
            }
        }
    }

    return dirty.result();
}

// ---------------------------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------------------------

const noiseCache = new Map<number, SimplexNoise>();

function getNoise(seed: number): SimplexNoise {
    let n = noiseCache.get(seed);

    if (!n) {
        n = new SimplexNoise(seed);
        noiseCache.set(seed, n);
    }

    return n;
}

/** Adds fbm displacement (world-anchored, so repeated passes amplify the same pattern). */
export function noise(
    hf: Heightfield,
    x: number,
    z: number,
    brush: BrushSettings,
    dt: number,
    opts: NoiseOptions,
    invert = false,
): GridRect | null {
    dt = clampDt(dt);

    if (!validBrush(x, z, brush) || dt <= 0) {
        return null;
    }

    const scale =
        Number.isFinite(opts.scale) && opts.scale > 0 ? opts.scale : 10;
    const gen = getNoise(Math.floor(opts.seed) || 0);
    const inv = 1 / scale;
    // Amplitude tied to the noise feature size so small-scale noise stays subtle.
    const rate = Math.min(scale, brush.radius) * 0.5 * dt * (invert ? -1 : 1);

    return forEachBrushCell(
        hf,
        x,
        z,
        brush,
        (h, w, px, pz) => h + gen.fbm(px * inv, pz * inv, 4) * rate * w,
    );
}

// ---------------------------------------------------------------------------------------------
// Thermal erosion
// ---------------------------------------------------------------------------------------------

const N8X = [-1, 0, 1, -1, 1, -1, 0, 1];
const N8Z = [-1, -1, -1, 0, 0, 1, 1, 1];
const N8D = [Math.SQRT2, 1, Math.SQRT2, 1, 1, Math.SQRT2, 1, Math.SQRT2];

/** Material slides from cells steeper than the talus angle to their lower neighbours (mass conserving). */
export function thermalErosion(
    hf: Heightfield,
    x: number,
    z: number,
    brush: BrushSettings,
    dt: number,
    opts: ThermalOptions,
): GridRect | null {
    dt = clampDt(dt);

    if (!validBrush(x, z, brush) || dt <= 0) {
        return null;
    }

    const angle = Math.min(
        89,
        Math.max(0, Number.isFinite(opts.talusAngle) ? opts.talusAngle : 35),
    );
    const talus = Math.tan((angle * Math.PI) / 180) * hf.cell;
    const iterations = Math.max(
        1,
        Math.min(20, Math.floor(opts.iterations) || 1),
    );
    const rect = hf.rectForCircle(x, z, brush.radius);
    const w = rect.x1 - rect.x0 + 1;
    const hgt = rect.z1 - rect.z0 + 1;
    const n = w * hgt;
    const weights = scratch(0, n);
    const delta = scratch(1, n);
    const data = hf.data;
    const res = hf.resolution;
    const strength = clamp01(brush.strength);
    const rate = Math.min(1, dt * 20);

    for (let r = 0; r < hgt; r++) {
        const dz = hf.rowToZ(rect.z0 + r) - z;

        for (let c = 0; c < w; c++) {
            const dx = hf.colToX(rect.x0 + c) - x;
            weights[r * w + c] =
                brushWeight(Math.sqrt(dx * dx + dz * dz), brush) *
                strength *
                rate;
        }
    }

    dirty.reset();
    const excess = [0, 0, 0, 0, 0, 0, 0, 0];

    for (let it = 0; it < iterations; it++) {
        delta.fill(0, 0, n);
        let moved = false;

        for (let r = 0; r < hgt; r++) {
            for (let c = 0; c < w; c++) {
                const bw = weights[r * w + c];

                if (bw <= 0) {
                    continue;
                }

                const h = data[(rect.z0 + r) * res + rect.x0 + c];
                let total = 0;
                let maxEx = 0;

                for (let k = 0; k < 8; k++) {
                    const nc = c + N8X[k];
                    const nr = r + N8Z[k];
                    excess[k] = 0;

                    if (nc < 0 || nr < 0 || nc >= w || nr >= hgt) {
                        continue;
                    }

                    const diff = h - data[(rect.z0 + nr) * res + rect.x0 + nc];
                    const ex = diff - talus * N8D[k];

                    if (ex > 0) {
                        excess[k] = ex;
                        total += ex;

                        if (ex > maxEx) {
                            maxEx = ex;
                        }
                    }
                }

                if (total <= 0) {
                    continue;
                }

                // Move half the largest excess (stable), split proportionally.
                const amount = maxEx * 0.5 * bw;

                if (amount <= 1e-7) {
                    continue;
                }

                delta[r * w + c] -= amount;

                for (let k = 0; k < 8; k++) {
                    if (excess[k] > 0) {
                        delta[(r + N8Z[k]) * w + c + N8X[k]] +=
                            (amount * excess[k]) / total;
                    }
                }

                moved = true;
            }
        }

        if (!moved) {
            break;
        }

        for (let r = 0; r < hgt; r++) {
            for (let c = 0; c < w; c++) {
                const d = delta[r * w + c];

                if (d !== 0 && Number.isFinite(d)) {
                    data[(rect.z0 + r) * res + rect.x0 + c] += d;
                    dirty.add(rect.x0 + c, rect.z0 + r);
                }
            }
        }
    }

    return dirty.result();
}

// ---------------------------------------------------------------------------------------------
// Hydraulic erosion (droplet based, after Hans Theobald Beyer 2015)
// ---------------------------------------------------------------------------------------------

type ErosionKernel = { dx: Int32Array; dz: Int32Array; w: Float32Array };

const kernelCache = new Map<number, ErosionKernel>();

function erosionKernel(radius: number): ErosionKernel {
    let k = kernelCache.get(radius);

    if (k) {
        return k;
    }

    const dxs: number[] = [];
    const dzs: number[] = [];
    const ws: number[] = [];
    let sum = 0;

    for (let j = -radius; j <= radius; j++) {
        for (let i = -radius; i <= radius; i++) {
            const d = Math.sqrt(i * i + j * j);

            if (d < radius) {
                const w = 1 - d / radius;
                dxs.push(i);
                dzs.push(j);
                ws.push(w);
                sum += w;
            }
        }
    }

    k = {
        dx: Int32Array.from(dxs),
        dz: Int32Array.from(dzs),
        w: Float32Array.from(ws.map((v) => v / sum)),
    };
    kernelCache.set(radius, k);

    return k;
}

let hydraulicCounter = 1;

/**
 * Simulates `droplets` water droplets spawned inside the brush (scaled for dt relative to 60 fps).
 * Erosion/deposition is weighted by brush falloff at the droplet position, so only the brush area
 * changes. Droplets die when they leave a padded region around the brush.
 */
export function hydraulicErosion(
    hf: Heightfield,
    x: number,
    z: number,
    brush: BrushSettings,
    dt: number,
    opts: HydraulicOptions,
): GridRect | null {
    dt = clampDt(dt);

    if (!validBrush(x, z, brush) || dt <= 0) {
        return null;
    }

    const res = hf.resolution;
    const data = hf.data;
    const cell = hf.cell;
    const base = Number.isFinite(opts.droplets)
        ? Math.max(0, opts.droplets)
        : 60;
    const count = Math.min(2000, Math.round(base * Math.min(3, dt * 60)));

    if (count <= 0 || res < 4) {
        return null;
    }

    const eRadius = Math.max(
        1,
        Math.min(8, Math.round(opts.erosionRadius ?? 3)),
    );
    const inertia = clamp01(opts.inertia ?? 0.05);
    const capacityF = opts.capacity ?? 4;
    const depositF = clamp01(opts.deposition ?? 0.3);
    const erodeF = clamp01(opts.erosion ?? 0.3);
    const evaporation = clamp01(opts.evaporation ?? 0.01);
    const maxLifetime = Math.max(
        1,
        Math.min(200, Math.floor(opts.maxLifetime ?? 30)),
    );
    const rate = Math.max(0, Math.min(1, opts.rate ?? 0.15));
    const gravity = 4;
    const minSlope = 0.01 * cell;
    const strength = clamp01(brush.strength);
    const kernel = erosionKernel(eRadius);
    const kn = kernel.w.length;

    const region = hf.rectForCircle(x, z, brush.radius * 1.25);
    const minC = Math.max(region.x0, eRadius);
    const minR = Math.max(region.z0, eRadius);
    const maxC = Math.min(region.x1, res - 2 - eRadius);
    const maxR = Math.min(region.z1, res - 2 - eRadius);

    if (maxC <= minC || maxR <= minR) {
        return null;
    }

    const seed =
        opts.seed !== undefined && Number.isFinite(opts.seed)
            ? opts.seed + hydraulicCounter
            : hydraulicCounter * 2654435761;
    hydraulicCounter++;
    const rand = mulberry32(seed >>> 0);
    const { gx: cgx, gz: cgz } = hf.toGrid(x, z);
    const rCells = brush.radius / cell;
    dirty.reset();

    // Bilinear height + gradient at grid position (heights in metres, gradient in m/cell).
    let gH = 0;
    let gGX = 0;
    let gGZ = 0;
    const heightGrad = (px: number, pz: number): void => {
        const c = Math.floor(px);
        const r = Math.floor(pz);
        const fx = px - c;
        const fz = pz - r;
        const i = r * res + c;
        const h00 = data[i];
        const h10 = data[i + 1];
        const h01 = data[i + res];
        const h11 = data[i + res + 1];
        gGX = (h10 - h00) * (1 - fz) + (h11 - h01) * fz;
        gGZ = (h01 - h00) * (1 - fx) + (h11 - h10) * fx;
        gH =
            h00 * (1 - fx) * (1 - fz) +
            h10 * fx * (1 - fz) +
            h01 * (1 - fx) * fz +
            h11 * fx * fz;
    };

    const weightAt = (px: number, pz: number): number => {
        const d = Math.hypot(px - cgx, pz - cgz) * cell;

        return brushWeight(d, brush) * strength;
    };

    for (let d = 0; d < count; d++) {
        const ang = rand() * Math.PI * 2;
        const rad = Math.sqrt(rand()) * rCells;
        let px = cgx + Math.cos(ang) * rad;
        let pz = cgz + Math.sin(ang) * rad;

        if (px < minC || pz < minR || px >= maxC || pz >= maxR) {
            continue;
        }

        let dirX = 0;
        let dirZ = 0;
        let speed = 1;
        let water = 1;
        let sediment = 0;

        for (let life = 0; life < maxLifetime; life++) {
            const c = Math.floor(px);
            const r = Math.floor(pz);
            const fx = px - c;
            const fz = pz - r;

            heightGrad(px, pz);
            const h = gH;

            dirX = dirX * inertia - gGX * (1 - inertia);
            dirZ = dirZ * inertia - gGZ * (1 - inertia);
            const len = Math.hypot(dirX, dirZ);

            if (len < 1e-9) {
                break;
            }

            dirX /= len;
            dirZ /= len;
            const nx = px + dirX;
            const nz = pz + dirZ;

            if (nx < minC || nz < minR || nx >= maxC || nz >= maxR) {
                break;
            }

            heightGrad(nx, nz);
            const deltaH = gH - h;
            const capacity =
                Math.max(-deltaH, minSlope) * speed * water * capacityF;
            const bw = weightAt(px, pz) * rate;

            if (sediment > capacity || deltaH > 0) {
                // Deposit: fill the pit when going uphill, otherwise a fraction of the surplus.
                let amount =
                    deltaH > 0
                        ? Math.min(deltaH, sediment)
                        : (sediment - capacity) * depositF;
                amount *= bw;

                if (amount > 0 && Number.isFinite(amount)) {
                    sediment -= amount;
                    const i = r * res + c;
                    data[i] += amount * (1 - fx) * (1 - fz);
                    data[i + 1] += amount * fx * (1 - fz);
                    data[i + res] += amount * (1 - fx) * fz;
                    data[i + res + 1] += amount * fx * fz;
                    dirty.add(c, r);
                    dirty.add(c + 1, r + 1);
                }
            } else {
                let amount = Math.min((capacity - sediment) * erodeF, -deltaH);
                amount *= bw;

                if (amount > 0 && Number.isFinite(amount)) {
                    for (let k = 0; k < kn; k++) {
                        const ec = c + kernel.dx[k];
                        const er = r + kernel.dz[k];
                        const removed = amount * kernel.w[k];
                        data[er * res + ec] -= removed;
                        sediment += removed;
                    }

                    dirty.add(c - eRadius, r - eRadius);
                    dirty.add(c + eRadius, r + eRadius);
                }
            }

            // Gain speed going downhill (deltaH < 0), lose it uphill.
            const v2 = speed * speed - (deltaH * gravity) / cell;
            speed = Math.sqrt(Math.max(0, v2));
            water *= 1 - evaporation;
            px = nx;
            pz = nz;
        }

        // Drop leftover sediment where the droplet died so the brush conserves mass.
        if (sediment > 0 && Number.isFinite(sediment)) {
            const c = Math.floor(px);
            const r = Math.floor(pz);
            const fx = px - c;
            const fz = pz - r;
            const i = r * res + c;
            data[i] += sediment * (1 - fx) * (1 - fz);
            data[i + 1] += sediment * fx * (1 - fz);
            data[i + res] += sediment * (1 - fx) * fz;
            data[i + res + 1] += sediment * fx * fz;
            dirty.add(c, r);
            dirty.add(c + 1, r + 1);
        }
    }

    return dirty.result();
}

// ---------------------------------------------------------------------------------------------
// Terrace
// ---------------------------------------------------------------------------------------------

/** Pulls heights toward stepped terraces of `step` metres; `sharpness` 0..1 controls the riser steepness. */
export function terrace(
    hf: Heightfield,
    x: number,
    z: number,
    brush: BrushSettings,
    dt: number,
    opts: TerraceOptions,
): GridRect | null {
    dt = clampDt(dt);

    if (
        !validBrush(x, z, brush) ||
        dt <= 0 ||
        !Number.isFinite(opts.step) ||
        opts.step <= 1e-3
    ) {
        return null;
    }

    const step = opts.step;
    const exp =
        1 /
        (1 +
            clamp01(Number.isFinite(opts.sharpness) ? opts.sharpness : 0.5) *
                9);
    const rate = Math.min(1, dt * 6);

    return forEachBrushCell(hf, x, z, brush, (h, w) => {
        const f = h / step;
        const fl = Math.floor(f);
        const s = 2 * (f - fl) - 1;
        const g = 0.5 + 0.5 * Math.sign(s) * Math.pow(Math.abs(s), exp);
        const t = (fl + g) * step;

        return h + (t - h) * Math.min(1, w * rate);
    });
}

// ---------------------------------------------------------------------------------------------
// Region copy helpers (undo, previews)
// ---------------------------------------------------------------------------------------------

/** Copies a rect of heights into a new (or provided) row-major array of (x1-x0+1)*(z1-z0+1). */
export function copyHeights(
    hf: Heightfield,
    rect: GridRect,
    out?: Float32Array,
): Float32Array {
    const w = rect.x1 - rect.x0 + 1;
    const h = rect.z1 - rect.z0 + 1;
    const dst = out && out.length >= w * h ? out : new Float32Array(w * h);

    for (let r = 0; r < h; r++) {
        const off = (rect.z0 + r) * hf.resolution + rect.x0;
        dst.set(hf.data.subarray(off, off + w), r * w);
    }

    return dst;
}

/** Writes `source` (row-major rect-sized, as produced by copyHeights) back into the heightfield. */
export function stampHeights(
    hf: Heightfield,
    rect: GridRect,
    source: Float32Array,
): GridRect | null {
    const max = hf.resolution - 1;
    const w = rect.x1 - rect.x0 + 1;
    const h = rect.z1 - rect.z0 + 1;

    if (w <= 0 || h <= 0 || source.length < w * h) {
        return null;
    }

    dirty.reset();

    for (let r = 0; r < h; r++) {
        const row = rect.z0 + r;

        if (row < 0 || row > max) {
            continue;
        }

        for (let c = 0; c < w; c++) {
            const col = rect.x0 + c;
            const v = source[r * w + c];

            if (col < 0 || col > max || !Number.isFinite(v)) {
                continue;
            }

            hf.data[row * hf.resolution + col] = v;
            dirty.add(col, row);
        }
    }

    return dirty.result();
}
