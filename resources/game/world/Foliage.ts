import * as THREE from 'three';
import type { GameRenderer } from '../core/renderer';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FOLIAGE_STRIDE } from '../shared/types';
import type { FoliageFile, FoliageKind, FoliageType } from '../shared/types';
import { mulberry32, SimplexNoise } from '../util/noise';
import type { FoliageTypeStat } from '../shared/protocol';
import { createFoliageGeometry } from './FoliageGeometry';
import {
    findLodRoots,
    LOD_BUDGETS,
    renderImpostor,
    simplifyGeometry,
    triangleCount,
} from './FoliageLod';
import type { Heightfield } from './Heightfield';

/**
 * Runtime cell size per kind (m). Small, dense foliage uses small cells so frustum culling, LOD and
 * the distance density falloff work at a finer grain; trees keep large cells (fewer draw calls).
 * Cells are runtime-only: the foliage file stores a flat instance list per type.
 */
const CELL_SIZES: Record<FoliageKind, number> = {
    conifer: 128,
    broadleaf: 128,
    palm: 128,
    rock: 64,
    bush: 64,
    reed: 32,
    grass: 32,
    flower: 32,
};

/**
 * Kinds that thin out with distance: beyond `start` × cull distance fewer instances are drawn,
 * down to `min` × density at the cull distance. Instances are shuffled, so drawing a prefix of a
 * cell is a uniform subset; the vertex shader shrinks the instances at the edge of that prefix so
 * the density changes smoothly instead of popping.
 */
const DENSITY_FALLOFF: Partial<
    Record<FoliageKind, { start: number; min: number }>
> = {
    grass: { start: 0.2, min: 0.2 },
    flower: { start: 0.25, min: 0.25 },
    reed: { start: 0.3, min: 0.35 },
    bush: { start: 0.3, min: 0.35 },
};

/** Fraction of a cell's instances that are mid-transition in the density fade. */
const RANK_FADE = 0.12;
/** Camera movement (m) that triggers re-evaluating cell visibility / LOD / density. */
const EVAL_MOVE = 2;
/** Re-evaluate at least this often (s) even when the camera is still. */
const EVAL_INTERVAL = 0.5;
/** Per-frame time budget (ms) for (re)building cell instance buffers. */
const BUILD_BUDGET_MS = 4;
/**
 * Far chunks: cells × cells blocks whose instances are drawn with the far LOD as one batch once the
 * whole block is beyond the far LOD distance (distant forests become a few draw calls).
 */
const CHUNK_CELLS = 4;
/** Default distance (m) within which foliage casts shadows (GraphicsSettings.foliage_shadow_distance). */
const DEFAULT_SHADOW_DISTANCE = 120;
/**
 * Slack (m) around the per-instance LOD0 → LOD1 split. Cells are only re-evaluated every EVAL_MOVE
 * metres, while the shader switches instances at the exact distance, so a cell is drawn as "near +
 * far" whenever the split might pass through it before the next evaluation.
 */
const LOD_SPLIT_SLACK = EVAL_MOVE * 2;
/** Split distance used while a type has no split (keeps the near-role shader test always true). */
const NO_SPLIT = 1e9;

/**
 * Which side of the per-instance LOD0 / LOD1 split a material draws: 'near' keeps instances closer
 * than the split distance (LOD0), 'far' those beyond it (LOD1), 'none' draws everything.
 */
type LodRole = 'near' | 'far' | 'none';

type Cell = {
    /** `${size}:${cx},${cz}` — also the undo snapshot id. */
    key: string;
    cx: number;
    cz: number;
    data: number[];
    mesh: THREE.InstancedMesh | null;
    /** Instances the mesh's buffers can hold (reused while the cell changes). */
    capacity: number;
    /** Instances written into the mesh buffers. */
    built: number;
    dirty: boolean;
    queued: boolean;
    lod: number;
    /** Tight instance bounds (incl. model extents) once built; the cell footprint before that. */
    bounds: THREE.Box3;
    /** Evaluation stamp while listed in renderer.shown. */
    shownStamp: number;
    /** Evaluation stamp while a far chunk draws this cell's instances. */
    coveredStamp: number;
    /** While covered: build the cell anyway (the chunk is about to hand over to its cells). */
    prebuild: boolean;
    /** Far chunk this cell belongs to (null for kinds without a far LOD, and for chunks). */
    chunk: Chunk | null;
    /**
     * LOD0 subset of a cell the LOD0 → LOD1 split passes through: the cell mesh then draws LOD1
     * (instances closer than the split collapse in the shader) and this mesh draws the instances
     * near the split with LOD0 — so LOD0 never reaches past the split just because the cell is large.
     */
    near: THREE.InstancedMesh | null;
};

/** A far-LOD batch over CHUNK_CELLS² cells; `data` is only filled while building. */
type Chunk = Cell & { members: Cell[]; gx: number; gz: number };

type TypeRenderer = {
    type: FoliageType;
    cellSize: number;
    lods: THREE.BufferGeometry[];
    /**
     * Geometry actually drawn per LOD. For procedural meshes LOD0 is LOD0 + a slightly shrunk LOD1
     * appended; the main pass draws the first range and the shadow pass the cheap second one.
     */
    drawLods: THREE.BufferGeometry[];
    shadowProxy: {
        geometry: THREE.BufferGeometry;
        start: number;
        count: number;
        main: number;
    } | null;
    lodDistances: number[];
    /** Material(s) per LOD — procedural LODs share one material, baked models have one set per LOD. */
    lodMaterials: (THREE.Material | THREE.Material[])[];
    /**
     * Wind-aware depth material for procedural meshes. null for models: three then builds a depth
     * variant per material that honours map + alphaTest, so leaf cards cast leaf-shaped shadows.
     */
    depthMaterial: THREE.MeshDepthMaterial | null;
    /** true once a GLB model replaced the procedural geometry. */
    model: boolean;
    disposed: boolean;
    cells: Map<string, Cell>;
    /** Same cells by packed grid index (fast lookups while evaluating). */
    grid: Map<number, Cell>;
    /** Far chunks by packed chunk index (kinds with ≥ 3 LODs). */
    chunks: Map<number, Chunk>;
    /** Union of every cell footprint that ever held data (hierarchical early-out). */
    extent: THREE.Box3;
    /** Cells currently shown (mesh.visible = true). */
    shown: Cell[];
    /** Distance fade / density falloff (per instance) for small foliage. */
    fade: boolean;
    falloff: { start: number; min: number } | null;
    /** Largest distance of any LOD vertex from the instance origin, at scale 1. */
    radius: number;
    /** Per-type shader uniforms (updated in place, e.g. when the cull distance changes). */
    uniforms: {
        uFadeEnd: { value: number };
        uFalloff: { value: THREE.Vector2 };
        /** Per-instance LOD0 → LOD1 switch distance (m, 3D), NO_SPLIT when unused. */
        uLodSplit: { value: number };
    };
    /** Where the LODs came from and what was generated at runtime (stats / F10 readout). */
    lodInfo: {
        source: FoliageTypeStat['source'];
        generated: string[];
        warnings: string[];
    };
    /** Materials of LOD0 / LOD1 are patched with the 'near' / 'far' roles (per-instance split). */
    splitRoles: boolean;
    /** Far impostor still to be rendered (needs the WebGL renderer; see Foliage.update()). */
    pendingImpostor: { distance: number; role: LodRole } | null;
};

export type FoliageStats = {
    /** Stored instances (all types). */
    instances: number;
    /** Instances submitted for drawing in the main pass (frustum-culled cells excluded). */
    drawnInstances: number;
    /** Main-pass foliage draw calls. */
    drawCalls: number;
    /** Main-pass foliage triangles. */
    triangles: number;
    /** Cells casting shadows (each costs a draw call per shadow pass when in the shadow frustum). */
    shadowCasters: number;
    /** Cells with a mesh / cells shown / cells total. */
    meshes: number;
    shownCells: number;
    cells: number;
    /** Cells waiting to be (re)built. */
    pendingBuilds: number;
    /** Main-pass draw calls / triangles / instances per foliage type name. */
    byType: Record<
        string,
        { drawCalls: number; triangles: number; instances: number }
    >;
    /** Per-type detail: LOD chain, triangles per LOD, drawn instances per LOD, missing-LOD warnings. */
    types: FoliageTypeStat[];
};

export type FoliagePlacementContext = {
    heights: Heightfield;
    waterLevelAt: (x: number, z: number) => number | null;
    /** ESA WorldCover class at a world position (0 = unknown), for real-world maps. */
    landCoverAt?: (x: number, z: number) => number;
};

/**
 * How likely each foliage kind grows on each ESA WorldCover class (10 trees, 20 shrubland,
 * 30 grassland, 40 cropland, 50 built-up, 60 bare, 70 snow, 80 water, 90 wetland, 95 mangroves,
 * 100 moss & lichen). Unknown classes fall back to the procedural masks.
 */
const LAND_COVER_AFFINITY: Record<string, Record<number, number>> = {
    tree: {
        10: 1,
        95: 0.9,
        20: 0.18,
        30: 0.04,
        40: 0.01,
        60: 0.03,
        90: 0.08,
        100: 0.04,
        50: 0.01,
        70: 0,
        80: 0,
    },
    bush: {
        20: 1,
        10: 0.5,
        30: 0.25,
        40: 0.05,
        60: 0.15,
        90: 0.4,
        95: 0.6,
        100: 0.3,
        50: 0.02,
        70: 0,
        80: 0,
    },
    grass: {
        30: 1,
        100: 0.9,
        20: 0.7,
        40: 0.5,
        10: 0.3,
        90: 0.8,
        95: 0.2,
        60: 0.12,
        50: 0.05,
        70: 0,
        80: 0,
    },
    flower: {
        30: 1,
        100: 0.6,
        20: 0.4,
        40: 0.15,
        10: 0.1,
        90: 0.3,
        60: 0.05,
        50: 0.02,
        70: 0,
        80: 0,
    },
    reed: {
        90: 1,
        95: 0.6,
        80: 1,
        30: 0.4,
        20: 0.4,
        40: 0.2,
        10: 0.2,
        60: 0.1,
        50: 0,
        70: 0,
        100: 0.3,
    },
    rock: {
        60: 1.6,
        70: 0.4,
        100: 0.9,
        20: 0.8,
        30: 0.6,
        10: 0.7,
        40: 0.2,
        50: 0.1,
        90: 0.2,
        80: 0.5,
        95: 0.1,
    },
};

function affinityGroup(kind: string): keyof typeof LAND_COVER_AFFINITY {
    return kind === 'conifer' || kind === 'broadleaf' || kind === 'palm'
        ? 'tree'
        : (kind as keyof typeof LAND_COVER_AFFINITY);
}

/**
 * Instanced foliage split into spatial cells per foliage type, so painting only rebuilds nearby
 * batches and distant cells can be culled or drawn with a cheaper LOD.
 */
export class Foliage {
    readonly group = new THREE.Group();
    /** Called before a cell's instance list changes (used for undo snapshots). */
    onBeforeModify: ((typeId: number, cellKey: string) => void) | null = null;
    private renderers = new Map<number, TypeRenderer>();
    /** Instances of types that are currently not in the type list (kept for saving / re-adding). */
    private orphaned = new Map<number, number[]>();
    private uniforms = {
        uTime: { value: 0 },
        uWind: { value: 0.4 },
        /** Horizontal direction the wind blows towards (unit x/z). */
        uWindDir: { value: new THREE.Vector2(0.84, 0.54) },
        uCamPos: { value: new THREE.Vector3() },
        uFadeScale: { value: 1 },
        uDensity: { value: 1 },
    };
    private gltf = new GLTFLoader();
    private random = mulberry32(Date.now() & 0xffff);
    private density = 1;
    private shadowDistance = DEFAULT_SHADOW_DISTANCE;
    private lodBias = 1;
    /** Forces a full re-evaluation of cells on the next update(). */
    private needsEval = true;
    private evalStamp = 0;
    private evalTimer = 0;
    private readonly lastEvalPos = new THREE.Vector3(Infinity, 0, 0);
    private readonly queue: { renderer: TypeRenderer; cell: Cell }[] = [];
    private lastCamera: THREE.Camera | null = null;
    /** Renderer used to render missing impostors (set explicitly or picked up from a draw). */
    private gl: GameRenderer | null = null;
    private readonly captureRenderer = (renderer: GameRenderer) => {
        this.gl ??= renderer;
    };

    constructor() {
        this.group.name = 'Foliage';
    }

