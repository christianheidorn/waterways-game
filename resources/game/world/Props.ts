import * as THREE from 'three/webgpu';
import {
    attribute,
    interleavedGradientNoise,
    screenCoordinate,
} from 'three/tsl';
import { createGltfLoader, loadGltfFirst } from '../util/gltf';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type {
    PropCollision,
    PropInstance,
    PropModelRef,
    PropsFile,
} from '../shared/types';
import type { Collider, CollisionProvider } from './collision/Collision';
import { MeshShape, trianglesOf } from './collision/shapes';
import type { Shape } from './collision/shapes';
import { voxelBoxes } from './collision/voxelBoxes';
import { simplifyGeometry, triangleCount } from './FoliageLod';
import { LOD_FADE_BAND, setLodFadeMask } from './foliage/FoliageMaterial';
import type { Heightfield } from './Heightfield';

/** One draw: a geometry in the model's normalised space (base centre at the origin, library size). */
type Part = {
    geometry: THREE.BufferGeometry;
    material: THREE.Material | THREE.Material[];
};

type Lod = { parts: Part[]; triangles: number };

type Template = {
    lods: Lod[];
    /** Camera distance (m, at scale 1) up to which each LOD is used; beyond the last, props are hidden. */
    distances: number[];
    /** Bounds at scale 1 (normalised space). */
    box: THREE.Box3;
    sphere: THREE.Sphere;
    /** Horizontal footprint radius at scale 1 (m). */
    radius: number;
    /** The model could not be loaded: a grey marker box stands in. */
    placeholder: boolean;
    /** Collision shapes by mode, built on first use. */
    shapes: Map<PropCollision, Shape>;
    /** Node material copies with the dithered LOD cross-fade, per source material (built on use). */
    fadeMaterials: Map<THREE.Material, THREE.Material>;
};

/** Instanced meshes of one model: [lod][part]. */
type Batch = {
    template: Template;
    meshes: THREE.InstancedMesh[][];
    capacity: number;
    /** Per LOD: dither range [lo, hi) kept per instance (see CROSSFADE_ATTRIBUTE); null: no fade. */
    fades: THREE.InstancedBufferAttribute[] | null;
};

/** Per-instance attribute of the LOD cross-fade: the dither range the draw keeps. */
const CROSSFADE_ATTRIBUTE = 'propLodFade';

export type PropStats = {
    model: number;
    name: string;
    instances: number;
    /** Instances drawn per LOD in the last view update. */
    visible: number[];
    /** Triangles of one instance per LOD. */
    triangles: number[];
    /** Draw calls per instanced LOD (materials after merging). */
    parts: number;
    loaded: boolean;
};

/** LOD0 above this is simplified on load (raw Meshy / photogrammetry models can have 500k+). */
const LOD0_BUDGET = 60_000;
/** Models lighter than this keep a single LOD. */
const LOD_MIN_TRIANGLES = 1_500;
/** Re-bucket instances once the camera moved this far (m). */
const VIEW_EPSILON = 1;
/** Cell size (m) of the collision grid. */
const COLLISION_CELL = 16;

/**
 * Placed props: individual models from the prop library (huts, bridges, fences, rocks, …) standing on
 * the terrain. Heights follow the terrain, so sculpting keeps props grounded.
 *
 * Rendering: each model is loaded once, flattened and merged per material, and simplified into up to
 * three LODs. All instances of a model share one InstancedMesh per LOD and material, so a thousand huts
 * cost a handful of draw calls; instances pick their LOD by camera distance (relative to the model's
 * size) and far ones are skipped. Missing models show a grey marker box.
 */
export class Props implements CollisionProvider {
    readonly group = new THREE.Group();
    /** Called whenever props were added, removed or moved (shadows, saving). */
    onChange: (() => void) | null = null;
    private models = new Map<number, PropModelRef>();
    private templates = new Map<number, Promise<Template>>();
    private batches = new Map<number, Batch>();
    private instances = new Map<string, PropInstance>();
    /** World matrix per instance (null until its model is loaded). */
    private matrices = new Map<string, THREE.Matrix4>();
    private readonly loader = createGltfLoader();
    private dirty = true;
    private readonly lastView = new THREE.Vector3(Infinity, 0, 0);
    private visible = new Map<number, number[]>();
    /** Collision grid: instance ids per cell, and the cells of each instance. */
    private readonly collisionGrid = new Map<number, Set<string>>();
    private readonly collisionCells = new Map<string, number[]>();
    /** Dithered LOD cross-fades (graphics lod_crossfade). */
    private crossfade = true;

    constructor(private readonly heights: () => Heightfield) {
        this.group.name = 'Props';
    }

