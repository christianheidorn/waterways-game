/**
 * Spreads low-rate heavy work (large texture uploads, whole-map recomputes) across frames: each frame
 * grants one claim, so the wetness map, the snow trail and the bounce light probes never all upload in
 * the same frame (a hitch) when their timers line up. Work that doesn't get the slot tries again on the
 * next frame.
 */
let claimed = 0;

/** Call once at the start of every frame. */
export function beginStaggerFrame(): void {
    claimed = 0;
}

/** True when the caller may do its heavy work this frame (the first claim of the frame). */
export function claimHeavySlot(): boolean {
    if (claimed > 0) {
        return false;
    }

    claimed++;

    return true;
}
