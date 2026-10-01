import { describe, expect, it } from 'vitest';
import { NO_WATER } from '../../shared/types';
import { bodyFetch, matchBodies, sanitizeSettings, segmentWaterBodies, serializeBodies, DEFAULT_BODY_SETTINGS } from './waterBodies';
import type { GridLike } from './waterBodies';

const RES = 101;
const CELL = 2; // 200 m map

function grid(fill: (c: number, r: number) => number): GridLike {
    const data = new Float32Array(RES * RES).fill(NO_WATER);

    for (let r = 0; r < RES; r++) {
        for (let c = 0; c < RES; c++) {
            data[r * RES + c] = fill(c, r);
        }
    }

    return { resolution: RES, cell: CELL, half: ((RES - 1) * CELL) / 2, data };
}

const terrain = grid((c, r) => Math.hypot(c - 30, r - 30) * 0.05 + Math.hypot(c - 75, r - 75) * 0.05);

/** A round lake (radius 20 samples) and a small pond (radius 4) at different levels. */
function lakeAndPond(lakeRadius = 20): GridLike {
    return grid((c, r) => (Math.hypot(c - 30, r - 30) <= lakeRadius ? 5 : Math.hypot(c - 75, r - 75) <= 4 ? 8 : NO_WATER));
}

describe('water bodies', () => {
    it('segments connected water into bodies and classifies them', () => {
        const seg = segmentWaterBodies(lakeAndPond(), { terrain });
        expect(seg.bodies).toHaveLength(2);
        const [lake, pond] = seg.bodies;
        expect(lake.auto_kind).toBe('lake');
        expect(pond.auto_kind).toBe('pond');
        expect(lake.area).toBeGreaterThan(4000);
        expect(lake.level).toBeCloseTo(5);
        expect(lake.centroid.x).toBeCloseTo(30 * CELL - 100, 0);
        // The deepest sample is the lake centre (lowest terrain).
        expect(lake.seed).toEqual({ x: -40, z: -40 });
        expect(seg.labels[30 * RES + 30]).toBe(1);
        expect(seg.labels[75 * RES + 75]).toBe(2);
        expect(seg.labels[0]).toBe(0);
    });

    it('splits water at level jumps (waterfalls)', () => {
        const g = grid((c, r) => (r > 40 && r < 60 ? (c < 50 ? 10 : 3) : NO_WATER));
        const seg = segmentWaterBodies(g, { wallLimit: 1.5 });
        expect(seg.bodies).toHaveLength(2);
    });

    it('recognises the sea and rivers', () => {
        const sea = grid((c, r) => (r < 20 ? 0 : NO_WATER));
        expect(segmentWaterBodies(sea, { seaLevel: 0 }).bodies[0].auto_kind).toBe('sea');

        // A long sloping ribbon.
        const river = grid((c, r) => (Math.abs(r - 50) <= 1 && c > 5 && c < 95 ? 10 - c * 0.05 : NO_WATER));
        expect(segmentWaterBodies(river, { wallLimit: 1.5 }).bodies[0].auto_kind).toBe('river');
    });

    it('keeps ids and settings stable across edits', () => {
        const before = matchBodies(segmentWaterBodies(lakeAndPond(), { terrain }), lakeAndPond(), []);
        expect(before.map((b) => b.id)).toEqual(['wb1', 'wb2']);
        before[0].settings.wave_height = 2.5;
        const stored = serializeBodies(before).bodies;

        // The lake shrinks (its seed stays wet) and a new pond appears in the top-right corner.
        const edited = grid((c, r) =>
            Math.hypot(c - 30, r - 30) <= 14 ? 5 : Math.hypot(c - 75, r - 75) <= 4 ? 8 : Math.hypot(c - 90, r - 10) <= 3 ? 2 : NO_WATER,
        );
        const after = matchBodies(segmentWaterBodies(edited, { terrain }), edited, stored);
        const lake = after.find((b) => b.id === 'wb1');
        expect(lake?.settings.wave_height).toBe(2.5);
        expect(after.find((b) => b.id === 'wb2')?.kind).toBe('pond');
        expect(after.map((b) => b.id).sort()).toEqual(['wb1', 'wb2', 'wb3']);
    });

    it('matches a body whose seed went dry by its centroid', () => {
        const stored = [{ ...DEFAULT_BODY_SETTINGS, id: 'wb7', seed: [500, 500] as [number, number], centroid: [-40, -40] as [number, number], wave_height: 0.3 }];
        const g = lakeAndPond();
        const after = matchBodies(segmentWaterBodies(g, { terrain }), g, stored);
        expect(after[0].id).toBe('wb7');
        expect(after[0].settings.wave_height).toBe(0.3);
        expect(after[1].id).toBe('wb8');
    });

    it('gives merged bodies the settings of the larger one', () => {
        const g = lakeAndPond();
        const bodies = matchBodies(segmentWaterBodies(g, { terrain }), g, []);
        bodies[1].settings.choppiness = 2;
        const stored = serializeBodies(bodies).bodies;
        // Flood everything between them at one level.
        const merged = grid((c, r) => (Math.hypot(c - 30, r - 30) <= 20 || Math.hypot(c - 75, r - 75) <= 4 || (Math.abs(c - r) < 3 && c > 30 && c < 76) ? 5 : NO_WATER));
        const after = matchBodies(segmentWaterBodies(merged, { terrain }), merged, stored);
        expect(after).toHaveLength(1);
        expect(after[0].id).toBe('wb1');
        expect(after[0].settings.choppiness).toBe(1);
    });

    it('measures the fetch along the wind', () => {
        const ribbon = grid((c, r) => (Math.abs(r - 50) <= 2 && c > 10 && c < 90 ? 4 : NO_WATER));
        const [body] = matchBodies(segmentWaterBodies(ribbon), ribbon, []);
        const along = bodyFetch(body, 1, 0, 1e5);
        const across = bodyFetch(body, 0, 1, 1e5);
        expect(along).toBeGreaterThan(140);
        expect(along).toBeLessThan(175);
        expect(across).toBeLessThan(15);
        expect(bodyFetch({ ...body, settings: { ...body.settings, fetch: 900 } }, 0, 1, 1e5)).toBe(900);
    });

    it('sanitises stored settings', () => {
        const s = sanitizeSettings({ wave_height: 99, choppiness: -1, shallow_color: 'red', deep_color: '#AABBCC', kind: 'swamp' }, DEFAULT_BODY_SETTINGS);
        expect(s.wave_height).toBe(4);
        expect(s.choppiness).toBe(0);
        expect(s.shallow_color).toBeNull();
        expect(s.deep_color).toBe('#aabbcc');
        expect(s.kind).toBeNull();
    });
});