    setModels(models: PropModelRef[]): void {
        const changed = models.filter((m) => {
            const old = this.models.get(m.id);

            return (
                !old ||
                old.model_url !== m.model_url ||
                (old.optimized_url ?? null) !== (m.optimized_url ?? null) ||
                old.target_height !== m.target_height
            );
        });
        this.models = new Map(models.map((m) => [m.id, m]));

        for (const m of changed) {
            this.dropModel(m.id);
        }

        for (const m of changed) {
            if (this.instancesOf(m.id).length) {
                void this.batch(m.id);
            }
        }
    }

    /** Adds or updates models without dropping the others (models sent along with an agent's edit). */
    addModels(models: PropModelRef[]): void {
        const ids = new Set(models.map((m) => m.id));
        this.setModels([
            ...this.library.filter((m) => !ids.has(m.id)),
            ...models,
        ]);
    }

    /** Footprint radius (m) of a model at a scale, from its library dimensions (a guess when unknown). */
    modelRadius(model: number, scale: number): number {
        const m = this.models.get(model);
        const d = m?.dimensions;

        if (!d) {
            return 1.5 * scale;
        }

        const fit = m.target_height && d.y > 0 ? m.target_height / d.y : 1;

        return (Math.hypot(d.x, d.z) / 2) * fit * scale;
    }

    hasModel(model: number): boolean {
        return this.models.has(model);
    }

    get library(): PropModelRef[] {
        return [...this.models.values()];
    }

    load(file: PropsFile | null): void {
        this.instances = new Map(
            (file?.props ?? []).map((p) => [p.id, { ...p }]),
        );
        this.matrices.clear();
        this.collisionGrid.clear();
        this.collisionCells.clear();

        for (const p of this.instances.values()) {
            this.index(p);
        }

        for (const model of new Set(
            [...this.instances.values()].map((p) => p.model),
        )) {
            void this.batch(model);
        }

        this.changed();
    }

    serialize(): PropsFile {
        const round = (v: number) => Math.round(v * 1000) / 1000;

        return {
            version: 1,
            props: [...this.instances.values()].map(({ align, ...p }) => ({
                ...p,
                x: round(p.x),
                z: round(p.z),
                yaw: round(p.yaw),
                scale: round(p.scale),
                offset: round(p.offset),
                ...(align ? { align: true } : {}),
            })),
        };
    }

    list(): PropInstance[] {
        return [...this.instances.values()];
    }

    get(id: string): PropInstance | null {
        return this.instances.get(id) ?? null;
    }

    add(p: Omit<PropInstance, 'id'>): PropInstance {
        const instance = { ...p, id: newId() };
        this.instances.set(instance.id, instance);
        this.index(instance);
        void this.batch(instance.model);
        this.changed();

        return instance;
    }

    /** Moves, turns or resizes a placed prop. */
    update(
        id: string,
        patch: Partial<
            Pick<PropInstance, 'x' | 'z' | 'yaw' | 'scale' | 'offset' | 'align'>
        >,
    ): PropInstance | null {
        const p = this.instances.get(id);

        if (!p) {
            return null;
        }

        Object.assign(p, patch);
        this.matrices.delete(id);
        this.index(p);
        this.changed();

        return p;
    }

    remove(ids: string[]): number {
        let removed = 0;

        for (const id of ids) {
            if (this.instances.delete(id)) {
                this.matrices.delete(id);
                this.unindex(id);
                removed++;
            }
        }

        if (removed) {
            this.changed();
        }

        return removed;
    }

    /** The closest prop to a point within `radius` metres. */
    nearest(x: number, z: number, radius: number): PropInstance | null {
        let best: PropInstance | null = null;
        let bestD = radius;

        for (const p of this.instances.values()) {
            const d = Math.hypot(p.x - x, p.z - z);

            if (d <= bestD) {
                best = p;
                bestD = d;
            }
        }

        return best;
    }

    /** Puts props inside a world rect back on the (edited) terrain. */
    snap(minX: number, minZ: number, maxX: number, maxZ: number): void {
        let moved = false;

        for (const p of this.instances.values()) {
            if (
                p.x >= minX - 20 &&
                p.x <= maxX + 20 &&
                p.z >= minZ - 20 &&
                p.z <= maxZ + 20
            ) {
                moved = this.matrices.delete(p.id) || moved;
            }
        }

        if (moved) {
            this.changed();
        }
    }

