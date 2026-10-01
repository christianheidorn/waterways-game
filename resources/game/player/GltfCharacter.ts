import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { toLitNodeMaterial } from '../world/SurfaceWetness';
import type { CharacterAnimState } from './CharacterModel';

export type ClipKey = 'idle' | 'walk' | 'run' | 'jump' | 'swim';

/**
 * A rigged glTF character driven by its own animation clips. Clips are matched by name
 * (idle / walk / run / jump|fall / swim), falling back to the closest available clip.
 * `extraClips` are separate GLBs with the same skeleton (e.g. Meshy's per-animation exports);
 * their first clip is used for that key.
 */
export class GltfCharacter {
    readonly root = new THREE.Group();
    private mixer: THREE.AnimationMixer | null = null;
    private actions = new Map<ClipKey, THREE.AnimationAction>();
    private current: ClipKey | null = null;
    private readonly materials: THREE.Material[] = [];

    static async load(
        url: string,
        height: number,
        extraClips: Partial<Record<ClipKey, string>> = {},
    ): Promise<GltfCharacter> {
        const loader = new GLTFLoader();
        const [gltf, ...extras] = await Promise.all([
            loader.loadAsync(url),
            ...Object.entries(extraClips).map(async ([key, clipUrl]) => {
                try {
                    const clip = (await loader.loadAsync(clipUrl!))
                        .animations[0];

                    return clip ? { key: key as ClipKey, clip } : null;
                } catch (error) {
                    console.warn(`Failed to load ${key} animation`, error);

                    return null;
                }
            }),
        ]);
        const character = new GltfCharacter();
        const model = gltf.scene;

        // Normalise: feet at origin, requested height, facing -Z.
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const scale = height / Math.max(0.01, size.y);
        model.scale.setScalar(scale);
        model.position.y = -box.min.y * scale;
        model.rotation.y = Math.PI;
        // Shared materials are converted once.
        const converted = new Map<THREE.Material, THREE.Material>();
        const lit = (m: THREE.Material): THREE.Material => {
            let node = converted.get(m);

            if (!node) {
                node = toLitNodeMaterial(m, true);
                converted.set(m, node);
                m.dispose();
            }

            return node;
        };
        model.traverse((obj) => {
            const mesh = obj as THREE.Mesh;

            if (mesh.isMesh) {
                mesh.castShadow = true;
                mesh.receiveShadow = true;
                // Skinned meshes animate outside their bind-pose bounds.
                mesh.frustumCulled = false;
                mesh.material = Array.isArray(mesh.material)
                    ? mesh.material.map(lit)
                    : lit(mesh.material);
            }
        });
        character.materials.push(...converted.values());
        character.root.add(model);

        const extra = new Map<ClipKey, THREE.AnimationClip>();

        for (const item of extras) {
            if (item) {
                extra.set(item.key, item.clip);
            }
        }

        if (gltf.animations.length || extra.size) {
            character.mixer = new THREE.AnimationMixer(model);
            const find = (...names: string[]) =>
                gltf.animations.find((clip) =>
                    names.some((n) => clip.name.toLowerCase().includes(n)),
                );
            const mapping: Record<ClipKey, THREE.AnimationClip | undefined> = {
                idle: extra.get('idle') ?? find('idle', 'stand'),
                walk: extra.get('walk') ?? find('walk'),
                run: extra.get('run') ?? find('run', 'sprint', 'jog'),
                jump: extra.get('jump') ?? find('jump', 'fall', 'air'),
                swim: extra.get('swim') ?? find('swim', 'tread'),
            };
            mapping.idle ??= gltf.animations[0];
            // Rigged models without an idle clip: hold the first frame of the walk as a pose.
            mapping.idle ??= mapping.walk
                ? THREE.AnimationUtils.subclip(mapping.walk, 'idle', 0, 1, 30)
                : undefined;
            mapping.walk ??= mapping.run ?? mapping.idle;
            mapping.run ??= mapping.walk;
            mapping.jump ??= mapping.idle;
            mapping.swim ??= mapping.walk;

            for (const [key, clip] of Object.entries(mapping) as [
                ClipKey,
                THREE.AnimationClip | undefined,
            ][]) {
                if (clip) {
                    character.actions.set(
                        key,
                        character.mixer.clipAction(clip),
                    );
                }
            }
        }

        return character;
    }

    update(dt: number, state: CharacterAnimState): void {
        if (!this.mixer) {
            return;
        }

        let key: ClipKey = 'idle';

        if (state.swimming) {
            key = 'swim';
        } else if (!state.grounded) {
            key = 'jump';
        } else if (state.speed > state.runSpeed * 0.7) {
            key = 'run';
        } else if (state.speed > 0.3) {
            key = 'walk';
        }

        if (key !== this.current) {
            const next = this.actions.get(key);
            const prev = this.current ? this.actions.get(this.current) : null;

            if (next) {
                next.reset().fadeIn(0.25).play();
                prev?.fadeOut(0.25);
            }

            this.current = key;
        }

        const action = this.actions.get(key);

        if (action && (key === 'walk' || key === 'run')) {
            action.timeScale = THREE.MathUtils.clamp(
                state.speed /
                    (key === 'run' ? state.runSpeed : state.runSpeed * 0.45),
                0.5,
                1.6,
            );
        }

        this.mixer.update(dt);
    }

    setColor(): void {
        // Model materials are authored; nothing to tint.
    }

    dispose(): void {
        this.mixer?.stopAllAction();
        this.root.removeFromParent();
        this.root.traverse((obj) => {
            const mesh = obj as THREE.Mesh;

            if (mesh.isMesh) {
                mesh.geometry.dispose();
            }
        });

        for (const material of this.materials) {
            material.dispose();
        }
    }
}
