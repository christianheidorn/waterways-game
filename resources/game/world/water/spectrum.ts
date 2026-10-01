/**
 * Wind wave spectrum shared by the GPU FFT (WebGPU), the sum-of-waves fallback (WebGL 2) and the CPU wave
 * sampler (gameplay / buoyancy): fetch-limited JONSWAP with a cos^2s directional spread, split into three
 * cascades (swell, wind waves, chop) that tile at different sizes.
 *
 * All functions here are pure (no three.js, no GPU), so they are unit tested.
 */
import { mulberry32 } from '../../util/noise';

export const GRAVITY = 9.81;

/** Grid size of every FFT cascade (texels per side). */
export const FFT_SIZE = 256;

export type Cascade = {
    /** Tile size in metres (the cascade repeats every `length` m). */
    length: number;
    /** Wavenumber band this cascade carries (rad/m): [kMin, kMax). */
    kMin: number;
    kMax: number;
};

/**
 * Swell / wind waves / chop. Each cascade only carries the wavenumbers the coarser one cannot resolve
 * (its band starts ~6 wavelengths per tile of the next), so the three sum to one continuous spectrum.
 */
export const CASCADES: readonly Cascade[] = (() => {
    const lengths = [192, 28, 6];
    const boundary = (l: number) => ((Math.PI * 2) / l) * 6;

    return lengths.map((length, i) => ({
        length,
        kMin: i === 0 ? 0.0001 : boundary(length),
        kMax: i + 1 < lengths.length ? boundary(lengths[i + 1]) : (Math.PI * FFT_SIZE) / length,
    }));
})();

/** Fetch used for the sea (and "unlimited" bodies): fully developed for any game wind. */
export const OPEN_FETCH = 200_000;

/** Wind strength setting (0-2, environment wind_strength / the weather's gusting wind) → wind speed at 10 m (m/s). */
export function windSpeed(strength: number): number {
    return 0.6 + Math.max(0, strength) * 9.4;
}

export type SpectrumParams = {
    /** Wind speed at 10 m (m/s). */
    wind: number;
    /** Fetch: distance over water the wind has blown (m). */
    fetch: number;
    /** Peak enhancement (JONSWAP gamma, 3.3 for a young sea). */
    gamma?: number;
};

/** Peak angular frequency (rad/s) of a fetch-limited JONSWAP sea, capped at a fully developed sea. */
export function peakOmega(p: SpectrumParams): number {
    const u = Math.max(0.3, p.wind);
    const f = Math.max(10, p.fetch);
    const limited = 22 * Math.pow((GRAVITY * GRAVITY) / (u * f), 1 / 3);
    // Pierson–Moskowitz (fully developed) peak: ω = 0.855 g / U.
    const developed = (0.855 * GRAVITY) / u;

    return Math.max(limited, developed);
}

/** JONSWAP frequency spectrum S(ω) (m²·s/rad). */
export function jonswap(omega: number, p: SpectrumParams): number {
    if (omega <= 0) {
        return 0;
    }

    const u = Math.max(0.3, p.wind);
    const f = Math.max(10, p.fetch);
    const wp = peakOmega(p);
    // Fetch-limited Phillips constant (more energy in the tail of a young, short-fetch sea).
    const alpha = 0.076 * Math.pow((u * u) / (f * GRAVITY), 0.22);
    const gamma = p.gamma ?? 3.3;
    const sigma = omega <= wp ? 0.07 : 0.09;
    const r = Math.exp(-((omega - wp) ** 2) / (2 * sigma * sigma * wp * wp));

    return (
        ((alpha * GRAVITY * GRAVITY) / Math.pow(omega, 5)) *
        Math.exp(-1.25 * Math.pow(wp / omega, 4)) *
        Math.pow(gamma, r)
    );
}

/** Deep water dispersion: ω(k). */
export function dispersion(k: number): number {
    return Math.sqrt(GRAVITY * k);
}

/**
 * Directional spread D(θ) (∫ D dθ = 1 over -π..π), narrow near the peak and wider for short waves
 * (Mitsuyasu-like spreading exponent), with a little energy travelling against the wind.
 */
