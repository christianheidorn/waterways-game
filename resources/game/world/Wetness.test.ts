import { describe, expect, it } from 'vitest';
import { beginStaggerFrame } from '../core/stagger';
import { NO_WATER } from '../shared/types';
import { Heightfield } from './Heightfield';
import { Wetness } from './Wetness';

/** A bumpy 129² map (2 m cells) with a lake in one corner. */
function world(): { heights: Heightfield; water: Heightfield } {
    const res = 129;
    const heights = new Heightfield(res, 256);
    const water = new Heightfield(res, 256);
    water.data.fill(NO_WATER);

    for (let r = 0; r < res; r++) {
        for (let c = 0; c < res; c++) {
            const h =
                Math.sin(c * 0.21) * 1.3 +
                Math.cos(r * 0.17) * 1.1 +
                Math.sin((c + r) * 0.05) * 4;
            heights.set(c, r, h);

            if (Math.hypot(c - 30, r - 30) < 18) {
                heights.set(c, r, h - 3);
                water.set(c, r, h - 1);
            }
        }
    }

    return { heights, water };
}

describe('Wetness', () => {
    it('recomputes an edited rect exactly like a full pass', () => {
        const { heights, water } = world();
        const wetness = new Wetness(heights, water);
        wetness.compute();

        // A new pond and a dug hollow in the middle of the map.
        const rect = { x0: 60, z0: 62, x1: 72, z1: 70 };

        for (let r = rect.z0; r <= rect.z1; r++) {
            for (let c = rect.x0; c <= rect.x1; c++) {
                if (c < 66) {
                    water.set(c, r, heights.get(c, r) + 0.8);
                } else {
                    heights.set(c, r, heights.get(c, r) - 0.6);
                }
            }
        }

        wetness.invalidate(rect);
        beginStaggerFrame();
        wetness.update(1);

        const fresh = new Wetness(heights, water);
        fresh.compute();
        const a = wetness.texture.image.data as Uint8Array;
        const b = fresh.texture.image.data as Uint8Array;
        let changed = 0;

        for (let i = 0; i < a.length; i++) {
            expect(a[i]).toBe(b[i]);
        }

        // The edit did change something (the test isn't comparing two untouched maps).
        const before = world();
        const untouched = new Wetness(before.heights, before.water);
        untouched.compute();
        const c = untouched.texture.image.data as Uint8Array;

        for (let i = 0; i < a.length; i++) {
            changed += a[i] !== c[i] ? 1 : 0;
        }

        expect(changed).toBeGreaterThan(100);
    });
});