    /**
     * WebGL renderer for runtime-generated impostors of models without a far LOD. Optional: the
     * renderer is otherwise picked up from the first foliage draw.
     */
    setRenderer(renderer: GameRenderer | null): void {
        this.gl = renderer;
    }

    /** Fraction of instances drawn (GraphicsSettings.foliage_density). */
    get densityScale(): number {
        return this.density;
    }

    set densityScale(value: number) {
        this.density = Math.max(0, value);
        this.uniforms.uDensity.value = this.density;
        this.needsEval = true;
    }

    /** Multiplier on every type's cull distance (GraphicsSettings.foliage_distance). */
    get distanceScale(): number {
        return this.uniforms.uFadeScale.value;
    }

    set distanceScale(value: number) {
        this.uniforms.uFadeScale.value = Math.max(0.01, value);
        this.needsEval = true;
    }

    /** Foliage further than this (m) casts no shadows (GraphicsSettings.foliage_shadow_distance). */
    setShadowDistance(metres: number | null | undefined): void {
        this.shadowDistance =
            typeof metres === 'number' && Number.isFinite(metres)
                ? Math.max(0, metres)
                : DEFAULT_SHADOW_DISTANCE;
        this.needsEval = true;
    }

    /** > 1 keeps detailed LODs further away, < 1 switches earlier (GraphicsSettings.foliage_lod_bias). */
    setLodBias(bias: number | null | undefined): void {
        this.lodBias =
            typeof bias === 'number' && Number.isFinite(bias) && bias > 0
                ? bias
                : 1;
        this.needsEval = true;
    }

    setTypes(types: FoliageType[]): void {
        const keep = new Set(types.map((t) => t.id));

        for (const [id, renderer] of this.renderers) {
            if (!keep.has(id)) {
                // Keep the data so re-adding the type (or saving) doesn't lose placements.
                this.orphaned.set(id, flatten(renderer));
                this.disposeRenderer(renderer);
                this.renderers.delete(id);
            }
        }

        for (const type of types) {
            const existing = this.renderers.get(type.id);

            if (existing && sameVisuals(existing.type, type)) {
                // Cheap in-place update (editor sliders): cull distance, shadows, placement rules.
                existing.type = type;
                existing.uniforms.uFadeEnd.value = type.cull_distance;
                continue;
            }

            let flat: number[] | undefined;

            if (existing) {
                flat = flatten(existing);
                this.disposeRenderer(existing);
            } else {
                flat = this.orphaned.get(type.id);
                this.orphaned.delete(type.id);
            }

            const renderer = this.createRenderer(type);
            this.renderers.set(type.id, renderer);

            if (flat?.length) {
                this.insertFlat(renderer, flat);
            }
        }

        this.needsEval = true;
    }

    load(file: FoliageFile | null): void {
        for (const renderer of this.renderers.values()) {
            for (const cell of renderer.cells.values()) {
                this.removeCellMesh(cell);
            }

            for (const chunk of renderer.chunks.values()) {
                this.removeCellMesh(chunk);
            }

            renderer.cells.clear();
            renderer.grid.clear();
            renderer.chunks.clear();
            renderer.shown = [];
            renderer.extent.makeEmpty();
        }

        this.queue.length = 0;
        this.orphaned.clear();
        this.needsEval = true;

        if (!file) {
            return;
        }

        for (const [id, flat] of Object.entries(file.instances)) {
            const typeId = Number(id);
            const renderer = this.renderers.get(typeId);

            if (renderer) {
                this.insertFlat(renderer, flat);
            } else {
                this.orphaned.set(
                    typeId,
                    flat.slice(0, flat.length - (flat.length % FOLIAGE_STRIDE)),
                );
            }
        }
    }

    serialize(): FoliageFile {
        const instances: Record<string, number[]> = {};
        const round = (v: number) => Math.round(v * 1000) / 1000;

        const add = (id: number, data: number[]) => {
            const list = (instances[id] ??= []);

            for (const v of data) {
                list.push(round(v));
            }
        };

        for (const [id, renderer] of this.renderers) {
            for (const cell of renderer.cells.values()) {
                add(id, cell.data);
            }
        }

        for (const [id, flat] of this.orphaned) {
            add(id, flat);
        }

        return { version: 1, instances };
    }

    get instanceCount(): number {
        let count = 0;

        for (const renderer of this.renderers.values()) {
            for (const cell of renderer.cells.values()) {
                count += cell.data.length / FOLIAGE_STRIDE;
            }
        }

        return count;
    }

    setWind(strength: number, dirX?: number, dirZ?: number): void {
        this.uniforms.uWind.value = strength;

        if (dirX !== undefined && dirZ !== undefined) {
            this.uniforms.uWindDir.value.set(dirX, dirZ);
        }
    }

    /** Paint instances of the given types into a circle, respecting each type's rules and density. */
    paint(
        ctx: FoliagePlacementContext,
        typeIds: number[],
        x: number,
        z: number,
        radius: number,
        strength: number,
        dt: number,
        weightAt: (d: number) => number,
    ): void {
        const area = Math.PI * radius * radius;

        for (const id of typeIds) {
            const renderer = this.renderers.get(id);

            if (!renderer) {
                continue;
            }

            const type = renderer.type;
            const target = (type.density / 100) * area * strength;
            const existing = this.countInCircle(renderer, x, z, radius);
            const budget = Math.min(
                Math.ceil((target - existing) * Math.min(1, dt * 6)),
                400,
            );

            if (budget <= 0) {
                continue;
            }

            const spacing =
                Math.sqrt(100 / Math.max(0.01, type.density)) * 0.45;
            let placed = 0;

            for (
                let attempt = 0;
                attempt < budget * 4 && placed < budget;
                attempt++
            ) {
                const a = this.random() * Math.PI * 2;
                const d = Math.sqrt(this.random()) * radius;

                if (this.random() > weightAt(d)) {
                    continue;
                }

                const px = x + Math.cos(a) * d;
                const pz = z + Math.sin(a) * d;

                if (this.tryPlace(ctx, renderer, px, pz, spacing)) {
                    placed++;
                }
            }
        }
    }

    /**
     * Procedurally scatter foliage over the whole map using each type's rules plus natural masks:
     * trees cluster into forests, bushes favour forest edges, reeds hug shorelines, rocks prefer slopes.
     * Existing instances of the given types are replaced.
     */
    populate(
        ctx: FoliagePlacementContext,
        typeIds: number[],
        seed = 1,
    ): number {
        const hf = ctx.heights;
        const noise = new SimplexNoise(seed * 31 + 7);
        const rand = mulberry32(seed * 977 + 13);
        const size = hf.size;
        const half = hf.half;
        const forest = (x: number, z: number) =>
            noise.fbm(x / 420, z / 420, 4) * 0.8 +
            noise.noise2D(x / 90 + 50, z / 90) * 0.2;
        const meadow = (x: number, z: number) =>
            noise.fbm(x / 160 + 100, z / 160 - 40, 3);
        const nearWater = (x: number, z: number) => {
            for (const [dx, dz] of [
                [0, 0],
                [7, 0],
                [-7, 0],
                [0, 7],
                [0, -7],
            ]) {
                if (ctx.waterLevelAt(x + dx, z + dz) !== null) {
                    return true;
                }
            }

            return false;
        };
        let total = 0;

        for (const id of typeIds) {
            const renderer = this.renderers.get(id);

            if (!renderer) {
                continue;
            }

            const type = renderer.type;
            const kindFactor: Record<string, number> = {
                conifer: 1,
                broadleaf: 1,
                palm: 0.6,
                bush: 0.35,
                grass: 0.12,
                flower: 0.12,
                reed: 0.5,
                rock: 0.6,
            };
            const cap: Record<string, number> = {
                conifer: 30000,
                broadleaf: 25000,
                palm: 8000,
                bush: 25000,
                grass: 140000,
                flower: 25000,
                reed: 20000,
                rock: 8000,
            };
            const density = Math.max(
                0.001,
                type.density * (kindFactor[type.kind] ?? 0.5),
            );
            const spacing = Math.max(0.6, Math.sqrt(100 / density));
            const steps = Math.floor(size / spacing);
            const maxCount = cap[type.kind] ?? 20000;
            const typeSeed = id * 0.37;

            for (const cell of renderer.cells.values()) {
                this.onBeforeModify?.(id, cell.key);
                cell.data = [];
                this.markDirty(renderer, cell);
            }

            let count = 0;

            for (let j = 0; j < steps && count < maxCount; j++) {
                for (let i = 0; i < steps && count < maxCount; i++) {
                    const x = -half + (i + rand()) * spacing;
                    const z = -half + (j + rand()) * spacing;
                    const f = forest(x + typeSeed * 1000, z);
                    let p = 1;

                    switch (type.kind) {
                        case 'conifer':
                        case 'broadleaf':
                        case 'palm':
                            p = smooth01(
                                0.05,
                                0.35,
                                f +
                                    (type.kind === 'broadleaf'
                                        ? noise.noise2D(x / 300, z / 300 + 9) *
                                          0.25
                                        : 0),
                            );
                            break;
                        case 'bush':
                            p =
                                0.15 +
                                smooth01(-0.1, 0.15, f) *
                                    (1 - smooth01(0.3, 0.5, f)) *
                                    0.85;
                            break;
                        case 'grass':
                            p =
                                smooth01(-0.45, 0.1, meadow(x, z)) *
                                (1 - smooth01(0.25, 0.5, f) * 0.7);
                            break;
                        case 'flower':
                            p =
                                smooth01(0.2, 0.55, meadow(x + 300, z)) *
                                (1 - smooth01(0.1, 0.3, f));
                            break;
                        case 'reed':
                            p = nearWater(x, z) ? 0.9 : 0;
                            break;
                        case 'rock':
                            p = 0.25 + smooth01(15, 40, hf.slope(x, z)) * 0.75;
                            break;
                    }

                    // Real-world maps: follow the actual land cover (forests, meadows, wetlands…).
                    const lc = ctx.landCoverAt?.(x, z) ?? 0;

                    if (lc !== 0) {
                        const group = affinityGroup(type.kind);
                        const affinity =
                            LAND_COVER_AFFINITY[group]?.[lc] ?? 0.5;

                        if (group === 'tree' && lc === 10) {
                            // Inside mapped forest: dense, with small natural clearings.
                            p = 0.55 + p * 0.45;
                        }

                        p *= affinity;
                    }

                    if (rand() > p) {
                        continue;
                    }

                    if (this.tryPlace(ctx, renderer, x, z, 0, false, true)) {
                        count++;
                    }
                }
            }

            for (const cell of renderer.cells.values()) {
                shuffleInstances(cell.data, rand);
            }

            total += count;
        }

        return total;
    }

    /**
     * Fill a circle as if painted at full strength until saturated (used by the foliage preview).
     * Every candidate spot is subject to the type's rules and spacing, so forbidden ground stays
     * empty and allowed ground ends up at the configured density. Deterministic for a given seed.
     * Returns the number of instances placed.
     */
    fill(
        ctx: FoliagePlacementContext,
        typeId: number,
        x: number,
        z: number,
        radius: number,
        seed = 1,
        maxInstances = 60000,
    ): number {
        const renderer = this.renderers.get(typeId);

        if (!renderer) {
            return 0;
        }

        const type = renderer.type;
        const target = Math.min(
            maxInstances,
            Math.round((type.density / 100) * Math.PI * radius * radius),
        );
        const spacing = Math.sqrt(100 / Math.max(0.01, type.density)) * 0.45;
        const checkSpacing = spacing > 0.3;
        const s2 = spacing * spacing;
        // Local spatial hash so the neighbour test stays O(1) even for dense grass.
        const grid = new Map<number, number[]>();
        const gridKey = (gx: number, gz: number) =>
            (gx + 32768) * 65536 + (gz + 32768);
        const crowded = (px: number, pz: number) => {
            const gx = Math.floor(px / spacing);
            const gz = Math.floor(pz / spacing);

            for (let dz = -1; dz <= 1; dz++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const list = grid.get(gridKey(gx + dx, gz + dz));

                    if (!list) {
                        continue;
                    }

                    for (let i = 0; i < list.length; i += 2) {
                        const ex = list[i] - px;
                        const ez = list[i + 1] - pz;

                        if (ex * ex + ez * ez < s2) {
                            return true;
                        }
                    }
                }
            }

            return false;
        };
        const previousRandom = this.random;
        const rand = mulberry32(seed * 7919 + 17);
        this.random = mulberry32(seed * 104729 + 3);
        let placed = 0;