export function spread(theta: number, omega: number, wp: number): number {
    const ratio = omega / wp;
    const s = ratio < 1 ? 6.97 * Math.pow(ratio, 4.06) : 9.77 * Math.pow(ratio, -2.33);
    const sc = Math.min(20, Math.max(1.5, s));
    // Normalised cos^2s(θ/2); the 2s+1 gamma ratio is approximated (exact to ~1 % for s ≥ 1).
    const norm = Math.sqrt(sc / Math.PI) * (1 + 1 / (8 * sc)) * 0.5;
    const c = Math.abs(Math.cos(theta / 2));

    return norm * Math.pow(c, 2 * sc) + 0.015;
}

/** Variance (m²) of the surface elevation between two wavenumbers (∫ S(ω) dω over the band). */
export function bandEnergy(p: SpectrumParams, kMin: number, kMax: number): number {
    const w0 = dispersion(Math.max(1e-4, kMin));
    const w1 = dispersion(kMax);
    const steps = 160;
    // Integrate in log ω (the spectrum spans decades).
    const l0 = Math.log(w0);
    const l1 = Math.log(w1);
    let sum = 0;

    for (let i = 0; i < steps; i++) {
        const w = Math.exp(l0 + ((i + 0.5) / steps) * (l1 - l0));
        sum += jonswap(w, p) * w;
    }

    return (sum * (l1 - l0)) / steps;
}

/** Significant wave height (m) of a sea state: 4·√variance. */
export function significantHeight(p: SpectrumParams): number {
    return 4 * Math.sqrt(bandEnergy(p, 1e-3, 400));
}

/**
 * Per-cascade amplitude multipliers that turn the reference spectrum (the GPU's) into a body's own:
 * √(energy of the body's sea state in the band / energy of the reference sea in the band). A small pond
 * gets almost no swell or wind waves but keeps its chop.
 */
export function cascadeWeights(body: SpectrumParams, reference: SpectrumParams): [number, number, number] {
    return CASCADES.map((c) => {
        const ref = bandEnergy(reference, c.kMin, c.kMax);
        const own = bandEnergy(body, c.kMin, c.kMax);

        return ref > 1e-12 ? Math.min(3, Math.sqrt(own / ref)) : 0;
    }) as [number, number, number];
}

export type CascadeSpectrum = {
    /**
     * Per texel (row-major, FFT_SIZE²): h0(k).re, h0(k).im, conj(h0(-k)).re, conj(h0(-k)).im, where texel
     * (x, y) holds k = 2π/L · (x - N/2, y - N/2).
     */
    h0: Float32Array;
};

/**
 * Initial spectrum amplitudes h0(k) of one cascade (Tessendorf): complex Gaussian noise (fixed seed, so
 * regenerating for a new wind keeps every wave's phase) scaled by √(S(k) Δk²) / 2, restricted to the
 * cascade's band. Wind direction (x, z) is the direction the wind blows towards.
 */
