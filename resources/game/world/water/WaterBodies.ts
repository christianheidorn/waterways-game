import * as THREE from 'three/webgpu';
import type { Heightfield } from '../Heightfield';
import {
    bodyFetch,
    bodyName,
    matchBodies,
    sanitizeSettings,
    segmentWaterBodies,
    serializeBodies,
} from './bodySegmentation';
import type {
    WaterBodiesFile,
    WaterBody,
    WaterBodyRecord,
    WaterBodySettings,
} from './bodySegmentation';

/** Rows of the body table texture (row 0 = water outside any body: the open sea beyond the map). */
export const BODY_ROWS = 256;

/** Layout of the body table (one column per body row, see WaterBodies.table). */
export const BODY_TABLE = {
    /** (swell, wind, chop) wave weights, choppiness. */
    waves: 0,
    /** Shallow colour (rgb), 1 if overridden. */
    shallow: 1,
    /** Deep colour (rgb), clarity (m, or -1 = environment). */
    deep: 2,
    /** Wind exposure, surf (0/1), kind code (0 lake, 1 pond, 2 river, 3 sea), 1 if the body is selected. */
    misc: 3,
} as const;

const KIND_CODE = { lake: 0, pond: 1, river: 2, sea: 3 } as const;

/** Per-body cascade weights for the current wind (computed by the wave field). */
export type BodyWaveWeights = (
    body: WaterBody | null,
) => [number, number, number];

/**
 * The map's water bodies: segmented from the water grid after every water edit (debounced), matched to
 * the stored ones (stable ids, kept settings), and published to the GPU as a small table texture
 * (BODY_ROWS × 4 RGBA floats) that the water material looks up per pixel by the body row in
 * WaterSurfaceData's data texture.
 */
export class WaterBodies {
    bodies: WaterBody[] = [];
    /** Body label (index + 1) per full-resolution water sample (0 = dry). */
    labels: Int32Array;
    readonly table: THREE.DataTexture;
    private readonly tableData: Float32Array;
    /** Stored records not matched yet (the file loaded before the first segmentation). */
    private records: WaterBodyRecord[] = [];
    private selectedId: string | null = null;
    /** Called after the bodies changed (re-segmented or settings edited). */
    onChange: ((reason: 'segmented' | 'settings') => void) | null = null;

    constructor(
        private readonly surface: Heightfield,
        private readonly terrain: Heightfield,
    ) {
        this.labels = new Int32Array(surface.resolution * surface.resolution);
        this.tableData = new Float32Array(BODY_ROWS * 4 * 4);
        this.table = new THREE.DataTexture(
            this.tableData,
            BODY_ROWS,
            4,
            THREE.RGBAFormat,
            THREE.FloatType,
        );
        this.table.minFilter = this.table.magFilter = THREE.NearestFilter;
        this.table.generateMipmaps = false;
        this.table.name = 'Water bodies';
    }

    /** Stored ids and settings (water_bodies.json); applied on the next segmentation. */
    load(file: WaterBodiesFile | null): void {
        this.records = Array.isArray(file?.bodies)
            ? file.bodies.filter(
                  (b) => typeof b?.id === 'string' && Array.isArray(b.seed),
              )
            : [];
        // The stored ids win over any derived before the file arrived.
        this.bodies = [];
    }

    /** Re-derives the bodies from the water grid, keeping ids and settings. */
    segment(options: {
        riverFlow: Float32Array | null;
        seaLevel: number | null;
        wallLimit: number;
    }): void {
        const seg = segmentWaterBodies(this.surface, {
            terrain: this.terrain,
            riverFlow: options.riverFlow,
            seaLevel: options.seaLevel,
            wallLimit: options.wallLimit,
        });
        const previous = this.bodies.length
            ? serializeBodies(this.bodies).bodies
            : this.records;
        this.records = [];
        this.labels = seg.labels;
        // Biggest first: they get the table rows when there are more bodies than rows.
        this.bodies = matchBodies(seg, this.surface, previous).sort(
            (a, b) => b.area - a.area,
        );
        this.onChange?.('segmented');
    }

    /** Table row of a body label (0 when it has none). */
    rowOfLabel(label: number): number {
        const body = this.byLabel(label);
        const index = body ? this.bodies.indexOf(body) : -1;

        return index >= 0 && index < BODY_ROWS - 1 ? index + 1 : 0;
    }

    byLabel(label: number): WaterBody | undefined {
        return this.labelMap().get(label);
    }

    get(id: string): WaterBody | undefined {
        return this.bodies.find((b) => b.id === id);
    }

    /** The body at a world position (or the nearest wet sample within 2 cells). */
    at(x: number, z: number): WaterBody | null {
        const hf = this.surface;
        const { gx, gz } = hf.toGrid(x, z);
        const c = Math.round(gx);
        const r = Math.round(gz);
        const res = hf.resolution;

        for (let d = 0; d <= 2; d++) {
            for (let dz = -d; dz <= d; dz++) {
                for (let dx = -d; dx <= d; dx++) {
                    const cc = c + dx;
                    const rr = r + dz;

                    if (
                        cc >= 0 &&
                        rr >= 0 &&
                        cc < res &&
                        rr < res &&
                        this.labels[rr * res + cc] > 0
                    ) {
                        return this.byLabel(this.labels[rr * res + cc]) ?? null;
                    }
                }
            }
        }

        return null;
    }

