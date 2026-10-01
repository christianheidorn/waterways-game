import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { measureCoverage } from '../util/alphaCoverage';
import { extractCardMatte } from './cardMatte';
import type { RawImage } from './cardMatte';

/**
 * Synthetic foliage cards: one plant (stem + leaves, shaded greens with dark undersides) composited
 * over different backgrounds, as image models return them. The matte must recover the plant's
 * silhouette (intersection over union with the ground truth) and never ship an opaque box.
 */
const W = 256;
const H = 256;

type Plant = {
    /** Coverage 0-1 per pixel (4×4 supersampled). */
    alpha: Float32Array;
    /** Straight colour per pixel. */
    color: Float32Array;
};

function rand(seed: number): () => number {
    let s = seed >>> 0;

    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;

        return s / 2 ** 32;
    };
}

function makePlant(): Plant {
    const leaves: {
        cx: number;
        cy: number;
        a: number;
        rx: number;
        ry: number;
        shade: number;
    }[] = [];
    const r = rand(7);

    for (let i = 0; i < 11; i++) {
        const t = i / 10;
        leaves.push({
            cx: 128 + (i % 2 ? 1 : -1) * (18 + r() * 22),
            cy: 220 - t * 160,
            a: (i % 2 ? -1 : 1) * (0.5 + r() * 0.5),
            rx: 30 - t * 10,
            ry: 9 + r() * 3,
            shade: 0.35 + r() * 0.65,
        });
    }

    const alpha = new Float32Array(W * H);
    const color = new Float32Array(W * H * 3);
    const ss = 4;

    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            let hit = 0;
            let shade = 0;

            for (let sy = 0; sy < ss; sy++) {
                for (let sx = 0; sx < ss; sx++) {
                    const px = x + (sx + 0.5) / ss;
                    const py = y + (sy + 0.5) / ss;
                    let s = -1;

                    // Stem.
                    if (Math.abs(px - 128) < 2.5 && py > 50 && py < 250) {
                        s = 0.45;
                    }

                    for (const leaf of leaves) {
                        const dx = px - leaf.cx;
                        const dy = py - leaf.cy;
                        const u =
                            (dx * Math.cos(leaf.a) + dy * Math.sin(leaf.a)) /
                            leaf.rx;
                        const v =
                            (-dx * Math.sin(leaf.a) + dy * Math.cos(leaf.a)) /
                            leaf.ry;

                        if (u * u + v * v <= 1) {
                            // Darker towards one side (undersides in shade).
                            s = leaf.shade * (0.6 + 0.4 * (v + 1) * 0.5);
                        }
                    }

                    if (s >= 0) {
                        hit++;
                        shade += s;
                    }
                }
            }

            const i = y * W + x;
            alpha[i] = hit / (ss * ss);

            if (hit) {
                const k = shade / hit;
                color[i * 3] = 60 + 60 * k;
                color[i * 3 + 1] = 130 + 90 * k;
                color[i * 3 + 2] = 40 + 35 * k;
            }
        }
    }

    return { alpha, color };
}

type Background = (x: number, y: number) => [number, number, number];

const flat =
    (r: number, g: number, b: number): Background =>
    () => [r, g, b];

/** Green in the middle fading to black at the corners (the "AI card" look). */
const vignetteOf =
    (r: number, g: number, b: number): Background =>
    (x, y) => {
        const d =
            Math.hypot((x - W / 2) / (W / 2), (y - H / 2) / (H / 2)) /
            Math.SQRT2;
        const k = Math.max(0, 1 - d * 1.15) ** 1.4;

        return [4 + r * k, 6 + g * k, 4 + b * k];
    };
const vignette = vignetteOf(24, 64, 26);
const brightVignette = vignetteOf(42, 100, 46);

/** Studio backdrop: light grey-blue at the top to dark grey at the bottom. */
const gradient: Background = (_x, y) => {
    const t = y / (H - 1);

    return [205 - 120 * t, 212 - 118 * t, 222 - 112 * t];
};

