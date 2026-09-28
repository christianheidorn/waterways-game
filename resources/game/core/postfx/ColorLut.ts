import * as THREE from 'three/webgpu';
import type { ColorGrade } from '../../shared/types';

export const LUT_SIZE = 32;

type Rgb = [number, number, number];

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (a: number, b: number, x: number) => {
    const t = clamp01((x - a) / (b - a));

    return t * t * (3 - 2 * t);
};
const luma = (c: Rgb) => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;

function saturate(c: Rgb, s: number): Rgb {
    const l = luma(c);

    return [mix(l, c[0], s), mix(l, c[1], s), mix(l, c[2], s)];
}

/** Filmic S-curve around a pivot: `k` > 1 adds contrast, highlights and shadows roll off smoothly. */
function sCurve(x: number, k: number, pivot = 0.45): number {
    x = clamp01(x);

    return x < pivot
        ? pivot * Math.pow(x / pivot, k)
        : 1 - (1 - pivot) * Math.pow((1 - x) / (1 - pivot), k);
}

function curve(c: Rgb, k: number, pivot?: number): Rgb {
    return [
        sCurve(c[0], k, pivot),
        sCurve(c[1], k, pivot),
        sCurve(c[2], k, pivot),
    ];
}

/** Lift (raise blacks) / gain (lower whites). */
function levels(c: Rgb, lift: number, gain = 1): Rgb {
    return c.map((v) => lift + v * (gain - lift)) as Rgb;
}

/** Split toning: tint shadows and highlights separately (tints are offsets around grey). */
function splitTone(c: Rgb, shadow: Rgb, highlight: Rgb, amount = 1): Rgb {
    const l = luma(c);
    const hs = smooth(0.0, 0.55, l);
    const sw = (1 - hs) * amount;
    const hw = smooth(0.35, 1.0, l) * amount;

    return [
        c[0] + shadow[0] * sw + highlight[0] * hw,
        c[1] + shadow[1] * sw + highlight[1] * hw,
        c[2] + shadow[2] * sw + highlight[2] * hw,
    ];
}

function rgbToHsv(c: Rgb): Rgb {
    const [r, g, b] = c;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;

    if (d > 1e-6) {
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h /= 6;

        if (h < 0) h += 1;
    }

    return [h, max > 0 ? d / max : 0, max];
}

function hsvToRgb(c: Rgb): Rgb {
    const [h, s, v] = c;
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);

    switch (((i % 6) + 6) % 6) {
        case 0:
            return [v, t, p];
        case 1:
            return [q, v, p];
        case 2:
            return [p, v, t];
        case 3:
            return [p, q, v];
        case 4:
            return [t, p, v];
        default:
            return [v, p, q];
    }
}

/** Weight of hue `h` (0-1) inside a soft band centred on `center` (degrees) with half-width `width`. */
function hueBand(h: number, center: number, width: number): number {
    let d = Math.abs(h * 360 - center);
    d = Math.min(d, 360 - d);

    return 1 - smooth(width * 0.5, width, d);
}

/** Moves hues in a band towards `to` degrees and scales their saturation. */
function hueShift(
    c: Rgb,
    center: number,
    width: number,
    to: number,
    shift: number,
    sat = 1,
): Rgb {
    const hsv = rgbToHsv(c);
    const w = hueBand(hsv[0], center, width) * smooth(0.02, 0.2, hsv[1]);

    if (w <= 0) {
        return c;
    }

    let d = to - hsv[0] * 360;
    d = ((((d + 180) % 360) + 360) % 360) - 180;
    hsv[0] = ((((hsv[0] * 360 + d * shift * w) % 360) + 360) % 360) / 360;
    hsv[1] = clamp01(hsv[1] * mix(1, sat, w));

    return hsvToRgb(hsv);
}