    /**
     * The model's footprint in its own frame at a scale (m): x / z ranges of its bounds, from the
     * loaded model or else the library dimensions.
     */
    extents(
        model: number,
        scale: number,
    ): { minX: number; maxX: number; minZ: number; maxZ: number } {
        const box = this.batches.get(model)?.template.box;

        if (box) {
            return {
                minX: box.min.x * scale,
                maxX: box.max.x * scale,
                minZ: box.min.z * scale,
                maxZ: box.max.z * scale,
            };
        }

        const m = this.models.get(model);
        const d = m?.dimensions;
        const fit =
            m?.target_height && d && d.y > 0 ? m.target_height / d.y : 1;
        const hx = ((d?.x ?? 2) / 2) * fit * scale;
        const hz = ((d?.z ?? 2) / 2) * fit * scale;

        return { minX: -hx, maxX: hx, minZ: -hz, maxZ: hz };
    }

    /** Footprint radius (m) of a model at a scale, once loaded. */
    async footprint(model: number, scale: number): Promise<number> {
        const template = await this.template(model);

        return template.radius * scale;
    }

    /**
     * The placed prop under a ray (exact, against the model's triangles), or null. Used by the editor
     * to select props.
     */
    pick(ray: THREE.Ray): PropInstance | null {
        const candidates: { p: PropInstance; t: number }[] = [];
        const sphere = new THREE.Sphere();
        const hit = new THREE.Vector3();

        for (const p of this.instances.values()) {
            const batch = this.batches.get(p.model);
            const matrix = batch && this.matrixOf(p, batch.template);

            if (!batch || !matrix) {
                continue;
            }

            sphere.copy(batch.template.sphere).applyMatrix4(matrix);

            if (ray.intersectSphere(sphere, hit)) {
                candidates.push({ p, t: hit.distanceTo(ray.origin) });
            }
        }

        candidates.sort((a, b) => a.t - b.t);
        const raycaster = new THREE.Raycaster();
        const probe = new THREE.Mesh();
        let best: { p: PropInstance; d: number } | null = null;

        for (const { p, t } of candidates.slice(0, 24)) {
            if (best && t > best.d) {
                break;
            }

            const batch = this.batches.get(p.model)!;
            const matrix = this.matrixOf(p, batch.template)!;
            raycaster.ray.copy(ray);

            for (const part of batch.template.lods[0].parts) {
                probe.geometry = part.geometry;
                probe.material = part.material;
                probe.matrixWorld.copy(matrix);
                const [first] = raycaster.intersectObject(probe, false);

                if (first && (!best || first.distance < best.d)) {
                    best = { p, d: first.distance };
                }
            }
        }

        return best?.p ?? null;
    }

    /**
     * Matrix that maps the unit cube (−0.5…0.5) onto a placed prop's oriented bounds (selection box),
     * or null while its model loads.
     */
    boundsMatrix(id: string): THREE.Matrix4 | null {
        const p = this.instances.get(id);
        const batch = p && this.batches.get(p.model);
        const matrix = p && batch && this.matrixOf(p, batch.template);

        if (!p || !batch || !matrix) {
            return null;
        }

        const box = batch.template.box;
        const size = box
            .getSize(new THREE.Vector3())
            .max(new THREE.Vector3(0.1, 0.1, 0.1));

        return matrix
            .clone()
            .multiply(
                new THREE.Matrix4().compose(
                    box.getCenter(new THREE.Vector3()),
                    new THREE.Quaternion(),
                    size,
                ),
            );
    }

    /**
     * A standalone copy of a model (full detail, see-through) for the editor's placement preview, or
     * null while it loads. Dispose its materials with `disposePreview`.
     */
    async preview(model: number): Promise<THREE.Object3D> {
        const template = await this.template(model);
        const root = new THREE.Group();

        for (const part of template.lods[0].parts) {
            const materials = (
                Array.isArray(part.material) ? part.material : [part.material]
            ).map((m) => {
                const clone = m.clone();
                clone.transparent = true;
                clone.opacity = 0.6;
                clone.depthWrite = false;

                return clone;
            });
            const mesh = new THREE.Mesh(
                part.geometry,
                Array.isArray(part.material) ? materials : materials[0],
            );
            mesh.renderOrder = 10;
            root.add(mesh);
        }

        root.userData.radius = template.radius;

        return root;
    }

    static disposePreview(object: THREE.Object3D): void {
        object.traverse((o) => {
            const mesh = o as THREE.Mesh;

            if (mesh.isMesh) {
                for (const m of Array.isArray(mesh.material)
                    ? mesh.material
                    : [mesh.material]) {
                    m.dispose();
                }
            }
        });
    }

