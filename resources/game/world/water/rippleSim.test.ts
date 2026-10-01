import { describe, expect, it } from 'vitest';
import {
    RIPPLE_DT,
    RIPPLE_SNAP,
    RIPPLE_SPEED,
    rippleCoefficient,
    rippleMask,
    rippleOrigin,
    RippleSim,
} from './rippleSim';

/** A 64² field of 0.25 m cells (16 m) centred on the origin. */
function sim(): RippleSim {
    const s = new RippleSim(64, 16);
    s.originX = -8;
    s.originZ = -8;

    return s;
}

/** Distance from (0, 0) of the ring's leading edge along +x (|h| above a fifth of its peak). */
function crestAlongX(s: RippleSim): number {
    const n = s.size;
    const j = n / 2;
    let best = 0;

    for (let i = n / 2; i < n; i++) {
        best = Math.max(best, Math.abs(s.h[j * n + i]));
    }

    let at = 0;

    for (let i = n / 2; i < n; i++) {
        if (Math.abs(s.h[j * n + i]) > best * 0.2) {
            at = s.cellX(i);
        }
    }

    return at;
}

describe('ripple simulation', () => {
    it('keeps the step stable for every resolution', () => {
        for (const n of [128, 192, 256]) {
            expect(rippleCoefficient(40 / n)).toBeLessThan(0.5);
        }
    });

    it('spreads a disturbance as a ring at about the ripple speed', () => {
        const s = sim();
        s.disturb({ x: 0, z: 0, radius: 0.3, amount: -0.05, foam: 0 });
        const steps = Math.round(2 / RIPPLE_DT);

        for (let i = 0; i < steps; i++) {
            s.step();
        }

        const r = crestAlongX(s);
        // Grid dispersion slows the short waves a little.
        expect(r).toBeGreaterThan(RIPPLE_SPEED * 2 * 0.6);
        expect(r).toBeLessThan(RIPPLE_SPEED * 2 * 1.3);
    });

    it('loses energy over time (damping)', () => {
        const s = sim();
        s.disturb({ x: 0, z: 0, radius: 0.4, amount: 0.05, foam: 0 });
        s.step();
        const e0 = s.energy();

        for (let i = 0; i < 240; i++) {
            s.step();
        }

        expect(s.energy()).toBeLessThan(e0 * 0.5);
        expect(Number.isFinite(s.energy())).toBe(true);
    });

    it('reflects at dry cells and never moves them', () => {
        const s = sim();
        // Shore: everything east of x = 2 is dry.
        s.buildMask((x) => (x > 2 ? 0 : 1));
        s.disturb({ x: 0, z: 0, radius: 0.3, amount: -0.05, foam: 0 });
        const n = s.size;
        const dry = Math.floor((2 - s.originX) / s.cell) + 2;
        let peakBack = 0;

        for (let k = 0; k < 240; k++) {
            s.step();

            for (let j = 0; j < n; j++) {
                expect(s.h[j * n + dry]).toBe(0);
            }

            // West of the source, after the direct ring has passed: the reflection arrives.
            if (k > 150) {
                peakBack = Math.max(
                    peakBack,
                    Math.abs(s.h[(n / 2) * n + Math.floor(n / 2) - 4]),
                );
            }
        }

        expect(peakBack).toBeGreaterThan(1e-4);
    });

    it('raises foam on strong impacts and lets it fade', () => {
        const s = sim();
        s.disturb({ x: 0, z: 0, radius: 0.5, amount: -0.3, foam: 0.8 });
        const c = (s.size / 2) * s.size + s.size / 2;
        expect(s.foam[c]).toBeGreaterThan(0.7);

        for (let i = 0; i < 600; i++) {
            s.step();
        }

        expect(s.foam[c]).toBeLessThan(0.05);
    });

    it('shifts the state when the field moves and samples it bilinearly', () => {
        const s = sim();
        s.disturb({ x: 1, z: 1, radius: 0.5, amount: 0.1, foam: 0 });
        const before = { height: 0, slopeX: 0, slopeZ: 0 };
        s.sample(1, 1, before);
        expect(before.height).toBeGreaterThan(0.05);
        s.moveTo(s.originX + 2, s.originZ - 1);
        const after = { height: 0, slopeX: 0, slopeZ: 0 };
        s.sample(1, 1, after);
        expect(after.height).toBeCloseTo(before.height, 5);
        // East of the bump the surface falls.
        s.sample(1.4, 1, after);
        expect(after.slopeX).toBeLessThan(0);
        s.sample(100, 100, after);
        expect(after.height).toBe(0);
    });

    it('snaps the origin to whole jumps and masks dry ground', () => {
        const cell = 40 / 256;
        const a = rippleOrigin(10, cell, 256);
        const b = rippleOrigin(10.3, cell, 256);
        expect(a).toBe(b);
        expect(
            Math.abs((a + 20) / (cell * RIPPLE_SNAP) - Math.round((a + 20) / (cell * RIPPLE_SNAP))),
        ).toBeLessThan(1e-9);
        expect(rippleMask(null)).toBe(0);
        expect(rippleMask(0)).toBe(0);
        expect(rippleMask(0.1)).toBeLessThan(rippleMask(2));
        expect(rippleMask(2)).toBeLessThan(1);
    });

    it('writes height, gradient and foam for the texture', () => {
        const s = sim();
        s.disturb({ x: 0, z: 0, radius: 0.5, amount: 0.1, foam: 0.5 });
        const out = s.writeOutput();
        const c = (s.size / 2) * s.size + s.size / 2;
        expect(out[c * 4]).toBeGreaterThan(0.05);
        expect(out[c * 4 + 3]).toBeGreaterThan(0.3);
    });
});
