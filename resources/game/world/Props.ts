import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { PropInstance, PropModelRef, PropsFile } from '../shared/types';
import type { Heightfield } from './Heightfield';

type Template = {
    /** The model, scaled to its library size and moved so its base centre is the origin. */
    object: THREE.Object3D;
    /** Horizontal radius of the footprint at scale 1 (m), for grounding on slopes. */
    radius: number;
};

/**
 * Placed props: individual models from the prop library (huts, bridges, fences, rocks, …) standing on
 * the terrain. Each instance is a clone of its model's template (geometry and materials shared);
 * heights follow the terrain, so sculpting keeps props grounded. Missing models show a placeholder.
 */
export class Props {
    readonly group = new THREE.Group();
    /** Called whenever props were added, removed or moved (shadows, saving). */
    onChange: (() => void) | null = null;
    private models = new Map<number, PropModelRef>();
    private templates = new Map<number, Promise<Template | null>>();
    private instances = new Map<string, PropInstance>();
    private objects = new Map<string, THREE.Object3D>();
    private readonly loader = new GLTFLoader();
    private placeholder: Template | null = null;

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
            this.templates.delete(m.id);
        }

        // Re-create instances whose model changed (or appeared).
        const ids = new Set(changed.map((m) => m.id));

        for (const p of this.instances.values()) {
            if (ids.has(p.model)) {
                this.spawn(p);
            }
        }
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
        for (const id of [...this.instances.keys()]) {
            this.despawn(id);
        }

        this.instances.clear();

        for (const p of file?.props ?? []) {
            this.instances.set(p.id, { ...p });
            this.spawn(p);
        }
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

    add(p: Omit<PropInstance, 'id'>): PropInstance {
        const instance = { ...p, id: newId() };
        this.instances.set(instance.id, instance);
        this.spawn(instance);
        this.onChange?.();

        return instance;
    }

    remove(ids: string[]): number {
        let removed = 0;

        for (const id of ids) {
            if (this.instances.delete(id)) {
                this.despawn(id);
                removed++;
            }
        }

        if (removed) {
            this.onChange?.();
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
                const object = this.objects.get(p.id);

                if (object) {
                    object.position.y = this.groundY(
                        p,
                        (object.userData.radius as number) ?? 0,
                    );
                    moved = true;
                }
            }
        }

        if (moved) {
            this.onChange?.();
        }
    }

    /** Footprint radius (m) of a model at a scale, once loaded (0 while loading). */
    async footprint(model: number, scale: number): Promise<number> {
        const template = await this.template(model);

        return (template?.radius ?? 1) * scale;
    }

    private groundY(p: PropInstance, radius: number): number {
        const hf = this.heights();
        const at = (x: number, z: number) =>
            hf.contains(x, z) ? hf.sample(x, z) : 0;
        // Lowest ground under the footprint, so props never float on slopes.
        const r = radius * 0.6;
        const y = Math.min(
            at(p.x, p.z),
            at(p.x + r, p.z),
            at(p.x - r, p.z),
            at(p.x, p.z + r),
            at(p.x, p.z - r),
        );

        return y + p.offset;
    }

    private spawn(p: PropInstance): void {
        void this.template(p.model).then((template) => {
            // Removed or replaced while loading.
            if (this.instances.get(p.id) !== p) {
                return;
            }

            this.despawn(p.id);
            const t = template ?? this.placeholderTemplate();
            const object = t.object.clone(true);
            object.scale.multiplyScalar(p.scale);
            object.rotation.y = p.yaw;
            object.userData.radius = t.radius * p.scale;
            object.userData.propId = p.id;
            object.position.set(p.x, this.groundY(p, t.radius * p.scale), p.z);
            this.objects.set(p.id, object);
            this.group.add(object);
            this.onChange?.();
        });
    }

    private despawn(id: string): void {
        const object = this.objects.get(id);

        if (object) {
            this.group.remove(object);
            this.objects.delete(id);
        }
    }

    private template(model: number): Promise<Template | null> {
        let promise = this.templates.get(model);

        if (!promise) {
            promise = this.loadTemplate(model);
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
            const scene = gltf.scene;
            scene.traverse((o) => {
                const mesh = o as THREE.Mesh;

                if (mesh.isMesh) {
                    mesh.castShadow = true;
                    mesh.receiveShadow = true;
                }
            });
            const box = new THREE.Box3().setFromObject(scene);
            const size = box.getSize(new THREE.Vector3());
            const scale =
                ref.target_height && size.y > 1e-3
                    ? ref.target_height / size.y
                    : 1;
            // Base centre at the origin, so placements stand on the ground.
            const center = box.getCenter(new THREE.Vector3());
            scene.position.set(-center.x, -box.min.y, -center.z);
            const root = new THREE.Group();
            root.name = ref.name;
            root.add(scene);
            root.scale.setScalar(scale);

            return {
                object: root,
                radius: (Math.max(size.x, size.z) / 2) * scale,
            };
        } catch (error) {
            console.warn(`Failed to load prop model ${ref.model_url}`, error);

            return null;
        }
    }

    /** A grey marker box for props whose model is missing or failed to load. */
    private placeholderTemplate(): Template {
        if (!this.placeholder) {
            const mesh = new THREE.Mesh(
                new THREE.BoxGeometry(2, 2, 2),
                new THREE.MeshStandardNodeMaterial({
                    color: 0x9a8f86,
                    roughness: 0.9,
                }),
            );
            mesh.position.y = 1;
            mesh.castShadow = true;
            const root = new THREE.Group();
            root.add(mesh);
            this.placeholder = { object: root, radius: 1 };
        }

        return this.placeholder;
    }
}

function newId(): string {
    return (
        globalThis.crypto?.randomUUID?.().slice(0, 12) ??
        `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    );
}