    /** Ground height under a prop at (x, z) with a footprint radius, plus its offset. */
    groundAt(x: number, z: number, radius: number, offset = 0): number {
        const hf = this.heights();
        const at = (px: number, pz: number) =>
            hf.contains(px, pz) ? hf.sample(px, pz) : 0;
        // Lowest ground under the footprint, so props never float on slopes.
        const r = radius * 0.6;

        return (
            Math.min(
                at(x, z),
                at(x + r, z),
                at(x - r, z),
                at(x, z + r),
                at(x, z - r),
            ) + offset
        );
    }

    /** Per-model rendering statistics (performance diagnostics). */
    stats(): PropStats[] {
        const counts = new Map<number, number>();

        for (const p of this.instances.values()) {
            counts.set(p.model, (counts.get(p.model) ?? 0) + 1);
        }

        return [...counts].map(([model, instances]) => {
            const batch = this.batches.get(model);

            return {
                model,
                name: this.models.get(model)?.name ?? `#${model}`,
                instances,
                visible: this.visible.get(model) ?? [],
                triangles: batch?.template.lods.map((l) => l.triangles) ?? [],
                parts: batch?.template.lods[0].parts.length ?? 0,
                loaded: !!batch,
            };
        });
    }

    /**
     * Dithered LOD cross-fades: over a band before each switch distance (and before the props are
     * hidden) an instance is drawn by both LODs, each keeping complementary pixels of a screen-space
     * dither (shadows too). Off: LODs switch at once.
     */
    setLodCrossfade(enabled: boolean): void {
        if (enabled !== this.crossfade) {
            this.crossfade = enabled;
            this.dirty = true;

            // The dither mask is only compiled into the shaders while cross-fades are on.
            for (const batch of this.batches.values()) {
                for (const material of batch.template.fadeMaterials.values()) {
                    setLodFadeMask(material, enabled);
                }
            }
        }
    }

    /**
     * Per frame: assigns each instance its LOD for the camera's distance and uploads the instance
     * matrices. Cheap when nothing moved: it only re-buckets after changes or a camera move of a metre.
     */
    updateView(camera: THREE.Camera): void {
        const eye = camera.getWorldPosition(new THREE.Vector3());

        if (
            !this.dirty &&
            eye.distanceToSquared(this.lastView) < VIEW_EPSILON ** 2
        ) {
            return;
        }

        this.dirty = false;
        this.lastView.copy(eye);
        const byModel = new Map<number, PropInstance[]>();

        for (const p of this.instances.values()) {
            const list = byModel.get(p.model);

            if (list) {
                list.push(p);
            } else {
                byModel.set(p.model, [p]);
            }
        }

        this.visible.clear();

        for (const [model, batch] of this.batches) {
            const list = byModel.get(model) ?? [];
            this.ensureCapacity(batch, list.length);
            const counts = batch.meshes.map(() => 0);
            const center = new THREE.Vector3();
            const distances = batch.template.distances;
            const fades = this.crossfade ? batch.fades : null;
            const put = (
                lod: number,
                matrix: THREE.Matrix4,
                lo: number,
                hi: number,
            ) => {
                for (const mesh of batch.meshes[lod]) {
                    mesh.setMatrixAt(counts[lod], matrix);
                }

                fades?.[lod].setXY(counts[lod], lo, hi);
                counts[lod]++;
            };

            for (const p of list) {
                const matrix = this.matrixOf(p, batch.template)!;
                center.setFromMatrixPosition(matrix);
                const d = center.distanceTo(eye) / Math.max(0.05, p.scale);
                const lod = distances.findIndex((max) => d <= max);

                if (lod < 0) {
                    continue;
                }

                if (!fades) {
                    put(lod, matrix, -1, 2);
                    continue;
                }

                // Cross-fade band before the switch: this LOD keeps the dither values above t, the
                // next one (if any; the props are hidden after the last) those below.
                const at = distances[lod];
                const band = at * LOD_FADE_BAND;
                const t = Math.min(1, Math.max(0, (d - (at - band)) / band));
                put(lod, matrix, t, 2);

                if (t > 0 && lod + 1 < distances.length) {
                    put(lod + 1, matrix, -1, t);
                }
            }

            batch.meshes.forEach((meshes, lod) => {
                for (const mesh of meshes) {
                    mesh.count = counts[lod];
                    mesh.visible = counts[lod] > 0;
                    mesh.instanceMatrix.needsUpdate = true;
                }

                const fade = batch.fades?.[lod];

                if (fade) {
                    if (!fades) {
                        // Switched off: keep everything (the mask stays in the shader).
                        for (let i = 0; i < counts[lod]; i++) {
                            fade.setXY(i, -1, 2);
                        }
                    }

                    fade.needsUpdate = true;
                }
            });
            this.visible.set(model, counts);
        }
    }