/** Composites the plant; `alphaChannel` = keep the plant's alpha (real transparency) instead of 255. */
function composite(
    plant: Plant,
    bg: Background,
    options: { alphaChannel?: boolean; grain?: number; margin?: number } = {},
): RawImage {
    const data = new Uint8ClampedArray(W * H * 4);
    const noise = rand(11);
    const m = options.margin ?? 0;

    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const i = y * W + x;
            const a = plant.alpha[i];
            const b = bg(x, y);
            const grain = options.grain
                ? (noise() - 0.5) * 2 * options.grain
                : 0;

            for (let c = 0; c < 3; c++) {
                data[i * 4 + c] = options.alphaChannel
                    ? plant.color[i * 3 + c]
                    : a * plant.color[i * 3 + c] + (1 - a) * b[c] + grain;
            }

            const inside = x >= m && y >= m && x < W - m && y < H - m;
            data[i * 4 + 3] = options.alphaChannel
                ? Math.round(a * 255)
                : inside
                  ? 255
                  : 0;
        }
    }

    return { data, width: W, height: H };
}

/**
 * How well the matte (alpha ≥ 0.5) matches the plant, allowing for the 1 px rim the matte choke
 * removes on purpose: `kept` = share of the plant's core (pixels whose 3 × 3 neighbourhood is all
 * plant) that stays opaque; `leaked` = share of the opaque result that is background more than 2 px
 * away from the plant.
 */
function score(
    plant: Plant,
    result: ReturnType<typeof extractCardMatte>,
): { kept: number; leaked: number } {
    const { image, offset } = result;
    const truth = (x: number, y: number) =>
        x >= 0 && y >= 0 && x < W && y < H && plant.alpha[y * W + x] >= 0.5;
    const near = (x: number, y: number, r: number) => {
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                if (truth(x + dx, y + dy)) {
                    return true;
                }
            }
        }

        return false;
    };
    let core = 0;
    let kept = 0;
    let opaque = 0;
    let leaked = 0;

    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const lx = x - offset.x;
            const ly = y - offset.y;
            const got =
                lx >= 0 &&
                ly >= 0 &&
                lx < image.width &&
                ly < image.height &&
                image.data[(ly * image.width + lx) * 4 + 3] >= 128;
            let isCore = true;

            for (let dy = -1; dy <= 1 && isCore; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (!truth(x + dx, y + dy)) {
                        isCore = false;
                        break;
                    }
                }
            }

            core += isCore ? 1 : 0;
            kept += isCore && got ? 1 : 0;
            opaque += got ? 1 : 0;
            leaked += got && !near(x, y, 2) ? 1 : 0;
        }
    }

    return { kept: kept / core, leaked: opaque ? leaked / opaque : 0 };
}

/** CARD_MATTE_DUMP=<dir>: writes inputs and mattes as raw RGBA (`<name>.<w>x<h>.rgba`) to look at. */
function dump(name: string, image: RawImage): void {
    const dir = process.env.CARD_MATTE_DUMP;

    if (dir) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(
                dir,
                `${name.replace(/[^a-z0-9]+/gi, '-')}.${image.width}x${image.height}.rgba`,
            ),
            image.data,
        );
    }
}

