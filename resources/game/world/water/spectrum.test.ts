import { describe, expect, it } from 'vitest';
import { bandEnergy, CASCADES, cascadeSpectrum, cascadeWeights, dominantComponents, OPEN_FETCH, peakOmega, significantHeight, spread } from './spectrum';

describe('wave spectrum', () => {
    it('grows waves with wind and fetch (fetch-limited JONSWAP)', () => {
        const pond = significantHeight({ wind: 8, fetch: 50 });
        const lake = significantHeight({ wind: 8, fetch: 2000 });
        const sea = significantHeight({ wind: 8, fetch: OPEN_FETCH });
        expect(pond).toBeLessThan(lake);
        expect(lake).toBeLessThan(sea);
        // Empirical JONSWAP: Hs ≈ 1.6e-3 · U · √(F/g) → ~0.18 m on a 2 km lake at 8 m/s.
        expect(lake).toBeGreaterThan(0.1);
        expect(lake).toBeLessThan(0.35);
        // Fully developed sea at 8 m/s: ~1.4 m (Pierson–Moskowitz 0.21 U²/g).
        expect(sea).toBeGreaterThan(0.9);
        expect(sea).toBeLessThan(2);
        // Short fetch → higher peak frequency (shorter waves).
        expect(peakOmega({ wind: 8, fetch: 50 })).toBeGreaterThan(peakOmega({ wind: 8, fetch: 2000 }));
    });

    it('cascades cover one continuous band', () => {
        for (let i = 1; i < CASCADES.length; i++) {
            expect(CASCADES[i].kMin).toBeCloseTo(CASCADES[i - 1].kMax);
        }
    });

    it('normalises the directional spread', () => {
        for (const ratio of [0.8, 1, 2, 5]) {
            let sum = 0;
            const n = 720;

            for (let i = 0; i < n; i++) {
                sum += spread(-Math.PI + ((i + 0.5) / n) * Math.PI * 2, ratio, 1) * ((Math.PI * 2) / n);
            }

            expect(sum).toBeGreaterThan(0.9);
            expect(sum).toBeLessThan(1.25);
        }
    });

    it('scales cascades per body: ponds lose swell but keep chop', () => {
        const reference = { wind: 8, fetch: OPEN_FETCH };
        const [swell, wind, chop] = cascadeWeights({ wind: 8, fetch: 40 }, reference);
        expect(swell).toBeLessThan(0.05);
        expect(wind).toBeLessThan(0.5);
        expect(chop).toBeGreaterThan(0.5);
        expect(cascadeWeights(reference, reference)).toEqual([1, 1, 1]);
    });

    it('builds a Hermitian-ready spectrum whose variance matches the band energy', () => {
        const p = { wind: 8, fetch: 5000 };
        const spec = cascadeSpectrum(1, p, [1, 0]);
        let variance = 0;

        for (let i = 0; i < spec.h0.length; i += 4) {
            variance += spec.h0[i] ** 2 + spec.h0[i + 1] ** 2;
        }

        // Each h0 carries half the variance of its k (the conjugate pair supplies the other half).
        const expected = bandEnergy(p, CASCADES[1].kMin, CASCADES[1].kMax);
        expect(variance * 2).toBeGreaterThan(expected * 0.6);
        expect(variance * 2).toBeLessThan(expected * 1.6);

        const waves = dominantComponents([spec], [16]);
        expect(waves).toHaveLength(16);
        // Mostly travelling downwind (+x).
        expect(waves.filter((w) => w.kx > 0).length).toBeGreaterThan(10);
    });
});