    /**
     * Colliders of the props touching a world rect (CollisionProvider). Each follows its prop's
     * position, rotation, scale and ground height; models still loading don't collide yet.
     */
    collidersIn(
        minX: number,
        minZ: number,
        maxX: number,
        maxZ: number,
        out: Collider[],
    ): void {
        const c0 = Math.floor(minX / COLLISION_CELL);
        const c1 = Math.floor(maxX / COLLISION_CELL);
        const r0 = Math.floor(minZ / COLLISION_CELL);
        const r1 = Math.floor(maxZ / COLLISION_CELL);
        const seen = new Set<string>();

        for (let r = r0; r <= r1; r++) {
            for (let c = c0; c <= c1; c++) {
                const ids = this.collisionGrid.get(cellKey(c, r));

                if (!ids) {
                    continue;
                }

                for (const id of ids) {
                    if (seen.has(id)) {
                        continue;
                    }

                    seen.add(id);
                    const collider = this.colliderOf(id);

                    if (
                        collider &&
                        collider.x + collider.radius >= minX &&
                        collider.x - collider.radius <= maxX &&
                        collider.z + collider.radius >= minZ &&
                        collider.z - collider.radius <= maxZ
                    ) {
                        out.push(collider);
                    }
                }
            }
        }
    }

    /** The collider of a placed prop (null: no collision, or its model is still loading). */
    colliderOf(id: string): Collider | null {
        const p = this.instances.get(id);
        const batch = p && this.batches.get(p.model);

        if (!p || !batch) {
            return null;
        }

        const ref = this.models.get(p.model);
        const mode = ref?.collision ?? 'auto';

        if (mode === 'none') {
            return null;
        }

        const template = batch.template;
        const shape = collisionShape(template, mode);
        const matrix = this.matrixOf(p, template)!;
        const y = matrix.elements[13];
        const box = template.box;
        // Props tilted to the slope keep upright colliders spanning the tilted model's height.
        const span = p.align ? box.clone().applyMatrix4(matrix) : null;

        return {
            info: {
                source: 'prop',
                key: `p${p.id}`,
                name: ref?.name ?? `#${p.model}`,
                mode,
                propModelId: p.model,
                propId: p.id,
            },
            x: p.x,
            y,
            z: p.z,
            cos: Math.cos(p.yaw),
            sin: Math.sin(p.yaw),
            scale: p.scale,
            radius: templateReach(template) * p.scale,
            bottom: span ? span.min.y : y + box.min.y * p.scale,
            top: span ? span.max.y : y + box.max.y * p.scale,
            shape,
        };
    }

    /** (Re)files a prop in the collision grid by its footprint. */
    private index(p: PropInstance): void {
        this.unindex(p.id);
        const batch = this.batches.get(p.model);
        const r = batch
            ? templateReach(batch.template) * p.scale
            : this.modelRadius(p.model, p.scale) * 1.5 + 1;
        const cells: number[] = [];

        for (
            let cz = Math.floor((p.z - r) / COLLISION_CELL);
            cz <= Math.floor((p.z + r) / COLLISION_CELL);
            cz++
        ) {
            for (
                let cx = Math.floor((p.x - r) / COLLISION_CELL);
                cx <= Math.floor((p.x + r) / COLLISION_CELL);
                cx++
            ) {
                const key = cellKey(cx, cz);
                let set = this.collisionGrid.get(key);

                if (!set) {
                    set = new Set();
                    this.collisionGrid.set(key, set);
                }

                set.add(p.id);
                cells.push(key);
            }
        }

        this.collisionCells.set(p.id, cells);
    }

    private unindex(id: string): void {
        for (const key of this.collisionCells.get(id) ?? []) {
            const set = this.collisionGrid.get(key);
            set?.delete(id);

            if (set && !set.size) {
                this.collisionGrid.delete(key);
            }
        }

        this.collisionCells.delete(id);
    }

    private changed(): void {
        this.dirty = true;
        this.onChange?.();
    }

    private instancesOf(model: number): PropInstance[] {
        return [...this.instances.values()].filter((p) => p.model === model);
    }

