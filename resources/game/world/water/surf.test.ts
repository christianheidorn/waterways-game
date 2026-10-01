import { describe, expect, it } from 'vitest';
import { NO_WATER } from '../../shared/types';
import { Heightfield } from '../Heightfield';
import {
    encodePainted,
    paintedStrength,
    SHORE_REACH,
    ShoreField,
    shoreStrength,
} from './shoreField';
import { shoreTravelTime, surfWave, swash } from './surfModel';
import { WaterSurfaceData } from './WaterSurfaceData';

const RES = 129;
const SIZE = 256; // 2 m cells
const LEVEL = 2;

/** A straight beach along z: the ground rises east at `slope` and meets the water (level 2) at x = shoreX. */
function beach(slope: number, shoreX = 20) {
    const terrain = new Heightfield(RES, SIZE);
    const surface = new Heightfield(RES, SIZE);

    for (let r = 0; r < RES; r++) {
        for (let c = 0; c < RES; c++) {
            const x = terrain.colToX(c);
            const y = LEVEL + (x - shoreX) * slope;
            terrain.data[r * RES + c] = y;
            surface.data[r * RES + c] = y < LEVEL ? LEVEL : NO_WATER;
        }
    }

    const data = new WaterSurfaceData(surface, terrain, 1);
    data.update({ x0: 0, z0: 0, x1: RES - 1, z1: RES - 1 }, null);
    const field = new ShoreField(
        data,
        surface,
        terrain,
        new Uint8Array(RES * RES),
    );
    field.update();

    return { terrain, surface, data, field };
}

const at = (f: ShoreField, x: number, z: number) => {
    const i = Math.round((x + SIZE / 2) / f.spacing);
    const j = Math.round((z + SIZE / 2) / f.spacing);

    return j * f.size + i;
};

describe('ShoreField', () => {
    it('measures the distance to the shoreline on both sides, sub-sample', () => {
        const { field } = beach(0.05, 21);

        // Shoreline at x = 21 (between samples 20 and 22).
        expect(field.dist[at(field, 0, 0)]).toBeCloseTo(21, 0);
        expect(field.dist[at(field, -60, 10)]).toBeCloseTo(81, 0);
        expect(field.dist[at(field, 30, 0)]).toBeCloseTo(-9, 0);
        // Beyond the reach: capped.
        expect(field.dist[at(field, -126, 0)]).toBeLessThanOrEqual(SHORE_REACH);
    });

    it('points the travel direction up the beach and keeps the shore level and slope', () => {
        const { field } = beach(0.05);
        const k = at(field, -30, 4);

        expect(field.dirX[k]).toBeCloseTo(1, 2);
        expect(Math.abs(field.dirZ[k])).toBeLessThan(0.01);
        // On land the waves would carry on up the sand.
        expect(field.dirX[at(field, 26, 4)]).toBeCloseTo(1, 2);
        expect(field.level[k]).toBeCloseTo(LEVEL, 3);
        expect(field.slope[k]).toBeCloseTo(0.05, 2);
        expect(field.wetIndex[k]).toBeGreaterThanOrEqual(0);
    });

    it('updates incrementally around an edit', () => {
        const { field, surface, data } = beach(0.05);
        const before = field.dist[at(field, -40, 0)];
        // Flood 20 m more of the beach (columns up to x = 40): the shore moves east.
        for (let r = 0; r < RES; r++) {
            for (let c = 0; c < RES; c++) {
                if (surface.colToX(c) <= 40) {
                    surface.data[r * RES + c] = LEVEL + 1.5;
                }
            }
        }

        const rect = { x0: 0, z0: 0, x1: 84, z1: RES - 1 };
        data.update(rect, null);
        field.update(rect);
        expect(field.dist[at(field, -40, 0)]).toBeGreaterThan(before + 15);
    });
});

describe('surf strength', () => {
    it('surfs on gentle shores of surf bodies, painting overrides', () => {
        expect(shoreStrength(true, null, 0.04)).toBe(1);
        expect(shoreStrength(true, null, 0.5)).toBe(0);
        expect(shoreStrength(false, null, 0.04)).toBe(0);
        expect(shoreStrength(false, 0.5, 0.04)).toBeCloseTo(0.5);
        expect(shoreStrength(true, 0, 0.04)).toBe(0);
        // Painted on a cliff: a gentler version.
        expect(shoreStrength(false, 1, 0.6)).toBeCloseTo(0.4);
        expect(paintedStrength(encodePainted(null))).toBeNull();
        expect(paintedStrength(encodePainted(0))).toBe(0);
        expect(paintedStrength(encodePainted(1))).toBe(1);
        expect(paintedStrength(encodePainted(0.5))).toBeCloseTo(0.5, 2);
    });
});

describe('surf model', () => {
    const params = { height: 1, period: 8, slope: 0.03 };

    it('slows the crests down towards the shore', () => {
        const near = shoreTravelTime(10, 8, 0.03) - shoreTravelTime(0, 8, 0.03);
        const far = shoreTravelTime(110, 8, 0.03) - shoreTravelTime(100, 8, 0.03);

        expect(near).toBeGreaterThan(far * 2);
    });

    it('grows towards the shore and breaks when higher than 0.8 × depth', () => {
        const peak = (d: number) => {
            let h = 0;
            let breaking = 0;

            for (let t = 0; t < 8; t += 0.05) {
                const w = surfWave(d, d * 0.03, t, 0, params, SHORE_REACH);
                h = Math.max(h, w.height);
                breaking = Math.max(breaking, w.breaking);
            }

            return { h, breaking };
        };
        const offshore = peak(80);
        const shoaling = peak(45);
        const surfZone = peak(15);

        expect(shoaling.h).toBeGreaterThan(offshore.h);
        expect(offshore.breaking).toBe(0);
        expect(surfZone.breaking).toBe(1);
        // Broken: the bore height is limited by the depth.
        expect(surfZone.h).toBeLessThanOrEqual(0.8 * 15 * 0.03 + 1e-6);
    });

    it('runs the swash up the beach and back once per period', () => {
        const reach = Array.from({ length: 80 }, (_, i) =>
            swash((i / 80) * 8, 0, params),
        );
        const max = Math.max(...reach.map((s) => s.reach));
        const min = Math.min(...reach.map((s) => s.reach));

        expect(max).toBeGreaterThan(0.2);
        expect(min).toBeLessThan(0);
        expect(reach[0].runup).toBeGreaterThan(0.2);
    });
});
