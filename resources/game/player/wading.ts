/**
 * Wading and wet-character rules (docs/ROADMAP.md phase 12), kept free of rendering so they can be tested.
 */

/** Water depth at the feet (m) from which the character counts as wading. */
export const WADE_MIN_DEPTH = 0.06;

/**
 * Movement speed factor for wading `depth` m deep (water level above the feet) with a character of
 * `height` m: ankle-deep water barely slows, knee-deep to ~70 %, hip-deep to ~45 %.
 */
export function wadeSpeedFactor(depth: number, height: number): number {
    if (depth <= WADE_MIN_DEPTH) {
        return 1;
    }

    const t = Math.min(1, depth / Math.max(0.5, height * 0.55));

    return 1 - 0.58 * t * t * (3 - 2 * t);
}

/** Seconds a soaked character takes to dry (to ~5 %). */
export const DRY_TIME = 90;
/** Drips fall for about this long after leaving the water. */
export const DRIP_TIME = 10;

/**
 * How wet the character is: up to which height above the feet (`line`, m) the clothes are soaked, and how
 * wet (`amount`, 0-1). Wading wets up to the waterline (plus a little splash), swimming wets everything;
 * out of the water the wetness fades over DRY_TIME and the line slowly sinks as the top dries first.
 */
export class CharacterWetness {
    line = 0;
    amount = 0;
    /** Seconds since the character last left the water (Infinity: never wet). */
    sinceExit = Number.POSITIVE_INFINITY;
    private inWater = false;

    /**
     * @param submerged height of the waterline above the feet (m; ≤ 0: out of the water)
     * @param height the character's height (m)
     */
    update(
        dt: number,
        submerged: number,
        height: number,
        swimming: boolean,
        moving: boolean,
    ): void {
        const wet = swimming ? height * 1.05 : submerged;

        if (wet > 0.02) {
            // Splashing while wading wets a little above the waterline.
            const target = Math.min(
                height * 1.05,
                wet + (moving && !swimming ? 0.12 : 0.03),
            );
            this.line = Math.max(this.line, target);
            // Soaks within a second or two.
            this.amount += (1 - this.amount) * (1 - Math.exp(-dt * 2.5));
            this.inWater = true;
            this.sinceExit = 0;

            return;
        }

        if (this.inWater) {
            this.inWater = false;
            this.sinceExit = 0;
        }

        this.sinceExit += dt;
        this.amount *= Math.exp((-dt * 3) / DRY_TIME);

        if (this.amount < 0.01) {
            this.amount = 0;
            this.line = 0;

            return;
        }

        // The top dries first: the line sinks a few millimetres per second.
        this.line = Math.max(0, this.line - dt * 0.004);
    }

    /** Drips per second (0 when dry): many right after leaving the water, fading over DRIP_TIME. */
    dripRate(): number {
        if (this.inWater || this.amount <= 0 || this.line <= 0.05) {
            return 0;
        }

        const t = this.sinceExit / DRIP_TIME;

        return t >= 1 ? 0 : 14 * this.amount * (1 - t) * (1 - t);
    }

    reset(): void {
        this.line = 0;
        this.amount = 0;
        this.sinceExit = Number.POSITIVE_INFINITY;
        this.inWater = false;
    }
}

/**
 * Splash size for something hitting the water at `speed` m/s (vertical) with a footprint of `size` m:
 * 0 below ~1.5 m/s, 1 for a person jumping in from a few metres.
 */
export function splashStrength(speed: number, size: number): number {
    const s = Math.max(0, speed - 1.5) / 6;

    return Math.min(2, s * Math.min(2, Math.max(0.15, size)));
}
