/**
 * Brush settings and falloff shared by all landscape tools (sculpt, paint, foliage, water).
 */

export type FalloffType = 'smooth' | 'linear' | 'spherical' | 'tip';

export type BrushSettings = {
    /** World metres. */
    radius: number;
    /** 0..1. */
    strength: number;
    /** 0..1 fraction of the radius over which the brush fades out. */
    falloff: number;
    falloffType: FalloffType;
};

/** A single application of the brush at a world position (e.g. one entry of a stroke). */
export type BrushStamp = {
    /** World centre X. */
    x: number;
    /** World centre Z. */
    z: number;
    /** World metres. */
    radius: number;
    /** Multiplier for the brush strength (e.g. pen pressure), 0..1. */
    pressure: number;
};

export const DEFAULT_BRUSH: BrushSettings = {
    radius: 20,
    strength: 0.5,
    falloff: 0.5,
    falloffType: 'smooth',
};

/**
 * Brush weight (0..1) at `dist` metres from the centre, UE Landscape semantics:
 * 1 inside the inner core (radius * (1 - falloff)), fading to 0 at the radius.
 */
export function brushWeight(dist: number, b: BrushSettings): number {
    const radius = b.radius;

    if (!(dist < radius) || radius <= 0) {
        return 0;
    }

    const falloff = b.falloff < 0 ? 0 : b.falloff > 1 ? 1 : b.falloff;
    const inner = radius * (1 - falloff);

    if (dist <= inner) {
        return 1;
    }

    // t: 0 at the inner edge, 1 at the outer edge.
    const t = (dist - inner) / (radius - inner);

    switch (b.falloffType) {
        case 'linear':
            return 1 - t;
        case 'spherical':
            return Math.sqrt(1 - t * t);
        case 'tip': {
            const u = 1 - t;

            return 1 - Math.sqrt(Math.max(0, 1 - u * u));
        }
        case 'smooth':
        default:
            return 1 - t * t * (3 - 2 * t);
    }
}

/** Weight scaled by strength (and optional pressure), clamped 0..1. */
export function brushStrengthAt(
    dist: number,
    b: BrushSettings,
    pressure = 1,
): number {
    const s = b.strength * pressure;

    return brushWeight(dist, b) * (s < 0 ? 0 : s > 1 ? 1 : s);
}