    private matrixOf(
        p: PropInstance,
        template: Template,
    ): THREE.Matrix4 | null {
        let matrix = this.matrices.get(p.id);

        if (!matrix) {
            const radius = template.radius * p.scale;
            const rotation = new THREE.Quaternion().setFromAxisAngle(
                new THREE.Vector3(0, 1, 0),
                p.yaw,
            );
            let y: number;

            if (p.align) {
                // Tilted to the ground's slope (averaged over the footprint), centred on the ground.
                const hf = this.heights();
                y =
                    (hf.contains(p.x, p.z) ? hf.sample(p.x, p.z) : 0) +
                    p.offset;
                rotation.premultiply(
                    new THREE.Quaternion().setFromUnitVectors(
                        new THREE.Vector3(0, 1, 0),
                        slopeNormal(hf, p.x, p.z, radius),
                    ),
                );
            } else {
                y = this.groundAt(p.x, p.z, radius, p.offset);
            }

            matrix = new THREE.Matrix4().compose(
                new THREE.Vector3(p.x, y, p.z),
                rotation,
                new THREE.Vector3(p.scale, p.scale, p.scale),
            );
            this.matrices.set(p.id, matrix);
        }

        return matrix;
    }

    private async batch(model: number): Promise<void> {
        if (this.batches.has(model)) {
            return;
        }

        const promise = this.template(model);
        const template = await promise;

        // Replaced (model changed) while loading, or created by a concurrent call.
        if (this.templates.get(model) !== promise || this.batches.has(model)) {
            return;
        }

        this.batches.set(model, {
            template,
            meshes: template.lods.map(() => []),
            capacity: 0,
            fades: null,
        });

        // The grid used a guess of the size until now.
        for (const p of this.instancesOf(model)) {
            this.index(p);
        }

        this.changed();
    }

    private ensureCapacity(batch: Batch, needed: number): void {
        if (needed <= batch.capacity && batch.meshes[0].length) {
            return;
        }

        const capacity = Math.max(
            8,
            2 ** Math.ceil(Math.log2(Math.max(1, needed * 1.25))),
        );

        for (const meshes of batch.meshes) {
            for (const mesh of meshes) {
                this.group.remove(mesh);
                mesh.dispose();
            }
        }

        const last = batch.template.lods.length - 1;
        // The placeholder box is shared by every missing model: no per-instance fade on it.
        const fade = !batch.template.placeholder;
        batch.fades = fade
            ? batch.template.lods.map(
                  () =>
                      new THREE.InstancedBufferAttribute(
                          new Float32Array(capacity * 2),
                          2,
                      ),
              )
            : null;
        batch.meshes = batch.template.lods.map((lod, index) =>
            lod.parts.map((part) => {
                if (batch.fades) {
                    part.geometry.setAttribute(
                        CROSSFADE_ATTRIBUTE,
                        batch.fades[index],
                    );
                }

                const mesh = new THREE.InstancedMesh(
                    part.geometry,
                    fade
                        ? crossfadeMaterial(
                              batch.template,
                              part.material,
                              this.crossfade,
                          )
                        : part.material,
                    capacity,
                );
                mesh.count = 0;
                mesh.frustumCulled = false;
                // The far LOD is too small in the shadow maps to be worth its draws.
                mesh.castShadow = index < last || last === 0;
                mesh.receiveShadow = true;
                mesh.name = `Prop ${batch.template.placeholder ? 'placeholder' : ''} LOD${index}`;
                this.group.add(mesh);

                return mesh;
            }),
        );
        batch.capacity = capacity;
    }

    private dropModel(model: number): void {
        const batch = this.batches.get(model);

        if (batch) {
            for (const meshes of batch.meshes) {
                for (const mesh of meshes) {
                    this.group.remove(mesh);
                    mesh.dispose();
                }
            }

            if (!batch.template.placeholder) {
                disposeTemplate(batch.template);
            }

            this.batches.delete(model);
        }

        this.templates.delete(model);

        for (const p of this.instances.values()) {
            if (p.model === model) {
                this.matrices.delete(p.id);
            }
        }

        this.dirty = true;
    }

    private template(model: number): Promise<Template> {
        let promise = this.templates.get(model);

        if (!promise) {
            promise = this.loadTemplate(model).then(
                (t) => t ?? placeholderTemplate(),
            );
            this.templates.set(model, promise);
        }

        return promise;
    }

    private async loadTemplate(model: number): Promise<Template | null> {
        const ref = this.models.get(model);

        if (!ref?.model_url) {
            return null;
        }

        try {
            const gltf = await loadGltfFirst(this.loader, [
                ref.optimized_url,
                ref.model_url,
            ]);

            return await buildTemplate(gltf.scene, ref);
        } catch (error) {
            console.warn(`Failed to load prop model ${ref.model_url}`, error);

            return null;
        }
    }
}

/**
 * Flattens a loaded model into parts in normalised space (scaled to the library height, base centre at
 * the origin), merged per material, and adds simplified LODs for heavy models.
 */
