import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { GpuProfiler } from '../core/GpuProfiler';
import { isWebGpu } from '../core/renderer';
import type { GameRenderer } from '../core/renderer';
import { FOLIAGE_STRIDE } from '../shared/types';
import type {
    FoliageFile,
    FoliageKind,
    FoliageType,
    TerrainLayer,
} from '../shared/types';
import { mulberry32, SimplexNoise } from '../util/noise';
import type { FoliageTypeStat } from '../shared/protocol';
import { uniform } from 'three/tsl';
import { createFoliageGeometry } from './FoliageGeometry';
import {
    findLodRoots,
    LOD_BUDGETS,
    simplifyGeometry,
    triangleCount,
} from './FoliageLod';
import { GpuCullFrame, GpuFoliageType } from './foliage/FoliageGpu';
import type { GpuTypeConfig } from './foliage/FoliageGpu';
import {
    attributeInstance,
    createFoliageGlobals,
    createFoliageMaterial,
    RANK_FADE,
    windStiffness,
} from './foliage/FoliageMaterial';
import type { FoliageTypeUniforms, LodRole } from './foliage/FoliageMaterial';
import { generateGroundCoverTile } from './foliage/groundCover';
import type {
    GroundCoverContext,
    GroundCoverSource,
} from './foliage/groundCover';
import { HiZ } from './foliage/HiZ';
import { renderImpostor } from './foliage/Impostor';
import { InstanceBatch } from './foliage/InstanceBatch';
import type { InstanceView } from './foliage/InstanceBatch';
import { INSTANCE_FLOATS, writeInstance } from './foliage/instances';
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
/**
 * CPU path: shown cells drawing at most MERGE_MAX_INSTANCES are merged per square, LOD and shadow
 * flag into one batch. Sparse cells (a few rocks or trees each) would otherwise cost a draw call
 * apiece, and every draw is expensive on the WebGL 2 backend. Squares are MERGE_SIZE metres at
 * LOD0 and double per LOD (farther away, so about the same size on screen): larger ones would
 * frustum-cull too coarsely.
 */
const MERGE_MAX_INSTANCES = 512;
const MERGE_SIZE = 256;
/** Small, dense kinds: not drawn in the water reflection (invisible in its ripples, costly). */
const SMALL_KINDS: ReadonlySet<FoliageKind> = new Set([
    'grass',
    'flower',
    'reed',
]);
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
 * Camera movement (m) between two frames treated as a cut (teleport, mode switch): the previous
 * frame's depth says nothing about the new view, so occlusion culling pauses for that frame.
 */
const CAMERA_CUT = 25;
/** Frame budget (ms) for growing ground cover tiles (at least one tile per frame while any is due). */
const COVER_BUDGET_MS = 3;
/** Camera movement (m) before the ground cover tiles around it are re-checked. */
const COVER_MOVE = 4;

type Cell = {
    /** `${size}:${cx},${cz}` — also the undo snapshot id. */
    key: string;
    cx: number;
    cz: number;
    data: number[];
    mesh: THREE.Mesh | null;
    /** Instance buffer + per-LOD geometry views of the mesh (reused while the cell changes). */
    batch: InstanceBatch | null;
    /** Instances written into the batch. */
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
    near: THREE.Mesh | null;
    nearBatch: InstanceBatch | null;
    /** Drawn through a merged batch since the last evaluation (the cell mesh is hidden). */
    merged: boolean;
};

/** A far-LOD batch over CHUNK_CELLS² cells; `data` is only filled while building. */
type Chunk = Cell & { members: Cell[]; gx: number; gz: number };

