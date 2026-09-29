import * as THREE from 'three/webgpu';
import {
    atomicAdd,
    atomicLoad,
    atomicStore,
    dot,
    Fn,
    If,
    instancedArray,
    instanceIndex,
    length,
    Return,
    smoothstep,
    storage,
    uint,
    uniform,
    uniformArray,
    vec3,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { GameRenderer } from '../../core/renderer';
import { FOLIAGE_STRIDE } from '../../shared/types';
import type {
    FoliageGlobals,
    FoliageTypeUniforms,
    InstanceSource,
} from './FoliageMaterial';
import { createFoliageMaterial, RANK_FADE } from './FoliageMaterial';
import type { HiZ } from './HiZ';
import { occludedNode } from './HiZ';
import { INSTANCE_FLOATS, writeInstance } from './instances';

type Storage<T extends string> = THREE.StorageBufferNode<T>;

/** Smallest instance capacity of a type (slots); grows ×1.5 when full. */
const MIN_CAPACITY = 1024;
/** Extra slots reserved per cell so painting doesn't move the cell on every dab. */
const CELL_HEADROOM = 0.25;
/** Wind sway / lean reach added to every bounding sphere (m). */
const SWAY_MARGIN = 0.6;
/** Stats read-back interval (s). */
const STATS_INTERVAL = 0.5;
/**
 * LOD switch distances of the water reflection relative to the main view: the rippled, reduced
 * resolution reflection takes coarser LODs much sooner.
 */
const REFLECTION_LOD_SCALE = 0.5;

/** Per-frame inputs shared by every type's culling pass (one set per Foliage). */
export class GpuCullFrame {
    readonly planes = uniformArray<'vec4'>(
        Array.from({ length: 6 }, () => new THREE.Vector4()),
        'vec4',
    );
    readonly prevView = uniform(new THREE.Matrix4());
    readonly prevProj = uniform(new THREE.Matrix4());
    readonly near = uniform(0.1);
    /** 1 while the Hi-Z pyramid is valid for this frame. */
    readonly occlusion = uniform(0);
    /** Extra sphere radius for the occlusion test (camera movement since the depth was rendered). */
    readonly occlusionMargin = uniform(0);
    readonly lodBias = uniform(1);
    readonly shadowDistance = uniform(120);
    /** 1 while the water reflection renders this frame (its visibility lists are filled). */
    readonly reflect = uniform(0);
    /** Frustum planes of the mirrored reflection camera (its oblique near plane is the water). */
    readonly reflectPlanes = uniformArray<'vec4'>(
        Array.from({ length: 6 }, () => new THREE.Vector4()),
        'vec4',
    );
    readonly reflectCamPos = uniform(new THREE.Vector3());
    private readonly frustum = new THREE.Frustum();
    private readonly projScreen = new THREE.Matrix4();

    constructor(
        readonly globals: FoliageGlobals,
        readonly hiz: HiZ,
    ) {}

    setCamera(camera: THREE.Camera): void {
        this.setPlanes(camera, this.planes);
    }

    /** The water reflection's camera of this frame (null: no reflection rendered this frame). */
    setReflection(camera: THREE.Camera | null): void {
        this.reflect.value = camera ? 1 : 0;

        if (camera) {
            camera.updateMatrixWorld();
            this.setPlanes(camera, this.reflectPlanes);
            this.reflectCamPos.value.setFromMatrixPosition(camera.matrixWorld);
        }
    }

    private setPlanes(
        camera: THREE.Camera,
        planes: THREE.UniformArrayNode<'vec4'>,
    ): void {
        this.projScreen.multiplyMatrices(
            camera.projectionMatrix,
            camera.matrixWorldInverse,
        );
        this.frustum.setFromProjectionMatrix(
            this.projScreen,
            camera.coordinateSystem,
            camera.reversedDepth,
        );
        const values = planes.array as THREE.Vector4[];
        this.frustum.planes.forEach((plane, i) =>
            values[i].set(
                plane.normal.x,
                plane.normal.y,
                plane.normal.z,
                plane.constant,
            ),
        );
    }

    /** Remembers the camera the depth pyramid of the next frame is rendered with. */
    setPrevious(camera: THREE.Camera): void {
        this.prevView.value.copy(camera.matrixWorldInverse);
        this.prevProj.value.copy(camera.projectionMatrix);
        this.near.value = (camera as THREE.PerspectiveCamera).near ?? 0.1;
    }
}

/** One LOD (or one material group of it) of a type's draw chain. */
export type GpuLod = {
    geometry: THREE.BufferGeometry;
    material: THREE.Material | THREE.Material[];
};

export type GpuTypeConfig = {
    name: string;
    lods: GpuLod[];
    /** LOD switch distances as fractions of the cull distance (LOD0 first, 0). */
    lodDistances: number[];
    /** LOD0 geometry with a cheap shadow copy appended: the shadow pass draws that range. */
    shadowProxy: { start: number; count: number; main: number } | null;
    fade: boolean;
    falloff: { start: number; min: number } | null;
    stiffness: number;
    uniforms: FoliageTypeUniforms;
    /**
     * Distance (m) added to every LOD switch: kinds whose LODs used to switch per cell keep their
     * detail about as far as before (the nearest point of a cell decided).
     */
    lodSlack: number;
    /** Distance (m) past the LOD1 switch within which instances still cast (LOD0) shadows. */
    shadowSlack: number;
    /** Bounding sphere of every LOD in instance space (scale 1). */
    center: THREE.Vector3;
    radius: number;
    /** Drawn in the water reflection (small foliage is not). */
    reflect: boolean;
};

type Draw = {
    mesh: THREE.Mesh;
    lod: number;
    /** Triangles per instance in the main pass (all material groups). */
    triangles: number;
    /** Indirect draws per pass (one per material group). */
    calls: number;
};

type Range = {
    start: number;
    capacity: number;
    count: number;
    /** Filled on the GPU (see GpuFiller); `count` is read back. */
    filled: boolean;
};

/**
 * Cells as the GPU store sees them: a flat instance list (x, y, z, yaw, scale, tiltX, tiltZ), and
 * their grid position (tiles the GPU fills).
 */
export type GpuCell = { data: number[]; cx: number; cz: number };

/** A slot range a GpuFiller writes; `cell` null clears it (every slot dead). */
export type GpuFill = { cell: GpuCell | null; start: number; length: number };

/**
 * Fills slot ranges of a type's store on the GPU (ground cover tiles, see GroundCoverGpu): one
 * compute pass per frame, run before the culling pass, writes every slot of the queued ranges (live
 * or dead) and counts the live instances of each range.
 */
export interface GpuFiller {
    /** Ranges / slots one pass handles at most (the rest waits for the next frame). */
    readonly maxFills: number;
    readonly maxSlots: number;
    /** The pass writing `fills` into `instances`. */
    pass(instances: Storage<'vec4'>, fills: GpuFill[]): THREE.ComputeNode;
    /** Live instances per fill of the last pass (read back asynchronously). */
    readCounts(renderer: GameRenderer): Promise<Uint32Array>;
    dispose(): void;
}

export type GpuTypeStats = {
    lodInstances: number[];
    shadowInstances: number;
    /** Instances drawn in the water reflection (all LODs). */
    reflectionInstances: number;
    occluded: number;
};

/**
 * GPU-driven rendering of one foliage type (WebGPU): every instance lives in a storage buffer; each
 * frame a compute pass tests all of them (distance, density, frustum, Hi-Z occlusion), picks the LOD
 * and appends the survivors to per-LOD visibility lists, and a one-thread pass writes the instance
 * counts into `drawIndexedIndirect` arguments. Each LOD (per material group) is then ONE indirect
 * draw whose vertex shader fetches the transform through the visibility list. Shadows use a separate
 * list (LOD0 instances within the shadow distance, not frustum / occlusion culled): LOD0 meshes switch
 * their indirect arguments and instance source in the shadow pass. The water reflection gets lists of
 * its own from the same pass (mirrored camera frustum, coarser LODs, no occlusion), drawn by separate
 * meshes that are only visible while the reflection renders (see setReflectionPass).
 *
 * Instances are stored per cell in contiguous slot ranges (with headroom), so editing a cell only
 * rewrites its range; freed slots are marked dead and skipped by the culling pass.
 */
export class GpuFoliageType {
    readonly group = new THREE.Group();
    private capacity = 0;
    private top = 0;
    private readonly ranges = new Map<GpuCell, Range>();
    private instances: Storage<'vec4'> | null = null;
    private visible: Storage<'uint'> | null = null;
    private counters: Storage<'uint'> | null = null;
    private stats: Storage<'uint'> | null = null;
    private args: THREE.IndirectStorageBufferAttribute | null = null;
    private readonly capacityNode = uniform(0, 'uint');
    private readonly castShadows = uniform(1);
    private draws: Draw[] = [];
    /** Draws of the water reflection pass (hidden otherwise). */
    private reflectionDraws: THREE.Mesh[] = [];
    /** Visibility lists: one per LOD, the shadow casters, then one per reflection LOD. */
    private regions = 0;
    private materials: THREE.Material[] = [];
    private computes: THREE.ComputeNode[] = [];
    private config: GpuTypeConfig | null = null;
    /** Indirect argument entries: visibility region + index range of each draw (shadow ones too). */
    private entries: { region: number; count: number; first: number }[] = [];
    private hizVersion = -1;
    private statsTimer = 0;
    private reading = false;
    private dirty = false;
    private live = 0;
    /** Fills ranges on the GPU instead of uploading cell data (ground cover). */
    private filler: GpuFiller | null = null;
    /** Cells whose ranges the next fill pass writes, and freed filled ranges it clears. */
    private readonly pendingFills = new Set<GpuCell>();
    private pendingClears: GpuFill[] = [];
    /** Filled ranges of this frame's fill pass (their counts are read back after it ran). */
    private passFills: { cell: GpuCell; range: Range; fill: number }[] = [];
    /** Last read-back counters (null until the first result). */
    lastStats: GpuTypeStats | null = null;

    constructor(private readonly frame: GpuCullFrame) {
        this.group.matrixAutoUpdate = false;
    }

    get instanceCount(): number {
        return this.live;
    }

    /** Instances of a cell (GPU-filled cells: as last read back). */
    cellCount(cell: GpuCell): number {
        return this.ranges.get(cell)?.count ?? 0;
    }

    /** Cells of this type are filled on the GPU by `filler` (ground cover); null: uploaded. */
    setFiller(filler: GpuFiller | null): void {
        if (filler !== this.filler) {
            this.filler?.dispose();
            this.filler = filler;
        }
    }

    /**
     * Queues a GPU fill of a cell's range, sized for `capacity` instances (0: the cell is empty). The
     * cell keeps its range and old instances until the fill pass rewrites them, so nothing flickers.
     */
    fillCell(cell: GpuCell, capacity: number): void {
        let range = this.ranges.get(cell);

        if (range && (!capacity || capacity > range.capacity)) {
            this.freeRange(range);
            this.ranges.delete(cell);
            range = undefined;
        }

        if (!capacity) {
            this.pendingFills.delete(cell);

            return;
        }

        if (!range) {
            if (this.top + capacity > this.capacity) {
                // Full: repack into a larger store (every filled range is filled again).
                this.ranges.set(cell, {
                    start: 0,
                    capacity,
                    count: 0,
                    filled: true,
                });
                this.repack(capacity);

                return;
            }

            range = { start: this.top, capacity, count: 0, filled: true };
            this.top += capacity;
            this.ranges.set(cell, range);
        }

        this.pendingFills.add(cell);
    }

    /** Indirect draws of the main pass. */
    get drawCalls(): number {
        return this.draws.reduce((sum, draw) => sum + draw.calls, 0);
    }

    /** Main-pass triangles per instance of every LOD (all material groups). */
    lodTriangles(): number[] {
        const tris: number[] = [];

        for (const draw of this.draws) {
            tris[draw.lod] = (tris[draw.lod] ?? 0) + draw.triangles;
        }

        return tris;
    }

    /** (Re)builds draws, materials and compute passes for a new LOD chain; instances are kept. */
    configure(config: GpuTypeConfig): void {
        this.config = config;
        this.rebuild();
    }

    /** Swaps the main draws for the reflection draws while the water reflection renders. */
    setReflectionPass(reflection: boolean): void {
        for (const draw of this.draws) {
            draw.mesh.visible = !reflection;
        }

        for (const mesh of this.reflectionDraws) {
            mesh.visible = reflection;
        }
    }

    setCastShadows(cast: boolean): void {
        this.castShadows.value = cast ? 1 : 0;

        for (const draw of this.draws) {
            draw.mesh.castShadow = cast && draw.lod === 0;
        }
    }

    /** Writes (or rewrites) a cell's instances. */
    writeCell(cell: GpuCell): void {
        const count = cell.data.length / FOLIAGE_STRIDE;
        let range = this.ranges.get(cell);

        if (range && count > range.capacity) {
            this.freeRange(range);
            this.ranges.delete(cell);
            range = undefined;
        }

        if (!count) {
            if (range) {
                this.freeRange(range);
                this.ranges.delete(cell);
            }

            return;
        }

        if (!range) {
            const capacity = count + Math.ceil(count * CELL_HEADROOM) + 4;

            if (this.top + capacity > this.capacity) {
                // Full: repack every cell into a larger store (rebuilds the GPU buffers).
                this.ranges.set(cell, {
                    start: 0,
                    capacity: 0,
                    count: 0,
                    filled: false,
                });
                this.repack(capacity);

                return;
            }

            range = { start: this.top, capacity, count: 0, filled: false };
            this.top += capacity;
            this.ranges.set(cell, range);
        }

        this.fillRange(range, cell);
    }

    removeCell(cell: GpuCell): void {
        const range = this.ranges.get(cell);

        if (range) {
            this.freeRange(range);
            this.ranges.delete(cell);
        }

        this.pendingFills.delete(cell);
    }

    /** Drops every instance (keeps the buffers). */
    clear(): void {
        let filled = false;

        for (const range of this.ranges.values()) {
            filled ||= range.filled;
            this.freeRange(range);
        }

        this.ranges.clear();
        this.pendingFills.clear();

        // Filled ranges are only cleared by the next fill pass, which must not fill their slots
        // again in the same dispatch: new ranges go above them (a repack reclaims the space).
        if (!filled) {
            this.top = 0;
        }
    }

    /** Compute passes of this frame (culling + indirect arguments); uploads pending edits first. */
    computeNodes(): THREE.ComputeNode[] {
        if (!this.config || !this.instances) {
            return [];
        }

        if (this.frame.hiz.version !== this.hizVersion) {
            // The pyramid buffers were reallocated: the culling pass binds the new ones.
            this.buildComputes();
        }

        if (this.dirty) {
            this.dirty = false;
            (this.instances.value as THREE.BufferAttribute).needsUpdate = true;
        }

        const fill = this.fillPass();

        return fill ? [fill, ...this.computes] : this.computes;
    }

    /**
     * Reads the counters back every STATS_INTERVAL seconds, and the instance counts of this frame's
     * fill pass (asynchronously). Call after the frame's compute passes were submitted.
     */
    updateStats(renderer: GameRenderer, dt: number): void {
        if (this.passFills.length && this.filler) {
            const fills = this.passFills;
            this.passFills = [];
            this.filler
                .readCounts(renderer)
                .then((counts) =>
                    fills.forEach(({ cell, range, fill }) => {
                        // Ranges freed or refilled since are skipped (a later read-back counts them).
                        if (this.ranges.get(cell) === range) {
                            this.live += counts[fill] - range.count;
                            range.count = counts[fill];
                        }
                    }),
                )
                .catch(() => undefined);
        }

        this.statsTimer -= dt;

        if (this.statsTimer > 0 || this.reading || !this.stats) {
            return;
        }

        this.statsTimer = STATS_INTERVAL;
        this.reading = true;
        const lods = this.config?.lods.length ?? 0;
        const regions = this.regions;
        const attribute = this.stats.value as THREE.StorageBufferAttribute;
        renderer
            .getArrayBufferAsync(attribute)
            .then((buffer) => {
                const counts = new Uint32Array(buffer as ArrayBuffer);
                this.lastStats = {
                    lodInstances: Array.from(counts.slice(0, lods)),
                    shadowInstances: counts[lods] ?? 0,
                    reflectionInstances: counts
                        .slice(lods + 1, regions)
                        .reduce((sum, n) => sum + n, 0),
                    occluded: counts[regions] ?? 0,
                };
            })
            .catch(() => {
                this.lastStats = null;
            })
            .finally(() => {
                this.reading = false;
            });
    }

    dispose(): void {
        this.disposeDraws();

        for (const node of this.computes) {
            node.dispose();
        }

        this.computes = [];
        this.instances = null;
        this.visible = null;
        this.counters = null;
        this.stats = null;
        this.args = null;
        this.ranges.clear();
        this.pendingFills.clear();
        this.pendingClears = [];
        this.passFills = [];
        this.setFiller(null);
    }

    /** This frame's fill pass: queued clears first, then fills, within the filler's limits. */
    private fillPass(): THREE.ComputeNode | null {
        const filler = this.filler;

        if (
            !filler ||
            !this.instances ||
            (!this.pendingFills.size && !this.pendingClears.length)
        ) {
            return null;
        }

        const fills: GpuFill[] = [];
        let slots = 0;
        const fits = (length: number) =>
            fills.length < filler.maxFills &&
            (!fills.length || slots + length <= filler.maxSlots);

        while (
            this.pendingClears.length &&
            fits(this.pendingClears[0].length)
        ) {
            const clear = this.pendingClears.shift()!;
            fills.push(clear);
            slots += clear.length;
        }

        for (const cell of this.pendingFills) {
            const range = this.ranges.get(cell)!;

            if (!fits(range.capacity)) {
                break;
            }

            this.pendingFills.delete(cell);
            this.passFills.push({ cell, range, fill: fills.length });
            fills.push({ cell, start: range.start, length: range.capacity });
            slots += range.capacity;
        }

        return fills.length ? filler.pass(this.instances, fills) : null;
    }

    private freeRange(range: Range): void {
        if (!this.instances) {
            return;
        }

        if (range.filled) {
            this.pendingClears.push({
                cell: null,
                start: range.start,
                length: range.capacity,
            });
            this.live -= range.count;
            range.count = 0;

            return;
        }

        const array = (this.instances.value as THREE.BufferAttribute)
            .array as Float32Array;

        for (let i = 0; i < range.count; i++) {
            // data.z = 0: dead slot.
            array[(range.start + i) * INSTANCE_FLOATS + 14] = 0;
        }

        this.live -= range.count;
        this.markRange(range.start, range.count);
        range.count = 0;
    }

    private fillRange(range: Range, cell: GpuCell): void {
        const array = (this.instances!.value as THREE.BufferAttribute)
            .array as Float32Array;
        const count = cell.data.length / FOLIAGE_STRIDE;

        for (let i = 0; i < count; i++) {
            // Rank within the cell (instances are shuffled): drives density scaling and its fade.
            writeInstance(
                cell.data,
                i,
                array,
                (range.start + i) * INSTANCE_FLOATS,
                (i + 0.5) / count,
            );
        }

        for (let i = count; i < range.count; i++) {
            array[(range.start + i) * INSTANCE_FLOATS + 14] = 0;
        }

        this.live += count - range.count;
        this.markRange(range.start, Math.max(count, range.count));
        range.count = count;
    }

    private markRange(start: number, count: number): void {
        if (!count || !this.instances) {
            return;
        }

        const attribute = this.instances.value as THREE.BufferAttribute;
        attribute.addUpdateRange(
            start * INSTANCE_FLOATS,
            count * INSTANCE_FLOATS,
        );
        this.dirty = true;
    }

    /** Moves every cell into a fresh store with room for `extra` more slots. */
    private repack(extra: number): void {
        let needed = extra;

        for (const [cell, range] of this.ranges) {
            if (!range.filled) {
                const count = cell.data.length / FOLIAGE_STRIDE;
                range.capacity = count + Math.ceil(count * CELL_HEADROOM) + 4;
            }

            needed += range.capacity;
        }

        this.allocate(
            Math.max(MIN_CAPACITY, this.capacity, Math.ceil(needed * 1.5)),
        );
        this.top = 0;
        this.live = 0;
        // The new store starts dead: nothing to clear, every filled range is filled again.
        this.pendingClears = [];
        this.passFills = [];

        for (const [cell, range] of this.ranges) {
            range.start = this.top;
            range.count = 0;
            this.top += range.capacity;

            if (range.filled) {
                this.pendingFills.add(cell);
            } else {
                this.fillRange(range, cell);
            }
        }
    }

    /** New (empty) storage for `capacity` instances; draws and compute passes are rebuilt. */
    private allocate(capacity: number): void {
        this.capacity = capacity;
        this.capacityNode.value = capacity;
        this.instances = instancedArray(capacity * 4, 'vec4');
        this.rebuild();
    }

    private rebuild(): void {
        const config = this.config;

        if (!config) {
            return;
        }

        if (!this.instances) {
            this.allocate(MIN_CAPACITY);

            return;
        }

        this.disposeDraws();
        const lodCount = config.lods.length;
        // Regions of the visibility list: one per LOD, the shadow casters, one per reflection LOD.
        const regions = lodCount + 1 + (config.reflect ? lodCount : 0);
        this.regions = regions;
        this.visible = instancedArray(this.capacity * regions, 'uint');
        // Counters: one per region, then the occlusion-culled instances.
        this.counters = instancedArray(regions + 1, 'uint').toAtomic();
        this.stats = instancedArray(regions + 1, 'uint');
        const entries: {
            region: number;
            count: number;
            first: number;
        }[] = [];
        const visible = this.visible;
        const instances = this.instances;
        const capacity = this.capacityNode;
        const source =
            (region: number): InstanceSource =>
            () => {
                const index = visible.element(
                    uint(region).mul(capacity).add(instanceIndex),
                );
                const base = index.mul(4);

                return {
                    row0: instances.element(base),
                    row1: instances.element(base.add(1)),
                    row2: instances.element(base.add(2)),
                    data: instances.element(base.add(3)),
                };
            };
        const argOffset = (entry: number) => entry * 5 * 4;
        const meshes: {
            mesh: THREE.Mesh;
            /** Indirect argument offsets per material group (main, shadow). */
            offsets: { main: number; shadow: number | null }[];
        }[] = [];
        const addMesh = (
            name: string,
            geometry: THREE.BufferGeometry,
            material: THREE.Material | THREE.Material[],
        ) => {
            const mesh = new THREE.Mesh(geometry, material);
            mesh.name = name;
            mesh.frustumCulled = false;
            mesh.matrixAutoUpdate = false;
            mesh.receiveShadow = true;
            this.group.add(mesh);

            return mesh;
        };

        config.lods.forEach(({ geometry, material }, lod) => {
            const base = indexed(geometry);
            const multi = Array.isArray(material) && base.groups.length > 0;
            const groups = multi
                ? base.groups
                : [
                      {
                          start: base.drawRange.start,
                          count: Math.min(
                              base.drawRange.count,
                              base.index!.count - base.drawRange.start,
                          ),
                          materialIndex: 0,
                      },
                  ];
            const sources = Array.isArray(material) ? material : [material];
            const proxy = lod === 0 ? config.shadowProxy : null;
            const offsets: { main: number; shadow: number | null }[] = [];
            const reflectionOffsets: { main: number; shadow: null }[] = [];
            const reflectionRegion = lodCount + 1 + lod;
            let triangles = 0;

            for (const group of groups) {
                const count = proxy ? proxy.main : group.count;
                entries.push({ region: lod, count, first: group.start });
                const main = argOffset(entries.length - 1);
                let shadow: number | null = null;

                if (lod === 0) {
                    entries.push({
                        region: lodCount,
                        count: proxy ? proxy.count : group.count,
                        first: proxy ? proxy.start : group.start,
                    });
                    shadow = argOffset(entries.length - 1);
                }

                if (config.reflect) {
                    entries.push({
                        region: reflectionRegion,
                        count,
                        first: group.start,
                    });
                    reflectionOffsets.push({
                        main: argOffset(entries.length - 1),
                        shadow: null,
                    });
                }

                offsets.push({ main, shadow });
                triangles += Math.floor(count / 3);
            }

            // One node material per source material (groups sharing a material share it too).
            const nodeMaterials = (
                instance: InstanceSource,
                shadowInstance?: InstanceSource,
            ): THREE.Material | THREE.Material[] => {
                const built = new Map<THREE.Material, THREE.Material>();
                const nodeMaterial = (src: THREE.Material) => {
                    let m = built.get(src);

                    if (!m) {
                        m = createFoliageMaterial(src, {
                            globals: this.frame.globals,
                            uniforms: config.uniforms,
                            stiffness: config.stiffness,
                            fade: config.fade,
                            role: 'none',
                            instance,
                            shadowInstance,
                        });
                        built.set(src, m);
                        this.materials.push(m);
                    }

                    return m;
                };

                return multi
                    ? sources.map(nodeMaterial)
                    : nodeMaterial(sources[0]);
            };
            const mesh = addMesh(
                `Foliage_${config.name}_gpu${lod}`,
                base,
                nodeMaterials(
                    source(lod),
                    lod === 0 ? source(lodCount) : undefined,
                ),
            );
            mesh.castShadow = lod === 0 && this.castShadows.value > 0;
            meshes.push({ mesh, offsets });
            this.draws.push({ mesh, lod, triangles, calls: groups.length });

            if (config.reflect) {
                const reflection = addMesh(
                    `Foliage_${config.name}_reflection${lod}`,
                    base,
                    nodeMaterials(source(reflectionRegion)),
                );
                reflection.visible = false;
                meshes.push({ mesh: reflection, offsets: reflectionOffsets });
                this.reflectionDraws.push(reflection);
            }
        });

        const argsArray = new Uint32Array(entries.length * 5);
        entries.forEach((entry, i) => {
            argsArray[i * 5] = entry.count;
            argsArray[i * 5 + 2] = entry.first;
        });
        this.args = new THREE.IndirectStorageBufferAttribute(argsArray, 1);

        const reset = new Set<THREE.BufferGeometry>();
        const passes = new Map<
            THREE.BufferGeometry,
            {
                state: {
                    scene: THREE.Scene | null;
                    main: number;
                    shadow: number;
                };
                inShadowPass: () => boolean;
            }
        >();

        for (const { mesh, offsets } of meshes) {
            const geometry = mesh.geometry;

            if (!reset.has(geometry)) {
                // Drop the per-pass offset of an earlier chain (see below) before assigning a plain
                // one; once per geometry (main and reflection meshes share it).
                reset.add(geometry);
                Reflect.deleteProperty(geometry, 'indirectOffset');
                geometry.setIndirect(this.args, offsets[0].main);
            }

            if (
                config.reflect ||
                offsets.length > 1 ||
                offsets[0].shadow !== null
            ) {
                // Every material group has its own index range, LOD0 draws the shadow list (and the
                // shadow proxy range) in the shadow pass, and the reflection draws share the LOD
                // geometry: pick the arguments per draw. The offset is resolved when the draw is
                // encoded, not stored in onBeforeRender: the main pass renders the shadow map from
                // within the node updates of a draw (after its onBeforeRender), which would leave the
                // shadow offset behind for that main draw: the shadow list's instance count of
                // main-list instances, in a different order every frame (whole trees flickering in
                // and out). Meshes sharing the geometry (main and reflection) share this state.
                let pass = passes.get(geometry);

                if (!pass) {
                    const state = {
                        scene: null as THREE.Scene | null,
                        main: offsets[0].main,
                        shadow: offsets[0].shadow ?? offsets[0].main,
                    };
                    const inShadowPass = () =>
                        !!(
                            state.scene?.overrideMaterial as {
                                isShadowPassMaterial?: boolean;
                            } | null
                        )?.isShadowPassMaterial;
                    Object.defineProperty(geometry, 'indirectOffset', {
                        configurable: true,
                        get: () => (inShadowPass() ? state.shadow : state.main),
                        // setIndirect(null) on dispose: the property is replaced on the next build.
                        set: () => undefined,
                    });
                    pass = { state, inShadowPass };
                    passes.set(geometry, pass);
                }

                const { state, inShadowPass } = pass;
                mesh.onBeforeRender = (
                    _renderer,
                    scene,
                    _camera,
                    _geometry,
                    _material,
                    group,
                ) => {
                    const index = group
                        ? geometry.groups.indexOf(
                              group as unknown as THREE.GeometryGroup,
                          )
                        : 0;
                    const entry = offsets[Math.max(0, index)];
                    state.scene = scene;

                    if (inShadowPass()) {
                        state.shadow = entry.shadow ?? entry.main;
                    } else {
                        state.main = entry.main;
                    }
                };
            }
        }

        this.entries = entries;
        this.buildComputes();
    }

    private buildComputes(): void {
        const config = this.config!;

        for (const node of this.computes) {
            node.dispose();
        }

        this.hizVersion = this.frame.hiz.version;
        const frame = this.frame;
        const g = frame.globals;
        const u = config.uniforms;
        const instances = this.instances!;
        const visible = this.visible!;
        const counters = this.counters!;
        const stats = this.stats!;
        const capacity = this.capacityNode;
        const lodCount = config.lods.length;
        const shadowRegion = lodCount;
        const reflectionRegion = lodCount + 1;
        const occludedSlot = this.regions;
        const falloff = config.falloff;
        const center = config.center.clone();
        const radius = config.radius;
        const hiz = frame.hiz.nodes;
        const castShadows = this.castShadows;

        const cull = Fn(() => {
            const i = instanceIndex;

            If(i.greaterThanEqual(capacity), () => {
                Return();
            });

            const base = i.mul(4);
            const data = instances.element(base.add(3)).toVar();

            If(data.z.lessThan(0.5), () => {
                Return();
            });

            const r0 = instances.element(base).toVar();
            const r1 = instances.element(base.add(1)).toVar();
            const r2 = instances.element(base.add(2)).toVar();
            const pos = vec3(r0.w, r1.w, r2.w).toVar();
            const d = pos.sub(g.camPos).toVar();
            const distH = length(d.xz).toVar();
            const dist = length(d);
            const cullDistance = u.fadeEnd.mul(g.fadeScale).toVar();

            If(distH.greaterThanEqual(cullDistance), () => {
                Return();
            });

            // Density scaling: instances are ranked within their cell; small foliage thins out with
            // distance (the vertex shader fades the instances at the edge of the kept fraction).
            let keep: Node<'float'>;

            if (falloff) {
                keep = g.density
                    .mul(
                        smoothstep(
                            u.falloff.x.mul(cullDistance),
                            cullDistance,
                            distH,
                        )
                            .mul(u.falloff.y.oneMinus())
                            .oneMinus(),
                    )
                    .mul(1 + RANK_FADE);
            } else {
                keep = g.density;
            }

            If(data.x.greaterThanEqual(keep), () => {
                Return();
            });

            const lodScale = cullDistance.mul(frame.lodBias).toVar();
            const lodOf = (distance: Node<'float'>, scale: Node<'float'>) => {
                const lod = uint(0).toVar();

                for (let l = 1; l < lodCount; l++) {
                    If(
                        distance.greaterThan(
                            scale
                                .mul(config.lodDistances[l])
                                .add(config.lodSlack),
                        ),
                        () => {
                            lod.assign(l);
                        },
                    );
                }

                return lod;
            };
            const lod = lodOf(dist, lodScale);

            // Shadow casters: LOD0 range (+ the reach the CPU cells had: whole cells / the split
            // slack) within the shadow distance, drawn with the LOD0 shadow geometry.
            const shadowReach =
                lodCount > 1
                    ? lodScale
                          .mul(config.lodDistances[1])
                          .add(config.lodSlack + config.shadowSlack)
                    : cullDistance;

            If(
                dist
                    .lessThan(shadowReach)
                    .and(distH.lessThan(frame.shadowDistance))
                    .and(castShadows.greaterThan(0.5)),
                () => {
                    const slot = atomicAdd(counters.element(shadowRegion), 1);
                    visible
                        .element(uint(shadowRegion).mul(capacity).add(slot))
                        .assign(i);
                },
            );

            // Bounding sphere: model centre through the instance transform, radius × scale.
            const c = vec3(center.x, center.y, center.z);
            const sphere = pos
                .add(vec3(dot(r0.xyz, c), dot(r1.xyz, c), dot(r2.xyz, c)))
                .toVar();
            const r = data.y.mul(radius).add(SWAY_MARGIN).toVar();

            // Water reflection: the mirrored camera's own frustum (its near plane is the water, so
            // nothing below it), coarser LODs, no occlusion test (the depth pyramid is the main
            // view's). Trees outside the main view (e.g. above it when looking down at a lake) or
            // hidden in it still show up in the reflection.
            if (config.reflect) {
                If(frame.reflect.greaterThan(0.5), () => {
                    const inside = uint(1).toVar();

                    for (let p = 0; p < 6; p++) {
                        const plane = frame.reflectPlanes.element(p);

                        If(
                            dot(plane.xyz, sphere)
                                .add(plane.w)
                                .lessThan(r.negate()),
                            () => {
                                inside.assign(0);
                            },
                        );
                    }

                    If(inside.equal(1), () => {
                        const region = lodOf(
                            length(pos.sub(frame.reflectCamPos)),
                            lodScale.mul(REFLECTION_LOD_SCALE),
                        ).add(reflectionRegion);
                        const slot = atomicAdd(counters.element(region), 1);
                        visible
                            .element(region.mul(capacity).add(slot))
                            .assign(i);
                    });
                });
            }

            for (let p = 0; p < 6; p++) {
                const plane = frame.planes.element(p);

                If(
                    dot(plane.xyz, sphere).add(plane.w).lessThan(r.negate()),
                    () => {
                        Return();
                    },
                );
            }

            if (hiz) {
                If(frame.occlusion.greaterThan(0.5), () => {
                    const occluded = occludedNode(
                        frame.hiz,
                        hiz,
                        sphere,
                        r.add(frame.occlusionMargin),
                        frame.prevView,
                        frame.prevProj,
                        frame.near,
                    );

                    If(occluded.greaterThan(0.5), () => {
                        atomicAdd(counters.element(occludedSlot), 1);
                        Return();
                    });
                });
            }

            const slot = atomicAdd(counters.element(lod), 1);
            visible.element(lod.mul(capacity).add(slot)).assign(i);
        })().compute(this.capacity);

        const args = storage(this.args!, 'uint', this.entries.length * 5);
        const entries = this.entries;
        const finalize = Fn(() => {
            entries.forEach((entry, i) => {
                args.element(i * 5 + 1).assign(
                    atomicLoad(counters.element(entry.region)),
                );
            });

            for (let r = 0; r <= occludedSlot; r++) {
                stats.element(r).assign(atomicLoad(counters.element(r)));
                atomicStore(counters.element(r), 0);
            }
        })().compute(1);

        this.computes = [cull, finalize];
    }

    private disposeDraws(): void {
        for (const mesh of [
            ...this.draws.map((draw) => draw.mesh),
            ...this.reflectionDraws,
        ]) {
            this.group.remove(mesh);
            // The geometry belongs to the type (shared LOD); only the indirect draw goes.
            Reflect.deleteProperty(mesh.geometry, 'indirectOffset');
            mesh.geometry.setIndirect(null);
        }

        for (const material of this.materials) {
            material.dispose();
        }

        this.draws = [];
        this.reflectionDraws = [];
        this.materials = [];
    }
}

/** Indirect draws are indexed: non-indexed geometries get a sequential index (once). */
function indexed(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
    if (!geometry.index) {
        const count = geometry.getAttribute('position').count;
        geometry.setIndex(
            new THREE.BufferAttribute(
                Uint32Array.from({ length: count }, (_, i) => i),
                1,
            ),
        );
    }

    return geometry;
}