        try {
            for (let i = 0; i < target; i++) {
                const a = rand() * Math.PI * 2;
                const d = Math.sqrt(rand()) * radius;
                let px = x + Math.cos(a) * d;
                let pz = z + Math.sin(a) * d;

                // Like a brush dab, a spot taken by a neighbour is retried nearby a few times.
                for (let attempt = 0; attempt < 4; attempt++) {
                    if (!placementAllowed(ctx, type, px, pz)) {
                        break;
                    }

                    if (!checkSpacing || !crowded(px, pz)) {
                        if (
                            this.tryPlace(ctx, renderer, px, pz, 0, true, true)
                        ) {
                            placed++;

                            if (checkSpacing) {
                                const k = gridKey(
                                    Math.floor(px / spacing),
                                    Math.floor(pz / spacing),
                                );
                                const list = grid.get(k) ?? [];
                                list.push(px, pz);
                                grid.set(k, list);
                            }
                        }

                        break;
                    }

                    px += (rand() - 0.5) * spacing * 3;
                    pz += (rand() - 0.5) * spacing * 3;

                    if ((px - x) ** 2 + (pz - z) ** 2 > radius * radius) {
                        break;
                    }
                }
            }

            for (const cell of renderer.cells.values()) {
                shuffleInstances(cell.data, rand);
            }
        } finally {
            this.random = previousRandom;
        }

