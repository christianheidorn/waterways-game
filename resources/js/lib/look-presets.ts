import type { ColorGrade } from '@game/shared/types';
import type { SettingValues } from '@/types';

export type LookPreset = {
    label: string;
    description: string;
    /** CSS gradient that hints at the grade. */
    swatch: string;
    values: SettingValues;
};

const base = {
    white_balance: 0,
    exposure_compensation: 0,
    chromatic_aberration: 0.1,
    film_grain: 0.08,
    lens_flare_intensity: 0.4,
    letterbox: 0,
};

/** One-click "Camera & look" bundles: colour grade plus matching lens settings. */
export const LOOK_PRESETS: Record<string, LookPreset> = {
    natural: {
        label: 'Natural',
        description: 'Clean, true-to-life colours.',
        swatch: 'linear-gradient(135deg,#7fb2e5,#6f9b4f 55%,#8a7a62)',
        values: {
            ...base,
            color_grade: 'neutral',
            color_grade_intensity: 0,
            chromatic_aberration: 0.05,
            film_grain: 0.04,
        },
    },
    filmic: {
        label: 'Filmic',
        description: 'Gentle film contrast and soft highlights.',
        swatch: 'linear-gradient(135deg,#8fb4d8,#5d8446 55%,#3b2f25)',
        values: { ...base, color_grade: 'filmic', color_grade_intensity: 0.6 },
    },
    golden_hour: {
        label: 'Golden hour',
        description: 'Warm highlights, strong light shafts and flares.',
        swatch: 'linear-gradient(135deg,#ffcf7a,#e0894a 55%,#5b3a2a)',
        values: {
            ...base,
            color_grade: 'golden_hour',
            color_grade_intensity: 0.8,
            white_balance: 0.35,
            god_ray_intensity: 1.1,
            lens_flare_intensity: 0.7,
        },
    },
    blockbuster: {
        label: 'Blockbuster',
        description: 'Teal shadows, orange skin tones, cinemascope bars.',
        swatch: 'linear-gradient(135deg,#1f6f78,#2d4a55 50%,#e59256)',
        values: {
            ...base,
            color_grade: 'teal_orange',
            color_grade_intensity: 0.75,
            chromatic_aberration: 0.2,
            film_grain: 0.12,
            lens_flare_intensity: 0.55,
            letterbox: 2.39,
        },
    },
    storm: {
        label: 'Moody storm',
        description: 'Cold, desaturated and heavy.',
        swatch: 'linear-gradient(135deg,#6d7b86,#3c4a52 55%,#1d242a)',
        values: {
            ...base,
            color_grade: 'cold_storm',
            color_grade_intensity: 0.8,
            white_balance: -0.3,
            exposure_compensation: -0.3,
            film_grain: 0.18,
            lens_flare_intensity: 0.1,
        },
    },
    documentary: {
        label: 'Documentary',
        description: 'Bleach bypass: muted colour, punchy contrast.',
        swatch: 'linear-gradient(135deg,#b7b8ae,#6d705f 55%,#2c2b27)',
        values: {
            ...base,
            color_grade: 'bleach_bypass',
            color_grade_intensity: 0.55,
            film_grain: 0.22,
        },
    },
    vintage: {
        label: 'Vintage',
        description: 'Faded blacks, warm cast, visible grain.',
        swatch: 'linear-gradient(135deg,#e7cfa2,#9c8a64 55%,#5e4b3a)',
        values: {
            ...base,
            color_grade: 'vintage',
            color_grade_intensity: 0.8,
            white_balance: 0.2,
            chromatic_aberration: 0.3,
            film_grain: 0.35,
        },
    },
    noir: {
        label: 'Noir',
        description: 'Black and white with deep contrast.',
        swatch: 'linear-gradient(135deg,#e8e8e8,#777 50%,#111)',
        values: {
            ...base,
            color_grade: 'noir',
            color_grade_intensity: 1,
            film_grain: 0.3,
            lens_flare_intensity: 0.2,
            letterbox: 2.39,
        },
    },
    lush: {
        label: 'Lush',
        description: 'Rich greens and clear skies.',
        swatch: 'linear-gradient(135deg,#6fc0ff,#3fa64a 55%,#1f5a2a)',
        values: { ...base, color_grade: 'lush', color_grade_intensity: 0.7 },
    },
    desert: {
        label: 'Desert',
        description: 'Warm, dusty and sun-bleached.',
        swatch: 'linear-gradient(135deg,#f3dcae,#d09a5c 55%,#7a4e2c)',
        values: {
            ...base,
            color_grade: 'desert',
            color_grade_intensity: 0.7,
            white_balance: 0.25,
            god_ray_intensity: 0.8,
        },
    },
};

export function lookPresetFor(values: SettingValues): string | null {
    const grade = values.color_grade as ColorGrade | undefined;

    return (
        Object.entries(LOOK_PRESETS).find(
            ([, p]) =>
                p.values.color_grade === grade &&
                Number(p.values.letterbox) === Number(values.letterbox ?? 0) &&
                Math.abs(
                    Number(p.values.color_grade_intensity) -
                        Number(values.color_grade_intensity ?? 0),
                ) < 0.01,
        )?.[0] ?? null
    );
}