async function buildTemplate(
    scene: THREE.Object3D,
    ref: PropModelRef,
): Promise<Template> {
    scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(scene);
    const size = box.getSize(new THREE.Vector3());
    const scale =
        ref.target_height && size.y > 1e-3 ? ref.target_height / size.y : 1;
    const center = box.getCenter(new THREE.Vector3());
    const normalise = new THREE.Matrix4()
        .makeScale(scale, scale, scale)
        .multiply(
            new THREE.Matrix4().makeTranslation(
                -center.x,
                -box.min.y,
                -center.z,
            ),
        );

    // Geometries per material (baked into normalised space); multi-material meshes stay whole.
    const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
    const whole: Part[] = [];

    scene.traverse((o) => {
        const mesh = o as THREE.Mesh;

        if (!mesh.isMesh || !mesh.visible) {
            return;
        }

        const geometry = mesh.geometry.clone();
        geometry.applyMatrix4(normalise.clone().multiply(mesh.matrixWorld));

        if (Array.isArray(mesh.material)) {
            whole.push({ geometry, material: mesh.material });

            return;
        }

        const list = byMaterial.get(mesh.material) ?? [];
        list.push(geometry);
        byMaterial.set(mesh.material, list);
    });

    const parts: Part[] = [...whole];

    for (const [material, geometries] of byMaterial) {
        const merged =
            geometries.length > 1
                ? mergeGeometries(geometries, false)
                : geometries[0];

        if (merged) {
            parts.push({ geometry: merged, material });

            if (merged !== geometries[0]) {
                geometries.forEach((g) => g.dispose());
            }
        } else {
            // Attribute sets differ: keep them as separate draws.
            parts.push(
                ...geometries.map((geometry) => ({ geometry, material })),
            );
        }
    }

    const lod0 = await simplifyParts(parts, LOD0_BUDGET);
    const lods: Lod[] = [{ parts: lod0, triangles: countTriangles(lod0) }];

    if (lods[0].triangles > LOD_MIN_TRIANGLES) {
        for (const share of [0.25, 0.06]) {
            const target = Math.max(150, Math.round(lods[0].triangles * share));
            const reduced = await simplifyParts(
                lods[lods.length - 1].parts,
                target,
            );
            const triangles = countTriangles(reduced);

            // Keep a LOD only when it saves a meaningful amount.
            if (triangles < lods[lods.length - 1].triangles * 0.7) {
                lods.push({ parts: reduced, triangles });
            }
        }
    }

    const bounds = new THREE.Box3();

    for (const part of lod0) {
        part.geometry.computeBoundingBox();
        bounds.union(part.geometry.boundingBox!);
    }

    const extent = bounds.getSize(new THREE.Vector3());
    const radius = Math.max(extent.x, extent.z) / 2;

    return {
        shapes: new Map(),
        fadeMaterials: new Map(),
        lods,
        distances: lodDistances(
            Math.max(extent.y, radius * 2, 0.5),
            lods.length,
        ),
        box: bounds,
        sphere: bounds.getBoundingSphere(new THREE.Sphere()),
        radius,
        placeholder: false,
    };
}

/**
 * Switch distances by model size: a 10 m house uses LOD1 from ~50 m, LOD2 from ~140 m and is hidden
 * beyond ~1 km; a 3 m rock from ~20 m, ~50 m and ~300 m.
 */
function lodDistances(size: number, count: number): number[] {
    const cull = Math.max(200, size * 100);
    const steps = [Math.max(20, size * 5), Math.max(50, size * 14)];

    return [...steps.slice(0, count - 1), cull];
}

async function simplifyParts(
    parts: Part[],
    targetTriangles: number,
): Promise<Part[]> {
    const total = countTriangles(parts);

    if (total <= targetTriangles) {
        return parts;
    }

    const share = targetTriangles / total;

    return Promise.all(
        parts.map(async (part) => {
            const target = Math.max(
                12,
                Math.round(triangleCount(part.geometry) * share),
            );
            const reduced = await simplifyGeometry(part.geometry, target);

            return reduced
                ? { geometry: reduced, material: part.material }
                : part;
        }),
    );
}

function countTriangles(parts: Part[]): number {
    return parts.reduce((sum, p) => sum + triangleCount(p.geometry), 0);
}

/**
 * Node material copy of a prop material that discards the pixels its LOD leaves to the neighbouring
 * one (screen-space dither over the per-instance range; the shadow pass uses it too). Materials
 * without a node counterpart are drawn as they are (no fade).
 */