export function cascadeSpectrum(
    cascadeIndex: number,
    p: SpectrumParams,
    windDir: [number, number],
    size = FFT_SIZE,
): CascadeSpectrum {
    const c = CASCADES[cascadeIndex];
    const n = size;
    const dk = (Math.PI * 2) / c.length;
    const wp = peakOmega(p);
    const windAngle = Math.atan2(windDir[1], windDir[0]);
    const rand = mulberry32(9137 + cascadeIndex * 7919);
    const noise = new Float32Array(n * n * 2);

    for (let i = 0; i < n * n; i++) {
        // Box–Muller.
        const u1 = Math.max(1e-9, rand());
        const u2 = rand();
        const r = Math.sqrt(-2 * Math.log(u1));
        noise[i * 2] = r * Math.cos(Math.PI * 2 * u2);
        noise[i * 2 + 1] = r * Math.sin(Math.PI * 2 * u2);
    }

    const amp = new Float32Array(n * n);

    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            const kx = (x - n / 2) * dk;
            const kz = (y - n / 2) * dk;
            const k = Math.hypot(kx, kz);

            if (k < c.kMin || k >= c.kMax || k < 1e-6) {
                continue;
            }

            const omega = dispersion(k);
            const dOmegaDk = GRAVITY / (2 * omega);
            const theta = Math.atan2(kz, kx) - windAngle;
            // S(kx, kz) = S(ω) · D(θ) · dω/dk / k.
            const s = (jonswap(omega, p) * spread(theta, omega, wp) * dOmegaDk) / k;
            // Very short ripples (below ~2 cm) damped.
            const damp = Math.exp(-k * k * 0.0001);
            // E|h0|² = S Δk² / 2: with its conjugate partner each k then carries S Δk² of variance.
            amp[y * n + x] = (Math.sqrt(s * dk * dk) / 2) * damp;
        }
    }

    const h0 = new Float32Array(n * n * 4);

    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            const i = y * n + x;
            // -k lives at (N - x, N - y) (mod N).
            const mx = (n - x) % n;
            const my = (n - y) % n;
            const j = my * n + mx;
            h0[i * 4] = noise[i * 2] * amp[i];
            h0[i * 4 + 1] = noise[i * 2 + 1] * amp[i];
            h0[i * 4 + 2] = noise[j * 2] * amp[j];
            h0[i * 4 + 3] = -noise[j * 2 + 1] * amp[j];
        }
    }

    return { h0 };
}

/** One travelling wave of the sum-of-waves approximation. */
export type WaveComponent = {
    /** Wave vector (rad/m): direction of travel × wavenumber. */
    kx: number;
    kz: number;
    /** Amplitude (m) and phase at t = 0. */
    amp: number;
    phase: number;
    omega: number;
    /** Cascade (0 swell, 1 wind, 2 chop): the per-body weight that scales it. */
    cascade: number;
};

/**
 * The strongest waves of each cascade's spectrum as individual sine waves, with the GPU's own phases:
 * their sum approximates the FFT surface (the long, visible waves match; the fine chop is left out).
 * Used for the WebGL 2 surface and for the CPU wave sampler.
 */
export function dominantComponents(
    spectra: CascadeSpectrum[],
    perCascade: readonly number[],
    size = FFT_SIZE,
): WaveComponent[] {
    const out: WaveComponent[] = [];

    spectra.forEach((spec, ci) => {
        const c = CASCADES[ci];
        const dk = (Math.PI * 2) / c.length;
        const n = size;
        const candidates: { i: number; a: number }[] = [];

        for (let i = 0; i < n * n; i++) {
            // Each wave is h0(k) with its conjugate partner at -k: rank by the k-side amplitude.
            const a = Math.hypot(spec.h0[i * 4], spec.h0[i * 4 + 1]);

            if (a > 0) {
                candidates.push({ i, a });
            }
        }

        candidates.sort((p, q) => q.a - p.a);
        const take = candidates.slice(0, perCascade[ci] ?? 0);
        // Energy of the waves left out goes into the kept ones (same variance, fewer waves).
        const total = candidates.reduce((s, q) => s + q.a * q.a, 0);
        const kept = take.reduce((s, q) => s + q.a * q.a, 0);
        const boost = kept > 0 ? Math.sqrt(Math.min(4, total / kept)) : 1;

        for (const { i, a } of take) {
            const x = i % n;
            const y = Math.floor(i / n);
            const kx = (x - n / 2) * dk;
            const kz = (y - n / 2) * dk;
            const k = Math.hypot(kx, kz);
            // The GPU evolves h(k,t) = h0(k) e^{-iωt} + conj(h0(-k)) e^{iωt}: the h0(k) term and its
            // conjugate at -k sum to 2|h0| cos(k·x - ωt + arg h0), a wave travelling along +k.
            // (0.7: the boosted few waves read peakier than the full spectrum; tempered to match by eye.)
            out.push({
                kx,
                kz,
                amp: 2 * a * boost * 0.7,
                phase: Math.atan2(spec.h0[i * 4 + 1], spec.h0[i * 4]),
                omega: dispersion(k),
                cascade: ci,
            });
        }
    });

    return out;
}