/** Display-referred (sRGB-encoded, 0-1) grade functions: input → output. */
const GRADES: Record<Exclude<ColorGrade, 'neutral'>, (c: Rgb) => Rgb> = {
    // Gentle filmic contrast, a touch of density in the shadows and warm/cool separation.
    filmic: (c) => {
        c = curve(c, 1.18, 0.42);
        c = splitTone(c, [-0.012, 0.0, 0.018], [0.018, 0.008, -0.012]);
        c = saturate(c, 1.06);

        return levels(c, 0.012, 0.985);
    },
    // Low sun: warm, golden highlights, rose-tinted shadows, soft contrast, richer colour.
    golden_hour: (c) => {
        c = [c[0] * 1.06, c[1] * 1.0, c[2] * 0.88];
        c = splitTone(c, [0.035, 0.005, 0.02], [0.08, 0.03, -0.08]);
        c = hueShift(c, 60, 50, 42, 0.35, 1.1);
        c = saturate(c, 1.12);
        c = curve(c, 1.08, 0.45);

        return levels(c, 0.015, 1);
    },
    // Blockbuster complementary look: teal shadows and cool hues, orange highlights and warm hues.
    teal_orange: (c) => {
        c = splitTone(c, [-0.05, 0.02, 0.06], [0.08, 0.03, -0.06], 0.9);
        c = hueShift(c, 200, 70, 188, 0.5, 1.15);
        c = hueShift(c, 110, 50, 150, 0.35, 0.9);
        c = hueShift(c, 30, 35, 28, 0.5, 1.15);
        c = curve(c, 1.2, 0.45);

        return saturate(c, 1.05);
    },
    // Storm light: desaturated steel blue, heavier mid-tones, flat highlights.
    cold_storm: (c) => {
        c = saturate(c, 0.55);
        c = [c[0] * 0.93, c[1] * 0.98, c[2] * 1.07];
        c = splitTone(c, [-0.01, 0.005, 0.03], [-0.02, 0.0, 0.02]);
        c = c.map((v) => Math.pow(clamp01(v), 1.1)) as Rgb;
        c = curve(c, 1.1, 0.5);

        return levels(c, 0.02, 0.95);
    },
    // Silver retention: luminance overlaid on a desaturated image, hard contrast, metallic highlights.
    bleach_bypass: (c) => {
        const l = luma(c);
        const overlay = (b: number) =>
            l < 0.5 ? 2 * l * b : 1 - 2 * (1 - l) * (1 - b);
        const o: Rgb = [overlay(c[0]), overlay(c[1]), overlay(c[2])];
        c = [
            mix(c[0], o[0], 0.65),
            mix(c[1], o[1], 0.65),
            mix(c[2], o[2], 0.65),
        ];
        c = saturate(c, 0.45);

        return curve(c, 1.25, 0.45);
    },
    // Old print: faded blacks, rolled-off whites, warm/yellow cast, green-cyan shadows, muted colour.
    vintage: (c) => {
        c = saturate(c, 0.72);
        c = [
            sCurve(c[0], 1.15, 0.45),
            sCurve(c[1], 1.05, 0.45),
            Math.pow(clamp01(c[2]), 0.92) * 0.88,
        ];
        c = splitTone(c, [-0.01, 0.025, 0.02], [0.05, 0.03, -0.03]);

        return levels(c, 0.07, 0.93);
    },
    // Black and white through a light yellow filter (darker skies), strong print contrast.
    noir: (c) => {
        const l = c[0] * 0.35 + c[1] * 0.55 + c[2] * 0.1;
        const v = sCurve(l, 1.5, 0.42);

        return levels([v, v, v], 0.01, 0.99);
    },
    // Rich vegetation: greens more saturated, yellows pulled towards green, gentle contrast.
    lush: (c) => {
        c = hueShift(c, 110, 60, 118, 0.2, 1.3);
        c = hueShift(c, 60, 25, 80, 0.3, 1.1);
        c = hueShift(c, 210, 40, 205, 0.2, 1.1);
        c = saturate(c, 1.08);
        c = curve(c, 1.1, 0.42);

        return splitTone(c, [0.0, 0.01, 0.005], [0.01, 0.015, -0.01]);
    },
    // Heat and dust: warm, sandy highlights, blues turned towards teal and muted, low contrast.
    desert: (c) => {
        c = [c[0] * 1.05, c[1] * 1.0, c[2] * 0.86];
        c = hueShift(c, 215, 60, 195, 0.35, 0.7);
        c = hueShift(c, 35, 40, 32, 0.3, 1.15);
        c = splitTone(c, [0.03, 0.015, -0.005], [0.04, 0.02, -0.03]);
        c = saturate(c, 0.92);
        c = curve(c, 0.92, 0.5);

        return levels(c, 0.03, 0.97);
    },
};

