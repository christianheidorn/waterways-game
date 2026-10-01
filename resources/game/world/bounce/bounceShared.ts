/**
 * Shared layout of the bounce light (diffuse global illumination) data, used by the main thread
 * (BounceLight.ts) and the worker that computes it (bounceWorker.ts).
 *
 * The probe volume is a heightfield-following grid over the whole map: `res`² probe columns, each with
 * PROBE_LAYERS probes at fixed heights above the ground (or water surface). Every probe stores
 *
 * - A: bounce irradiance per unit of sun irradiance (rgb, averaged over all normals) and the sky
 *   visibility (w: cosine-weighted fraction of the upper hemisphere that reaches the sky),
 * - B: bounce irradiance per unit of sky irradiance (rgb),
 * - C: the dominant direction the bounce comes from (xyz, scaled so E(n) = E × max(0, 1 + n·d)) and
 *   the probe column's ground height (w, relative to a reference height; the same in every layer).
 *
 * Splitting the bounce into a sun and a sky part keeps weather, cloud and colour changes free (they
 * only change two uniforms): only a new sun / moon direction or an edit needs the worker.
 */

/** Probe heights above the ground (m). The shader interpolates between them. */
export const PROBE_HEIGHTS = [1, 5, 13, 30] as const;
export const PROBE_LAYERS = PROBE_HEIGHTS.length;

/** Probe columns per worker tile (square). */
export const TILE = 16;

export type BounceQuality = 'off' | 'low' | 'medium' | 'high';

/** Probe grid resolution and rays per probe for each quality. */
export const QUALITY_PARAMS: Record<
    Exclude<BounceQuality, 'off'>,
    { res: number; rays: number }
> = {
    low: { res: 128, rays: 16 },
    medium: { res: 192, rays: 24 },
    high: { res: 256, rays: 32 },
};

/**
 * What the worker sees of the world, on a cell-centred `n`² grid twice as fine as the probes
 * (cell (i, j) centred at -size/2 + (i + 0.5) × size / n).
 */
export type BounceScene = {
    n: number;
    size: number;
    /** Ground height (terrain, m). */
    ground: Float32Array;
    /** What the probes stand on: max(terrain, water surface). */
    base: Float32Array;
    /** Top of whatever light bounces off: max(terrain, water surface, props / rocks). */
    surf: Float32Array;
    /** Surface albedo (linear rgb, interleaved). */
    albedo: Float32Array;
    /** Tree / bush canopy: bottom and top height (m), extinction (1/m), albedo (rgb interleaved). */
    canopyBottom: Float32Array;
    canopyTop: Float32Array;
    canopySigma: Float32Array;
    canopyAlbedo: Float32Array;
};

export type BounceRequest =
    | {
          op: 'scene';
          scene: BounceScene;
          /** Probe columns per side (the scene grid is twice as fine). */
          res: number;
          rays: number;
          /** Height the probe ground (C.w) is stored relative to. */
          reference: number;
          /** Direction towards the sun / moon. */
          light: [number, number, number];
      }
    | { op: 'light'; light: [number, number, number] }
    | { op: 'focus'; x: number; z: number }
    | { op: 'pause'; paused: boolean };

export type BounceTile = {
    x0: number;
    z0: number;
    w: number;
    h: number;
    /** Half floats, PROBE_LAYERS × h × w × 4 (layer-major, then rows, then columns). */
    a: Uint16Array;
    b: Uint16Array;
    c: Uint16Array;
};

export type BounceResponse =
    | { op: 'tiles'; tiles: BounceTile[]; remaining: number }
    | {
          op: 'done';
          /** Worker milliseconds spent on the last full update (lighting + probes). */
          ms: number;
          probes: number;
      };

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** IEEE half float bits of a number (round to nearest, clamped to ±65504). */
export function toHalf(value: number): number {
    f32[0] = value;
    const x = u32[0];
    const sign = (x >>> 16) & 0x8000;
    const exp = (x >>> 23) & 0xff;
    let mant = x & 0x7fffff;

    if (exp === 0xff) {
        return sign | 0x7c00 | (mant ? 0x200 : 0);
    }

    let e = exp - 127 + 15;

    if (e >= 0x1f) {
        return sign | 0x7bff;
    }

    if (e <= 0) {
        if (e < -10) {
            return sign;
        }

        mant = (mant | 0x800000) >> (1 - e);

        return sign | ((mant + 0x1000) >> 13);
    }

    const half = sign | (e << 10) | (mant >> 13);

    // Round to nearest (carries into the exponent correctly).
    return mant & 0x1000 ? half + 1 : half;
}