function crossfadeMaterial(
    template: Template,
    source: THREE.Material | THREE.Material[],
    enabled: boolean,
): THREE.Material | THREE.Material[] {
    if (Array.isArray(source)) {
        return source.map(
            (m) => crossfadeMaterial(template, m, enabled) as THREE.Material,
        );
    }

    let material = template.fadeMaterials.get(source);

    if (!material) {
        material = source;
        const NodeClass = (
            THREE as unknown as Record<
                string,
                (new () => THREE.NodeMaterial) | undefined
            >
        )[source.type.replace(/Material$/, 'NodeMaterial')];

        if ((source as THREE.NodeMaterial).isNodeMaterial) {
            material = source.clone();
        } else if (NodeClass) {
            material = new NodeClass();
            material.copy(source as unknown as THREE.NodeMaterial);
            material.name = source.name;
        }

        if ((material as THREE.NodeMaterial).isNodeMaterial) {
            const range = attribute(CROSSFADE_ATTRIBUTE, 'vec2');
            const n = interleavedGradientNoise(screenCoordinate.xy);
            material.userData.lodFadeMask = n
                .greaterThanEqual(range.x)
                .and(n.lessThan(range.y)) as unknown as THREE.Node<'bool'>;
            setLodFadeMask(material, enabled);
        }

        template.fadeMaterials.set(source, material);
    }

    return material;
}

function disposeTemplate(template: Template): void {
    const geometries = new Set<THREE.BufferGeometry>();

    for (const material of template.fadeMaterials.values()) {
        material.dispose();
    }

    template.fadeMaterials.clear();

    for (const lod of template.lods) {
        for (const part of lod.parts) {
            geometries.add(part.geometry);
        }
    }

    geometries.forEach((g) => g.dispose());
}

let placeholder: Template | null = null;

/** A grey marker box for props whose model is missing or failed to load (shared). */
function placeholderTemplate(): Template {
    if (!placeholder) {
        const geometry = new THREE.BoxGeometry(2, 2, 2).translate(0, 1, 0);
        const box = new THREE.Box3(
            new THREE.Vector3(-1, 0, -1),
            new THREE.Vector3(1, 2, 1),
        );
        placeholder = {
            fadeMaterials: new Map(),
            lods: [
                {
                    parts: [
                        {
                            geometry,
                            material: new THREE.MeshStandardNodeMaterial({
                                color: 0x9a8f86,
                                roughness: 0.9,
                            }),
                        },
                    ],
                    triangles: 12,
                },
            ],
            distances: [600],
            box,
            sphere: box.getBoundingSphere(new THREE.Sphere()),
            radius: 1,
            placeholder: true,
            shapes: new Map(),
        };
    }

    return placeholder;
}

/** Horizontal reach of a template's bounds from its origin (scale 1). */
function templateReach(template: Template): number {
    const b = template.box;

    return Math.hypot(
        Math.max(Math.abs(b.min.x), Math.abs(b.max.x)),
        Math.max(Math.abs(b.min.z), Math.abs(b.max.z)),
    );
}

/** A template's collision shape for a mode (built once: voxel boxes or the LOD0 triangles). */
function collisionShape(
    template: Template,
    mode: Exclude<PropCollision, 'none'>,
): Shape {
    let shape = template.shapes.get(mode);

    if (!shape) {
        const geometries = template.lods[0].parts.map((p) => p.geometry);
        const b = template.box;

        if (mode === 'mesh') {
            shape = {
                kind: 'mesh',
                mesh: MeshShape.fromGeometries(geometries),
            };
        } else {
            const boxes =
                mode === 'auto' && !template.placeholder
                    ? voxelBoxes(trianglesOf(geometries))
                    : new Float32Array(0);
            shape = {
                kind: 'boxes',
                boxes: boxes.length
                    ? boxes
                    : new Float32Array([
                          b.min.x,
                          b.min.y,
                          b.min.z,
                          b.max.x,
                          b.max.y,
                          b.max.z,
                      ]),
            };
        }

        template.shapes.set(mode, shape);
    }

    return shape;
}

/** Average ground normal over a footprint (a tilted prop leans with the slope, not with bumps). */
function slopeNormal(
    hf: Heightfield,
    x: number,
    z: number,
    radius: number,
): THREE.Vector3 {
    const e = Math.max(hf.cell, radius * 0.6);
    const at = (px: number, pz: number) =>
        hf.contains(px, pz) ? hf.sample(px, pz) : hf.sample(x, z);

    return new THREE.Vector3(
        at(x - e, z) - at(x + e, z),
        2 * e,
        at(x, z - e) - at(x, z + e),
    ).normalize();
}

function cellKey(cx: number, cz: number): number {
    return (cx + 32768) * 65536 + (cz + 32768);
}

function newId(): string {
    return (
        globalThis.crypto?.randomUUID?.().slice(0, 12) ??
        `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    );
}
