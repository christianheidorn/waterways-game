import { describe, expect, it } from 'vitest';
import {
    Breath,
    BREATH_SECONDS,
    buoyancy,
    CLIMB_MAX,
    climbEase,
    climbTarget,
    floatDepth,
    RISE_SPEED,
    shouldSwim,
    swimVelocity,
} from './swimming';

const H = 1.8;

/** Integrates the vertical buoyancy for `seconds` (fixed steps). */
function settle(
    y: number,
    floatY: (t: number) => number,
    seconds: number,
    targetVy = 0,
    active = false,
): { y: number; vy: number; min: number; max: number } {
    let vy = 0;
    let min = y;
    let max = y;
    const dt = 1 / 60;

    for (let t = 0; t < seconds; t += dt) {
        vy += buoyancy(y, vy, floatY(t), targetVy, active) * dt;
        y += vy * dt;
        min = Math.min(min, y);
        max = Math.max(max, y);
    }

    return { y, vy, min, max };
}

describe('swimming', () => {
    it('swims only where the water is deep enough, with hysteresis', () => {
        const float = floatDepth(H);
        // Chest-deep: standing.
        expect(shouldSwim(10, 10, 10 - float * 0.7, 10 - float * 0.7, H, false)).toBe(false);
        // Deep water, feet below the surface: swimming.
        expect(shouldSwim(10, 10, 5, 10 - float, H, false)).toBe(true);
        // Getting shallower: keeps swimming a little longer than it started…
        const edge = 10 - float * 0.85;
        expect(shouldSwim(10, 10, edge, 10 - float, H, false)).toBe(false);
        expect(shouldSwim(10, 10, edge, 10 - float, H, true)).toBe(true);
        // …and stands up once it is clearly shallow.
        expect(shouldSwim(10, 10, 10 - float * 0.7, 10 - float, H, true)).toBe(false);
        // Airborne above the water (jumping in) is not swimming yet; dry land never.
        expect(shouldSwim(10, 10, 5, 10.2, H, false)).toBe(false);
        expect(shouldSwim(null, 0, 0, 0, H, false)).toBe(false);
    });

    it('floats on the surface and follows the waves', () => {
        const still = settle(10 - floatDepth(H) - 1, () => 10 - floatDepth(H), 4);
        expect(still.y).toBeCloseTo(10 - floatDepth(H), 2);

        // A wave of ±0.3 m every 4 s: the swimmer rides it with most of the amplitude.
        const wave = (t: number) => 10 - floatDepth(H) + 0.3 * Math.sin((t * Math.PI * 2) / 4);
        const ride = settle(wave(0), wave, 12);
        expect(ride.max - ride.min).toBeGreaterThan(0.45);
        expect(ride.max - ride.min).toBeLessThan(0.75);
    });

    it('dives against the buoyancy and floats back up when let go', () => {
        const top = 10 - floatDepth(H);
        const down = settle(top, () => top, 3, -2, true);
        expect(down.y).toBeLessThan(top - 3);
        expect(down.vy).toBeLessThan(-1.5);

        // Released deep down: rises at about RISE_SPEED, then settles at the surface.
        const up = settle(top - 4, () => top, 1.5);
        expect(up.vy).toBeGreaterThan(RISE_SPEED * 0.8);
        const back = settle(top - 4, () => top, 15);
        expect(back.y).toBeCloseTo(top, 1);
    });

    it('swims where the camera looks under water, level at the surface', () => {
        const out = { x: 0, y: 0, z: 0 };
        const controls = { forward: 1, strafe: 0, up: false, down: false, sprint: false };
        // Camera yaw 0 looks towards −z; pitched 45° down.
        swimVelocity(controls, 0, -Math.PI / 4, true, 2, out);
        expect(out.z).toBeLessThan(-1);
        expect(out.y).toBeLessThan(-0.9);
        expect(out.x).toBeCloseTo(0, 5);
        // At the surface the same view swims level.
        swimVelocity(controls, 0, -Math.PI / 4, false, 2, out);
        expect(out.y).toBe(0);
        expect(out.z).toBeCloseTo(-2, 5);
        // Diving key alone: straight down; sprint is faster.
        swimVelocity({ ...controls, forward: 0, down: true }, 0, 0, true, 2, out);
        expect(out.y).toBeLessThan(0);
        expect(Math.hypot(out.x, out.z)).toBeCloseTo(0, 5);
        swimVelocity({ ...controls, sprint: true }, Math.PI / 2, 0, false, 2, out);
        expect(out.x).toBeCloseTo(-3.2, 5);
    });

    it('holds its breath and refills at the surface', () => {
        const breath = new Breath();

        for (let t = 0; t < BREATH_SECONDS / 2; t += 0.1) {
            breath.update(0.1, true);
        }

        expect(breath.amount).toBeCloseTo(0.5, 1);
        expect(breath.empty).toBe(false);

        for (let t = 0; t < BREATH_SECONDS; t += 0.1) {
            breath.update(0.1, true);
        }

        expect(breath.empty).toBe(true);
        breath.update(4.5, false);
        expect(breath.amount).toBe(1);
    });

    it('climbs out onto low banks and jetties only', () => {
        const surface = 10;
        const feet = surface - floatDepth(H);
        expect(climbTarget(surface + 0.5, surface, feet)).toBe(surface + 0.5);
        expect(climbTarget(surface + CLIMB_MAX + 0.1, surface, feet)).toBeNull();
        // Bed under water: wading out, not climbing.
        expect(climbTarget(surface - 0.6, surface, feet)).toBeNull();
        const start = climbEase(0);
        const mid = climbEase(0.5);
        const end = climbEase(1);
        expect(start.up).toBe(0);
        expect(mid.up).toBeGreaterThan(mid.forward);
        expect(end.up).toBe(1);
        expect(end.forward).toBe(1);
    });
});