        return placed;
    }

    /** Current render geometry of a type (procedural LODs, or the loaded GLB model's LODs). */
    geometryOf(typeId: number): {
        lods: THREE.BufferGeometry[];
        lodDistances: number[];
        /** true once a GLB model has replaced the procedural mesh. */
        model: boolean;
    } | null {
        const renderer = this.renderers.get(typeId);

        return renderer
            ? {
                  lods: renderer.lods,
                  lodDistances: renderer.lodDistances,
                  model: renderer.model,
              }
            : null;
    }

    /** Place one instance exactly (single-click placement). */
    placeSingle(
        ctx: FoliagePlacementContext,
        typeId: number,
        x: number,
        z: number,
    ): boolean {
        const renderer = this.renderers.get(typeId);

        return renderer ? this.tryPlace(ctx, renderer, x, z, 0, true) : false;
    }

    erase(
        typeIds: number[] | null,
        x: number,
        z: number,
        radius: number,
        strength: number,
        weightAt: (d: number) => number,
    ): void {
        const r2 = radius * radius;

        for (const [id, renderer] of this.renderers) {
            if (typeIds && !typeIds.includes(id)) {
                continue;
            }

            for (const cell of this.cellsInCircle(renderer, x, z, radius)) {
                const data = cell.data;
                let changed = false;
                const next: number[] = [];

                for (let i = 0; i < data.length; i += FOLIAGE_STRIDE) {
                    const dx = data[i] - x;
                    const dz = data[i + 2] - z;
                    const dd = dx * dx + dz * dz;

                    if (
                        dd <= r2 &&
                        this.random() <
                            weightAt(Math.sqrt(dd)) * Math.max(0.05, strength)
                    ) {
                        if (!changed) {
                            this.onBeforeModify?.(id, cell.key);
                            changed = true;
                        }

                        continue;
                    }

                    for (let k = 0; k < FOLIAGE_STRIDE; k++) {
                        next.push(data[i + k]);
                    }
                }

                if (changed) {
                    cell.data = next;
                    this.markDirty(renderer, cell);
                }
            }
        }
    }

    /** Re-seat instances on the terrain after sculpting (world-space rect). */
    snapToTerrain(
        heights: Heightfield,
        minX: number,
        minZ: number,
        maxX: number,
        maxZ: number,
    ): void {
        const normal = new THREE.Vector3();

        for (const renderer of this.renderers.values()) {
            const size = renderer.cellSize;

            for (const cell of renderer.cells.values()) {
                if (
                    (cell.cx + 1) * size < minX ||
                    cell.cx * size > maxX ||
                    (cell.cz + 1) * size < minZ ||
                    cell.cz * size > maxZ
                ) {
                    continue;
                }

                const d = cell.data;
                let changed = false;

                for (let i = 0; i < d.length; i += FOLIAGE_STRIDE) {
                    if (
                        d[i] < minX ||
                        d[i] > maxX ||
                        d[i + 2] < minZ ||
                        d[i + 2] > maxZ
                    ) {
                        continue;
                    }

                    d[i + 1] = heights.sample(d[i], d[i + 2]);

                    if (renderer.type.align_to_normal) {
                        heights.normal(d[i], d[i + 2], normal);
                        d[i + 5] = Math.atan2(normal.z, normal.y);
                        d[i + 6] = -Math.atan2(normal.x, normal.y);
                    }

                    changed = true;
                }

                if (changed) {
                    this.markDirty(renderer, cell);
                }
            }
        }
    }

    /**
     * Snapshot / restore support for undo (per type + cell). Keys come from onBeforeModify; a key
     * of a different cell size (the type's kind changed since) is resolved by its footprint.
     */
    captureCell(typeId: number, key: string): number[] {
        const renderer = this.renderers.get(typeId);
        const cell = parseCellKey(key);

        if (!renderer || !cell) {
            return [];
        }

        if (cell.size === renderer.cellSize) {
            return [...(renderer.cells.get(key)?.data ?? [])];
        }

        const out: number[] = [];

        for (const c of this.cellsInRect(renderer, cell)) {
            forEachInRect(c.data, cell, (i) => {
                for (let k = 0; k < FOLIAGE_STRIDE; k++) {
                    out.push(c.data[i + k]);
                }
            });
        }

        return out;
    }

    restoreCell(typeId: number, key: string, data: number[]): void {
        const renderer = this.renderers.get(typeId);
        const cell = parseCellKey(key);

        if (!renderer || !cell) {
            return;
        }

        if (cell.size === renderer.cellSize) {
            const target = this.cellFor(renderer, key);
            target.data = [...data];
            this.markDirty(renderer, target);

            return;
        }

        for (const c of this.cellsInRect(renderer, cell)) {
            const next: number[] = [];
            let removed = false;

            for (let i = 0; i < c.data.length; i += FOLIAGE_STRIDE) {
                if (inRect(c.data[i], c.data[i + 2], cell)) {
                    removed = true;
                    continue;
                }

                for (let k = 0; k < FOLIAGE_STRIDE; k++) {
                    next.push(c.data[i + k]);
                }
            }

            if (removed) {
                c.data = next;
                this.markDirty(renderer, c);
            }
        }

        this.insertFlat(renderer, data);
    }

    /** Foliage rendering statistics for the last evaluated camera. */
    stats(): FoliageStats {
        const stats: FoliageStats = {
            instances: 0,
            drawnInstances: 0,
            drawCalls: 0,
            triangles: 0,
            shadowCasters: 0,
            meshes: 0,
            shownCells: 0,
            cells: 0,
            pendingBuilds: this.queue.length,
            byType: {},
            types: [],
        };
        const camera = this.lastCamera;

        if (camera) {
            camera.updateMatrixWorld();
            _projScreen.multiplyMatrices(
                camera.projectionMatrix,
                camera.matrixWorldInverse,
            );
            _frustum.setFromProjectionMatrix(_projScreen);
        }

        for (const renderer of this.renderers.values()) {
            stats.cells += renderer.cells.size;
            const typeStats = (stats.byType[renderer.type.name] ??= {
                drawCalls: 0,
                triangles: 0,
                instances: 0,
            });
            const cull = renderer.type.cull_distance * this.distanceScale;
            const lodTriangles = renderer.lods.map(triangleCount);
            const detail: FoliageTypeStat = {
                name: renderer.type.name,
                kind: renderer.type.kind,
                source: renderer.lodInfo.source,
                instances: 0,
                drawn: 0,
                drawCalls: 0,
                triangles: 0,
                lodTriangles,
                lodInstances: lodTriangles.map(() => 0),
                lodDistances: renderer.lodDistances.map((d) =>
                    Math.round(d * cull * this.lodBias),
                ),
                cullDistance: Math.round(cull),
                shadowCasters: 0,
                generated: renderer.lodInfo.generated.slice(),
                warnings: lodWarnings(renderer, lodTriangles),
            };
            stats.types.push(detail);

            for (const cell of renderer.cells.values()) {
                const n = cell.data.length / FOLIAGE_STRIDE;
                stats.instances += n;
                detail.instances += n;
                stats.meshes += cell.mesh ? 1 : 0;
            }

            for (const cell of renderer.shown) {
                for (const mesh of [cell.mesh, cell.near]) {
                    if (!mesh?.visible) {
                        continue;
                    }

                    const lod = mesh === cell.near ? 0 : cell.lod;

                    if (mesh === cell.mesh) {
                        stats.shownCells++;
                    }

                    stats.shadowCasters += mesh.castShadow ? 1 : 0;
                    detail.shadowCasters += mesh.castShadow ? 1 : 0;

                    if (
                        camera &&
                        !_frustum.intersectsSphere(mesh.boundingSphere!)
                    ) {
                        continue;
                    }

                    const geometry = mesh.geometry;
                    const groups = Array.isArray(mesh.material)
                        ? Math.max(1, geometry.groups.length)
                        : 1;
                    const triangles = triangleCount(geometry) * mesh.count;
                    stats.drawnInstances += mesh.count;
                    stats.drawCalls += groups;
                    stats.triangles += triangles;
                    typeStats.drawCalls += groups;
                    typeStats.triangles += triangles;
                    typeStats.instances += mesh.count;
                    detail.drawn += mesh.count;
                    detail.drawCalls += groups;
                    detail.triangles += triangles;

                    if (lod < detail.lodInstances.length) {
                        detail.lodInstances[lod] += mesh.count;
                    }
                }
            }
        }

        return stats;
    }

    update(dt: number, camera: THREE.Camera): void {
        this.uniforms.uTime.value += dt;
        this.uniforms.uCamPos.value.copy(camera.position);
        this.lastCamera = camera;
        this.evalTimer -= dt;

        // Visibility / LOD / density / shadows only change with distance, so cells are re-evaluated
        // when the camera moved a bit (or something changed), not every frame.
        if (
            this.needsEval ||
            this.evalTimer <= 0 ||
            camera.position.distanceToSquared(this.lastEvalPos) >
                EVAL_MOVE * EVAL_MOVE
        ) {
            this.evaluate(camera.position);
        }

        if (this.queue.length) {
            this.processQueue(camera);
        }

        if (this.gl) {
            this.renderPendingImpostor(this.gl);
        }
    }

    /** Renders at most one missing impostor per frame (outside the render pass). */
    private renderPendingImpostor(gl: GameRenderer): void {
        for (const renderer of this.renderers.values()) {
            const pending = renderer.pendingImpostor;

            if (!pending || renderer.disposed) {
                continue;
            }

            renderer.pendingImpostor = null;
            let built: ReturnType<typeof renderImpostor> = null;

            try {
                built = renderImpostor(
                    gl as never,
                    renderer.lods[0],
                    renderer.lodMaterials[0],
                );
            } catch (error) {
                console.warn(
                    `Could not render an impostor for foliage type ${renderer.type.name}`,
                    error,
                );
            }

            if (!built) {
                renderer.lodInfo.warnings.push(
                    'no far LOD (impostor capture failed)',
                );

                return;
            }

            renderer.lods[0].computeBoundingBox();
            addWindAttribute(built.geometry, renderer.lods[0].boundingBox!);
            this.patchMaterial(built.material, renderer, pending.role);
            renderer.lods = [...renderer.lods, built.geometry];
            renderer.drawLods = [...renderer.drawLods, built.geometry];
            renderer.lodMaterials = [...renderer.lodMaterials, built.material];
            renderer.lodDistances = [
                ...renderer.lodDistances,
                pending.distance,
            ];
            renderer.lodInfo.generated.push(
                `LOD${renderer.lods.length - 1} impostor (rendered)`,
            );
            const radius = geometryRadius(renderer.lods);

            if (radius > renderer.radius * 1.05) {
                // Wider than the model: refresh the cell bounds (frustum culling).
                renderer.radius = radius;

                for (const cell of renderer.cells.values()) {
                    this.markDirty(renderer, cell);
                }
            }

            // Far chunks (≥ 3 LODs) may start now; cells pick the new LOD on the next evaluation.
            this.needsEval = true;

            return;
        }
    }

    private evaluate(cam: THREE.Vector3): void {
        this.needsEval = false;
        this.evalTimer = EVAL_INTERVAL;
        this.lastEvalPos.copy(cam);
        const stamp = ++this.evalStamp;

        for (const renderer of this.renderers.values()) {
            const cull = renderer.type.cull_distance * this.distanceScale;
            const previous = renderer.shown;
            renderer.shown = [];
            renderer.uniforms.uLodSplit.value = splitsLod(renderer)
                ? renderer.lodDistances[1] * cull * this.lodBias
                : NO_SPLIT;

            // Whole type out of range (e.g. grass while flying high): skip its cells entirely.
            if (
                !renderer.extent.isEmpty() &&
                renderer.extent.distanceToPoint(cam) < cull
            ) {
                if (renderer.lodDistances.length >= 3) {
                    // Only chunks that can be in range (maps can hold thousands of chunks).
                    const chunkSize = renderer.cellSize * CHUNK_CELLS;
                    const g0 = Math.floor((cam.x - cull) / chunkSize);
                    const g1 = Math.floor((cam.x + cull) / chunkSize);
                    const h0 = Math.floor((cam.z - cull) / chunkSize);
                    const h1 = Math.floor((cam.z + cull) / chunkSize);

                    if ((g1 - g0 + 1) * (h1 - h0 + 1) < renderer.chunks.size) {
                        for (let gz = h0; gz <= h1; gz++) {
                            for (let gx = g0; gx <= g1; gx++) {
                                const chunk = renderer.chunks.get(
                                    gridIndex(gx, gz),
                                );

                                if (chunk) {
                                    this.evaluateChunk(
                                        renderer,
                                        chunk,
                                        cam,
                                        cull,
                                        stamp,
                                    );
                                }
                            }
                        }
                    } else {
                        for (const chunk of renderer.chunks.values()) {
                            this.evaluateChunk(
                                renderer,
                                chunk,
                                cam,
                                cull,
                                stamp,
                            );
                        }
                    }
                }

                const size = renderer.cellSize;
                const c0 = Math.floor((cam.x - cull) / size);
                const c1 = Math.floor((cam.x + cull) / size);
                const r0 = Math.floor((cam.z - cull) / size);
                const r1 = Math.floor((cam.z + cull) / size);

                if ((c1 - c0 + 1) * (r1 - r0 + 1) < renderer.cells.size) {
                    for (let cz = r0; cz <= r1; cz++) {
                        for (let cx = c0; cx <= c1; cx++) {
                            const cell = renderer.grid.get(gridIndex(cx, cz));

                            if (cell) {
                                this.evaluateCell(
                                    renderer,
                                    cell,
                                    cam,
                                    cull,
                                    stamp,
                                );
                            }
                        }
                    }
                } else {
                    for (const cell of renderer.cells.values()) {
                        this.evaluateCell(renderer, cell, cam, cull, stamp);
                    }
                }
            }

            for (const cell of previous) {
                if (cell.shownStamp !== stamp) {
                    hideCell(cell);
                }
            }
        }

        if (this.queue.length > 1) {
            this.queue.sort(
                (a, b) =>
                    a.cell.bounds.distanceToPoint(cam) -
                    b.cell.bounds.distanceToPoint(cam),
            );
        }
    }

    private evaluateCell(
        renderer: TypeRenderer,
        cell: Cell,
        cam: THREE.Vector3,
        cull: number,
        stamp: number,
    ): void {
        if (!cell.data.length) {
            if (cell.mesh) {
                this.removeCellMesh(cell);
            }

            return;
        }

        const dist = cell.bounds.distanceToPoint(cam);

        if (dist >= cull) {
            return;
        }

        const covered = cell.coveredStamp === stamp;

        if (covered && !cell.prebuild) {
            return;
        }

        if ((cell.dirty || !cell.mesh) && !cell.queued) {
            cell.queued = true;
            this.queue.push({ renderer, cell });
        }

        if (cell.mesh && !covered) {
            this.applyCell(renderer, cell, cam, cull, dist, stamp);
        }
    }

    /**
     * Shows a far chunk instead of its cells when the whole chunk is beyond the far LOD distance
     * (and inside the cull distance). Handovers never leave holes: cells stay visible until the
     * chunk is built, and the chunk stays visible until its cells are built.
     */
    private evaluateChunk(
        renderer: TypeRenderer,
        chunk: Chunk,
        cam: THREE.Vector3,
        cull: number,
        stamp: number,
    ): void {
        let count = 0;

        for (const cell of chunk.members) {
            count += cell.data.length;
        }

        if (!count) {
            this.removeCellMesh(chunk);

            return;
        }

        const b = chunk.bounds;
        const near = b.distanceToPoint(cam);
        const farLod = renderer.lodDistances.length - 1;
        const farStart = renderer.lodDistances[farLod] * cull * this.lodBias;
        // Instances past the cull distance are shrunk away in the vertex shader, so a chunk may
        // straddle it.
        const eligible = near > farStart && near < cull;
        let prebuild = false;

        if (eligible) {
            if ((chunk.dirty || !chunk.mesh) && !chunk.queued) {
                chunk.queued = true;
                this.queue.push({ renderer, cell: chunk });
            }

            if (!chunk.mesh) {
                return;
            }
        } else {
            // Leaving far range: keep the chunk until every member in range has a mesh.
            if (!chunk.mesh?.visible || near >= cull) {
                return;
            }

            const pending = chunk.members.some(
                (cell) =>
                    cell.data.length > 0 &&
                    !cell.mesh &&
                    cell.bounds.distanceToPoint(cam) < cull,
            );

            if (!pending) {
                return;
            }

            prebuild = true;
        }

        for (const cell of chunk.members) {
            cell.coveredStamp = stamp;
            cell.prebuild = prebuild;
        }

        this.applyCell(
            renderer,
            chunk,
            cam,
            cull,
            Math.max(near, farStart + 1),
            stamp,
        );
    }

    private lodFor(renderer: TypeRenderer, dist: number, cull: number): number {
        const lodScale = cull * this.lodBias;

        for (let l = renderer.lodDistances.length - 1; l > 0; l--) {
            if (dist > renderer.lodDistances[l] * lodScale) {
                return l;
            }
        }

        return 0;
    }

    /** Applies LOD, shadow casting and instance count to a built cell and marks it shown. */
    private applyCell(
        renderer: TypeRenderer,
        cell: Cell,
        cam: THREE.Vector3,
        cull: number,
        dist: number,
        stamp: number,
    ): void {
        const mesh = cell.mesh!;
        let lod = this.lodFor(renderer, dist, cull);
        let straddles = false;

        // Per-instance LOD0 → LOD1 switch: a cell the split distance may pass through (before the
        // next evaluation) draws LOD1 plus a LOD0 subset of the instances near the camera.
        if (!isChunk(cell) && splitsLod(renderer)) {
            const split = renderer.uniforms.uLodSplit.value;

            if (dist < split + LOD_SPLIT_SLACK) {
                if (
                    farthestDistance(cell.bounds, cam) + LOD_SPLIT_SLACK <
                    split
                ) {
                    lod = 0;
                } else {
                    lod = 1;
                    straddles = true;
                }
            }
        }

        if (lod !== cell.lod || mesh.geometry !== renderer.drawLods[lod]) {
            mesh.geometry = renderer.drawLods[lod];
            mesh.material = lodMaterial(renderer, lod);
            cell.lod = lod;
        }

        // Horizontal distance: the shadow map is centred on the ground, so an elevated editor
        // camera still gets shadows below it.
        const b = cell.bounds;
        const sx = Math.max(b.min.x - cam.x, 0, cam.x - b.max.x);
        const sz = Math.max(b.min.z - cam.z, 0, cam.z - b.max.z);
        const shadows =
            renderer.type.cast_shadows &&
            sx * sx + sz * sz < this.shadowDistance * this.shadowDistance;
        mesh.castShadow = shadows && lod === 0;
        mesh.count = this.drawCount(renderer, cell, cam, cull);
        mesh.visible = mesh.count > 0;

        if (straddles && mesh.visible) {
            this.updateNear(renderer, cell, cam, shadows);
        } else if (cell.near) {
            cell.near.visible = false;
        }

        if (cell.shownStamp !== stamp) {
            cell.shownStamp = stamp;
            renderer.shown.push(cell);
        }
    }

    /**
     * Fills the cell's LOD0 subset with the drawn instances within the split distance (+ slack; the
     * shader trims the rest), reusing the cell's instance matrices.
     */
    private updateNear(
        renderer: TypeRenderer,
        cell: Cell,
        cam: THREE.Vector3,
        shadows: boolean,
    ): void {
        const mesh = cell.mesh!;
        let near = cell.near;

        if (!near || near.instanceMatrix.count < cell.capacity) {
            this.removeNear(cell);
            near = new THREE.InstancedMesh(
                renderer.drawLods[0],
                lodMaterial(renderer, 0),
                cell.capacity,
            );
            this.setupMesh(renderer, near, `${cell.key}_near`);
            cell.near = near;
            this.group.add(near);
        } else if (near.geometry !== renderer.drawLods[0]) {
            near.geometry = renderer.drawLods[0];
            near.material = lodMaterial(renderer, 0);
        }

        const reach = renderer.uniforms.uLodSplit.value + LOD_SPLIT_SLACK;
        const reach2 = reach * reach;
        const src = mesh.instanceMatrix.array as Float32Array;
        const dst = near.instanceMatrix.array as Float32Array;
        const r = renderer.radius * Math.max(0.01, renderer.type.max_scale);
        let n = 0;
        let minX = Infinity;
        let minY = Infinity;
        let minZ = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        let maxZ = -Infinity;

        for (let i = 0; i < mesh.count; i++) {
            const o = i * 16;
            const x = src[o + 12];
            const y = src[o + 13];
            const z = src[o + 14];
            const dx = x - cam.x;
            const dy = y - cam.y;
            const dz = z - cam.z;

            if (dx * dx + dy * dy + dz * dz > reach2) {
                continue;
            }

            for (let k = 0; k < 16; k++) {
                dst[n * 16 + k] = src[o + k];
            }

            minX = Math.min(minX, x - r);
            maxX = Math.max(maxX, x + r);
            minY = Math.min(minY, y - r * 0.25);
            maxY = Math.max(maxY, y + r);
            minZ = Math.min(minZ, z - r);
            maxZ = Math.max(maxZ, z + r);
            n++;
        }

        near.count = n;
        near.visible = n > 0;
        near.castShadow = shadows;

        if (n > 0) {
            near.instanceMatrix.clearUpdateRanges();
            near.instanceMatrix.addUpdateRange(0, n * 16);
            near.instanceMatrix.needsUpdate = true;
            near.boundingBox!.min.set(minX, minY, minZ);
            near.boundingBox!.max.set(maxX, maxY, maxZ);
            near.boundingBox!.getBoundingSphere(near.boundingSphere!);
        }
    }

    /**
     * Instances to draw: a prefix of the (shuffled) cell. Small foliage thins out with distance; the
     * count is an upper bound (nearest point of the cell, minus the re-evaluation slack) and the
     * vertex shader fades the instances at the end of the prefix.
     */
    private drawCount(
        renderer: TypeRenderer,
        cell: Cell,
        cam: THREE.Vector3,
        cull: number,
    ): number {
        const built = cell.built;
        const falloff = renderer.falloff;

        if (!falloff || !renderer.fade) {
            return Math.max(
                0,
                Math.min(built, Math.floor(built * this.density)),
            );
        }

        const b = cell.bounds;
        const dx = Math.max(b.min.x - cam.x, 0, cam.x - b.max.x);
        const dz = Math.max(b.min.z - cam.z, 0, cam.z - b.max.z);
        const near = Math.max(0, Math.hypot(dx, dz) - EVAL_MOVE);
        const k =
            1 - (1 - falloff.min) * smooth01(falloff.start * cull, cull, near);
        const target = Math.min(1, this.density * k * (1 + RANK_FADE));

        return Math.min(built, Math.ceil(target * built));
    }

    /** (Re)builds queued cells nearest-first within a per-frame time budget. */
    private processQueue(camera: THREE.Camera): void {
        const start = performance.now();
        let built = 0;
        camera.updateMatrixWorld();
        _projScreen.multiplyMatrices(
            camera.projectionMatrix,
            camera.matrixWorldInverse,
        );
        _frustum.setFromProjectionMatrix(_projScreen);

        // Cells in view first (the queue is already sorted by distance).
        let order = this.queue;

        if (this.queue.length > 1) {
            const inView = this.queue.filter(({ cell }) =>
                _frustum.intersectsBox(cell.bounds),
            );

            if (inView.length && inView.length < this.queue.length) {
                const set = new Set(inView);
                order = [...inView, ...this.queue.filter((e) => !set.has(e))];
            }
        }

        let i = 0;

        for (; i < order.length; i++) {
            if (built > 0 && performance.now() - start > BUILD_BUDGET_MS) {
                break;
            }

            const { renderer, cell } = order[i];
            cell.queued = false;

            if (renderer.disposed) {
                continue;
            }

            if (isChunk(cell)) {
                if (renderer.chunks.get(gridIndex(cell.gx, cell.gz)) === cell) {
                    this.buildChunkMesh(renderer, cell);
                    built++;
                    // Shown by the next evaluation (its cells stay visible meanwhile).
                    this.needsEval = true;
                }

                continue;
            }

            if (renderer.cells.get(cell.key) !== cell) {
                continue;
            }

            this.buildCellMesh(renderer, cell);
            built++;

            if (!cell.mesh || cell.coveredStamp === this.evalStamp) {
                hideCell(cell);

                continue;
            }

            const cam = camera.position;
            const cull = renderer.type.cull_distance * this.distanceScale;
            const dist = cell.bounds.distanceToPoint(cam);

            if (dist < cull) {
                this.applyCell(renderer, cell, cam, cull, dist, this.evalStamp);
            } else {
                hideCell(cell);
            }
        }

        // `order` may be the queue itself: keep the unprocessed tail.
        const rest = order.slice(i);
        this.queue.length = 0;

        for (const entry of rest) {
            this.queue.push(entry);
        }
    }

    dispose(): void {
        for (const renderer of this.renderers.values()) {
            this.disposeRenderer(renderer);
        }

        this.renderers.clear();
    }

    private tryPlace(
        ctx: FoliagePlacementContext,
        renderer: TypeRenderer,
        x: number,
        z: number,
        spacing: number,
        force = false,
        append = false,
    ): boolean {
        const type = renderer.type;
        const hf = ctx.heights;

        if (!hf.contains(x, z)) {
            return false;
        }

        const y = hf.sample(x, z);

        if (!force) {
            if (!placementAllowed(ctx, type, x, z)) {
                return false;
            }

            if (spacing > 0.3 && this.hasNeighbour(renderer, x, z, spacing)) {
                return false;
            }
        }

        const normal = hf.normal(x, z, _normal);
        const scale =
            type.min_scale + this.random() * (type.max_scale - type.min_scale);
        const yaw = type.random_yaw ? this.random() * Math.PI * 2 : 0;
        const tiltX = type.align_to_normal ? Math.atan2(normal.z, normal.y) : 0;
        const tiltZ = type.align_to_normal
            ? -Math.atan2(normal.x, normal.y)
            : 0;
        const key = cellKey(renderer.cellSize, x, z);
        this.onBeforeModify?.(type.id, key);
        const cell = this.cellFor(renderer, key);

        if (append) {
            cell.data.push(x, y - 0.05 * scale, z, yaw, scale, tiltX, tiltZ);
        } else {
            // Insert at a random position so any prefix (density scaling) is spatially uniform.
            const count = cell.data.length / FOLIAGE_STRIDE;
            const slot = Math.floor(this.random() * (count + 1));
            cell.data.splice(
                slot * FOLIAGE_STRIDE,
                0,
                x,
                y - 0.05 * scale,
                z,
                yaw,
                scale,
                tiltX,
                tiltZ,
            );
        }

        this.markDirty(renderer, cell);

        return true;
    }

    private hasNeighbour(
        renderer: TypeRenderer,
        x: number,
        z: number,
        spacing: number,
    ): boolean {
        const s2 = spacing * spacing;

        for (const cell of this.cellsInCircle(renderer, x, z, spacing)) {
            const d = cell.data;

            for (let i = 0; i < d.length; i += FOLIAGE_STRIDE) {
                const dx = d[i] - x;
                const dz = d[i + 2] - z;

                if (dx * dx + dz * dz < s2) {
                    return true;
                }
            }
        }

        return false;
    }

    private countInCircle(
        renderer: TypeRenderer,
        x: number,
        z: number,
        radius: number,
    ): number {
        const r2 = radius * radius;
        let count = 0;

        for (const cell of this.cellsInCircle(renderer, x, z, radius)) {
            const d = cell.data;

            for (let i = 0; i < d.length; i += FOLIAGE_STRIDE) {
                const dx = d[i] - x;
                const dz = d[i + 2] - z;

                if (dx * dx + dz * dz <= r2) {
                    count++;
                }
            }
        }

        return count;
    }

    private *cellsInCircle(
        renderer: TypeRenderer,
        x: number,
        z: number,
        radius: number,
    ): Generator<Cell> {
        yield* this.cellsInRect(renderer, {
            x0: x - radius,
            z0: z - radius,
            x1: x + radius,
            z1: z + radius,
        });
    }

    private *cellsInRect(renderer: TypeRenderer, rect: Rect): Generator<Cell> {
        const size = renderer.cellSize;
        const c0 = Math.floor(rect.x0 / size);
        const c1 = Math.floor(rect.x1 / size);
        const r0 = Math.floor(rect.z0 / size);
        const r1 = Math.floor(rect.z1 / size);

        for (let cz = r0; cz <= r1; cz++) {
            for (let cx = c0; cx <= c1; cx++) {
                const cell = renderer.grid.get(gridIndex(cx, cz));

                if (cell) {
                    yield cell;
                }
            }
        }
    }

    private cellFor(renderer: TypeRenderer, key: string): Cell {
        let cell = renderer.cells.get(key);

        if (!cell) {
            cell = this.makeCell(renderer, key);
            renderer.cells.set(key, cell);
            renderer.grid.set(gridIndex(cell.cx, cell.cz), cell);
            cell.chunk = this.chunkFor(renderer, cell);
            cell.chunk.members.push(cell);
        }

        return cell;
    }

    private chunkFor(renderer: TypeRenderer, cell: Cell): Chunk {
        const gx = Math.floor(cell.cx / CHUNK_CELLS);
        const gz = Math.floor(cell.cz / CHUNK_CELLS);
        const index = gridIndex(gx, gz);
        let chunk = renderer.chunks.get(index);

        if (!chunk) {
            const size = renderer.cellSize * CHUNK_CELLS;
            chunk = {
                ...this.makeCell(renderer, `${size}:${gx},${gz}`),
                key: `far${size}:${gx},${gz}`,
                members: [],
                gx,
                gz,
            };
            chunk.bounds.min.set(gx * size, -1e4, gz * size);
            chunk.bounds.max.set((gx + 1) * size, 1e4, (gz + 1) * size);
            renderer.chunks.set(index, chunk);
        }

        return chunk;
    }

    /** Builds a far chunk from its cells, interleaved by rank so any prefix stays uniform. */
    private buildChunkMesh(renderer: TypeRenderer, chunk: Chunk): void {
        const entries: { rank: number; cell: Cell; offset: number }[] = [];

        for (const cell of chunk.members) {
            const n = cell.data.length / FOLIAGE_STRIDE;

            for (let i = 0; i < n; i++) {
                entries.push({
                    rank: (i + 0.5) / n,
                    cell,
                    offset: i * FOLIAGE_STRIDE,
                });
            }
        }

        entries.sort((a, b) => a.rank - b.rank);
        const data: number[] = [];

        for (const { cell, offset } of entries) {
            for (let k = 0; k < FOLIAGE_STRIDE; k++) {
                data.push(cell.data[offset + k]);
            }
        }

        chunk.lod = renderer.lodDistances.length - 1;
        chunk.data = data;
        this.buildCellMesh(renderer, chunk);
        // The instance data lives in the cells; the chunk only keeps its GPU buffers.
        chunk.data = [];

        if (chunk.mesh) {
            chunk.mesh.castShadow = false;
            chunk.mesh.visible = false;
        }
    }

    private makeCell(renderer: TypeRenderer, key: string): Cell {
        const parsed = parseCellKey(key)!;
        const cell: Cell = {
            key,
            cx: parsed.cx,
            cz: parsed.cz,
            data: [],
            mesh: null,
            capacity: 0,
            built: 0,
            dirty: true,
            queued: false,
            lod: 0,
            bounds: new THREE.Box3(),
            shownStamp: -1,
            coveredStamp: -1,
            prebuild: false,
            chunk: null,
            near: null,
        };
        this.resetBounds(renderer, cell);

        return cell;
    }

    /** Footprint bounds (any height) until the cell is built and gets tight bounds. */
    private resetBounds(renderer: TypeRenderer, cell: Cell): void {
        const size = renderer.cellSize;
        cell.bounds.min.set(cell.cx * size, -1e4, cell.cz * size);
        cell.bounds.max.set((cell.cx + 1) * size, 1e4, (cell.cz + 1) * size);
    }

    /** Appends a flat instance list, bucketing each instance into its cell. */
    private insertFlat(renderer: TypeRenderer, flat: number[]): void {
        const size = renderer.cellSize;
        let last: Cell | null = null;

        for (
            let i = 0;
            i + FOLIAGE_STRIDE <= flat.length;
            i += FOLIAGE_STRIDE
        ) {
            const cx = Math.floor(flat[i] / size);
            const cz = Math.floor(flat[i + 2] / size);
            let cell: Cell | undefined =
                last && last.cx === cx && last.cz === cz
                    ? last
                    : renderer.grid.get(gridIndex(cx, cz));

            if (!cell) {
                cell = this.cellFor(renderer, `${size}:${cx},${cz}`);
            }

            for (let k = 0; k < FOLIAGE_STRIDE; k++) {
                cell.data.push(flat[i + k]);
            }

            if (cell !== last) {
                this.markDirty(renderer, cell);
                last = cell;
            }
        }
    }

    private markDirty(renderer: TypeRenderer, cell: Cell): void {
        cell.dirty = true;
        this.needsEval = true;

        const chunk = cell.chunk;

        if (chunk) {
            chunk.dirty = true;
            const size = renderer.cellSize * CHUNK_CELLS;
            chunk.bounds.min.set(chunk.gx * size, -1e4, chunk.gz * size);
            chunk.bounds.max.set(
                (chunk.gx + 1) * size,
                1e4,
                (chunk.gz + 1) * size,
            );
        }

        if (!cell.data.length) {
            this.removeCellMesh(cell);
            this.resetBounds(renderer, cell);

            return;
        }

        const size = renderer.cellSize;
        renderer.extent.expandByPoint(
            _v.set(cell.cx * size, -1e4, cell.cz * size),
        );
        renderer.extent.expandByPoint(
            _v.set((cell.cx + 1) * size, 1e4, (cell.cz + 1) * size),
        );

        // Edits may move instances outside the tight bounds: widen until rebuilt.
        const b = cell.bounds;
        b.min.x = Math.min(b.min.x, cell.cx * size);
        b.min.z = Math.min(b.min.z, cell.cz * size);
        b.max.x = Math.max(b.max.x, (cell.cx + 1) * size);
        b.max.z = Math.max(b.max.z, (cell.cz + 1) * size);
        b.min.y = -1e4;
        b.max.y = 1e4;
    }

    /**
     * Writes the cell's instances into its InstancedMesh, reusing the existing buffers when they
     * are large enough (painting grows cells a few instances at a time).
     */
    private buildCellMesh(renderer: TypeRenderer, cell: Cell): void {
        const count = cell.data.length / FOLIAGE_STRIDE;
        cell.dirty = false;

        if (count === 0) {
            this.removeCellMesh(cell);
            cell.built = 0;

            return;
        }

        let mesh = cell.mesh;

        if (!mesh || count > cell.capacity || count < cell.capacity / 4) {
            this.removeCellMesh(cell);
            // Headroom so painting doesn't reallocate on every dab.
            const capacity = count + Math.ceil(count * 0.25) + 8;
            mesh = new THREE.InstancedMesh(
                renderer.drawLods[cell.lod] ?? renderer.drawLods[0],
                lodMaterial(renderer, cell.lod),
                capacity,
            );
            cell.capacity = capacity;
            this.setupMesh(renderer, mesh, cell.key);

            if (renderer.fade) {
                // r = rank of the instance within the cell (0..1): drives the density fade.
                mesh.instanceColor = new THREE.InstancedBufferAttribute(
                    new Float32Array(capacity * 3),
                    3,
                );
            }

            cell.mesh = mesh;
            this.group.add(mesh);
        }

        const matrices = mesh.instanceMatrix.array as Float32Array;
        const ranks = mesh.instanceColor?.array as Float32Array | undefined;
        const d = cell.data;
        const r = renderer.radius;
        let minX = Infinity;
        let minY = Infinity;
        let minZ = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        let maxZ = -Infinity;

        for (let i = 0; i < count; i++) {
            const o = i * FOLIAGE_STRIDE;
            const x = d[o];
            const y = d[o + 1];
            const z = d[o + 2];
            const scale = d[o + 4];
            _p.set(x, y, z);
            // Yaw first (Y), then tilt to the terrain normal (Z, X).
            _e.set(d[o + 5], d[o + 3], d[o + 6], 'XZY');
            _q.setFromEuler(_e);
            _s.setScalar(scale);
            _m.compose(_p, _q, _s);
            _m.toArray(matrices, i * 16);

            if (ranks) {
                ranks[i * 3] = (i + 0.5) / count;
            }

            const e = r * scale;
            minX = Math.min(minX, x - e);
            maxX = Math.max(maxX, x + e);
            minZ = Math.min(minZ, z - e);
            maxZ = Math.max(maxZ, z + e);
            minY = Math.min(minY, y - e * 0.25);
            maxY = Math.max(maxY, y + e);
        }

        mesh.instanceMatrix.clearUpdateRanges();
        mesh.instanceMatrix.addUpdateRange(0, count * 16);
        mesh.instanceMatrix.needsUpdate = true;

        if (mesh.instanceColor) {
            mesh.instanceColor.clearUpdateRanges();
            mesh.instanceColor.addUpdateRange(0, count * 3);
            mesh.instanceColor.needsUpdate = true;
        }

        cell.built = count;
        mesh.count = count;
        cell.bounds.min.set(minX, minY, minZ);
        cell.bounds.max.set(maxX, maxY, maxZ);
        mesh.boundingBox!.copy(cell.bounds);
        cell.bounds.getBoundingSphere(mesh.boundingSphere!);
    }

    /** Shared setup of cell / chunk / near-subset meshes. */
    private setupMesh(
        renderer: TypeRenderer,
        mesh: THREE.InstancedMesh,
        key: string,
    ): void {
        mesh.receiveShadow = true;
        mesh.frustumCulled = true;
        mesh.matrixAutoUpdate = false;
        // The reflection pass hides small foliage by this prefix (see Game.renderReflection).
        mesh.name = `Foliage_${renderer.type.name}_${key}`;

        if (renderer.depthMaterial) {
            mesh.customDepthMaterial = renderer.depthMaterial;
        }

        mesh.onBeforeShadow = () => {
            const proxy = renderer.shadowProxy;

            if (proxy && mesh.geometry === proxy.geometry) {
                proxy.geometry.setDrawRange(proxy.start, proxy.count);
            }
        };
        mesh.onAfterShadow = () => {
            const proxy = renderer.shadowProxy;

            if (proxy && mesh.geometry === proxy.geometry) {
                proxy.geometry.setDrawRange(0, proxy.main);
            }
        };
        mesh.onBeforeRender = this.captureRenderer as never;
        // Set explicitly (never null): three would otherwise compute them from every instance.
        mesh.boundingSphere = new THREE.Sphere();
        mesh.boundingBox = new THREE.Box3();
    }

    private removeNear(cell: Cell): void {
        if (cell.near) {
            this.group.remove(cell.near);
            cell.near.dispose();
            cell.near = null;
        }
    }

    private removeCellMesh(cell: Cell): void {
        this.removeNear(cell);

        if (cell.mesh) {
            this.group.remove(cell.mesh);
            cell.mesh.dispose();
            cell.mesh = null;
            cell.capacity = 0;
            cell.built = 0;
        }
    }

    private createRenderer(type: FoliageType): TypeRenderer {
        const set = createFoliageGeometry(
            type.kind,
            new THREE.Color(type.color),
            new THREE.Color(type.color_secondary),
            type.id * 7919,
        );
        const material = new THREE.MeshStandardMaterial({
            vertexColors: true,
            roughness: type.kind === 'rock' ? 0.85 : 0.75,
            metalness: 0,
            side: set.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
        });
        const falloff = DENSITY_FALLOFF[type.kind] ?? null;
        // Kinds without the density fade (trees, rocks) switch LOD0 → LOD1 per instance.
        const splitRoles = falloff === null && set.lods.length >= 2;
        const nearMaterial = splitRoles ? material.clone() : material;
        const farMaterial = splitRoles ? material.clone() : material;
        const renderer: TypeRenderer = {
            type,
            cellSize: CELL_SIZES[type.kind] ?? 64,
            lods: set.lods,
            drawLods: set.lods,
            shadowProxy: null,
            lodDistances: set.lodDistances,
            lodMaterials: set.lods.map((_g, lod) =>
                lod === 0 ? nearMaterial : lod === 1 ? farMaterial : material,
            ),
            depthMaterial: null,
            model: false,
            disposed: false,
            cells: new Map(),
            grid: new Map(),
            chunks: new Map(),
            extent: new THREE.Box3(),
            shown: [],
            fade: falloff !== null,
            falloff,
            radius: geometryRadius(set.lods),
            uniforms: {
                uFadeEnd: { value: type.cull_distance },
                uFalloff: {
                    value: new THREE.Vector2(
                        falloff?.start ?? 1,
                        falloff?.min ?? 1,
                    ),
                },
                uLodSplit: { value: NO_SPLIT },
            },
            lodInfo: {
                source: type.model_url ? 'loading' : 'procedural',
                generated: [],
                warnings: [],
            },
            splitRoles,
            pendingImpostor: null,
        };
        this.patchMaterial(material, renderer, 'none');

        if (splitRoles) {
            this.patchMaterial(nearMaterial, renderer, 'near');
            this.patchMaterial(farMaterial, renderer, 'far');
        }

        const depthMaterial = new THREE.MeshDepthMaterial({
            depthPacking: THREE.RGBADepthPacking,
        });
        this.patchMaterial(depthMaterial, renderer, 'none');
        renderer.depthMaterial = depthMaterial;

        // Shadow proxy: the shadow pass of LOD0 draws a slightly shrunk LOD1 instead.
        if (set.lods.length > 1 && !set.doubleSided) {
            renderer.shadowProxy = createShadowProxy(set.lods[0], set.lods[1]);

            if (renderer.shadowProxy) {
                renderer.drawLods = [
                    renderer.shadowProxy.geometry,
                    ...set.lods.slice(1),
                ];
            }
        }

        if (type.model_url) {
            void this.loadModel(renderer, type.model_url);
        }

        return renderer;
    }

    /** Wind sway, distance fade and density falloff injected into a standard / depth material. */
    private patchMaterial(
        material: THREE.Material,
        renderer: TypeRenderer,
        role: LodRole,
    ): void {
        const type = renderer.type;
        const fade = renderer.fade;
        const stiffness =
            type.kind === 'rock'
                ? 0
                : type.kind === 'conifer' ||
                    type.kind === 'broadleaf' ||
                    type.kind === 'palm'
                  ? 0.35
                  : 1;

        material.onBeforeCompile = (shader) => {
            shader.uniforms.uTime = this.uniforms.uTime;
            shader.uniforms.uWind = this.uniforms.uWind;
            shader.uniforms.uWindDir = this.uniforms.uWindDir;
            shader.uniforms.uCamPos = this.uniforms.uCamPos;
            shader.uniforms.uFadeScale = this.uniforms.uFadeScale;
            shader.uniforms.uDensity = this.uniforms.uDensity;
            shader.uniforms.uFadeEnd = renderer.uniforms.uFadeEnd;
            shader.uniforms.uFalloff = renderer.uniforms.uFalloff;
            shader.uniforms.uLodSplit = renderer.uniforms.uLodSplit;
            shader.vertexShader = shader.vertexShader
                .replace(
                    '#include <common>',
                    `#include <common>
attribute float wind;
uniform float uTime;
uniform float uWind;
uniform vec2 uWindDir;
uniform vec3 uCamPos;
uniform float uFadeEnd;
uniform float uFadeScale;
uniform float uDensity;
uniform vec2 uFalloff;
uniform float uLodSplit;`,
                )
                // instanceColor carries the per-instance rank (density fade), not a colour.
                .replace(
                    '#include <color_vertex>',
                    THREE.ShaderChunk.color_vertex.replace(
                        'vColor.rgb *= instanceColor.rgb;',
                        '',
                    ),
                )
                .replace(
                    '#include <begin_vertex>',
                    `#include <begin_vertex>
#ifdef USE_INSTANCING
vec3 instPos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
#else
vec3 instPos = vec3(0.0);
#endif
float phase = dot(instPos.xz, vec2(0.071, 0.113));
float gust = sin(uTime * 0.7 + instPos.x * 0.01) * 0.5 + 0.5;
float sway = (sin(uTime * 1.9 + phase) * 0.6 + sin(uTime * 3.7 + phase * 1.7) * 0.25) * (0.4 + gust * 0.6);
float bend = wind * wind * uWind * ${stiffness.toFixed(2)};
// Sway along the wind plus a steady lean downwind. Instances are randomly yawed, so the
// world-space wind direction is brought into instance space first.
#ifdef USE_INSTANCING
vec3 windLocal = transpose(mat3(instanceMatrix)) * vec3(uWindDir.x, 0.0, uWindDir.y);
vec2 windDir = normalize(windLocal.xz + vec2(1e-5));
#else
vec2 windDir = uWindDir;
#endif
float lean = bend * 0.22 * (0.5 + gust * 0.5);
transformed.xz += windDir * (sway * bend * 0.35 + lean)
    + vec2(-windDir.y, windDir.x) * sway * bend * 0.1;
float camDist = distance(instPos.xz, uCamPos.xz);
float fadeEnd = uFadeEnd * uFadeScale;
float fadeK = 1.0 - smoothstep(fadeEnd * ${fade ? '0.7' : '0.92'}, fadeEnd, camDist);
${
    fade
        ? `#ifdef USE_INSTANCING_COLOR
float densityT = uDensity * (1.0 - (1.0 - uFalloff.y) * smoothstep(uFalloff.x * fadeEnd, fadeEnd, camDist)) * ${(1 + RANK_FADE).toFixed(3)};
fadeK *= 1.0 - smoothstep(densityT - ${RANK_FADE.toFixed(3)}, densityT, instanceColor.r);
#endif`
        : ''
}${
                        role === 'none'
                            ? ''
                            : `
#ifdef USE_INSTANCING
// Per-instance LOD0 / LOD1 split (Foliage.applyCell): each side keeps its own instances.
fadeK *= ${role === 'near' ? 'step(distance(instPos, uCamPos), uLodSplit)' : 'step(uLodSplit, distance(instPos, uCamPos))'};
#endif`
                    }
transformed *= fadeK;`,
                );

            // Blade normals are bent upwards; flipping them on back faces would render grass dark.
            if (material.side === THREE.DoubleSide) {
                shader.fragmentShader = shader.fragmentShader.replace(
                    '#include <normal_fragment_begin>',
                    THREE.ShaderChunk.normal_fragment_begin.replace(
                        'normal *= faceDirection;',
                        '',
                    ),
                );
            }

            // Alpha-tested leaf textures lose coverage in smaller mips (averaged alpha drops below
            // the cutoff and distant canopies turn bare); scale alpha up with the mip level.
            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <alphatest_fragment>',
                `#if defined( USE_ALPHATEST ) && defined( USE_MAP )
{
    vec2 texel = vMapUv * vec2(textureSize(map, 0));
    vec2 dx = dFdx(texel);
    vec2 dy = dFdy(texel);
    float mipLevel = max(0.0, 0.5 * log2(max(dot(dx, dx), dot(dy, dy))));
    diffuseColor.a *= 1.0 + mipLevel * 0.25;
}
#endif
#include <alphatest_fragment>`,
            );
        };
        material.customProgramCacheKey = () =>
            `foliage2-${stiffness}-${fade}-${material.side}-${role}`;
    }

    /**
     * Loads a GLB model. Baked assets (resources/game/tools/FoliageBaker.ts) contain top-level
     * nodes "LOD0".."LODn" which become the type's LODs; other GLBs may name their LODs anywhere in
     * the hierarchy ("Tree_LOD1", nested "LOD0" groups, …) or be a single LOD. Missing reduced / far
     * LODs are generated (see completeModelLods).
     */
    private async loadModel(
        renderer: TypeRenderer,
        url: string,
    ): Promise<void> {
        try {
            const gltf = await this.gltf.loadAsync(url);

            if (renderer.disposed) {
                disposeObject(gltf.scene);

                return;
            }

            gltf.scene.updateMatrixWorld(true);
            // Without LOD naming the whole scene is LOD0. (Merging every node of a model that
            // carries LODs deeper in its hierarchy would draw all of them on top of each other.)
            const levels = findLodRoots(gltf.scene);
            const roots = levels.length ? levels : [[gltf.scene]];
            let lods: THREE.BufferGeometry[] = [];
            let lodMaterials: (THREE.Material | THREE.Material[])[] = [];

            for (const level of roots) {
                const built = buildModelLod(level);

                if (built) {
                    lods.push(built.geometry);
                    lodMaterials.push(
                        built.materials.length === 1
                            ? built.materials[0]
                            : built.materials,
                    );
                }
            }

            // The loader's per-node geometry was copied into the merged LODs.
            gltf.scene.traverse((obj) => {
                const mesh = obj as THREE.Mesh;

                if (mesh.isMesh) {
                    mesh.geometry.dispose();
                }
            });

            if (!lods.length) {
                return;
            }

            const type = renderer.type;
            const tint = new THREE.Color(type.tint || '#ffffff');

            // Tint before any impostor capture so the far LOD matches.
            for (const mat of new Set(lodMaterials.flat())) {
                const colored = mat as THREE.MeshStandardMaterial;

                if (colored.color?.isColor) {
                    colored.color.multiply(tint);
                }
            }

            const originals = new Set(lodMaterials.flat());
            const completed = await completeModelLods(
                type.kind,
                lods,
                lodMaterials,
                pickLodDistances(type, gltf.scene.userData, lods.length),
            );

            if (renderer.disposed) {
                for (const g of completed.lods) {
                    g.dispose();
                }

                for (const m of originals) {
                    disposeMaterialTextures(m);
                    m.dispose();
                }

                return;
            }

            lods = completed.lods;
            lodMaterials = completed.materials;
            lods[0].computeBoundingBox();
            const box = lods[0].boundingBox!.clone();

            for (const geometry of lods) {
                addWindAttribute(geometry, box);
            }

            // LOD0 / LOD1 get their own material copies for the per-instance split (the density
            // fade kinds keep cell-granular LODs).
            const chainLength =
                lods.length + (completed.impostorDistance !== null ? 1 : 0);
            const splitRoles = !renderer.fade && chainLength >= 2;
            const roleCopies = new Map<string, THREE.Material>();
            const withRole = (m: THREE.Material, role: LodRole) => {
                if (role === 'none') {
                    return m;
                }

                const key = `${m.uuid}:${role}`;
                let copy = roleCopies.get(key);

                if (!copy) {
                    copy = m.clone();
                    roleCopies.set(key, copy);
                }

                return copy;
            };
            const roleOf = (lod: number): LodRole =>
                !splitRoles
                    ? 'none'
                    : lod === 0
                      ? 'near'
                      : lod === 1
                        ? 'far'
                        : 'none';

            lodMaterials = lodMaterials.map((m, lod) =>
                Array.isArray(m)
                    ? m.map((x) => withRole(x, roleOf(lod)))
                    : withRole(m, roleOf(lod)),
            );

            const used = new Set(lodMaterials.flat());

            for (const [lod, m] of lodMaterials.entries()) {
                for (const mat of Array.isArray(m) ? m : [m]) {
                    if (!mat.userData.foliagePatched) {
                        mat.userData.foliagePatched = true;
                        this.patchMaterial(mat, renderer, roleOf(lod));
                    }
                }
            }

            // Originals only referenced through their role copies (textures stay shared).
            for (const m of originals) {
                if (!used.has(m)) {
                    m.dispose();
                }
            }

            const previous = {
                lods: renderer.lods,
                proxy: renderer.shadowProxy?.geometry ?? null,
                materials: renderer.lodMaterials,
                depth: renderer.depthMaterial,
            };
            renderer.lods = lods;
            renderer.drawLods = lods;
            renderer.shadowProxy = null;
            renderer.radius = geometryRadius(lods);
            renderer.lodMaterials = lodMaterials;
            renderer.lodDistances = completed.distances;
            renderer.depthMaterial = null;
            renderer.model = true;
            renderer.splitRoles = splitRoles;
            renderer.pendingImpostor =
                completed.impostorDistance !== null
                    ? {
                          distance: completed.impostorDistance,
                          role: roleOf(lods.length),
                      }
                    : null;
            renderer.lodInfo = {
                source: type.asset ? 'baked' : 'model',
                generated: completed.generated,
                warnings: completed.warnings,
            };

            // Swap existing meshes over right away (the stand-in geometry is disposed below);
            // the rebuild then refreshes their bounds for the model's size.
            for (const cell of renderer.cells.values()) {
                this.removeNear(cell);

                if (cell.mesh) {
                    cell.lod = Math.min(cell.lod, lods.length - 1);
                    cell.mesh.geometry = lods[cell.lod];
                    cell.mesh.material = lodMaterial(renderer, cell.lod);
                    cell.mesh.customDepthMaterial = undefined;
                }

                this.markDirty(renderer, cell);
            }

            for (const chunk of renderer.chunks.values()) {
                this.removeCellMesh(chunk);
                chunk.dirty = true;
            }

            for (const g of new Set(previous.lods)) {
                g.dispose();
            }

            previous.proxy?.dispose();

            for (const m of new Set(previous.materials.flat())) {
                m.dispose();
            }

            previous.depth?.dispose();
        } catch (error) {
            renderer.lodInfo.source = 'procedural';
            renderer.lodInfo.warnings.push('model failed to load');
            console.warn(`Failed to load foliage model ${url}`, error);
        }
    }

    private disposeRenderer(renderer: TypeRenderer): void {
        renderer.disposed = true;

        for (const cell of [
            ...renderer.cells.values(),
            ...renderer.chunks.values(),
        ]) {
            this.removeCellMesh(cell);
        }

        for (const g of new Set([...renderer.lods, ...renderer.drawLods])) {
            g.dispose();
        }

        renderer.shown = [];

        for (const m of new Set(renderer.lodMaterials.flat())) {
            if (renderer.model) {
                disposeMaterialTextures(m);
            }

            m.dispose();
        }

        renderer.depthMaterial?.dispose();
    }
}

