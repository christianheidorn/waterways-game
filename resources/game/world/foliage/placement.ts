import { NO_WATER } from '../../shared/types';
import type { FoliageType } from '../../shared/types';
import type { Heightfield } from '../Heightfield';

/**
 * Placement rules of foliage (slope, altitude, water) and the water level lookup they use: kept free
 * of rendering code so the editor worker (editor/workers/editorWorker.ts) applies exactly the same
 * rules as the main thread.
 */

export type PlacementWorld = {
    heights: Heightfield;
    waterLevelAt: (x: number, z: number) => number | null;
};

/** Whether a type's rules (slope, altitude, underwater) allow an instance at a world position. */
export function placementAllowed(
    ctx: PlacementWorld,
    type: FoliageType,
    x: number,
    z: number,
): boolean {
    const hf = ctx.heights;

    if (!hf.contains(x, z)) {
        return false;
    }

    const y = hf.sample(x, z);
    const slope = hf.slope(x, z);

    if (slope < type.min_slope || slope > type.max_slope) {
        return false;
    }

    if (
        (type.min_height !== null && y < type.min_height) ||
        (type.max_height !== null && y > type.max_height)
    ) {
        return false;
    }

    const water = ctx.waterLevelAt(x, z);

    return type.allow_underwater || water === null || water <= y - 0.05;
}

/**
 * Water surface at a world position inside the water grid (NO_WATER where dry): null when dry,
 * otherwise the average of the wet neighbours (smooth swimming heights). See Water.levelAt.
 */
export function gridWaterLevel(
    surface: Heightfield,
    x: number,
    z: number,
): number | null {
    const { gx, gz } = surface.toGrid(x, z);
    const v = surface.get(Math.round(gx), Math.round(gz));

    if (v <= NO_WATER + 1) {
        return null;
    }

    let sum = 0;
    let count = 0;

    for (let dz = 0; dz <= 1; dz++) {
        for (let dx = 0; dx <= 1; dx++) {
            const s = surface.get(Math.floor(gx) + dx, Math.floor(gz) + dz);

            if (s > NO_WATER + 1) {
                sum += s;
                count++;
            }
        }
    }

    return count ? sum / count : v;
}
