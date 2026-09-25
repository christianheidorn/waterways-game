import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { CharacterAnimState } from './CharacterModel';

type ClipKey = 'idle' | 'walk' | 'run' | 'jump' | 'swim';

/**
 * A rigged glTF character driven by its own animation clips. Clips are matched by name
 * (idle / walk / run / jump|fall / swim), falling back to the closest available clip.
 */
export class GltfCharacter {
    readonly root = new THREE.Group();
    private mixer: THREE.AnimationMixer | null = null;
    private actions = new Map<ClipKey, THREE.AnimationAction>();
    private current: ClipKey | null = null;

    static async load(url: string, height: number): Promise<GltfCharacter> {
        const gltf = await new GLTFLoader().loadAsync(url);
        const character = new GltfCharacter();
        const model = gltf.scene;

        // Normalise: feet at origin, requested height, facing -Z.
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const scale = height / Math.max(0.01, size.y);
        model.scale.setScalar(scale);
        model.position.y = -box.min.y * scale;
        model.rotation.y = Math.PI;
        model.traverse((obj) => {
            if ((obj as THREE.Mesh).isMesh) {
                obj.castShadow = true;
                obj.receiveShadow = true;
            }
        });
        character.root.add(model);

        if (gltf.animations.length) {
            character.mixer = new THREE.AnimationMixer(model);
            const find = (...names: string[]) =>
                gltf.animations.find((clip) =>
                    names.some((n) => clip.name.toLowerCase().includes(n)),
                );
            const mapping: Record<ClipKey, THREE.AnimationClip | undefined> = {
                idle: find('idle', 'stand') ?? gltf.animations[0],
                walk: find('walk'),
                run: find('run', 'sprint', 'jog'),
                jump: find('jump', 'fall', 'air'),
                swim: find('swim', 'tread'),
            };
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
    }
}
