/**
 * Swimming rules (docs/ROADMAP.md phase 13), kept free of rendering so they can be tested: when the
 * character swims, how it floats on the (wavy) surface, dives and comes back up, how long it can hold
 * its breath and where it can climb out.
 */

/** Feet below the surface while floating, as a share of the character's height (head and shoulders out). */
export const FLOAT_FRACTION = 0.64;
/** Water deeper than this share of the floating depth lifts the character off its feet… */
export const ENTER_DEPTH = 0.9;
/** …and it stands again once the water is shallower than this share (hysteresis: no flicker at the edge). */
export const EXIT_DEPTH = 0.78;
/** Seconds of breath under water. */
export const BREATH_SECONDS = 30;
/** Highest ledge above the water surface (m) the character can pull itself onto. */
export const CLIMB_MAX = 0.95;
/** Seconds a climb out of the water takes. */
export const CLIMB_TIME = 0.45;
/** Rise speed (m/s) of a submerged character that neither dives nor swims up (it floats up). */
export const RISE_SPEED = 0.45;
/** The head counts as under water this far (m) below the surface. */
export const HEAD_UNDER = 0.05;

export function floatDepth(height: number): number {
    return height * FLOAT_FRACTION;
}

/**
 * Whether the character swims: the water is deep enough to float and its feet are not standing on
 * the bottom near the surface. `wasSwimming` adds hysteresis at the edge of the deep water.
 *
 * @param level still water level (m), null where dry
 * @param surface surface height with waves (m)
 * @param ground bed height under the character (m)
 * @param feetY the character's feet (m)
 */
export function shouldSwim(
    level: number | null,
    surface: number,
    ground: number,
    feetY: number,
    height: number,
    wasSwimming: boolean,
): boolean {
    if (level === null) {
        return false;
    }

    const float = floatDepth(height);
    const depth = level - ground;

    if (depth < float * (wasSwimming ? EXIT_DEPTH : ENTER_DEPTH)) {
        return false;
    }

    // Jumping out of the water (or falling in from above) is airborne until it reaches the water.
    return feetY < surface - float * (wasSwimming ? 0.35 : 0.6);
}

export type SwimControls = {
    /** -1…1 forward / back and right / left (camera relative). */
    forward: number;
    strafe: number;
    /** Swim up (Space) / dive (C, Ctrl). */
    up: boolean;
    down: boolean;
    sprint: boolean;
};

/**
 * Target velocity of a swimmer (m/s) for the controls. At the surface it swims horizontally (the
 * buoyancy spring keeps it on the waves, see `buoyancy`); submerged it swims where the camera looks
 * (pitch included), Space / dive add straight up / down.
 *
 * @param yaw camera yaw (0 looks towards −z)
 * @param pitch camera pitch (negative looks down)
 * @param submerged the head is under water (or the character dives)
 */
export function swimVelocity(
    controls: SwimControls,
    yaw: number,
    pitch: number,
    submerged: boolean,
    speed: number,
    out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
    const s = speed * (controls.sprint ? 1.6 : 1);
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    // Right of the view: (cos yaw, 0, −sin yaw).
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    let x = controls.forward * fx + controls.strafe * rx;
    let z = controls.forward * fz + controls.strafe * rz;
    let y = 0;

    if (submerged) {
        // Swim where the camera looks; a little looking down / up is ignored near level.
        const p = Math.abs(pitch) < 0.12 ? 0 : pitch;
        const c = Math.cos(p);
        x = controls.forward * fx * c + controls.strafe * rx;
        z = controls.forward * fz * c + controls.strafe * rz;
        y = controls.forward * Math.sin(p);
    }

    y += (controls.up ? 1 : 0) - (controls.down ? 1 : 0);
    const len = Math.hypot(x, y, z);

    if (len > 1) {
        x /= len;
        y /= len;
        z /= len;
    }

    out.x = x * s;
    out.y = y * s * 0.8;
    out.z = z * s;

    return out;
}

/**
 * Vertical acceleration (m/s²) that keeps a swimmer floating on the waves: a damped spring towards the
 * floating height when at the surface; submerged without input it slowly rises (positive buoyancy).
 *
 * @param y feet height (m)
 * @param vy vertical velocity (m/s)
 * @param floatY feet height when floating on the local (wavy) surface (m)
 * @param targetVy the controls' vertical speed (swimVelocity.y)
 * @param active up / down / swimming while submerged is under the player's control
 */
export function buoyancy(
    y: number,
    vy: number,
    floatY: number,
    targetVy: number,
    active: boolean,
): number {
    const below = floatY - y;

    if (active && targetVy < 0) {
        // Diving: swim down against the buoyancy.
        return (targetVy - vy) * 3;
    }

    if (below > 0.6) {
        // Deep: float (or swim) up, easing into the surface spring.
        const rise = Math.max(targetVy, RISE_SPEED + Math.min(1, below) * 0.3);

        return (rise - vy) * 2.5;
    }

    // At the surface: damped spring (follows the waves, bobs a little after a jump in).
    return (below + targetVy * 0.15) * 22 - vy * 7;
}

/** Breath under water: 1 = full, drains over BREATH_SECONDS, refills at the surface within a few seconds. */
export class Breath {
    amount = 1;

    update(dt: number, headUnder: boolean): number {
        if (headUnder) {
            this.amount = Math.max(0, this.amount - dt / BREATH_SECONDS);
        } else {
            this.amount = Math.min(1, this.amount + dt / 4);
        }

        return this.amount;
    }

    /** Out of breath: the character has to surface (diving no longer works). */
    get empty(): boolean {
        return this.amount <= 0;
    }

    reset(): void {
        this.amount = 1;
    }
}

/**
 * Where a swimmer pushing against a bank or a jetty can climb out: the height of the ledge ahead, or null
 * when it is too high above the water (or not higher than the feet: the character just wades out).
 *
 * @param ledge top of the ground / a collider ahead (m)
 * @param surface water surface (m)
 * @param feetY the swimmer's feet (m)
 */
export function climbTarget(
    ledge: number,
    surface: number,
    feetY: number,
): number | null {
    if (ledge > surface + CLIMB_MAX) {
        return null;
    }

    // Lower ledges are reached by wading (the bed rises under the feet).
    if (ledge < surface - 0.25 || ledge <= feetY + 0.3) {
        return null;
    }

    return ledge;
}

/** Ease of a climb (0…1 → 0…1): up first, then forward over the edge. */
export function climbEase(t: number): { up: number; forward: number } {
    const c = Math.min(1, Math.max(0, t));
    const up = Math.min(1, c / 0.6);

    return {
        up: up * up * (3 - 2 * up),
        forward: c < 0.4 ? 0 : ((c - 0.4) / 0.6) ** 2,
    };
}
