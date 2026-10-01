import * as THREE from 'three/webgpu';
import type { GameRenderer } from '../../core/renderer';
import {
    CASCADES,
    cascadeSpectrum,
    cascadeWeights,
    dominantComponents,
    FFT_SIZE,
    OPEN_FETCH,
    windSpeed,
} from './spectrum';
import type {
    CascadeSpectrum,
    SpectrumParams,
    WaveComponent,
} from './spectrum';
import { WaveFFT } from './WaveFFT';
import type { WaterBody } from './bodySegmentation';
import { bodyFetch } from './bodySegmentation';

/** Waves of the sum-of-waves surface (WebGL 2) and the CPU sampler, per cascade. */
export const COMPONENTS_PER_CASCADE = [6, 8, 8] as const;
export const COMPONENT_COUNT = COMPONENTS_PER_CASCADE.reduce(
    (a, b) => a + b,
    0,
);

/** Waves calm down towards the shore: amplitude factor by water depth (m). Shared with the shader. */
export function shoreFade(depth: number): number {
    const t = Math.min(1, Math.max(0, (depth - 0.25) / (2.5 - 0.25)));

    return t * t * (3 - 2 * t);
}

/** Where a wind-wave sample is taken (see WaveField.sample). */
export type WaveSample = {
    /** Wave height above the still level (m). */
    height: number;
    /** Surface normal. */
    normal: THREE.Vector3;
    /** Water velocity at the surface (m/s): orbital motion of the waves (x, y, z). River flow is added by Water. */
    velocity: THREE.Vector3;
};

/**
 * The wind waves: their spectrum for the current wind (fetch-limited per water body), the GPU FFT on
 * WebGPU, and the strongest waves as a sum of sines (the WebGL 2 surface and the CPU sampler).
 *
 * The GPU carries one reference spectrum (the wind over the largest fetch); each body scales its three
 * cascades by weights from its own fetch-limited sea state (see cascadeWeights), wind exposure and wave
 * height setting, so a sheltered pond only ripples while a long lake builds proper wind waves.
 */
export class WaveField {
    fft: WaveFFT | null = null;
    components: WaveComponent[] = [];
    /** Mean square slope per cascade of the reference spectrum (for sub-pixel roughness). */
    readonly slopeVariance: [number, number, number] = [0, 0, 0];
    /** Version, bumped whenever the spectrum (and so weights / components) changed. */
    version = 0;
    reference: SpectrumParams = { wind: windSpeed(0.4), fetch: 1000 };
    /** Smoothed wind strength (0-2) and direction (x, z towards). */
    private wind = 0.4;
    private windTarget = 0.4;
    readonly windDir = new THREE.Vector2(0.8, 0.6);
    private readonly windDirTarget = new THREE.Vector2(0.8, 0.6);
    private spectra: CascadeSpectrum[] = [];
    private built: { wind: number; dir: THREE.Vector2; fetch: number } | null =
        null;
    /** Pending regeneration, one cascade per frame. */
    private pending: {
        cascade: number;
        params: SpectrumParams;
        dir: [number, number];
        out: CascadeSpectrum[];
    } | null = null;
    private maxFetch = 1000;
    private readonly weightCache = new Map<
        WaterBody | null,
        [number, number, number]
    >();
    private time = 0;

    /** WebGPU: run the FFT (null: sum of sines only). */
    setFft(enabled: boolean): void {
        if (enabled && !this.fft) {
            this.fft = new WaveFFT();

            if (this.spectra.length === CASCADES.length) {
                this.fft.setSpectra(this.spectra);
            }
        } else if (!enabled && this.fft) {
            this.fft.dispose();
            this.fft = null;
        }
    }

    /** Weather wind (strength 0-2, gusting) and the direction it blows towards. */
    setWind(strength: number, dirX: number, dirZ: number): void {
        this.windTarget = Math.max(0, strength);
        const len = Math.hypot(dirX, dirZ);

        if (len > 1e-4) {
            this.windDirTarget.set(dirX / len, dirZ / len);
        }
    }

    /** Largest fetch on the map (m): sizes the reference spectrum. */
    setMaxFetch(fetch: number): void {
        this.maxFetch = Math.max(20, Math.min(OPEN_FETCH, fetch));
    }

    get windStrength(): number {
        return this.wind;
    }

    /** Smooths the wind and regenerates the spectrum when it changed noticeably (spread over frames). */
    update(dt: number, renderer: GameRenderer | null): void {
        this.time += dt;
        // The sea state follows the wind slowly (gusts only modulate the ripples, see the material).
        const k = 1 - Math.exp(-dt / 6);
        this.wind += (this.windTarget - this.wind) * k;
        this.windDir.lerp(this.windDirTarget, k).normalize();

        if (this.pending) {
            const p = this.pending;
            p.out.push(cascadeSpectrum(p.cascade, p.params, p.dir));
            p.cascade++;

            if (p.cascade === CASCADES.length) {
                this.applySpectra(p.out, p.params);
                this.pending = null;
            }
        } else if (this.needsRebuild()) {
            this.built = {
                wind: this.wind,
                dir: this.windDir.clone(),
                fetch: this.maxFetch,
            };
            this.pending = {
                cascade: 0,
                params: { wind: windSpeed(this.wind), fetch: this.maxFetch },
                dir: [this.windDir.x, this.windDir.y],
                out: [],
            };

            // The very first spectrum is built at once (no flat water on load).
            if (!this.spectra.length) {
                while (this.pending.cascade < CASCADES.length) {
                    this.pending.out.push(
                        cascadeSpectrum(
                            this.pending.cascade,
                            this.pending.params,
                            this.pending.dir,
                        ),
                    );
                    this.pending.cascade++;
                }

                this.applySpectra(this.pending.out, this.pending.params);
                this.pending = null;
            }
        }

        if (renderer && this.fft) {
            this.fft.update(renderer, this.time, dt);
        }
    }

