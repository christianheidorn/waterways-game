const STEP = 0.05;

/**
 * Dynamic resolution controller: picks a render scale (× device pixel ratio) between `min` and the
 * configured render scale that keeps the frame time under the target budget.
 *
 * - With GPU timings, the scale follows the measured GPU cost (time ∝ pixels ∝ scale²).
 * - Without them (e.g. Safari, SwiftShader) the smoothed frame interval is used. Since a vsync-capped
 *   frame rate hides headroom, the controller probes one step up after a stable period and backs off
 *   (doubling the wait) if that makes the target miss again.
 * - Changes are quantised to 5% steps with a cooldown, so buffers are not reallocated every frame.
 */
export class DynamicResolution {
    scale = 1;
    min = 0.5;
    max = 1;
    private ema = 0;
    private cooldown = 0;
    private stable = 0;
    private probeDelay = 3;
    private sinceProbe = Infinity;

    reset(max: number): void {
        this.max = Math.max(this.min, max);
        this.scale = this.max;
        this.ema = 0;
        this.cooldown = 1;
        this.stable = 0;
        this.probeDelay = 3;
        this.sinceProbe = Infinity;
    }

    /**
     * @param dt seconds since the last frame
     * @param frameMs wall-clock frame interval in ms
     * @param gpuMs GPU time of the frame in ms, or null when unavailable
     * @returns true when `scale` changed
     */
    update(
        dt: number,
        frameMs: number,
        gpuMs: number | null,
        targetFps: number,
    ): boolean {
        if (frameMs > 250) {
            return false; // Tab switch / hitch: not representative.
        }

        const sample = gpuMs ?? frameMs;
        this.ema = this.ema ? this.ema + (sample - this.ema) * 0.08 : sample;
        this.sinceProbe += dt;
        this.cooldown -= dt;

        if (this.cooldown > 0) {
            return false;
        }

        const budget = 1000 / Math.max(1, targetFps);
        let next = this.scale;

        if (gpuMs !== null) {
            if (this.ema > budget * 0.92) {
                next = this.scale * Math.sqrt((budget * 0.8) / this.ema);
            } else if (this.ema < budget * 0.65) {
                next =
                    this.scale *
                    Math.min(1.15, Math.sqrt((budget * 0.75) / this.ema));
            }
        } else if (this.ema > budget * 1.12) {
            next = this.scale * Math.sqrt(budget / this.ema);

            if (this.sinceProbe < 4) {
                // The last step up caused this: wait longer before trying again.
                this.probeDelay = Math.min(60, this.probeDelay * 2);
            }

            this.stable = 0;
        } else if (this.ema < budget * 0.7) {
            // Uncapped and well under budget: grow quickly.
            next = this.scale * Math.min(1.15, Math.sqrt(budget / this.ema));
        } else {
            this.stable += dt;

            if (this.stable > this.probeDelay && this.scale < this.max) {
                next = this.scale + STEP;
                this.stable = 0;
                this.sinceProbe = 0;
            }
        }

        next = Math.min(
            this.max,
            Math.max(this.min, Math.round(next / STEP) * STEP),
        );

        if (Math.abs(next - this.scale) < STEP * 0.5) {
            return false;
        }

        this.scale = next;
        this.cooldown = 0.75;
        // Pixel count changes, so the old average no longer applies.
        this.ema = 0;

        return true;
    }
}

/** Common display refresh rates (Hz): measurements snap to the closest. */
const REFRESH_RATES = [
    30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 180, 240,
];
/** Animation frame intervals per measurement window. */
const WINDOW = 90;

/**
 * Measures the display refresh rate from animation frame intervals. Callbacks are aligned to
 * vsync, so even when the game renders slower, the shortest intervals (a low percentile over a
 * window) are one refresh period whenever a frame makes it in one. The rate rises at once (a heavy
 * scene makes frames take two periods, which must not read as a slower display); it drops only when
 * ten windows in a row agree (e.g. the window moved to a slower monitor).
 */
export class RefreshRate {
    /** Measured refresh rate (Hz); 60 until the first window completes. */
    hz = 60;
    /** A window completed (hz is measured, not assumed). */
    measured = false;
    private readonly samples: number[] = [];
    private last = 0;
    private lower = 0;

    /** Call on every animation frame callback (also on frames the FPS limit skips). */
    tick(now: number): void {
        const interval = this.last ? now - this.last : 0;
        this.last = now;

        if (interval <= 1 || interval > 100) {
            return; // First frame, duplicate callback, or a hitch / hidden tab.
        }

        this.samples.push(interval);

        if (this.samples.length < WINDOW) {
            return;
        }

        const sorted = [...this.samples].sort((a, b) => a - b);
        this.samples.length = 0;
        const hz = snapRefreshRate(1000 / sorted[Math.floor(WINDOW * 0.1)]);

        if (!this.measured || hz > this.hz) {
            this.hz = hz;
            this.lower = 0;
        } else if (hz < this.hz && ++this.lower >= 10) {
            this.hz = hz;
            this.lower = 0;
        } else if (hz === this.hz) {
            this.lower = 0;
        }

        this.measured = true;
    }
}

/** Snaps a measured rate to a common refresh rate (within 4 %; others are rounded). */
export function snapRefreshRate(hz: number): number {
    let best = REFRESH_RATES[0];

    for (const rate of REFRESH_RATES) {
        if (Math.abs(rate - hz) < Math.abs(best - hz)) {
            best = rate;
        }
    }

    return Math.abs(best - hz) / best < 0.04 ? best : Math.round(hz);
}

export type FrameRateTarget = 'auto' | '60' | '120' | 'off';

/**
 * The frame rate dynamic resolution holds: the display refresh (`auto`), a fixed 60 / 120, or the
 * manual `target_fps` (`off`), never above the FPS limit.
 */
export function resolveTargetFps(
    mode: FrameRateTarget | undefined,
    targetFps: number,
    maxFps: number,
    refreshHz: number,
): number {
    const target =
        mode === 'auto' || mode === undefined
            ? refreshHz
            : mode === 'off'
              ? targetFps || 60
              : Number(mode);

    return Math.min(target, maxFps > 0 ? maxFps : Infinity);
}

/**
 * With the `auto` target: when even the lowest render scale can't hold the refresh rate for a few
 * seconds (CPU-bound, or a very slow GPU), hold half of it instead (an even fraction keeps frame pacing
 * smooth under vsync), and try the full rate again after a while.
 */
export class RefreshFallback {
    divisor = 1;
    private missing = 0;
    private since = 0;

    update(
        dt: number,
        atMin: boolean,
        missing: boolean,
        target: number,
    ): number {
        if (this.divisor > 1) {
            this.since += dt;

            if (this.since > 30) {
                this.divisor = 1;
                this.since = 0;
                this.missing = 0;
            }
        }

        this.missing = atMin && missing ? this.missing + dt : 0;

        if (this.missing > 3 && target / (this.divisor * 2) >= 30) {
            this.divisor *= 2;
            this.missing = 0;
            this.since = 0;
        }

        return target / this.divisor;
    }
}
