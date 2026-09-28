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
