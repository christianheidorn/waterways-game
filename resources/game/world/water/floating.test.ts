import { describe, expect, it } from 'vitest';
import {
    collideFloats,
    createFloatBody,
    draft,
    MAX_TILT,
    pushFloat,
    stepFloat,
} from './floating';
import type { FloatBody, WaterProbe } from './floating';

const ground = () => 0;

/** Flat water at `level`, `depth` deep, flowing at (vx, vz); dry beyond x = `shore` (if given). */
function flat(
    level: number,
    depth = 5,
    vx = 0,
    vz = 0,
    shore = Infinity,
): WaterProbe {
    return (x) => (x > shore ? null : { height: level, vx, vz, depth });
}

function run(
    b: FloatBody,
    probe: WaterProbe,
    seconds: number,
    drift = false,
    wind = { x: 0, z: 0 },
): void {
    for (let t = 0; t < seconds; t += 1 / 60) {
        stepFloat(b, 1 / 60, probe, {
            drift,
            windX: wind.x,
            windZ: wind.z,
            groundAt: ground,
        });
    }
}

/** A 4 × 0.6 m log, 0.6 m thick, half under water. */
const log = (x = 0, z = 0, yaw = 0) =>
    createFloatBody(x, z, yaw, 2, 0.3, 0.6, 0.5);

describe('floating props', () => {
    it('floats with its draft under the surface, level on still water', () => {
        const b = log();
        run(b, flat(10), 5);
        expect(draft(b)).toBeCloseTo(0.3, 5);
        expect(b.y).toBeCloseTo(10 - 0.3, 2);
        expect(Math.abs(b.pitch)).toBeLessThan(1e-3);
        expect(Math.abs(b.roll)).toBeLessThan(1e-3);
        expect(b.grounded).toBe(false);
    });

    it('bobs after a drop and settles', () => {
        const b = log();
        run(b, flat(10), 0.1);
        b.vy = -1.5;
        let min = Infinity;
        let max = -Infinity;

        for (let t = 0; t < 3; t += 1 / 60) {
            run(b, flat(10), 1 / 60);
            min = Math.min(min, b.y);
            max = Math.max(max, b.y);
        }

        // Overshoots above its rest height at least once (underdamped)…
        expect(max).toBeGreaterThan(9.7 + 0.01);
        expect(min).toBeLessThan(9.6);
        // …and comes to rest.
        run(b, flat(10), 10);
        expect(b.y).toBeCloseTo(9.7, 2);
    });

    it('tilts with the slope of a wave under it (multi-point sampling)', () => {
        // Water rising towards +x with a slope of 0.15.
        const slope: WaterProbe = (x) => ({ height: 10 + x * 0.15, vx: 0, vz: 0, depth: 5 });
        const b = log();
        run(b, slope, 5);
        // The +x end is raised: positive roll about the local z axis (yaw 0: local x = world x).
        expect(b.roll).toBeGreaterThan(0.1);
        expect(b.roll).toBeLessThan(MAX_TILT + 1e-6);
        expect(Math.abs(b.pitch)).toBeLessThan(0.02);

        // Turned 90°: the same slope now pitches it about its local x axis instead.
        const c = log(0, 0, Math.PI / 2);
        run(c, slope, 5);
        expect(Math.abs(c.pitch)).toBeGreaterThan(0.1);
        expect(Math.abs(c.roll)).toBeLessThan(0.02);
    });

    it('drifts with the current only when drifting is allowed', () => {
        const river = flat(10, 5, 1.2, 0);
        const moored = log();
        run(moored, river, 10, false);
        expect(Math.hypot(moored.x, moored.z)).toBeLessThan(0.5);

        const free = log();
        run(free, river, 10, true);
        expect(free.x).toBeGreaterThan(8);
        expect(free.vx).toBeGreaterThan(1);
        expect(free.vx).toBeLessThan(1.3);
    });

    it('is blown along by the wind, more when floating high', () => {
        const high = createFloatBody(0, 0, 0, 1, 1, 0.5, 0.1);
        const low = createFloatBody(0, 0, 0, 1, 1, 0.5, 0.9);
        run(high, flat(10), 20, true, { x: 0, z: 8 });
        run(low, flat(10), 20, true, { x: 0, z: 8 });
        expect(high.z).toBeGreaterThan(low.z * 3);
        expect(low.z).toBeGreaterThan(0);
    });

    it('is pushed back off the shore', () => {
        // Dry land beyond x = 2: a current pushes the log towards it.
        const b = log(0, 0, Math.PI / 2);
        run(b, flat(10, 5, 1, 0, 2), 20, true);
        expect(b.x).toBeLessThan(2.2);
        expect(Number.isFinite(b.y)).toBe(true);
    });

    it('rests on the bed where too shallow to float', () => {
        const b = createFloatBody(0, 0, 0, 1, 1, 1, 0.8);
        run(b, flat(10, 0.3), 5);
        // Needs 0.8 m of water; the bed is 0.3 m down.
        expect(b.grounded).toBe(true);
        expect(b.y).toBeGreaterThan(9.7 - 0.05);
    });

    it('can be pushed (heavier bodies give way less) and bounces off another', () => {
        const small = createFloatBody(0, 0, 0, 0.3, 0.3, 0.2, 0.3);
        const big = log();
        pushFloat(small, 1, 0);
        pushFloat(big, 1, 0);
        expect(small.vx).toBeGreaterThan(big.vx);

        const a = log(0, 0);
        const b = log(1, 0);
        a.vx = 1;
        expect(collideFloats(a, b)).toBe(true);
        expect(b.x - a.x).toBeGreaterThan(1);
        expect(b.vx).toBeGreaterThan(0);
        expect(collideFloats(log(0, 0), log(10, 0))).toBe(false);
    });

    it('stays on the ground where there is no water', () => {
        const b = log();
        expect(stepFloat(b, 1 / 60, () => null, { drift: true, windX: 0, windZ: 0, groundAt: () => 3 })).toBe(false);
        expect(b.y).toBe(3);
        expect(b.grounded).toBe(true);
    });
});