const cache = new Map<ColorGrade, THREE.DataTexture>();

/**
 * 32³ RGBA8 LUT for a grade (cached; neutral is the identity), as a 2D strip of 32 blue slices
 * (x = blue × 32 + red, y = green): sampled with two bilinear lookups, which works the same on every
 * backend (3D texture support differs).
 */
export function colorGradeLut(grade: ColorGrade): THREE.DataTexture {
    const cached = cache.get(grade);

    if (cached) {
        return cached;
    }

    const fn = grade === 'neutral' ? null : GRADES[grade];
    const n = LUT_SIZE;
    const data = new Uint8Array(n * n * n * 4);

    for (let b = 0; b < n; b++) {
        for (let g = 0; g < n; g++) {
            for (let r = 0; r < n; r++) {
                const input: Rgb = [r / (n - 1), g / (n - 1), b / (n - 1)];
                const out = fn ? fn(input) : input;
                const i = (g * n * n + b * n + r) * 4;
                data[i] = Math.round(clamp01(out[0]) * 255);
                data[i + 1] = Math.round(clamp01(out[1]) * 255);
                data[i + 2] = Math.round(clamp01(out[2]) * 255);
                data[i + 3] = 255;
            }
        }
    }

    const texture = new THREE.DataTexture(data, n * n, n);
    texture.format = THREE.RGBAFormat;
    texture.type = THREE.UnsignedByteType;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.unpackAlignment = 1;
    texture.needsUpdate = true;
    cache.set(grade, texture);

    return texture;
}

export function isColorGrade(value: unknown): value is ColorGrade {
    return (
        typeof value === 'string' &&
        (value === 'neutral' || Object.hasOwn(GRADES, value))
    );
}

/**
 * White balance gains (linear RGB, luminance-normalised) for a warm/cool shift -1..1: the ratio between
 * a black body at the shifted temperature and at 6500 K (Tanner Helland's fit of the Planckian locus).
 */
export function whiteBalanceGains(
    shift: number,
    out: THREE.Vector3,
): THREE.Vector3 {
    if (Math.abs(shift) < 1e-4) {
        return out.set(1, 1, 1);
    }

    // -1 → 11000 K look (cool), +1 → 3800 K look (warm): the image is tinted like a mis-set camera.
    const kelvin =
        6500 *
        Math.pow(shift > 0 ? 3800 / 6500 : 11000 / 6500, Math.abs(shift));
    const a = blackBody(kelvin);
    const ref = blackBody(6500);
    const gains: Rgb = [a[0] / ref[0], a[1] / ref[1], a[2] / ref[2]];
    const l = luma(gains);

    return out.set(gains[0] / l, gains[1] / l, gains[2] / l);
}

function blackBody(kelvin: number): Rgb {
    const t = kelvin / 100;
    const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
    const g =
        t <= 66
            ? 99.4708025861 * Math.log(t) - 161.1195681661
            : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    const b =
        t >= 66
            ? 255
            : t <= 19
              ? 0
              : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
    // sRGB-encoded fit → linear.
    const lin = (v: number) => Math.pow(clamp01(v / 255), 2.2);

    return [lin(r), lin(g), lin(b)];
}