    get elapsed(): number {
        return this.time;
    }

    /**
     * Cascade weights of a body (null: the open sea outside the map) for the current wind: its own
     * fetch-limited sea state relative to the reference, × wind exposure × wave height setting.
     */
    weights(
        body: WaterBody | null,
        heightScale: number,
    ): [number, number, number] {
        const cached = this.weightCache.get(body);

        if (cached) {
            return cached.map((w) => w * heightScale) as [
                number,
                number,
                number,
            ];
        }

        const exposure = body ? body.settings.wind_exposure : 1;
        const fetch = body
            ? bodyFetch(body, this.windDir.x, this.windDir.y, OPEN_FETCH)
            : OPEN_FETCH;
        const own: SpectrumParams = {
            wind: windSpeed(this.wind * exposure),
            fetch,
        };
        const w = cascadeWeights(own, this.reference).map(
            (v) => v * (body ? body.settings.wave_height : 1),
        ) as [number, number, number];
        this.weightCache.set(body, w);

        return w.map((v) => v * heightScale) as [number, number, number];
    }

    /** Forget cached body weights (body settings changed). */
    invalidateWeights(): void {
        this.weightCache.clear();
    }

    /**
     * CPU wave sample at a world position: the sum of the dominant waves (the GPU's long waves exactly on
     * WebGL 2, an approximation of the FFT surface on WebGPU), with horizontal choppiness, weighted per
     * cascade. `weights` and `chop` come from the water body there; `fade` from shoreFade(depth).
     */
    sample(
        x: number,
        z: number,
        weights: readonly [number, number, number],
        chop: number,
        fade: number,
        out: WaveSample,
        time = this.time,
    ): WaveSample {
        out.height = 0;
        out.normal.set(0, 1, 0);
        out.velocity.set(0, 0, 0);

        if (fade <= 0 || !this.components.length) {
            return out;
        }

        // The surface point above (x, z) started at p and was pushed horizontally: two fixed-point steps.
        let px = x;
        let pz = z;

        for (let iter = 0; iter < 2; iter++) {
            let dx = 0;
            let dz = 0;

            for (const c of this.components) {
                const a = c.amp * weights[c.cascade] * fade;
                const k = Math.hypot(c.kx, c.kz);
                const s = Math.sin(
                    c.kx * px + c.kz * pz - c.omega * time + c.phase,
                );
                dx -= (chop * a * c.kx * s) / k;
                dz -= (chop * a * c.kz * s) / k;
            }

            px = x - dx;
            pz = z - dz;
        }

        let h = 0;
        let sx = 0;
        let sz = 0;
        let jx = 1;
        let jz = 1;

        for (const c of this.components) {
            const a = c.amp * weights[c.cascade] * fade;
            const k = Math.hypot(c.kx, c.kz);
            const phi = c.kx * px + c.kz * pz - c.omega * time + c.phase;
            const cs = Math.cos(phi);
            const sn = Math.sin(phi);
            h += a * cs;
            sx -= a * c.kx * sn;
            sz -= a * c.kz * sn;
            jx -= (chop * a * c.kx * c.kx * cs) / k;
            jz -= (chop * a * c.kz * c.kz * cs) / k;
            // Orbital velocity: up/down ∂h/∂t, forwards under the crest.
            out.velocity.x += (a * c.omega * cs * c.kx) / k;
            out.velocity.z += (a * c.omega * cs * c.kz) / k;
            out.velocity.y += a * c.omega * sn;
        }

        out.height = h;
        out.normal
            .set(-sx / Math.max(0.2, jx), 1, -sz / Math.max(0.2, jz))
            .normalize();

        return out;
    }

    dispose(): void {
        this.fft?.dispose();
        this.fft = null;
    }

    private needsRebuild(): boolean {
        const b = this.built;

        if (!b) {
            return true;
        }

        const windChange =
            Math.abs(this.wind - b.wind) / Math.max(0.15, b.wind);
        const angle = Math.acos(
            Math.min(1, Math.max(-1, this.windDir.dot(b.dir))),
        );

        return (
            windChange > 0.12 ||
            angle > 0.14 ||
            Math.abs(Math.log(this.maxFetch / b.fetch)) > 0.2
        );
    }

    private applySpectra(
        spectra: CascadeSpectrum[],
        params: SpectrumParams,
    ): void {
        this.spectra = spectra;
        this.reference = params;
        this.components = dominantComponents(spectra, COMPONENTS_PER_CASCADE);
        this.fft?.setSpectra(spectra);

        spectra.forEach((s, ci) => {
            const dk = (Math.PI * 2) / CASCADES[ci].length;
            let mss = 0;

            for (let y = 0; y < FFT_SIZE; y++) {
                for (let x = 0; x < FFT_SIZE; x++) {
                    const i = (y * FFT_SIZE + x) * 4;
                    const k2 =
                        ((x - FFT_SIZE / 2) ** 2 + (y - FFT_SIZE / 2) ** 2) *
                        dk *
                        dk;
                    mss +=
                        (s.h0[i] ** 2 +
                            s.h0[i + 1] ** 2 +
                            s.h0[i + 2] ** 2 +
                            s.h0[i + 3] ** 2) *
                        k2;
                }
            }

            this.slopeVariance[ci] = mss;
        });

        this.weightCache.clear();
        this.version++;
    }
}