/** Whether a type's slope / height / underwater rules allow an instance at world X/Z. */
export function placementAllowed(
    ctx: FoliagePlacementContext,
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

function smooth01(a: number, b: number, v: number): number {
    const t = Math.min(1, Math.max(0, (v - a) / (b - a)));

    return t * t * (3 - 2 * t);
}

/** Fisher–Yates shuffle of whole instances so density scaling (prefix rendering) stays uniform. */
function shuffleInstances(data: number[], rand: () => number): void {
    const n = data.length / FOLIAGE_STRIDE;

    for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));

        for (let k = 0; k < FOLIAGE_STRIDE; k++) {
            const a = i * FOLIAGE_STRIDE + k;
            const b = j * FOLIAGE_STRIDE + k;
            const t = data[a];
            data[a] = data[b];
            data[b] = t;
        }
    }
}

type Rect = { x0: number; z0: number; x1: number; z1: number };

function cellKey(size: number, x: number, z: number): string {
    return `${size}:${Math.floor(x / size)},${Math.floor(z / size)}`;
}

/** Parses `${size}:${cx},${cz}` (or a legacy `${cx},${cz}` of the old 128 m grid). */
function parseCellKey(
    key: string,
): (Rect & { size: number; cx: number; cz: number }) | null {
    const m = /^(?:(\d+(?:\.\d+)?):)?(-?\d+),(-?\d+)$/.exec(key);

    if (!m) {
        return null;
    }

    const size = m[1] ? Number(m[1]) : 128;
    const cx = Number(m[2]);
    const cz = Number(m[3]);

    return {
        size,
        cx,
        cz,
        x0: cx * size,
        z0: cz * size,
        x1: (cx + 1) * size,
        z1: (cz + 1) * size,
    };
}

