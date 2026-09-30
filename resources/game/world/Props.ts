import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { PropInstance, PropModelRef, PropsFile } from '../shared/types';
import { simplifyGeometry, triangleCount } from './FoliageLod';
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
};

/** Instanced meshes of one model: [lod][part]. */
type Batch = {
    template: Template;
    meshes: THREE.InstancedMesh[][];
    capacity: number;
};

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

/**
 * Placed props: individual models from the prop library (huts, bridges, fences, rocks, …) standing on
 * the terrain. Heights follow the terrain, so sculpting keeps props grounded.
 *
 * Rendering: each model is loaded once, flattened and merged per material, and simplified into up to
 * three LODs. All instances of a model share one InstancedMesh per LOD and material, so a thousand huts
 * cost a handful of draw calls; instances pick their LOD by camera distance (relative to the model's
 * size) and far ones are skipped. Missing models show a grey marker box.
 */
export class Props {
    readonly group = new THREE.Group();
    /** Called whenever props were added, removed or moved (shadows, saving). */
    onChange: (() => void) | null = null;
    private models = new Map<number, PropModelRef>();
    private templates = new Map<number, Promise<Template>>();
    private batches = new Map<number, Batch>();
    private instances = new Map<string, PropInstance>();
    /** World matrix per instance (null until its model is loaded). */
    private matrices = new Map<string, THREE.Matrix4>();
    private readonly loader = new GLTFLoader();
    private dirty = true;
    private readonly lastView = new THREE.Vector3(Infinity, 0, 0);
    private visible = new Map<number, number[]>();

    constructor(private readonly heights: () => Heightfield) {
        this.group.name = 'Props';
    }

    setModels(models: PropModelRef[]): void {
        const changed = models.filter((m) => {
            const old = this.models.get(m.id);

            return (
                !old ||
                old.model_url !== m.model_url ||
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
            props: [...this.instances.values()].map((p) => ({
                ...p,
                x: round(p.x),
                z: round(p.z),
                yaw: round(p.yaw),
                scale: round(p.scale),
                offset: round(p.offset),
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
        void this.batch(instance.model);
        this.changed();

        return instance;
    }

    /** Moves, turns or resizes a placed prop. */
    update(
        id: string,
        patch: Partial<
            Pick<PropInstance, 'x' | 'z' | 'yaw' | 'scale' | 'offset'>
        >,
    ): PropInstance | null {
        const p = this.instances.get(id);

        if (!p) {
            return null;
        }

        Object.assign(p, patch);
        this.matrices.delete(id);
        this.changed();

        return p;
    }

    remove(ids: string[]): number {
        let removed = 0;

        for (const id of ids) {
            if (this.instances.delete(id)) {
                this.matrices.delete(id);
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

            for (const p of list) {
                const matrix = this.matrixOf(p, batch.template)!;
                center.setFromMatrixPosition(matrix);
                const d = center.distanceTo(eye) / Math.max(0.05, p.scale);
                const lod = batch.template.distances.findIndex(
                    (max) => d <= max,
                );

                if (lod < 0) {
                    continue;
                }

                for (const mesh of batch.meshes[lod]) {
                    mesh.setMatrixAt(counts[lod], matrix);
                }

                counts[lod]++;
            }

            batch.meshes.forEach((meshes, lod) => {
                for (const mesh of meshes) {
                    mesh.count = counts[lod];
                    mesh.visible = counts[lod] > 0;
                    mesh.instanceMatrix.needsUpdate = true;
                }
            });
            this.visible.set(model, counts);
        }
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
            const y = this.groundAt(
                p.x,
                p.z,
                template.radius * p.scale,
                p.offset,
            );
            matrix = new THREE.Matrix4().compose(
                new THREE.Vector3(p.x, y, p.z),
                new THREE.Quaternion().setFromAxisAngle(
                    new THREE.Vector3(0, 1, 0),
                    p.yaw,
                ),
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
        });
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
        batch.meshes = batch.template.lods.map((lod, index) =>
            lod.parts.map((part) => {
                const mesh = new THREE.InstancedMesh(
                    part.geometry,
                    part.material,
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
            const gltf = await this.loader.loadAsync(ref.model_url);

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

function disposeTemplate(template: Template): void {
    const geometries = new Set<THREE.BufferGeometry>();

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
        };
    }

    return placeholder;
}

function newId(): string {
    return (
        globalThis.crypto?.randomUUID?.().slice(0, 12) ??
        `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    );
}
