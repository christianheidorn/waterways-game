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
    private readonly frustum = new THREE.Frustum();
    private readonly projScreen = new THREE.Matrix4();

    constructor(
        readonly globals: FoliageGlobals,
        readonly hiz: HiZ,
    ) {}

    setCamera(camera: THREE.Camera): void {
        this.projScreen.multiplyMatrices(
            camera.projectionMatrix,
            camera.matrixWorldInverse,
        );
        this.frustum.setFromProjectionMatrix(
            this.projScreen,
            camera.coordinateSystem,
        );
        const values = this.planes.array as THREE.Vector4[];
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
};

type Draw = {
    mesh: THREE.Mesh;
    lod: number;
    /** Triangles per instance in the main pass (all material groups). */
    triangles: number;
    /** Indirect draws per pass (one per material group). */
    calls: number;
};

type Range = { start: number; capacity: number; count: number };

/** Cells as the GPU store sees them: a flat instance list (x, y, z, yaw, scale, tiltX, tiltZ). */
export type GpuCell = { data: number[] };

export type GpuTypeStats = {
    lodInstances: number[];
    shadowInstances: number;
    occluded: number;
};

/**
 * GPU-driven rendering of one foliage type (WebGPU): every instance lives in a storage buffer; each
 * frame a compute pass tests all of them (distance, density, frustum, Hi-Z occlusion), picks the LOD
 * and appends the survivors to per-LOD visibility lists, and a one-thread pass writes the instance
 * counts into `drawIndexedIndirect` arguments. Each LOD (per material group) is then ONE indirect
 * draw whose vertex shader fetches the transform through the visibility list. Shadows use a separate
 * list (LOD0 instances within the shadow distance, not frustum / occlusion culled): LOD0 meshes switch
 * their indirect arguments and instance source in the shadow pass.
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
    /** Last read-back counters (null until the first result). */
    lastStats: GpuTypeStats | null = null;

    constructor(private readonly frame: GpuCullFrame) {}

    get instanceCount(): number {
        return this.live;
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
                this.ranges.set(cell, { start: 0, capacity: 0, count: 0 });
                this.repack(capacity);

                return;
            }

            range = { start: this.top, capacity, count: 0 };
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
    }

    /** Drops every instance (keeps the buffers). */
    clear(): void {
        for (const range of this.ranges.values()) {
            this.freeRange(range);
        }

        this.ranges.clear();
        this.top = 0;
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

        return this.computes;
    }

    /** Reads the counters back every STATS_INTERVAL seconds (asynchronously). */
    updateStats(renderer: GameRenderer, dt: number): void {
        this.statsTimer -= dt;

        if (this.statsTimer > 0 || this.reading || !this.stats) {
            return;
        }

        this.statsTimer = STATS_INTERVAL;
        this.reading = true;
        const lods = this.config?.lods.length ?? 0;
        const attribute = this.stats.value as THREE.StorageBufferAttribute;
        renderer
            .getArrayBufferAsync(attribute)
            .then((buffer) => {
                const counts = new Uint32Array(buffer as ArrayBuffer);
                this.lastStats = {
                    lodInstances: Array.from(counts.slice(0, lods)),
                    shadowInstances: counts[lods] ?? 0,
                    occluded: counts[lods + 1] ?? 0,
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
    }

    private freeRange(range: Range): void {
        if (!this.instances) {
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
            const count = cell.data.length / FOLIAGE_STRIDE;
            range.capacity = count + Math.ceil(count * CELL_HEADROOM) + 4;
            needed += range.capacity;
        }

        this.allocate(
            Math.max(MIN_CAPACITY, this.capacity, Math.ceil(needed * 1.5)),
        );
        this.top = 0;
        this.live = 0;

        for (const [cell, range] of this.ranges) {
            range.start = this.top;
            range.count = 0;
            this.top += range.capacity;
            this.fillRange(range, cell);
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
        // Regions of the visibility list: one per LOD, then the shadow casters.
        const regions = lodCount + 1;
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
            const nodeMaterials = new Map<THREE.Material, THREE.Material>();
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

                offsets.push({ main, shadow });
                triangles += Math.floor(count / 3);
            }

            // One node material per source material (groups sharing a material share it too).
            const nodeMaterial = (src: THREE.Material) => {
                let m = nodeMaterials.get(src);

                if (!m) {
                    m = createFoliageMaterial(src, {
                        globals: this.frame.globals,
                        uniforms: config.uniforms,
                        stiffness: config.stiffness,
                        fade: config.fade,
                        role: 'none',
                        instance: source(lod),
                        shadowInstance:
                            lod === 0 ? source(lodCount) : undefined,
                    });
                    nodeMaterials.set(src, m);
                    this.materials.push(m);
                }

                return m;
            };
            const mesh = new THREE.Mesh(
                base,
                multi ? sources.map(nodeMaterial) : nodeMaterial(sources[0]),
            );
            mesh.name = `Foliage_${config.name}_gpu${lod}`;
            mesh.frustumCulled = false;
            mesh.matrixAutoUpdate = false;
            mesh.receiveShadow = true;
            mesh.castShadow = lod === 0 && this.castShadows.value > 0;
            meshes.push({ mesh, offsets });
            this.draws.push({ mesh, lod, triangles, calls: groups.length });
            this.group.add(mesh);
        });

        const argsArray = new Uint32Array(entries.length * 5);
        entries.forEach((entry, i) => {
            argsArray[i * 5] = entry.count;
            argsArray[i * 5 + 2] = entry.first;
        });
        this.args = new THREE.IndirectStorageBufferAttribute(argsArray, 1);

        for (const { mesh, offsets } of meshes) {
            const geometry = mesh.geometry;
            geometry.setIndirect(this.args, offsets[0].main);

            if (offsets.length > 1 || offsets[0].shadow !== null) {
                // Every material group has its own index range, and LOD0 draws the shadow list (and
                // the shadow proxy range) in the shadow pass: pick the arguments per draw.
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
                    const shadow = (
                        scene.overrideMaterial as {
                            isShadowPassMaterial?: boolean;
                        } | null
                    )?.isShadowPassMaterial;
                    geometry.indirectOffset =
                        shadow && entry.shadow !== null
                            ? entry.shadow
                            : entry.main;
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
        const occludedSlot = lodCount + 1;
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

            const lod = uint(0).toVar();
            const lodScale = cullDistance.mul(frame.lodBias);

            for (let l = 1; l < lodCount; l++) {
                If(
                    dist.greaterThan(
                        lodScale
                            .mul(config.lodDistances[l])
                            .add(config.lodSlack),
                    ),
                    () => {
                        lod.assign(l);
                    },
                );
            }

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
        for (const draw of this.draws) {
            this.group.remove(draw.mesh);
            // The geometry belongs to the type (shared LOD); only the indirect draw goes.
            draw.mesh.geometry.setIndirect(null);
        }

        for (const material of this.materials) {
            material.dispose();
        }

        this.draws = [];
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