/** Whether a position lies in a cell rect (half-open, matching cell bucketing). */
function inRect(x: number, z: number, r: Rect): boolean {
    return x >= r.x0 && x < r.x1 && z >= r.z0 && z < r.z1;
}

function forEachInRect(
    data: number[],
    rect: Rect,
    fn: (offset: number) => void,
): void {
    for (let i = 0; i < data.length; i += FOLIAGE_STRIDE) {
        if (inRect(data[i], data[i + 2], rect)) {
            fn(i);
        }
    }
}

/** Packs cell grid coordinates into one number (cells span ±32k cells). */
function gridIndex(cx: number, cz: number): number {
    return (cx + 32768) * 65536 + (cz + 32768);
}

function isChunk(cell: Cell): cell is Chunk {
    return (cell as Chunk).members !== undefined;
}

function hideCell(cell: Cell): void {
    if (cell.mesh) {
        cell.mesh.visible = false;
    }

    if (cell.near) {
        cell.near.visible = false;
    }
}

/** Whether a type switches LOD0 → LOD1 per instance (materials patched with near / far roles). */
function splitsLod(renderer: TypeRenderer): boolean {
    return renderer.splitRoles && renderer.drawLods.length >= 2;
}

/** Distance from a point to the farthest corner of a box. */
function farthestDistance(box: THREE.Box3, p: THREE.Vector3): number {
    const dx = Math.max(p.x - box.min.x, box.max.x - p.x);
    const dy = Math.max(p.y - box.min.y, box.max.y - p.y);
    const dz = Math.max(p.z - box.min.z, box.max.z - p.z);

    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Wind weight: 0 at the base → 1 at the top of `box` (LOD0), so every LOD sways alike. */
function addWindAttribute(
    geometry: THREE.BufferGeometry,
    box: THREE.Box3,
): void {
    const pos = geometry.getAttribute('position');
    const height = Math.max(0.001, box.max.y - box.min.y);
    const wind = new Float32Array(pos.count);

    for (let i = 0; i < pos.count; i++) {
        wind[i] = Math.min(
            1.2,
            Math.max(0, (pos.getY(i) - box.min.y) / height),
        );
    }

    geometry.setAttribute('wind', new THREE.BufferAttribute(wind, 1));
}

/** All instances of a renderer as one flat list. */
function flatten(renderer: TypeRenderer): number[] {
    const out: number[] = [];

    for (const cell of renderer.cells.values()) {
        for (const v of cell.data) {
            out.push(v);
        }
    }

    return out;
}

/** Missing / over-budget LODs of a type (F10 readout), plus problems recorded while loading. */
function lodWarnings(renderer: TypeRenderer, tris: number[]): string[] {
    const budget = LOD_BUDGETS[renderer.type.kind] ?? LOD_BUDGETS.bush;
    const warnings = renderer.lodInfo.warnings.slice();

    if (renderer.pendingImpostor) {
        warnings.push('impostor pending (rendered after the first frame)');
    } else if (tris.length === 1) {
        warnings.push('single LOD: full detail at every distance');
    } else if (tris[tris.length - 1] > budget.far) {
        warnings.push(
            `no far LOD / impostor (last LOD ${formatTris(tris[tris.length - 1])})`,
        );
    }

    if (tris[0] > budget.lod0 * 1.5) {
        warnings.push(
            `LOD0 ${formatTris(tris[0])} over the ${formatTris(budget.lod0)} budget`,
        );
    }

    return warnings;
}

/** Largest distance of any vertex from the model origin across all LODs (scale 1). */
function geometryRadius(lods: THREE.BufferGeometry[]): number {
    let radius = 0.5;

    for (const geometry of lods) {
        if (!geometry.boundingSphere) {
            geometry.computeBoundingSphere();
        }

        const sphere = geometry.boundingSphere!;
        radius = Math.max(radius, sphere.center.length() + sphere.radius);
    }

    return radius;
}

/**
 * LOD0 with a slightly shrunk copy of LOD1 appended. The main pass draws the LOD0 range; the shadow
 * pass switches the draw range to the LOD1 copy, so shadows cost LOD1 triangles. Shrinking it
 * towards the trunk keeps the proxy inside the detailed mesh (no self-shadowing acne).
 */
function createShadowProxy(
    lod0: THREE.BufferGeometry,
    lod1: THREE.BufferGeometry,
): TypeRenderer['shadowProxy'] {
    if (!lod0.index || !lod1.index) {
        return null;
    }

    const names = Object.keys(lod0.attributes);

    if (
        names.length !== Object.keys(lod1.attributes).length ||
        names.some((n) => !lod1.getAttribute(n))
    ) {
        return null;
    }

    const proxy = lod1.clone();
    const pos = proxy.getAttribute('position') as THREE.BufferAttribute;

    for (let i = 0; i < pos.count; i++) {
        pos.setXYZ(i, pos.getX(i) * 0.9, pos.getY(i) * 0.97, pos.getZ(i) * 0.9);
    }

    const merged = mergeGeometries([lod0, proxy], false);
    proxy.dispose();

    if (!merged) {
        return null;
    }

    const main = lod0.index.count;
    merged.setDrawRange(0, main);
    merged.boundingBox = lod0.boundingBox?.clone() ?? null;
    merged.boundingSphere = lod0.boundingSphere?.clone() ?? null;

    return {
        geometry: merged,
        start: main,
        count: lod1.index.count,
        main,
    };
}

function sameVisuals(a: FoliageType, b: FoliageType): boolean {
    return (
        a.kind === b.kind &&
        a.color === b.color &&
        a.color_secondary === b.color_secondary &&
        a.model_url === b.model_url &&
        (a.tint || '#ffffff').toLowerCase() ===
            (b.tint || '#ffffff').toLowerCase() &&
        (a.asset?.id ?? null) === (b.asset?.id ?? null) &&
        (a.asset?.lod_distances ?? []).join() ===
            (b.asset?.lod_distances ?? []).join()
    );
}

function lodMaterial(
    renderer: TypeRenderer,
    lod: number,
): THREE.Material | THREE.Material[] {
    return (
        renderer.lodMaterials[lod] ??
        renderer.lodMaterials[renderer.lodMaterials.length - 1]
    );
}

/**
 * Fills in the LODs a model lacks (see LOD_BUDGETS in FoliageLod.ts):
 *
 * - LOD0 far beyond its budget (raw, unbaked sources) is simplified,
 * - a simplified mid LOD is inserted when the cheapest mesh LOD is still heavy,
 * - rocks get a coarse far mesh; vegetation without a far LOD gets an impostor, rendered later
 *   (`impostorDistance` != null) because that needs the WebGL renderer.
 *
 * `lods` / `materials` are updated in place and returned with the matching LOD distances.
 */
async function completeModelLods(
    kind: FoliageKind,
    lods: THREE.BufferGeometry[],
    materials: (THREE.Material | THREE.Material[])[],
    distances: number[],
): Promise<{
    lods: THREE.BufferGeometry[];
    materials: (THREE.Material | THREE.Material[])[];
    distances: number[];
    impostorDistance: number | null;
    generated: string[];
    warnings: string[];
}> {
    const budget = LOD_BUDGETS[kind] ?? LOD_BUDGETS.bush;
    const generated: string[] = [];
    const warnings: string[] = [];
    const lod0 = triangleCount(lods[0]);

    if (lod0 > budget.lod0 * 3) {
        const reduced = await simplifyGeometry(lods[0], budget.lod0);

        if (reduced) {
            lods[0].dispose();
            lods[0] = reduced;
            const tris = triangleCount(reduced);
            generated.push(
                `LOD0 simplified ${formatTris(lod0)} → ${formatTris(tris)}`,
            );

            // Source LODs now heavier than LOD0 would make the chain more expensive with distance.
            for (let i = lods.length - 1; i > 0; i--) {
                if (triangleCount(lods[i]) >= tris) {
                    lods[i].dispose();
                    lods.splice(i, 1);
                    materials.splice(i, 1);
                    distances.splice(i, 1);
                }
            }
        } else {
            warnings.push(`LOD0 ${formatTris(lod0)} could not be simplified`);
        }

        await nextTick();
    }

    const originalCount = lods.length;
    // Mesh LODs end where the far LOD (impostor / coarse mesh) starts.
    let meshEnd = lods.length;

    while (meshEnd > 1 && triangleCount(lods[meshEnd - 1]) <= budget.far) {
        meshEnd--;
    }

    const hasFar = meshEnd < lods.length;
    const cheapest = triangleCount(lods[meshEnd - 1]);
    let midIndex = -1;

    if (cheapest > budget.mid * 1.5) {
        const mid = await simplifyGeometry(lods[meshEnd - 1], budget.mid);

        if (mid) {
            midIndex = meshEnd;
            lods.splice(midIndex, 0, mid);
            materials.splice(midIndex, 0, materials[midIndex - 1]);
            meshEnd++;
            generated.push(
                `LOD${midIndex} simplified (${formatTris(triangleCount(mid))})`,
            );
        } else {
            warnings.push(`no reduced LOD (cheapest ${formatTris(cheapest)})`);
        }

        await nextTick();
    }

    let farIndex = -1;
    let impostor = false;

    if (!hasFar) {
        if (budget.impostor) {
            impostor = true;
        } else {
            const far = await simplifyGeometry(lods[meshEnd - 1], budget.far);

            if (far) {
                farIndex = lods.length;
                lods.push(far);
                materials.push(materials[meshEnd - 1]);
                generated.push(
                    `LOD${farIndex} far mesh (${formatTris(triangleCount(far))})`,
                );
            } else {
                warnings.push('no far LOD');
            }
        }
    }

    // Distances: kind defaults for single-LOD sources, otherwise the source's distances with the
    // generated LODs slotted in between / after them.
    let d: number[];

    if (originalCount <= 1) {
        d = [0];

        if (midIndex >= 0) {
            d.push(budget.midAt);
        }

        if (farIndex >= 0 || impostor) {
            d.push(budget.farAt);
        }
    } else {
        d = distances.slice(0, originalCount);
        const farAt = (prev: number) =>
            Math.min(0.95, Math.max(budget.farAt, prev + 0.1));

        if (midIndex >= 0) {
            const prev = d[midIndex - 1];
            const next = midIndex < d.length ? d[midIndex] : farAt(prev);
            d.splice(midIndex, 0, (prev + next) / 2);
        }

        if (farIndex >= 0 || impostor) {
            d.push(farAt(d[d.length - 1]));
        }
    }

    return {
        lods,
        materials,
        distances: d.slice(0, lods.length),
        impostorDistance: impostor ? d[lods.length] : null,
        generated,
        warnings,
    };
}

function formatTris(tris: number): string {
    return tris >= 10000
        ? `${Math.round(tris / 1000)}k tris`
        : `${tris.toLocaleString()} tris`;
}

/** Yields to the event loop between expensive steps (model LOD generation). */
function nextTick(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Merges every mesh under the given LOD roots into one indexed geometry (one group per material)
 * with float position / normal / uv (+ colour when a material uses vertex colours).
 */
function buildModelLod(roots: THREE.Object3D[]): {
    geometry: THREE.BufferGeometry;
    materials: THREE.Material[];
} | null {
    const pieces: {
        geometry: THREE.BufferGeometry;
        material: THREE.Material;
    }[] = [];

    for (const root of roots) {
        root.updateWorldMatrix(true, true);
    }

    const visit = (obj: THREE.Object3D) => {
        const mesh = obj as THREE.Mesh;

        if (!mesh.isMesh || !mesh.geometry.getAttribute('position')) {
            return;
        }

        const source = mesh.geometry;
        const materials = Array.isArray(mesh.material)
            ? mesh.material
            : [mesh.material];
        const groups =
            Array.isArray(mesh.material) && source.groups.length
                ? source.groups
                : [
                      {
                          start: 0,
                          count: Infinity,
                          materialIndex: 0,
                      },
                  ];

        for (const group of groups) {
            const material = materials[group.materialIndex ?? 0];

            if (!material) {
                continue;
            }

            const g = new THREE.BufferGeometry();

            for (const name of ['position', 'normal', 'uv', 'color']) {
                const attr = source.getAttribute(name);

                if (attr) {
                    g.setAttribute(
                        name,
                        toFloatAttribute(
                            attr,
                            name === 'color' ? 3 : attr.itemSize,
                        ),
                    );
                }
            }

            const count = source.index
                ? source.index.count
                : source.getAttribute('position').count;
            const start = Math.max(0, group.start);
            const end = Math.min(count, group.start + group.count);
            const index: number[] = [];

            for (let i = start; i < end; i++) {
                index.push(source.index ? source.index.getX(i) : i);
            }

            g.setIndex(index);
            g.applyMatrix4(mesh.matrixWorld);

            if (!g.getAttribute('normal')) {
                g.computeVertexNormals();
            }

            if (!g.getAttribute('uv')) {
                g.setAttribute(
                    'uv',
                    new THREE.BufferAttribute(
                        new Float32Array(g.getAttribute('position').count * 2),
                        2,
                    ),
                );
            }

            pieces.push({ geometry: g, material });
        }
    };

    for (const root of roots) {
        root.traverse(visit);
    }

    if (!pieces.length) {
        return null;
    }

    const withColor = pieces.some(
        (p) => (p.material as THREE.MeshStandardMaterial).vertexColors,
    );

    for (const { geometry } of pieces) {
        if (!withColor) {
            geometry.deleteAttribute('color');
        } else if (!geometry.getAttribute('color')) {
            const white = new Float32Array(
                geometry.getAttribute('position').count * 3,
            ).fill(1);
            geometry.setAttribute('color', new THREE.BufferAttribute(white, 3));
        }
    }

    // Consecutive pieces sharing a material become one draw group.
    const materials: THREE.Material[] = [];
    const ordered = [...pieces].sort(
        (a, b) =>
            firstIndexOf(pieces, a.material) - firstIndexOf(pieces, b.material),
    );

    for (const piece of ordered) {
        if (!materials.includes(piece.material)) {
            materials.push(piece.material);
        }
    }

    const merged = mergeGeometries(
        ordered.map((p) => p.geometry),
        true,
    );

    for (const piece of pieces) {
        piece.geometry.dispose();
    }

    if (!merged) {
        return null;
    }

    // mergeGeometries makes one group per input; remap them to material slots and coalesce.
    const groups = merged.groups.map((group, i) => ({
        start: group.start,
        count: group.count,
        materialIndex: materials.indexOf(ordered[i].material),
    }));
    merged.clearGroups();

    for (const group of groups) {
        const last = merged.groups[merged.groups.length - 1];

        if (
            last &&
            last.materialIndex === group.materialIndex &&
            last.start + last.count === group.start
        ) {
            last.count += group.count;
        } else {
            merged.addGroup(group.start, group.count, group.materialIndex);
        }
    }

    merged.computeBoundingBox();
    merged.computeBoundingSphere();

    return { geometry: merged, materials };
}

function firstIndexOf(
    pieces: { material: THREE.Material }[],
    material: THREE.Material,
): number {
    return pieces.findIndex((p) => p.material === material);
}

/** Plain, non-normalized Float32 copy of any (interleaved / quantized) attribute. */
function toFloatAttribute(
    attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
    itemSize: number,
): THREE.BufferAttribute {
    const out = new Float32Array(attr.count * itemSize);

    for (let i = 0; i < attr.count; i++) {
        for (let k = 0; k < itemSize; k++) {
            out[i * itemSize + k] =
                k < attr.itemSize ? attr.getComponent(i, k) : 1;
        }
    }

    return new THREE.BufferAttribute(out, itemSize);
}

function pickLodDistances(
    type: FoliageType,
    userData: Record<string, unknown>,
    count: number,
): number[] {
    const valid = (d: unknown): d is number[] =>
        Array.isArray(d) &&
        d.length === count &&
        d.every((v) => typeof v === 'number' && Number.isFinite(v));
    const fromAsset = type.asset?.lod_distances;

    if (valid(fromAsset)) {
        return [0, ...fromAsset.slice(1)];
    }

    const extras = (
        userData?.waterways as { lod_distances?: unknown } | undefined
    )?.lod_distances;

    if (valid(extras)) {
        return [0, ...extras.slice(1)];
    }

    if (count === 1) {
        return [0];
    }

    if (count === 2) {
        return [0, 0.35];
    }

    return Array.from({ length: count }, (_, i) =>
        i === 0 ? 0 : 0.5 * (i / (count - 1)) ** 1.3,
    );
}

function disposeMaterialTextures(material: THREE.Material): void {
    for (const value of Object.values(material)) {
        if ((value as THREE.Texture | null)?.isTexture) {
            (value as THREE.Texture).dispose();
        }
    }
}

function disposeObject(root: THREE.Object3D): void {
    root.traverse((obj) => {
        const mesh = obj as THREE.Mesh;

        if (!mesh.isMesh) {
            return;
        }

        mesh.geometry.dispose();

        for (const m of Array.isArray(mesh.material)
            ? mesh.material
            : [mesh.material]) {
            disposeMaterialTextures(m);
            m.dispose();
        }
    });
}

const _normal = new THREE.Vector3();
const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();
const _frustum = new THREE.Frustum();
const _projScreen = new THREE.Matrix4();