/** Copies of sparse cells of one chunk area drawn with one LOD and shadow flag (see mergeCells). */
type MergedBatch = {
    mesh: THREE.Mesh;
    batch: InstanceBatch;
    /** Source batches, their versions and drawn counts of the current contents. */
    signature: string;
    lod: number;
    stamp: number;
};

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
    /**
     * Source material(s) per LOD — procedural LODs share one material, baked models have one set per
     * LOD. The foliage node materials of both render paths are built from these.
     */
    sourceMaterials: (THREE.Material | THREE.Material[])[];
    /** CPU-path node materials per LOD (instance attributes, near / far roles for the LOD split). */
    lodMaterials: (THREE.Material | THREE.Material[])[];
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
    /** Merged batches of sparse shown cells by chunk area, LOD and shadow flag (CPU path). */
    merged: Map<string, MergedBatch>;
    /** Distance fade / density falloff (per instance) for small foliage. */
    fade: boolean;
    falloff: { start: number; min: number } | null;
    /** Largest distance of any LOD vertex from the instance origin, at scale 1. */
    radius: number;
    /** Per-type shader uniforms (updated in place, e.g. when the cull distance changes). */
    uniforms: FoliageTypeUniforms;
    /** GPU-driven renderer (WebGPU); null on the CPU-culled path. */
    gpu: GpuFoliageType | null;
    /** Cells whose instances changed since the last GPU upload. */
    gpuDirty: Set<Cell>;
    /** Where the LODs came from and what was generated at runtime (stats / F10 readout). */
    lodInfo: {
        source: FoliageTypeStat['source'];
        generated: string[];
        warnings: string[];
    };
    /** Materials of LOD0 / LOD1 are patched with the 'near' / 'far' roles (per-instance split). */
    splitRoles: boolean;
    /** Far impostor still to be rendered (needs the renderer; see Foliage.update()). */
    pendingImpostor: { distance: number; role: LodRole } | null;
    /** An impostor capture is in flight (read-back is asynchronous). */
    capturing: boolean;
    /**
     * Set for ground cover renderers (a type grown by terrain layers, see groundCover.ts): their cells
     * are generated tiles around the camera, never saved or edited.
     */
    cover: {
        sources: GroundCoverSource[];
        /** Generation inputs; a change regrows every tile. */
        signature: string;
        /** Tiles to regrow (painted, sculpted, …); they keep their old instances until then. */
        stale: Set<string>;
    } | null;
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
    /**
     * Cells casting shadows (each costs a draw call per shadow pass when in the shadow frustum); on
     * the GPU-culled path: instances in the shadow list.
     */
    shadowCasters: number;
    /** Instances rejected by Hi-Z occlusion culling (GPU path). */
    occludedInstances: number;
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
    private readonly globals = createFoliageGlobals();
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
    /** Released instance batches (CPU path), reused before new ones are allocated. */
    private readonly batchPool: InstanceBatch[] = [];
    private lastCamera: THREE.Camera | null = null;
    /** Renderer used to render missing impostors (set explicitly or picked up from a draw). */
    private gl: GameRenderer | null = null;
    /** Shared inputs of the GPU culling passes; non-null once the GPU-driven path is active. */
    private gpuFrame: GpuCullFrame | null = null;
    private readonly previousCamera = new THREE.Vector3();
    private hasPrevious = false;
    private lastCull = 0;
    /** Every foliage type (ground cover renderers are created from these). */
    private types = new Map<number, FoliageType>();
    private coverLayers: TerrainLayer[] = [];
    private coverCtx: GroundCoverContext | null = null;
    /** Re-check the ground cover tiles on the next update (else only after the camera moved). */
    private coverScan = true;
    private readonly lastCoverPos = new THREE.Vector3(Infinity, 0, 0);

    constructor() {
        this.group.name = 'Foliage';
        // Static: an auto-updated group would recompute every cell mesh's world matrix each frame.
        this.group.matrixAutoUpdate = false;
    }

    /**
     * The renderer foliage is drawn with. On WebGPU this switches to GPU-driven culling and indirect
     * draws (see cull()); on WebGL 2 cells are culled on the CPU. It also renders the impostors of
     * models without a far LOD (otherwise picked up from the first foliage draw).
     */
    setRenderer(renderer: GameRenderer | null): void {
        this.gl = renderer;

        if (
            renderer &&
            isWebGpu(renderer) &&
            this.gpuAllowed &&
            !this.gpuFrame
        ) {
            this.enableGpu();
        }
    }

    /** Whether instances are culled on the GPU (WebGPU) rather than per cell on the CPU. */
    get gpuDriven(): boolean {
        return this.gpuFrame !== null;
    }

    /**
     * GPU-driven culling on WebGPU (default on). Off keeps the CPU-culled cells on WebGPU too
     * (comparisons, troubleshooting); switching rebuilds every type's draws.
     */
    get gpuCulling(): boolean {
        return this.gpuAllowed;
    }

    set gpuCulling(enabled: boolean) {
        this.gpuAllowed = enabled;

        if (!enabled && this.gpuFrame) {
            this.disableGpu();
        } else if (enabled && this.gl && isWebGpu(this.gl) && !this.gpuFrame) {
            this.enableGpu();
        }
    }

    private gpuAllowed = true;

    /** Hi-Z occlusion culling on the GPU path (on by default). */
    occlusionCulling = true;

    /** Fraction of instances drawn (GraphicsSettings.foliage_density). */
    get densityScale(): number {
        return this.density;
    }

    set densityScale(value: number) {
        this.density = Math.max(0, value);
        this.globals.density.value = this.density;
        this.needsEval = true;
    }

    /** Multiplier on every type's cull distance (GraphicsSettings.foliage_distance). */
    get distanceScale(): number {
        return this.globals.fadeScale.value;
    }

    set distanceScale(value: number) {
        this.globals.fadeScale.value = Math.max(0.01, value);
        this.needsEval = true;
        this.coverScan = true;
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
        this.types = new Map(types.map((t) => [t.id, t]));

        for (const [id, renderer] of this.renderers) {
            if (!renderer.cover && !keep.has(id)) {
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
                existing.uniforms.fadeEnd.value = type.cull_distance;
                existing.gpu?.setCastShadows(type.cast_shadows);
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

        this.syncCover();
        this.needsEval = true;
    }

    /**
     * Ground cover: the foliage types each terrain layer grows by itself wherever it is painted.
     * `ctx` (terrain, splat map, water) is kept from the previous call when omitted.
     */
    setGroundCover(
        layers: TerrainLayer[],
        ctx?: GroundCoverContext | null,
    ): void {
        this.coverLayers = layers;

        if (ctx !== undefined) {
            this.coverCtx = ctx;
        }

        this.syncCover();
    }

    /** Regrows the ground cover tiles touching a world rect (splat paint, sculpting, water edits). */
    invalidateGroundCover(
        minX: number,
        minZ: number,
        maxX: number,
        maxZ: number,
    ): void {
        for (const renderer of this.renderers.values()) {
            if (!renderer.cover) {
                continue;
            }

            const size = renderer.cellSize;

            for (const cell of renderer.cells.values()) {
                if (
                    (cell.cx + 1) * size >= minX &&
                    cell.cx * size <= maxX &&
                    (cell.cz + 1) * size >= minZ &&
                    cell.cz * size <= maxZ
                ) {
                    renderer.cover.stale.add(cell.key);
                }
            }
        }

        this.coverScan = true;
    }

    /** Ground cover instances currently grown around the camera (not part of the saved foliage). */
    get groundCoverCount(): number {
        let count = 0;

        for (const renderer of this.renderers.values()) {
            if (renderer.cover) {
                for (const cell of renderer.cells.values()) {
                    count += cell.data.length / FOLIAGE_STRIDE;
                }
            }
        }

        return count;
    }

    /** Creates / updates / removes the ground cover renderers to match the layers and types. */
    private syncCover(): void {
        const sources = new Map<number, GroundCoverSource[]>();

        for (const layer of this.coverLayers) {
            for (const entry of layer.ground_cover ?? []) {
                if (
                    entry.density > 0 &&
                    this.types.has(entry.foliage_type_id)
                ) {
                    const list = sources.get(entry.foliage_type_id) ?? [];
                    list.push({ slot: layer.slot, density: entry.density });
                    sources.set(entry.foliage_type_id, list);
                }
            }
        }

        for (const [key, renderer] of this.renderers) {
            if (
                renderer.cover &&
                (!this.coverCtx || !sources.has(renderer.type.id))
            ) {
                this.disposeRenderer(renderer);
                this.renderers.delete(key);
            }
        }

        if (!this.coverCtx) {
            return;
        }

        for (const [id, list] of sources) {
            const type = this.types.get(id)!;
            const key = coverKey(id);
            const signature = JSON.stringify([
                list,
                type.density,
                type.min_scale,
                type.max_scale,
                type.min_slope,
                type.max_slope,
                type.min_height,
                type.max_height,
                type.align_to_normal,
                type.random_yaw,
                type.allow_underwater,
                type.kind,
            ]);
            let renderer = this.renderers.get(key);

            if (renderer && sameVisuals(renderer.type, type)) {
                renderer.type = type;
                renderer.uniforms.fadeEnd.value = type.cull_distance;
                renderer.gpu?.setCastShadows(type.cast_shadows);
            } else {
                // New, or the look changed (new model, colours): rebuild, keeping the grown tiles.
                const old = renderer;
                renderer = this.createRenderer(type);
                renderer.cover = {
                    sources: list,
                    signature: old?.cover?.signature ?? signature,
                    stale: new Set(),
                };

                if (old) {
                    const flat = flatten(old);
                    this.disposeRenderer(old);

                    if (old.cellSize === renderer.cellSize) {
                        this.insertFlat(renderer, flat);
                    }
                }

                this.renderers.set(key, renderer);
            }

            const cover = renderer.cover!;
            cover.sources = list;

            if (cover.signature !== signature) {
                // Density, scale or rules changed: regrow every tile (in place, no gap).
                cover.signature = signature;

                for (const k of renderer.cells.keys()) {
                    cover.stale.add(k);
                }
            }
        }

        this.coverScan = true;
        this.needsEval = true;
    }

    /**
     * Grows the ground cover tiles within reach of the camera (nearest first, within a frame budget),
     * regrows stale ones and drops the ones left far behind.
     */
    private updateGroundCover(cam: THREE.Vector3): void {
        const ctx = this.coverCtx;

        if (
            !ctx ||
            (!this.coverScan &&
                cam.distanceToSquared(this.lastCoverPos) <
                    COVER_MOVE * COVER_MOVE)
        ) {
            return;
        }

        this.coverScan = false;
        this.lastCoverPos.copy(cam);
        const hf = ctx.heights;
        const ground = hf.contains(cam.x, cam.z) ? hf.sample(cam.x, cam.z) : 0;
        const above = Math.max(0, cam.y - ground);
        const todo: {
            renderer: TypeRenderer;
            cx: number;
            cz: number;
            d: number;
        }[] = [];

        for (const renderer of this.renderers.values()) {
            const cover = renderer.cover;

            if (!cover) {
                continue;
            }

            const size = renderer.cellSize;
            const cull = renderer.type.cull_distance * this.distanceScale;
            // Horizontal reach at the camera's height above the ground.
            const reach = Math.sqrt(Math.max(0, cull * cull - above * above));
            const keep = reach + size * 2;

            for (const cell of renderer.cells.values()) {
                if (rectDistance(cam, cell.cx, cell.cz, size) > keep) {
                    this.dropCell(renderer, cell);
                    cover.stale.delete(cell.key);
                }
            }

            if (reach <= 0) {
                continue;
            }

            const c0 = Math.max(
                Math.floor((cam.x - reach) / size),
                Math.floor(-hf.half / size),
            );
            const c1 = Math.min(
                Math.floor((cam.x + reach) / size),
                Math.ceil(hf.half / size) - 1,
            );
            const r0 = Math.max(
                Math.floor((cam.z - reach) / size),
                Math.floor(-hf.half / size),
            );
            const r1 = Math.min(
                Math.floor((cam.z + reach) / size),
                Math.ceil(hf.half / size) - 1,
            );

            for (let cz = r0; cz <= r1; cz++) {
                for (let cx = c0; cx <= c1; cx++) {
                    const d = rectDistance(cam, cx, cz, size);

                    if (d > reach) {
                        continue;
                    }

                    const key = `${size}:${cx},${cz}`;

                    if (!renderer.cells.has(key) || cover.stale.has(key)) {
                        todo.push({ renderer, cx, cz, d });
                    }
                }
            }
        }

        if (!todo.length) {
            return;
        }

        todo.sort((a, b) => a.d - b.d);
        const start = performance.now();
        let i = 0;

        for (; i < todo.length; i++) {
            if (i > 0 && performance.now() - start > COVER_BUDGET_MS) {
                break;
            }

            const { renderer, cx, cz } = todo[i];
            const size = renderer.cellSize;
            const key = `${size}:${cx},${cz}`;
            const cell = this.cellFor(renderer, key);
            cell.data = generateGroundCoverTile(
                renderer.type,
                size,
                cx,
                cz,
                renderer.cover!.sources,
                ctx,
            );
            renderer.cover!.stale.delete(key);
            this.markDirty(renderer, cell);
        }

        // More to grow: carry on next frame.
        if (i < todo.length) {
            this.coverScan = true;
        }
    }

    /** Removes a cell entirely (ground cover tiles left behind by the camera). */
    private dropCell(renderer: TypeRenderer, cell: Cell): void {
        this.removeCellMesh(cell);
        cell.data = [];
        renderer.cells.delete(cell.key);
        renderer.grid.delete(gridIndex(cell.cx, cell.cz));
        const chunk = cell.chunk;

        if (chunk) {
            const index = chunk.members.indexOf(cell);

            if (index >= 0) {
                chunk.members.splice(index, 1);
            }

            chunk.dirty = true;

            if (!chunk.members.length) {
                this.removeCellMesh(chunk);
                renderer.chunks.delete(gridIndex(chunk.gx, chunk.gz));
            }
        }

        if (renderer.gpu) {
            renderer.gpuDirty.add(cell);
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

            this.clearMerged(renderer);
            renderer.cells.clear();
            renderer.grid.clear();
            renderer.chunks.clear();
            renderer.shown = [];
            renderer.extent.makeEmpty();
            renderer.gpu?.clear();
            renderer.gpuDirty.clear();
            renderer.cover?.stale.clear();
        }

        this.queue.length = 0;
        this.coverScan = true;
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
            if (renderer.cover) {
                continue;
            }

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
            if (renderer.cover) {
                continue;
            }

            for (const cell of renderer.cells.values()) {
                count += cell.data.length / FOLIAGE_STRIDE;
            }
        }

        return count;
    }

    setWind(strength: number, dirX?: number, dirZ?: number): void {
        this.globals.wind.value = strength;

        if (dirX !== undefined && dirZ !== undefined) {
            this.globals.windDir.value.set(dirX, dirZ);
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
            if (renderer.cover || (typeIds && !typeIds.includes(id))) {
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
        // Ground cover regrows instead (slope and height rules may now differ).
        this.invalidateGroundCover(minX, minZ, maxX, maxZ);

        for (const renderer of this.renderers.values()) {
            if (renderer.cover) {
                continue;
            }

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

    /** Foliage rendering statistics for the last evaluated camera (GPU path: last read-back). */
    stats(): FoliageStats {
        const stats: FoliageStats = {
            instances: 0,
            drawnInstances: 0,
            drawCalls: 0,
            triangles: 0,
            shadowCasters: 0,
            occludedInstances: 0,
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
            _frustum.setFromProjectionMatrix(
                _projScreen,
                camera.coordinateSystem,
            );
        }

        for (const renderer of this.renderers.values()) {
            stats.cells += renderer.cells.size;
            const name = renderer.cover
                ? `${renderer.type.name} · ground cover`
                : renderer.type.name;
            const typeStats = (stats.byType[name] ??= {
                drawCalls: 0,
                triangles: 0,
                instances: 0,
            });
            const cull = renderer.type.cull_distance * this.distanceScale;
            const lodTriangles = renderer.lods.map(triangleCount);
            const detail: FoliageTypeStat = {
                name,
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

            if (renderer.gpu) {
                this.gpuStats(renderer.gpu, detail);
                stats.shadowCasters += detail.shadowCasters;
                stats.occludedInstances += detail.occluded ?? 0;
                stats.drawnInstances += detail.drawn;
                stats.drawCalls += detail.drawCalls;
                stats.triangles += detail.triangles;
                typeStats.drawCalls += detail.drawCalls;
                typeStats.triangles += detail.triangles;
                typeStats.instances += detail.drawn;

                continue;
            }

            const drawn: { mesh: THREE.Mesh | null; lod: number }[] = [];

            for (const cell of renderer.shown) {
                stats.shownCells += cell.mesh?.visible || cell.merged ? 1 : 0;
                drawn.push(
                    { mesh: cell.mesh, lod: cell.lod },
                    { mesh: cell.near, lod: 0 },
                );
            }

            for (const merged of renderer.merged.values()) {
                drawn.push(merged);
            }

            for (const { mesh, lod } of drawn) {
                if (!mesh?.visible) {
                    continue;
                }

                stats.shadowCasters += mesh.castShadow ? 1 : 0;
                detail.shadowCasters += mesh.castShadow ? 1 : 0;

                if (
                    camera &&
                    !_frustum.intersectsSphere(mesh.geometry.boundingSphere!)
                ) {
                    continue;
                }

                const geometry = mesh.geometry;
                const count = instanceCountOf(mesh);
                const groups = Array.isArray(mesh.material)
                    ? Math.max(1, geometry.groups.length)
                    : 1;
                const triangles = triangleCount(geometry) * count;
                stats.drawnInstances += count;
                stats.drawCalls += groups;
                stats.triangles += triangles;
                typeStats.drawCalls += groups;
                typeStats.triangles += triangles;
                typeStats.instances += count;
                detail.drawn += count;
                detail.drawCalls += groups;
                detail.triangles += triangles;

                if (lod < detail.lodInstances.length) {
                    detail.lodInstances[lod] += count;
                }
            }
        }

        return stats;
    }

    /** Per-type numbers of the GPU path from the last counter read-back. */
    private gpuStats(gpu: GpuFoliageType, detail: FoliageTypeStat): void {
        const counters = gpu.lastStats;
        const tris = gpu.lodTriangles();
        detail.drawCalls = gpu.drawCalls;
        detail.occluded = counters?.occluded ?? 0;
        detail.shadowCasters = counters?.shadowInstances ?? 0;

        if (!counters) {
            return;
        }

        counters.lodInstances.forEach((count, lod) => {
            if (lod < detail.lodInstances.length) {
                detail.lodInstances[lod] = count;
            }

            detail.drawn += count;
            detail.triangles += count * (tris[lod] ?? 0);
        });
    }

    /**
     * Light for the leaf translucency term: sky irradiance, sun / moon colour × intensity and the
     * direction towards it (from the Atmosphere, once per frame).
     */
    setLighting(
        sky: THREE.Color,
        sun: THREE.Color,
        sunDir: THREE.Vector3,
    ): void {
        this.globals.skyLight.value.copy(sky);
        this.globals.sunLight.value.copy(sun);
        this.globals.sunDir.value.copy(sunDir);
    }

    update(dt: number, camera: THREE.Camera): void {
        this.globals.prevTime.value = this.globals.time.value;
        this.globals.time.value += dt;
        this.globals.camPos.value.copy(camera.position);
        this.lastCamera = camera;
        this.updateGroundCover(camera.position);

        if (this.gpuFrame) {
            this.syncGpu();
        } else {
            this.evalTimer -= dt;

            // Visibility / LOD / density / shadows only change with distance, so cells are
            // re-evaluated when the camera moved a bit (or something changed), not every frame.
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

            this.cullMerged(camera);
        }

        if (this.gl) {
            this.renderPendingImpostor(this.gl);
        }
    }

    /**
     * GPU-driven culling (WebGPU; no-op on the CPU path): builds the Hi-Z pyramid from the previous
     * frame's scene depth, then one compute pass per type culls every instance and writes the
     * indirect draw arguments. Call once per frame after update(), before the scene is rendered.
     * `reflection` is the water reflection's camera when the reflection renders this frame: the same
     * passes fill its own visibility lists (drawn between beginReflection() and endReflection()).
     */
    cull(
        renderer: GameRenderer,
        camera: THREE.Camera,
        depth?: THREE.Texture | null,
        profiler?: GpuProfiler | null,
        reflection?: THREE.Camera | null,
    ): void {
        if (!isWebGpu(renderer)) {
            return;
        }

        if (!this.gpuFrame) {
            this.setRenderer(renderer);
        }

        const frame = this.gpuFrame;

        if (!frame) {
            return;
        }

        const now = performance.now();
        const dt = this.lastCull ? (now - this.lastCull) / 1000 : 0;
        this.lastCull = now;
        profiler?.mark('Foliage culling');
        camera.updateMatrixWorld();
        this.globals.camPos.value.copy(camera.position);
        frame.setCamera(camera);
        frame.setReflection(reflection ?? null);
        frame.lodBias.value = this.lodBias;
        frame.shadowDistance.value = this.shadowDistance;

        // Occlusion needs last frame's depth from (nearly) the same viewpoint and projection.
        const moved = camera.position.distanceTo(this.previousCamera);
        const sameLens =
            this.hasPrevious &&
            Math.abs(
                frame.prevProj.value.elements[5] -
                    camera.projectionMatrix.elements[5],
            ) <
                0.01 * Math.abs(camera.projectionMatrix.elements[5]);
        let occlusion = false;

        if (this.occlusionCulling && depth && sameLens && moved < CAMERA_CUT) {
            occlusion = frame.hiz.update(renderer, depth);
        }

        frame.occlusion.value = occlusion ? 1 : 0;
        // Parallax since the depth was rendered: widen the tested spheres by the camera movement.
        frame.occlusionMargin.value = moved * 1.5;
        const nodes: THREE.ComputeNode[] = [];

        for (const type of this.renderers.values()) {
            if (type.gpu) {
                nodes.push(...type.gpu.computeNodes());
                type.gpu.updateStats(renderer, dt);
            }
        }

        if (nodes.length) {
            void renderer.compute(nodes);
        }

        frame.setPrevious(camera);
        this.previousCamera.copy(camera.position);
        this.hasPrevious = true;
    }

    /**
     * Around the water reflection's render: the GPU path swaps its draws for the ones culled against
     * the reflection camera (see cull()). The CPU path needs nothing: three frustum-culls its cells
     * per camera.
     */
    beginReflection(): void {
        this.setReflectionPass(true);
    }

    endReflection(): void {
        this.setReflectionPass(false);
    }

    /**
     * CPU path: merged batches span 256 m or more, and three culls them with the bounding sphere of
     * that whole square, so batches next to the camera drew even when looking at the sky. Batches
     * that cast no shadow are culled here against their (much tighter) instance box instead; shadow
     * casters stay to three, whose shadow pass culls against the light (their shadows may fall into
     * view from outside it). The water reflection sees them all again (setReflectionPass).
     */
    private cullMerged(camera: THREE.Camera): void {
        camera.updateMatrixWorld();
        _projScreen.multiplyMatrices(
            camera.projectionMatrix,
            camera.matrixWorldInverse,
        );
        _frustum.setFromProjectionMatrix(_projScreen);
        this.frustumHidden.length = 0;

        for (const renderer of this.renderers.values()) {
            for (const { mesh, batch } of renderer.merged.values()) {
                if (mesh.castShadow) {
                    continue;
                }

                mesh.visible = _frustum.intersectsBox(batch.box);

                if (!mesh.visible) {
                    this.frustumHidden.push(mesh);
                }
            }
        }
    }

    /** Merged batches hidden by cullMerged this frame. */
    private readonly frustumHidden: THREE.Mesh[] = [];

    private setReflectionPass(reflection: boolean): void {
        for (const mesh of this.frustumHidden) {
            mesh.visible = reflection;
        }

        if (!this.gpuFrame) {
            return;
        }

        for (const renderer of this.renderers.values()) {
            renderer.gpu?.setReflectionPass(reflection);
        }
    }

    /** Switches to the GPU-driven path: CPU cell meshes go, every type gets its storage buffers. */
    private enableGpu(): void {
        this.gpuFrame = new GpuCullFrame(this.globals, new HiZ());
        this.queue.length = 0;

        for (const renderer of this.renderers.values()) {
            for (const cell of [
                ...renderer.cells.values(),
                ...renderer.chunks.values(),
            ]) {
                this.removeCellMesh(cell);
                cell.queued = false;
            }

            this.clearMerged(renderer);
            renderer.shown = [];
            this.attachGpu(renderer);
        }
    }

    /** Back to CPU-culled cells: GPU draws go, every cell is rebuilt on the next evaluations. */
    private disableGpu(): void {
        for (const renderer of this.renderers.values()) {
            if (renderer.gpu) {
                this.group.remove(renderer.gpu.group);
                renderer.gpu.dispose();
                renderer.gpu = null;
            }

            renderer.gpuDirty.clear();

            for (const cell of renderer.cells.values()) {
                this.markDirty(renderer, cell);
            }
        }

        this.gpuFrame?.hiz.dispose();
        this.gpuFrame = null;
        this.hasPrevious = false;
        this.needsEval = true;
    }

    /** Creates a type's GPU renderer and queues all of its cells for upload. */
    private attachGpu(renderer: TypeRenderer): void {
        const frame = this.gpuFrame;

        if (!frame || renderer.gpu) {
            return;
        }

        const gpu = new GpuFoliageType(frame);
        gpu.setCastShadows(renderer.type.cast_shadows);
        gpu.configure(this.gpuConfig(renderer));
        renderer.gpu = gpu;
        this.group.add(gpu.group);

        for (const cell of renderer.cells.values()) {
            renderer.gpuDirty.add(cell);
        }
    }

    /** Uploads the cells edited since the last frame (only their slot ranges). */
    private syncGpu(): void {
        for (const renderer of this.renderers.values()) {
            if (!renderer.gpu || !renderer.gpuDirty.size) {
                continue;
            }

            for (const cell of renderer.gpuDirty) {
                if (renderer.cells.get(cell.key) === cell) {
                    renderer.gpu.writeCell(cell);
                } else {
                    renderer.gpu.removeCell(cell);
                }
            }

            renderer.gpuDirty.clear();
        }
    }

    /** Draw chain of a type for the GPU path (rebuilt whenever its LODs change). */
    private gpuConfig(renderer: TypeRenderer): GpuTypeConfig {
        const sphere = lodSphere(renderer.lods);

        return {
            name: renderer.type.name,
            lods: renderer.drawLods.map((geometry, lod) => ({
                geometry,
                material:
                    renderer.sourceMaterials[lod] ??
                    renderer.sourceMaterials[
                        renderer.sourceMaterials.length - 1
                    ],
            })),
            lodDistances: renderer.lodDistances,
            shadowProxy: renderer.shadowProxy
                ? {
                      start: renderer.shadowProxy.start,
                      count: renderer.shadowProxy.count,
                      main: renderer.shadowProxy.main,
                  }
                : null,
            fade: renderer.fade,
            falloff: renderer.falloff,
            stiffness: windStiffness(renderer.type.kind),
            uniforms: renderer.uniforms,
            // Split kinds switch LOD0 → LOD1 per instance (+ shadow slack as the near subset had);
            // the others switched per cell (nearest point), so their LODs reach about half a cell
            // further, and so do their LOD0 shadows.
            lodSlack: renderer.splitRoles ? 0 : renderer.cellSize * 0.5,
            shadowSlack: renderer.splitRoles
                ? LOD_SPLIT_SLACK
                : renderer.cellSize * 0.5,
            center: sphere.center,
            radius: sphere.radius,
            reflect: !SMALL_KINDS.has(renderer.type.kind),
        };
    }

    /** Renders at most one missing impostor at a time (outside the render pass). */
    private renderPendingImpostor(gl: GameRenderer): void {
        for (const renderer of this.renderers.values()) {
            const pending = renderer.pendingImpostor;

            if (!pending || renderer.disposed || renderer.capturing) {
                continue;
            }

            renderer.capturing = true;
            void renderImpostor(
                gl,
                renderer.lods[0],
                renderer.sourceMaterials[0],
            )
                .catch((error: unknown) => {
                    console.warn(
                        `Could not render an impostor for foliage type ${renderer.type.name}`,
                        error,
                    );

                    return null;
                })
                .then((built) => {
                    renderer.capturing = false;
                    renderer.pendingImpostor = null;

                    if (renderer.disposed) {
                        built?.geometry.dispose();
                        built?.material.map?.dispose();
                        built?.material.dispose();

                        return;
                    }

                    if (!built) {
                        renderer.lodInfo.warnings.push(
                            'no far LOD (impostor capture failed)',
                        );

                        return;
                    }

                    this.addImpostor(renderer, built, pending);
                });

            return;
        }
    }

    /** Appends a rendered impostor as the type's far LOD. */
    private addImpostor(
        renderer: TypeRenderer,
        built: { geometry: THREE.BufferGeometry; material: THREE.Material },
        pending: { distance: number; role: LodRole },
    ): void {
        renderer.lods[0].computeBoundingBox();
        addWindAttribute(built.geometry, renderer.lods[0].boundingBox!);
        renderer.lods = [...renderer.lods, built.geometry];
        renderer.drawLods = [...renderer.drawLods, built.geometry];
        renderer.sourceMaterials = [
            ...renderer.sourceMaterials,
            built.material,
        ];
        renderer.lodMaterials = [
            ...renderer.lodMaterials,
            this.cpuMaterial(built.material, renderer, pending.role),
        ];
        renderer.lodDistances = [...renderer.lodDistances, pending.distance];
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

        renderer.gpu?.configure(this.gpuConfig(renderer));
        // Far chunks (≥ 3 LODs) may start now; cells pick the new LOD on the next evaluation.
        this.needsEval = true;
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
            renderer.uniforms.lodSplit.value = splitsLod(renderer)
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

            this.mergeCells(renderer, stamp);
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
            if (!(chunk.mesh?.visible || chunk.merged) || near >= cull) {
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
            const split = renderer.uniforms.lodSplit.value;

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

        const view = cell.batch!.view(renderer.drawLods[lod]);

        if (lod !== cell.lod || mesh.geometry !== view) {
            mesh.geometry = view;
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
        view.instanceCount = this.drawCount(renderer, cell, cam, cull);
        mesh.visible = view.instanceCount > 0;

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
        const batch = cell.batch!;
        let nearBatch = cell.nearBatch;

        if (!cell.near || !nearBatch || nearBatch.capacity < batch.capacity) {
            this.removeNear(cell);
            nearBatch = this.acquireBatch(batch.capacity);
            const near = new THREE.Mesh(
                nearBatch.view(renderer.drawLods[0]),
                lodMaterial(renderer, 0),
            );
            this.setupMesh(renderer, near, `${cell.key}_near`);
            cell.near = near;
            cell.nearBatch = nearBatch;
            this.group.add(near);
        }

        const near = cell.near!;
        const view = nearBatch.view(renderer.drawLods[0]);

        if (near.geometry !== view) {
            near.geometry = view;
            near.material = lodMaterial(renderer, 0);
        }

        const reach = renderer.uniforms.lodSplit.value + LOD_SPLIT_SLACK;
        const reach2 = reach * reach;
        const src = batch.array;
        const dst = nearBatch.array;
        const count = instanceCountOf(cell.mesh!);
        const r = renderer.radius * Math.max(0.01, renderer.type.max_scale);
        let n = 0;
        _box.makeEmpty();

        for (let i = 0; i < count; i++) {
            const o = i * INSTANCE_FLOATS;
            const x = src[o + 3];
            const y = src[o + 7];
            const z = src[o + 11];
            const dx = x - cam.x;
            const dy = y - cam.y;
            const dz = z - cam.z;

            if (dx * dx + dy * dy + dz * dz > reach2) {
                continue;
            }

            dst.set(src.subarray(o, o + INSTANCE_FLOATS), n * INSTANCE_FLOATS);
            _box.expandByPoint(_v.set(x - r, y - r * 0.25, z - r));
            _box.expandByPoint(_v.set(x + r, y + r, z + r));
            n++;
        }

        view.instanceCount = n;
        near.visible = n > 0;
        near.castShadow = shadows;

        if (n > 0) {
            nearBatch.upload(n);
            nearBatch.setBounds(_box);
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

    /**
     * Draws sparse shown cells through merged batches: the meshes of one square (MERGE_SIZE) that draw
     * the same LOD (and LOD split role) with the same shadow flag are copied into one instance buffer
     * (the drawn prefix of each, keeping the per-cell ranks of the density fade) and hidden. Cells the
     * LOD split passes through contribute their LOD1 mesh and their LOD0 subset separately; far
     * chunks merge per 2 × 2 chunks. Batches are only rewritten when their sources, source versions
     * or drawn counts change; dense cells keep their own draws.
     */
    private mergeCells(renderer: TypeRenderer, stamp: number): void {
        const groups = new Map<
            string,
            { lod: number; cells: Cell[]; sources: THREE.Mesh[] }
        >();
        const add = (cell: Cell, mesh: THREE.Mesh | null, lod: number) => {
            if (!mesh?.visible || instanceCountOf(mesh) > MERGE_MAX_INSTANCES) {
                return;
            }

            // Far chunks pair up (their own grid: cx / cz count chunks).
            const chunk = isChunk(cell);
            const span = chunk
                ? 2
                : Math.max(
                      1,
                      Math.round(
                          (MERGE_SIZE << Math.max(0, lod - 1)) /
                              renderer.cellSize,
                      ),
                  );

            // The LOD0 subsets draw with the 'near' role, whole cells at LOD0 too.
            const key = `${chunk ? 'c' : ''}${Math.floor(cell.cx / span)},${Math.floor(cell.cz / span)}:${lod}:${mesh.castShadow ? 1 : 0}`;
            let group = groups.get(key);

            if (!group) {
                group = { lod, cells: [], sources: [] };
                groups.set(key, group);
            }

            group.cells.push(cell);
            group.sources.push(mesh);
        };

        for (const cell of renderer.shown) {
            cell.merged = false;

            add(cell, cell.mesh, cell.lod);
            add(cell, cell.near, 0);
        }

        for (const [key, { lod, cells, sources }] of groups) {
            if (sources.length < 2) {
                continue;
            }

            let total = 0;
            let signature = '';

            for (const source of sources) {
                const n = instanceCountOf(source);
                const batch = batchOf(source);
                total += n;
                signature += `${batch.id}.${batch.version}:${n};`;
            }

            let merged = renderer.merged.get(key);

            // Reallocated when full or far too large (the headroom avoids churn while counts vary).
            if (
                !merged ||
                total > merged.batch.capacity ||
                merged.batch.capacity > (total + 8) * 4
            ) {
                this.removeMerged(renderer, key);
                const batch = this.acquireBatch(total);
                const mesh = new THREE.Mesh(
                    batch.view(renderer.drawLods[lod]),
                    lodMaterial(renderer, lod),
                );
                this.setupMesh(renderer, mesh, `merged:${key}`);
                this.group.add(mesh);
                merged = { mesh, batch, signature: '', lod, stamp };
                renderer.merged.set(key, merged);
            }

            const { mesh, batch } = merged;

            if (merged.signature !== signature) {
                merged.signature = signature;
                _box.makeEmpty();
                let offset = 0;

                for (const source of sources) {
                    const from = batchOf(source);
                    const n = instanceCountOf(source) * INSTANCE_FLOATS;
                    batch.array.set(from.array.subarray(0, n), offset);
                    offset += n;
                    _box.union(from.box);
                }

                batch.upload(total);
                batch.setBounds(_box);
            }

            const view = batch.view(renderer.drawLods[lod]);
            mesh.geometry = view;
            mesh.material = lodMaterial(renderer, lod);
            mesh.castShadow = sources[0].castShadow;
            merged.lod = lod;
            view.instanceCount = total;
            mesh.visible = true;
            merged.stamp = stamp;

            for (const source of sources) {
                source.visible = false;
            }

            for (const cell of cells) {
                cell.merged = true;
            }
        }

        for (const [key, merged] of renderer.merged) {
            if (merged.stamp !== stamp) {
                this.removeMerged(renderer, key);
            }
        }
    }

    private removeMerged(renderer: TypeRenderer, key: string): void {
        const merged = renderer.merged.get(key);

        if (merged) {
            this.group.remove(merged.mesh);
            this.releaseBatch(merged.batch);
            renderer.merged.delete(key);
        }
    }

    /** Drops every merged batch of a type (its cells show again on the next evaluation). */
    private clearMerged(renderer: TypeRenderer): void {
        for (const key of renderer.merged.keys()) {
            this.removeMerged(renderer, key);
        }

        for (const cell of renderer.cells.values()) {
            cell.merged = false;
        }
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

            // Its merged copy keeps drawing the old instances until the next evaluation re-merges.
            if (cell.merged) {
                hideCell(cell);
                this.needsEval = true;

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
        this.gpuFrame?.hiz.dispose();

        for (const batch of this.batchPool) {
            batch.dispose();
        }

        this.batchPool.length = 0;
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
            batch: null,
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
            nearBatch: null,
            merged: false,
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

        if (renderer.gpu) {
            renderer.gpuDirty.add(cell);

            return;
        }

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
     * Writes the cell's instances into its instance batch, reusing the existing buffers when they
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

        let batch = cell.batch;

        if (
            !cell.mesh ||
            !batch ||
            count > batch.capacity ||
            count < batch.capacity / 4
        ) {
            this.removeCellMesh(cell);
            batch = this.acquireBatch(count);
            const lod = Math.min(cell.lod, renderer.drawLods.length - 1);
            const mesh = new THREE.Mesh(
                batch.view(renderer.drawLods[lod]),
                lodMaterial(renderer, lod),
            );
            this.setupMesh(renderer, mesh, cell.key);
            cell.lod = lod;
            cell.batch = batch;
            cell.mesh = mesh;
            this.group.add(mesh);
        }

        const array = batch.array;
        const d = cell.data;
        const r = renderer.radius;
        let minX = Infinity;
        let minY = Infinity;
        let minZ = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        let maxZ = -Infinity;

        for (let i = 0; i < count; i++) {
            // Rank of the instance within the cell (0..1): drives the density fade.
            const scale = writeInstance(
                d,
                i,
                array,
                i * INSTANCE_FLOATS,
                (i + 0.5) / count,
            );
            const o = i * FOLIAGE_STRIDE;
            const x = d[o];
            const y = d[o + 1];
            const z = d[o + 2];
            const e = r * scale;
            minX = Math.min(minX, x - e);
            maxX = Math.max(maxX, x + e);
            minZ = Math.min(minZ, z - e);
            maxZ = Math.max(maxZ, z + e);
            minY = Math.min(minY, y - e * 0.25);
            maxY = Math.max(maxY, y + e);
        }

        batch.upload(count);
        cell.built = count;
        (cell.mesh!.geometry as THREE.InstancedBufferGeometry).instanceCount =
            count;
        cell.bounds.min.set(minX, minY, minZ);
        cell.bounds.max.set(maxX, maxY, maxZ);
        batch.setBounds(cell.bounds);
    }

    /** Shared setup of cell / chunk / near-subset meshes. */
    private setupMesh(
        renderer: TypeRenderer,
        mesh: THREE.Mesh,
        key: string,
    ): void {
        mesh.receiveShadow = true;
        mesh.frustumCulled = true;
        mesh.matrixAutoUpdate = false;
        // The reflection pass hides small foliage by this prefix (see Game.renderReflection).
        mesh.name = `Foliage_${renderer.type.name}_${key}`;
        mesh.onBeforeRender = (gl, scene) => {
            this.gl ??= gl as unknown as GameRenderer;
            const proxy = renderer.shadowProxy;
            const geometry = mesh.geometry;

            // The shadow pass of LOD0 draws the cheap proxy range appended to it.
            if (proxy && geometry.index === proxy.geometry.index) {
                const shadow = (
                    scene.overrideMaterial as {
                        isShadowPassMaterial?: boolean;
                    } | null
                )?.isShadowPassMaterial;
                geometry.setDrawRange(
                    shadow ? proxy.start : 0,
                    shadow ? proxy.count : proxy.main,
                );
            }
        };
    }

    /**
     * An instance batch with room for `count` instances: the smallest released one that fits, or a
     * new one with headroom (painting grows cells a few instances at a time). Batches are recycled
     * rather than disposed while the world lives: disposing a batch's views makes three drop the LOD
     * vertex / index buffers they share with every other cell, and its WebGL backend keeps drawing
     * those cells through vertex array objects that still point at the deleted buffers.
     */
    private acquireBatch(count: number): InstanceBatch {
        const pool = this.batchPool;
        let best = -1;

        for (let i = 0; i < pool.length; i++) {
            const capacity = pool[i].capacity;

            if (
                capacity >= count &&
                (best < 0 || capacity < pool[best].capacity)
            ) {
                best = i;
            }
        }

        if (best < 0) {
            return new InstanceBatch(count + Math.ceil(count * 0.25) + 8);
        }

        const batch = pool[best];
        pool[best] = pool[pool.length - 1];
        pool.pop();

        return batch;
    }

    private releaseBatch(batch: InstanceBatch | null): void {
        if (batch) {
            this.batchPool.push(batch);
        }
    }

    /** Drops every batch's views of LOD geometries that are being disposed. */
    private forgetGeometries(geometries: Iterable<THREE.BufferGeometry>): void {
        const list = [...geometries];
        const batches = new Set(this.batchPool);

        for (const renderer of this.renderers.values()) {
            for (const cell of [
                ...renderer.cells.values(),
                ...renderer.chunks.values(),
            ]) {
                if (cell.batch) {
                    batches.add(cell.batch);
                }

                if (cell.nearBatch) {
                    batches.add(cell.nearBatch);
                }
            }

            for (const merged of renderer.merged.values()) {
                batches.add(merged.batch);
            }
        }

        for (const batch of batches) {
            batch.forget(list);
        }
    }

    private removeNear(cell: Cell): void {
        if (cell.near) {
            this.group.remove(cell.near);
            cell.near = null;
        }

        this.releaseBatch(cell.nearBatch);
        cell.nearBatch = null;
    }

    private removeCellMesh(cell: Cell): void {
        this.removeNear(cell);

        if (cell.mesh) {
            this.group.remove(cell.mesh);
            cell.mesh = null;
            cell.built = 0;
        }

        this.releaseBatch(cell.batch);
        cell.batch = null;
    }

    private createRenderer(type: FoliageType): TypeRenderer {
        const set = createFoliageGeometry(
            type.kind,
            new THREE.Color(type.color),
            new THREE.Color(type.color_secondary),
            type.id * 7919,
        );
        const material = new THREE.MeshStandardNodeMaterial({
            vertexColors: true,
            roughness: type.kind === 'rock' ? 0.85 : 0.75,
            metalness: 0,
            side: set.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
        });
        const falloff = DENSITY_FALLOFF[type.kind] ?? null;
        // Kinds without the density fade (trees, rocks) switch LOD0 → LOD1 per instance.
        const splitRoles = falloff === null && set.lods.length >= 2;
        const renderer: TypeRenderer = {
            type,
            cellSize: CELL_SIZES[type.kind] ?? 64,
            lods: set.lods,
            drawLods: set.lods,
            shadowProxy: null,
            lodDistances: set.lodDistances,
            sourceMaterials: set.lods.map(() => material),
            lodMaterials: [],
            model: false,
            disposed: false,
            cells: new Map(),
            grid: new Map(),
            chunks: new Map(),
            extent: new THREE.Box3(),
            shown: [],
            merged: new Map(),
            fade: falloff !== null,
            falloff,
            radius: geometryRadius(set.lods),
            uniforms: {
                fadeEnd: uniform(type.cull_distance),
                falloff: uniform(
                    new THREE.Vector2(falloff?.start ?? 1, falloff?.min ?? 1),
                ),
                lodSplit: uniform(NO_SPLIT),
            },
            gpu: null,
            gpuDirty: new Set(),
            lodInfo: {
                source: type.model_url ? 'loading' : 'procedural',
                generated: [],
                warnings: [],
            },
            splitRoles,
            pendingImpostor: null,
            capturing: false,
            cover: null,
        };
        const none = this.cpuMaterial(material, renderer, 'none');
        const near = splitRoles
            ? this.cpuMaterial(material, renderer, 'near')
            : none;
        const far = splitRoles
            ? this.cpuMaterial(material, renderer, 'far')
            : none;
        renderer.lodMaterials = set.lods.map((_g, lod) =>
            lod === 0 ? near : lod === 1 ? far : none,
        );

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

        this.attachGpu(renderer);

        if (type.model_url) {
            void this.loadModel(renderer, type.model_url);
        }

        return renderer;
    }

    /**
     * CPU-path node material (per-cell instance attributes) with wind sway, distance fade, density
     * falloff and the given side of the per-instance LOD split.
     */
    private cpuMaterial(
        source: THREE.Material,
        renderer: TypeRenderer,
        role: LodRole,
    ): THREE.Material {
        return createFoliageMaterial(source, {
            globals: this.globals,
            uniforms: renderer.uniforms,
            stiffness: windStiffness(renderer.type.kind),
            fade: renderer.fade,
            role,
            instance: attributeInstance,
        });
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

            // LOD0 / LOD1 get their own near / far node materials for the per-instance split (the
            // density fade kinds keep cell-granular LODs).
            const chainLength =
                lods.length + (completed.impostorDistance !== null ? 1 : 0);
            const splitRoles = !renderer.fade && chainLength >= 2;
            const roleOf = (lod: number): LodRole =>
                !splitRoles
                    ? 'none'
                    : lod === 0
                      ? 'near'
                      : lod === 1
                        ? 'far'
                        : 'none';
            const cpuMaterials = new Map<string, THREE.Material>();
            const withRole = (m: THREE.Material, role: LodRole) => {
                const key = `${m.uuid}:${role}`;
                let material = cpuMaterials.get(key);

                if (!material) {
                    material = this.cpuMaterial(m, renderer, role);
                    cpuMaterials.set(key, material);
                }

                return material;
            };
            const previous = {
                lods: renderer.lods,
                proxy: renderer.shadowProxy?.geometry ?? null,
                materials: [
                    ...renderer.lodMaterials.flat(),
                    ...renderer.sourceMaterials.flat(),
                ],
            };
            renderer.lods = lods;
            renderer.drawLods = lods;
            renderer.shadowProxy = null;
            renderer.radius = geometryRadius(lods);
            renderer.sourceMaterials = lodMaterials;
            renderer.lodMaterials = lodMaterials.map((m, lod) =>
                Array.isArray(m)
                    ? m.map((x) => withRole(x, roleOf(lod)))
                    : withRole(m, roleOf(lod)),
            );
            renderer.lodDistances = completed.distances;
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

                if (cell.mesh && cell.batch) {
                    cell.lod = Math.min(cell.lod, lods.length - 1);
                    cell.mesh.geometry = cell.batch.view(lods[cell.lod]);
                    cell.mesh.material = lodMaterial(renderer, cell.lod);
                }

                this.markDirty(renderer, cell);
            }

            for (const chunk of renderer.chunks.values()) {
                this.removeCellMesh(chunk);
                chunk.dirty = true;
            }

            this.clearMerged(renderer);
            renderer.gpu?.configure(this.gpuConfig(renderer));

            const disposed = new Set(previous.lods);

            if (previous.proxy) {
                disposed.add(previous.proxy);
            }

            this.forgetGeometries(disposed);

            for (const g of disposed) {
                g.dispose();
            }

            for (const m of new Set(previous.materials)) {
                m.dispose();
            }

            const used = new Set(lodMaterials.flat());

            // Originals dropped from the LOD chain while completing it (textures stay shared).
            for (const m of originals) {
                if (!used.has(m)) {
                    m.dispose();
                }
            }
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

        this.clearMerged(renderer);
        const disposed = new Set([...renderer.lods, ...renderer.drawLods]);
        this.forgetGeometries(disposed);

        for (const g of disposed) {
            g.dispose();
        }

        renderer.shown = [];

        if (renderer.gpu) {
            this.group.remove(renderer.gpu.group);
            renderer.gpu.dispose();
            renderer.gpu = null;
        }

        for (const m of new Set(renderer.lodMaterials.flat())) {
            m.dispose();
        }

        for (const m of new Set(renderer.sourceMaterials.flat())) {
            if (renderer.model) {
                disposeMaterialTextures(m);
            }

            m.dispose();
        }
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

/** Renderer key of a type's ground cover (type ids are positive). */
function coverKey(typeId: number): number {
    return -typeId - 1;
}

/** Horizontal distance from a point to a cell's square. */
function rectDistance(
    p: THREE.Vector3,
    cx: number,
    cz: number,
    size: number,
): number {
    const dx = Math.max(cx * size - p.x, 0, p.x - (cx + 1) * size);
    const dz = Math.max(cz * size - p.z, 0, p.z - (cz + 1) * size);

    return Math.hypot(dx, dz);
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

/** Instance batch behind a cell / near mesh (its geometry is a view of it). */
function batchOf(mesh: THREE.Mesh): InstanceBatch {
    return (mesh.geometry as InstanceView).batch;
}

/** Instances a cell / near mesh draws (its instanced geometry view). */
function instanceCountOf(mesh: THREE.Mesh): number {
    return (mesh.geometry as THREE.InstancedBufferGeometry).instanceCount;
}

/** Bounding sphere around every LOD (instance space, scale 1): the GPU culling bound. */
function lodSphere(lods: THREE.BufferGeometry[]): THREE.Sphere {
    for (const geometry of lods) {
        if (!geometry.boundingSphere) {
            geometry.computeBoundingSphere();
        }
    }

    const center = lods[0].boundingSphere!.center.clone();
    let radius = 0.5;

    for (const geometry of lods) {
        const sphere = geometry.boundingSphere!;
        radius = Math.max(
            radius,
            center.distanceTo(sphere.center) + sphere.radius,
        );
    }

    return new THREE.Sphere(center, radius);
}

const _normal = new THREE.Vector3();
const _v = new THREE.Vector3();
const _box = new THREE.Box3();
const _frustum = new THREE.Frustum();
const _projScreen = new THREE.Matrix4();
