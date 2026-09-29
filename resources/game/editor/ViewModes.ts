import type { PostFx } from '../core/PostFx';
import type { TerrainLayer } from '../shared/types';
import type { Foliage } from '../world/Foliage';
import type { Heightfield } from '../world/Heightfield';
import {
    DENSITY_STOPS,
    HEIGHT_STOPS,
    LAYER_VIEW_COLORS,
    SLOPE_STOPS,
} from '../world/TerrainDebugView';
import type { TerrainViewMode } from '../world/TerrainDebugView';
import type { TerrainMaterial } from '../world/TerrainMaterial';

export type { TerrainViewMode } from '../world/TerrainDebugView';

export type ViewModeInfo = {
    id: TerrainViewMode;
    label: string;
    description: string;
};

/** The editor's view modes, in menu (and V-cycling) order. */
export const VIEW_MODES: ViewModeInfo[] = [
    { id: 'lit', label: 'Lit', description: 'Final rendering' },
    {
        id: 'lighting',
        label: 'Lighting only',
        description: 'Grey albedo: judge light, shadows and AO',
    },
    {
        id: 'layers',
        label: 'Layers',
        description: 'Each terrain layer in its own colour',
    },
    { id: 'slope', label: 'Slope', description: 'Steepness of the ground' },
    { id: 'height', label: 'Height', description: 'Height bands and contours' },
    {
        id: 'density',
        label: 'Foliage density',
        description: 'Instances per 100 m²',
    },
    {
        id: 'wireframe',
        label: 'Wireframe',
        description: 'Terrain triangles at their current LOD',
    },
];

export type LegendEntry = { color: string; label: string };

/** What the view-mode UI shows under the picker for the current mode. */
export type ViewLegend = {
    /** Swatches (a list) or a continuous ramp (entries are its stops, evenly spaced). */
    kind: 'swatches' | 'ramp';
    entries: LegendEntry[];
    note?: string;
};

export type ViewModeTargets = {
    material: TerrainMaterial;
    foliage: Foliage;
    postFx: PostFx;
    heights: Heightfield;
    /** Current terrain layers (names for the layers legend). */
    layers: () => TerrainLayer[];
};

/** Minimum time between two recomputations of the density grid or height range (s). */
const REFRESH_INTERVAL = 0.5;

/** Height bands aimed for over the map's height range. */
const HEIGHT_BANDS = 12;

/**
 * Editor view modes (like Unreal's viewport view modes): applies the chosen mode to the terrain,
 * foliage and post-processing, and keeps the mode's data (foliage density grid, height range) up to
 * date while it is shown. Purely an editor tool: nothing is saved, and play mode renders lit.
 */
export class ViewModes {
    /** Called when the mode or its legend changes. */
    onChange: (() => void) | null = null;
    private mode: TerrainViewMode = 'lit';
    private suspended = false;
    private heightsDirty = true;
    private heightRange = { min: 0, max: 0, step: 1 };
    private densityRevision = -1;
    private cooldown = 0;

    constructor(private readonly targets: ViewModeTargets) {}

    get current(): TerrainViewMode {
        return this.mode;
    }

    set(mode: TerrainViewMode): void {
        if (mode === this.mode) {
            return;
        }

        this.mode = mode;
        this.cooldown = 0;
        this.refresh();
        this.apply();
        this.onChange?.();
    }

    /** Next (+1) or previous (-1) mode, wrapping around. */
    cycle(step: number): void {
        const i = VIEW_MODES.findIndex((m) => m.id === this.mode);
        const n = VIEW_MODES.length;
        this.set(VIEW_MODES[(((i + step) % n) + n) % n].id);
    }

    /** Play mode renders lit; the chosen mode comes back in build mode. */
    setSuspended(suspended: boolean): void {
        this.suspended = suspended;
        this.apply();
    }

    /** The heightmap changed (the height view's range is recomputed). */
    invalidateHeights(): void {
        this.heightsDirty = true;
    }

