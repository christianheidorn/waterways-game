import { describe, expect, it } from 'vitest';
import {
    CharacterWetness,
    DRIP_TIME,
    splashStrength,
    wadeSpeedFactor,
} from './wading';

describe('wading', () => {
    it('slows down with depth', () => {
        expect(wadeSpeedFactor(0, 1.8)).toBe(1);
        expect(wadeSpeedFactor(0.05, 1.8)).toBe(1);
        const knee = wadeSpeedFactor(0.5, 1.8);
        const hip = wadeSpeedFactor(0.95, 1.8);
        expect(knee).toBeLessThan(0.85);
        expect(knee).toBeGreaterThan(0.6);
        expect(hip).toBeLessThan(knee);
        expect(hip).toBeGreaterThanOrEqual(0.42);
        expect(wadeSpeedFactor(3, 1.8)).toBeCloseTo(0.42, 5);
    });

    it('sizes splashes by impact speed', () => {
        expect(splashStrength(1, 0.5)).toBe(0);
        expect(splashStrength(4, 0.5)).toBeGreaterThan(0);
        expect(splashStrength(9, 0.5)).toBeGreaterThan(splashStrength(4, 0.5));
        expect(splashStrength(9, 1)).toBeGreaterThan(splashStrength(9, 0.3));
    });
});

describe('character wetness', () => {
    it('soaks up to the waterline while wading', () => {
        const w = new CharacterWetness();

        for (let i = 0; i < 60; i++) {
            w.update(1 / 30, 0.5, 1.8, false, true);
        }

        expect(w.amount).toBeGreaterThan(0.9);
        expect(w.line).toBeGreaterThan(0.5);
        expect(w.line).toBeLessThan(0.7);
        expect(w.dripRate()).toBe(0);
    });

    it('soaks everything while swimming', () => {
        const w = new CharacterWetness();
        w.update(1, 0, 1.8, true, false);
        expect(w.line).toBeGreaterThan(1.8);
    });

    it('drips after leaving the water, then dries', () => {
        const w = new CharacterWetness();

        for (let i = 0; i < 60; i++) {
            w.update(1 / 30, 0.8, 1.8, false, false);
        }

        w.update(0.1, 0, 1.8, false, true);
        expect(w.dripRate()).toBeGreaterThan(5);
        const line = w.line;

        for (let i = 0; i < DRIP_TIME + 1; i++) {
            w.update(1, 0, 1.8, false, true);
        }

        expect(w.dripRate()).toBe(0);
        expect(w.amount).toBeGreaterThan(0.3);
        expect(w.line).toBeLessThan(line);

        for (let i = 0; i < 200; i++) {
            w.update(1, 0, 1.8, false, false);
        }

        expect(w.amount).toBe(0);
        expect(w.line).toBe(0);
    });
});