    /** Changes a body's settings (validated); returns the body or null if there is none with that id. */
    update(
        id: string,
        patch: Partial<Record<keyof WaterBodySettings, unknown>>,
    ): WaterBody | null {
        const body = this.get(id);

        if (!body) {
            return null;
        }

        body.settings = sanitizeSettings(patch, body.settings);
        body.kind = body.settings.kind ?? body.auto_kind;
        this.onChange?.('settings');

        return body;
    }

    select(id: string | null): void {
        this.selectedId = id;
        this.onChange?.('settings');
    }

    get selected(): string | null {
        return this.selectedId;
    }

    /** Writes the table texture: per-body wave weights for the current wind, colours, flags. */
    writeTable(
        weights: BodyWaveWeights,
        defaults: { choppiness: number },
    ): void {
        const d = this.tableData;
        const set = (
            row: number,
            entry: number,
            v: [number, number, number, number],
        ) => d.set(v, (entry * BODY_ROWS + row) * 4);
        const color = new THREE.Color();
        const rgb = (hex: string | null): [number, number, number] => {
            if (!hex) {
                return [0, 0, 0];
            }

            color.set(hex);

            return [color.r, color.g, color.b];
        };

        // Row 0: open water outside any body (the ocean beyond the map).
        const open = weights(null);
        set(0, BODY_TABLE.waves, [
            open[0],
            open[1],
            open[2],
            defaults.choppiness,
        ]);
        set(0, BODY_TABLE.shallow, [0, 0, 0, 0]);
        set(0, BODY_TABLE.deep, [0, 0, 0, -1]);
        set(0, BODY_TABLE.misc, [1, 1, KIND_CODE.sea, 0]);

        this.bodies.slice(0, BODY_ROWS - 1).forEach((b, i) => {
            const row = i + 1;
            const s = b.settings;
            const w = weights(b);
            set(row, BODY_TABLE.waves, [
                w[0],
                w[1],
                w[2],
                s.choppiness * defaults.choppiness,
            ]);
            set(row, BODY_TABLE.shallow, [
                ...rgb(s.shallow_color),
                s.shallow_color ? 1 : 0,
            ]);
            set(row, BODY_TABLE.deep, [...rgb(s.deep_color), s.clarity ?? -1]);
            set(row, BODY_TABLE.misc, [
                s.wind_exposure,
                s.surf ? 1 : 0,
                KIND_CODE[b.kind],
                b.id === this.selectedId ? 1 : 0,
            ]);
        });
        this.table.needsUpdate = true;
    }

    /** Fetch (m) of a body for the wind direction (dx, dz). */
    fetch(body: WaterBody, dx: number, dz: number, open: number): number {
        return bodyFetch(body, dx, dz, open);
    }

    serialize(): WaterBodiesFile {
        return this.bodies.length || !this.records.length
            ? serializeBodies(this.bodies)
            : { version: 1, bodies: this.records };
    }

    /** Summary for agents / the editor list. */
    describe(body: WaterBody, windDir?: { x: number; z: number }, open = 1e5) {
        const r = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

        return {
            id: body.id,
            name: bodyName(body),
            kind: body.kind,
            auto_kind: body.auto_kind,
            area_m2: Math.round(body.area),
            level: r(body.level, 2),
            max_depth: r(body.max_depth),
            centroid: { x: r(body.centroid.x), z: r(body.centroid.z) },
            seed: { x: r(body.seed.x), z: r(body.seed.z) },
            bounds: {
                x0: r(body.bounds.x0),
                z0: r(body.bounds.z0),
                x1: r(body.bounds.x1),
                z1: r(body.bounds.z1),
            },
            ...(windDir
                ? {
                      fetch_m: Math.round(
                          bodyFetch(body, windDir.x, windDir.z, open),
                      ),
                  }
                : {}),
            settings: { ...body.settings },
        };
    }

    dispose(): void {
        this.table.dispose();
    }

    private labelIndex: Map<number, WaterBody> | null = null;
    private labelBodies: WaterBody[] | null = null;

    private labelMap(): Map<number, WaterBody> {
        if (this.labelBodies !== this.bodies || !this.labelIndex) {
            // Labels follow segmentation order; bodies are sorted by area: map by seed sample.
            const map = new Map<number, WaterBody>();
            const hf = this.surface;

            for (const b of this.bodies) {
                const { gx, gz } = hf.toGrid(b.seed.x, b.seed.z);
                const label =
                    this.labels[
                        Math.round(gz) * hf.resolution + Math.round(gx)
                    ];

                if (label > 0) {
                    map.set(label, b);
                }
            }

            this.labelIndex = map;
            this.labelBodies = this.bodies;
        }

        return this.labelIndex;
    }
}