    /** Refreshes the current mode's data when it changed (throttled). */
    update(dt: number): void {
        this.cooldown -= dt;

        if (this.suspended || this.cooldown > 0) {
            return;
        }

        this.refresh();
    }

    legend(): ViewLegend | null {
        switch (this.mode) {
            case 'layers':
                return {
                    kind: 'swatches',
                    entries: [...this.targets.layers()]
                        .sort((a, b) => a.slot - b.slot)
                        .map((l) => ({
                            color: LAYER_VIEW_COLORS[l.slot],
                            label: l.name,
                        })),
                    note: 'Blended by paint weight',
                };
            case 'slope':
                return {
                    kind: 'ramp',
                    entries: SLOPE_STOPS.map((s, i) => ({
                        color: s.color,
                        label:
                            i === SLOPE_STOPS.length - 1
                                ? `${s.at}°+`
                                : `${s.at}°`,
                    })),
                };
            case 'height': {
                const { min, max, step } = this.heightRange;

                return {
                    kind: 'ramp',
                    entries: HEIGHT_STOPS.map((s) => ({
                        color: s.color,
                        label: `${Math.round(min + (max - min) * s.at)} m`,
                    })),
                    note: `Contours every ${step} m, bold every ${step * 5} m`,
                };
            }
            case 'density':
                return {
                    kind: 'ramp',
                    entries: DENSITY_STOPS.map((s, i) => ({
                        color: s.color,
                        label:
                            i === DENSITY_STOPS.length - 1
                                ? `${s.at}+`
                                : `${s.at}`,
                    })),
                    note: 'Per 100 m²: placed foliage and ground cover grown around the camera',
                };
            case 'lighting':
                return {
                    kind: 'swatches',
                    entries: [],
                    note: 'Grey albedo on terrain and foliage',
                };
            case 'wireframe':
                return {
                    kind: 'swatches',
                    entries: [],
                    note: 'Terrain triangles at their current LOD',
                };
            default:
                return null;
        }
    }

    private apply(): void {
        const mode = this.suspended ? 'lit' : this.mode;
        const { material, foliage, postFx } = this.targets;
        material.debug.setMode(mode);
        foliage.setLightingOnly(mode === 'lighting');
        postFx.setUnlitView(mode !== 'lit' && mode !== 'lighting');
    }

    /** Recomputes the current mode's data if its source changed. */
    private refresh(): void {
        if (this.mode === 'density') {
            const foliage = this.targets.foliage;

            if (foliage.revision !== this.densityRevision) {
                this.densityRevision = foliage.revision;
                const grid = this.targets.material.debug.density;
                grid.counts.fill(0);
                foliage.countInstances(
                    grid.x0,
                    grid.z0,
                    grid.cell,
                    grid.res,
                    grid.counts,
                );
                grid.upload();
                this.cooldown = REFRESH_INTERVAL;
            }
        } else if (this.mode === 'height' && this.heightsDirty) {
            this.heightsDirty = false;
            const { min, max } = this.targets.heights.minMax();
            const step = niceStep((max - min) / HEIGHT_BANDS);
            this.targets.material.debug.setHeightRange(min, max, step);
            const changed =
                min !== this.heightRange.min ||
                max !== this.heightRange.max ||
                step !== this.heightRange.step;
            this.heightRange = { min, max, step };
            this.cooldown = REFRESH_INTERVAL;

            if (changed) {
                this.onChange?.();
            }
        }
    }
}

/** 1, 2 or 5 × a power of ten, at least `raw` (≥ 1 m). */
function niceStep(raw: number): number {
    const r = Math.max(1, raw);
    const pow = 10 ** Math.floor(Math.log10(r));

    for (const m of [1, 2, 5, 10]) {
        if (m * pow >= r) {
            return m * pow;
        }
    }

    return 10 * pow;
}
