/**
 * Seeded 2D simplex noise + fractal helpers.
 */

export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;

    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const GRAD = [
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
];

export class SimplexNoise {
    private perm = new Uint8Array(512);

    constructor(seed = 1337) {
        const random = mulberry32(seed);
        const p = new Uint8Array(256);

        for (let i = 0; i < 256; i++) {
            p[i] = i;
        }

        for (let i = 255; i > 0; i--) {
            const j = Math.floor(random() * (i + 1));
            [p[i], p[j]] = [p[j], p[i]];
        }

        for (let i = 0; i < 512; i++) {
            this.perm[i] = p[i & 255];
        }
    }

    /** Returns noise in roughly [-1, 1]. */
    noise2D(x: number, y: number): number {
        const perm = this.perm;
        const s = (x + y) * F2;
        const i = Math.floor(x + s);
        const j = Math.floor(y + s);
        const t = (i + j) * G2;
        const x0 = x - (i - t);
        const y0 = y - (j - t);
        const i1 = x0 > y0 ? 1 : 0;
        const j1 = x0 > y0 ? 0 : 1;
        const x1 = x0 - i1 + G2;
        const y1 = y0 - j1 + G2;
        const x2 = x0 - 1 + 2 * G2;
        const y2 = y0 - 1 + 2 * G2;
        const ii = i & 255;
        const jj = j & 255;

        let n = 0;
        let t0 = 0.5 - x0 * x0 - y0 * y0;

        if (t0 > 0) {
            const g = GRAD[perm[ii + perm[jj]] & 7];
            t0 *= t0;
            n += t0 * t0 * (g[0] * x0 + g[1] * y0);
        }

        let t1 = 0.5 - x1 * x1 - y1 * y1;

        if (t1 > 0) {
            const g = GRAD[perm[ii + i1 + perm[jj + j1]] & 7];
            t1 *= t1;
            n += t1 * t1 * (g[0] * x1 + g[1] * y1);
        }

        let t2 = 0.5 - x2 * x2 - y2 * y2;

        if (t2 > 0) {
            const g = GRAD[perm[ii + 1 + perm[jj + 1]] & 7];
            t2 *= t2;
            n += t2 * t2 * (g[0] * x2 + g[1] * y2);
        }

        return 70 * n;
    }

    /** Fractal Brownian motion, result roughly in [-1, 1]. */
    fbm(x: number, y: number, octaves = 5, lacunarity = 2, gain = 0.5): number {
        let amp = 1;
        let freq = 1;
        let sum = 0;
        let norm = 0;

        for (let o = 0; o < octaves; o++) {
            sum += amp * this.noise2D(x * freq, y * freq);
            norm += amp;
            amp *= gain;
            freq *= lacunarity;
        }

        return sum / norm;
    }

    /** Ridged multifractal in [0, 1]. */
    ridged(
        x: number,
        y: number,
        octaves = 5,
        lacunarity = 2,
        gain = 0.5,
    ): number {
        let amp = 0.5;
        let freq = 1;
        let sum = 0;
        let weight = 1;

        for (let o = 0; o < octaves; o++) {
            let n = 1 - Math.abs(this.noise2D(x * freq, y * freq));
            n *= n * weight;
            weight = Math.min(1, Math.max(0, n * 2));
            sum += n * amp;
            amp *= gain;
            freq *= lacunarity;
        }

        return Math.min(1, sum);
    }
}