describe('card matte', () => {
    const plant = makePlant();

    it.each([
        ['flat black', flat(0, 0, 0), {}, undefined],
        ['dark green → black vignette', vignette, {}, undefined],
        ['bright green → black vignette', brightVignette, {}, undefined],
        ['vignette with grain', brightVignette, { grain: 6 }, undefined],
        ['vertical grey gradient', gradient, {}, undefined],
        ['flat magenta (requested key)', flat(255, 0, 255), {}, '#ff00ff'],
        ['flat white', flat(250, 250, 250), {}, undefined],
    ] as const)('keys a plant on %s', (_name, bg, options, keyColor) => {
        const input = composite(plant, bg, options);
        dump(`${_name} in`, input);
        const result = extractCardMatte(
            { ...input, data: input.data.slice() },
            { keyColor },
        );
        dump(`${_name} out`, result.image);
        const { kept, leaked } = score(plant, result);

        expect(result.keyed).toBe(true);
        expect(result.coverage.ok).toBe(true);
        expect(kept).toBeGreaterThan(0.97);
        expect(leaked).toBeLessThan(0.01);
    });

    it('keeps real alpha as it is', () => {
        const result = extractCardMatte(
            composite(plant, flat(0, 0, 0), { alphaChannel: true }),
            {},
        );

        expect(result.keyed).toBe(false);
        expect(score(plant, result).kept).toBeGreaterThan(0.99);
        expect(score(plant, result).leaked).toBe(0);
    });

    it('keys an opaque card inside a transparent margin', () => {
        const input = composite(plant, vignette, { margin: 6 });
        dump('margin in', input);
        const result = extractCardMatte(
            { ...input, data: input.data.slice() },
            {},
        );
        dump('margin out', result.image);

        expect(result.keyed).toBe(true);
        expect(score(plant, result).kept).toBeGreaterThan(0.97);
        expect(score(plant, result).leaked).toBeLessThan(0.01);
    });

    it('keys an image whose alpha channel is opaque even when keying was not requested', () => {
        const result = extractCardMatte(composite(plant, vignette), {
            keyBackground: false,
        });

        expect(result.keyed).toBe(true);
        expect(score(plant, result).leaked).toBeLessThan(0.01);
    });

    it('keeps a thin stem whose colour is close to the vignette behind it', () => {
        // A 6 px stem only ~30 RGB units from the vignette's centre colour, plus the plant.
        const stemColor = [62, 122, 44];
        const stem: Plant = {
            alpha: plant.alpha.slice(),
            color: plant.color.slice(),
        };

        for (let y = 20; y < H; y++) {
            for (let x = 60; x < 66; x++) {
                const i = y * W + x;
                stem.alpha[i] = 1;
                stem.color.set(stemColor, i * 3);
            }
        }

        const input = composite(stem, brightVignette);
        dump('stem in', input);
        const result = extractCardMatte(
            { ...input, data: input.data.slice() },
            {},
        );
        dump('stem out', result.image);
        let kept = 0;
        let total = 0;

        for (let y = 30; y < H - 10; y++) {
            for (let x = 61; x < 65; x++) {
                const lx = x - result.offset.x;
                const ly = y - result.offset.y;
                total++;
                kept +=
                    result.image.data[(ly * result.image.width + lx) * 4 + 3] >=
                    128
                        ? 1
                        : 0;
            }
        }

        expect(kept / total).toBeGreaterThan(0.95);
        expect(score(stem, result).leaked).toBeLessThan(0.01);
    });

    it('refuses a background it cannot remove instead of shipping a box', () => {
        const noisy = rand(3);
        const busy: Background = () => [
            noisy() * 255,
            noisy() * 255,
            noisy() * 255,
        ];

        expect(() => extractCardMatte(composite(plant, busy), {})).toThrow(
            /background could not be removed/,
        );
    });
});

describe('alpha coverage', () => {
    it('flags opaque octahedral cells and passes cut-out ones', () => {
        const n = 4;
        const cell = 32;
        const size = n * cell;
        const data = new Uint8Array(size * size * 4);

        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const cx = (x % cell) - cell / 2 + 0.5;
                const cy = (y % cell) - cell / 2 + 0.5;
                // A round crown in every view; view 5 is an opaque box.
                const view = Math.floor(y / cell) * n + Math.floor(x / cell);
                const inside = Math.hypot(cx, cy) < cell * 0.4;
                data[(y * size + x) * 4 + 3] = view === 5 || inside ? 255 : 0;
            }
        }

        const report = measureCoverage(data, size, size, 'octahedral', n, n);

        expect(report.ok).toBe(false);
        expect(report.opaque).toEqual([5]);
    });
});
