/**
 * Beach surf, the model (CPU reference; Surf.ts builds the same in TSL for the GPU):
 *
 * - Shoaling: wave trains travel up the shore distance field. On a beach of slope m the depth is
 *   ~m·d at distance d, the shallow-water speed √(g·h), so the travel time to the shore is
 *   τ(d) = 2√(d / (g·m)) (capped by the deep-water speed g·T / 2π farther out). The phase t/T + τ/T
 *   makes crests parallel to the coast that slow down and close up towards it.
 * - Height: Green's law (H ∝ h^-¼) from the deep-water height until H > γ·h (γ = 0.8): the wave
 *   breaks and the bore that runs on carries H = γ·h, i.e. it dies down towards the shore. Unbroken
 *   crests sharpen as they grow (cos^p), broken ones turn into a sawtooth bore with a steep front.
 * - Swash: each bore runs up the sand to R = H₀·(0.75ξ + 0.25) above the still level (ξ: Iribarren
 *   number m / √(H₀/L₀)), quickly, then drains back over the rest of the period; the sand it leaves
 *   stays glossy for a while and darker below the usual run-up.
 * - Wave groups and an alongshore variation keep sets of bigger waves and the crest lines irregular.
 */

export const GRAVITY = 9.81;
/** Breaker index: waves break when higher than this × the depth. */
export const BREAKER = 0.8;
/** Phase width of a bore's front face. */
export const BORE_FRONT = 0.1;
/** Share of the swash cycle running up (the rest drains back). */
export const UPRUSH = 0.3;
export const MIN_SLOPE = 0.015;
export const MAX_SLOPE = 0.3;

export type SurfWaveParams = {
    /** Wave height offshore (m, × group / strength applied by the caller). */
    height: number;
    period: number;
    /** Beach slope (rise / run). */
    slope: number;
};

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const smoothstep = (a: number, b: number, v: number) => {
    const t = clamp((v - a) / (b - a), 0, 1);

    return t * t * (3 - 2 * t);
};
const fract = (v: number) => v - Math.floor(v);

/** Smooth alongshore variation (-1..1), the same on the GPU. */
export function alongshore(x: number, z: number): number {
    return (
        0.5 * Math.sin(x * 0.037 + 1.7 * Math.sin(z * 0.021)) +
        0.5 * Math.sin(z * 0.031 - x * 0.019 + 2.3 * Math.sin(x * 0.013))
    );
}

/** Travel time (s) of a crest from distance d (m) to the shore. */
export function shoreTravelTime(d: number, period: number, slope: number) {
    const m = clamp(slope, MIN_SLOPE, MAX_SLOPE);
    const c0 = (GRAVITY * period) / (2 * Math.PI);
    const sStar = (c0 * c0) / (GRAVITY * m);
    const dd = Math.max(d, 0);

    return dd < sStar
        ? 2 * Math.sqrt(dd / (GRAVITY * m))
        : (2 * c0) / (GRAVITY * m) + (dd - sStar) / c0;
}

/** Wave-group factor (sets of bigger waves travelling in with the crests). */
export function waveGroup(
    time: number,
    tau: number,
    period: number,
    along: number,
) {
    return (
        0.72 +
        0.28 *
            Math.sin((2 * Math.PI * (time + tau)) / (6.3 * period) + 4 * along)
    );
}

export type SurfWaveSample = {
    /** Surface elevation (m) and its derivative along the distance to the shore. */
    eta: number;
    detaDd: number;
    /** Wave height there (m), breaking (0-1), phase (0-1, crest at 0). */
    height: number;
    breaking: number;
    phase: number;
};

/** Phase of the waves at distance d (0-1; the crest passes at 0). */
export function surfPhase(
    d: number,
    time: number,
    along: number,
    p: SurfWaveParams,
): number {
    return fract(
        time / p.period +
            shoreTravelTime(d, p.period, p.slope) / p.period +
            0.12 * along,
    );
}

function profile(u: number, ratio: number, breaking: number): number {
    const pw = 1 + 2 * smoothstep(0.3, 1, ratio);
    const peak =
        Math.pow(Math.max(1e-4, 0.5 + 0.5 * Math.cos(2 * Math.PI * u)), pw) -
        0.5 / Math.pow(pw, 0.6);
    const bore =
        (u < 1 - BORE_FRONT
            ? 1 - u / (1 - BORE_FRONT)
            : (u - (1 - BORE_FRONT)) / BORE_FRONT) - 0.5;

    return peak + (bore - peak) * breaking;
}

/** The surf wave at distance d (m, > 0 in the water) over `depth` m of water. */
export function surfWave(
    d: number,
    depth: number,
    time: number,
    along: number,
    p: SurfWaveParams,
    reach: number,
): SurfWaveSample {
    const at = (dd: number) => {
        const m = clamp(p.slope, MIN_SLOPE, MAX_SLOPE);
        const c0 = (GRAVITY * p.period) / (2 * Math.PI);
        const tau = shoreTravelTime(dd, p.period, p.slope);
        const u = fract(time / p.period + tau / p.period + 0.12 * along);
        const h = clamp(Math.min(depth, Math.max(dd, 0) * m), 0.02, 1e4);
        const hs = (c0 * c0) / GRAVITY;
        const ks = clamp(Math.pow(hs / h, 0.25), 1, 2.2);
        const h0 =
            p.height *
            waveGroup(time, tau, p.period, along) *
            smoothstep(reach, reach * 0.6, dd);
        const hu = h0 * ks;
        const ratio = hu / (BREAKER * h);
        const breaking = smoothstep(0.8, 1.05, ratio);
        const height = Math.min(hu, BREAKER * h);

        return {
            eta: height * profile(u, ratio, breaking),
            height,
            breaking,
            phase: u,
        };
    };
    const c = at(d);
    const delta = 0.3;

    return {
        ...c,
        detaDd: (at(d + delta).eta - at(d - delta).eta) / (2 * delta),
    };
}

export type SwashSample = {
    /** Height the swash reaches above the still level now (m) and its typical maximum. */
    reach: number;
    runup: number;
    /** Phase of the swash cycle (0 = the bore arrives). */
    phase: number;
};

/** The swash on the beach: how high above the still level it is now. */
export function swash(
    time: number,
    along: number,
    p: SurfWaveParams,
): SwashSample {
    const m = clamp(p.slope, MIN_SLOPE, MAX_SLOPE);
    const c0 = (GRAVITY * p.period) / (2 * Math.PI);
    const l0 = c0 * p.period;
    const typical = p.height;
    const h0 = p.height * waveGroup(time, 0, p.period, along);
    const xi = m / Math.sqrt(Math.max(h0, 0.01) / l0);
    const runupOf = (h: number) => h * clamp(0.75 * xi + 0.25, 0.3, 1.4);
    const u = fract(time / p.period + 0.12 * along);
    const r =
        u < UPRUSH
            ? 1 - (1 - u / UPRUSH) ** 2
            : 1 - (u - UPRUSH) / (1 - UPRUSH);
    const runup = runupOf(h0);

    return {
        reach: runup * r - 0.05 * runup,
        runup: runupOf(typical),
        phase: u,
    };
}
