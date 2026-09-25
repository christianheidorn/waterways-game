import * as THREE from 'three';
import type { PlayerSettings } from '../shared/types';
import type { Input } from '../core/Input';
import type { Heightfield } from '../world/Heightfield';
import { CharacterModel } from './CharacterModel';
import { GltfCharacter } from './GltfCharacter';

export type PlayerEnvironment = {
    heights: Heightfield;
    waterLevelAt: (x: number, z: number) => number | null;
};

type Avatar = {
    root: THREE.Object3D;
    update: CharacterModel['update'];
    setColor: (color: THREE.ColorRepresentation) => void;
    dispose: () => void;
};

/**
 * Third-person character controller: walking/running on the heightfield with a slope limit,
 * jumping, and swimming wherever the water is deep enough.
 */
export class Player {
    readonly object = new THREE.Group();
    readonly position = new THREE.Vector3();
    readonly velocity = new THREE.Vector3();
    /** Facing direction around Y (radians); 0 faces -Z. */
    yaw = 0;
    grounded = false;
    swimming = false;
    private avatar: Avatar;
    private settings: PlayerSettings;
    private modelUrl: string | null = null;
    private jumpBuffered = 0;
    private coyote = 0;

    constructor(settings: PlayerSettings) {
        this.settings = settings;
        this.object.name = 'Player';
        const model = new CharacterModel(settings.character_color);
        this.avatar = model;
        this.object.add(model.root);
        this.applySettings(settings);
    }

    applySettings(settings: PlayerSettings): void {
        this.settings = settings;
        this.avatar.setColor(settings.character_color);

        if (settings.character_model_url !== this.modelUrl) {
            this.modelUrl = settings.character_model_url;
            void this.loadModel(settings.character_model_url);
        }

        const scale = settings.character_height / 1.8;

        if (this.avatar instanceof CharacterModel) {
            this.avatar.root.scale.setScalar(scale);
        }
    }

    spawn(x: number, z: number, yaw: number, env: PlayerEnvironment): void {
        this.position.set(x, env.heights.sample(x, z), z);
        const water = env.waterLevelAt(x, z);

        if (water !== null && water > this.position.y) {
            this.position.y = water - this.swimDepth();
        }

        this.velocity.set(0, 0, 0);
        this.yaw = yaw;
        this.syncObject();
    }

    /**
     * @param cameraYaw yaw of the camera so movement is camera-relative
     */
    update(
        dt: number,
        input: Input,
        cameraYaw: number,
        env: PlayerEnvironment,
    ): void {
        const s = this.settings;
        const hf = env.heights;

        // Movement intent in camera space.
        const forward =
            (input.isDown('KeyW') || input.isDown('ArrowUp') ? 1 : 0) -
            (input.isDown('KeyS') || input.isDown('ArrowDown') ? 1 : 0);
        const strafe =
            (input.isDown('KeyD') || input.isDown('ArrowRight') ? 1 : 0) -
            (input.isDown('KeyA') || input.isDown('ArrowLeft') ? 1 : 0);
        const running = input.shift;
        const wish = new THREE.Vector3(strafe, 0, -forward);

        if (wish.lengthSq() > 1) {
            wish.normalize();
        }

        wish.applyAxisAngle(_up, cameraYaw);

        if (input.wasPressed('Space')) {
            this.jumpBuffered = 0.15;
        }

        this.jumpBuffered = Math.max(0, this.jumpBuffered - dt);

        const ground = hf.sample(this.position.x, this.position.z);
        const water = env.waterLevelAt(this.position.x, this.position.z);
        const swimDepth = this.swimDepth();
        this.swimming =
            water !== null &&
            water - ground > swimDepth * 0.9 &&
            this.position.y < water - swimDepth * 0.6;

        if (this.swimming && water !== null) {
            const speed = s.swim_speed * (running ? 1.6 : 1);
            const accel = 1 - Math.exp(-dt * 3);
            this.velocity.x += (wish.x * speed - this.velocity.x) * accel;
            this.velocity.z += (wish.z * speed - this.velocity.z) * accel;
            // Buoyancy towards floating depth, dive with C, surface / leap out with Space.
            const targetY =
                water - swimDepth + (input.isDown('KeyC') ? -2.5 : 0);
            this.velocity.y +=
                ((targetY - this.position.y) * 4 - this.velocity.y * 2.5) * dt;

            if (
                this.jumpBuffered > 0 &&
                Math.abs(this.position.y - (water - swimDepth)) < 0.3
            ) {
                this.velocity.y = s.jump_velocity * 0.7;
                this.jumpBuffered = 0;
            }

            this.grounded = false;
        } else {
            const speed = running ? s.run_speed : s.walk_speed;
            const control = this.grounded
                ? 1 - Math.exp(-dt * 12)
                : 1 - Math.exp(-dt * 2);
            this.velocity.x += (wish.x * speed - this.velocity.x) * control;
            this.velocity.z += (wish.z * speed - this.velocity.z) * control;
            this.velocity.y -= s.gravity * dt;

            this.coyote = this.grounded ? 0.12 : Math.max(0, this.coyote - dt);

            if (this.jumpBuffered > 0 && this.coyote > 0) {
                this.velocity.y = s.jump_velocity;
                this.grounded = false;
                this.coyote = 0;
                this.jumpBuffered = 0;
            }
        }

        // Slope limit: block horizontal motion into terrain steeper than max_slope.
        const next = this.position.clone().addScaledVector(this.velocity, dt);
        const nextGround = hf.sample(next.x, next.z);
        const horiz = Math.hypot(
            next.x - this.position.x,
            next.z - this.position.z,
        );

        if (!this.swimming && this.grounded && horiz > 1e-4) {
            const rise = nextGround - ground;
            const slope = THREE.MathUtils.radToDeg(Math.atan2(rise, horiz));

            if (slope > s.max_slope) {
                // Slide along the contour instead of climbing.
                const n = hf.normal(this.position.x, this.position.z, _n);
                const push = new THREE.Vector3(n.x, 0, n.z).normalize();
                const into =
                    this.velocity.x * push.x + this.velocity.z * push.z;

                if (into < 0) {
                    this.velocity.x -= push.x * into;
                    this.velocity.z -= push.z * into;
                }

                next.copy(this.position).addScaledVector(this.velocity, dt);
            }
        }

        // Keep inside the map.
        const limit = hf.half - 1;
        next.x = THREE.MathUtils.clamp(next.x, -limit, limit);
        next.z = THREE.MathUtils.clamp(next.z, -limit, limit);

        const groundAtNext = hf.sample(next.x, next.z);

        if (next.y <= groundAtNext) {
            next.y = groundAtNext;

            if (this.velocity.y < 0) {
                this.velocity.y = 0;
            }

            this.grounded = true;
        } else if (
            !this.swimming &&
            this.grounded &&
            next.y - groundAtNext < 0.35 &&
            this.velocity.y <= 0
        ) {
            // Stick to the ground when walking downhill.
            next.y = groundAtNext;
            this.velocity.y = 0;
        } else {
            this.grounded = false;
        }

        // Steep ground slides the player down.
        if (this.grounded && hf.slope(next.x, next.z) > s.max_slope + 5) {
            const n = hf.normal(next.x, next.z, _n);
            this.velocity.x += n.x * s.gravity * dt;
            this.velocity.z += n.z * s.gravity * dt;
        }

        this.position.copy(next);

        const hs = Math.hypot(this.velocity.x, this.velocity.z);

        if (hs > 0.2) {
            const targetYaw = Math.atan2(-this.velocity.x, -this.velocity.z);
            this.yaw = dampAngle(this.yaw, targetYaw, 12, dt);
        }

        this.syncObject();
        this.avatar.update(dt, {
            speed: hs,
            runSpeed: s.run_speed,
            grounded: this.grounded,
            swimming: this.swimming,
            verticalVelocity: this.velocity.y,
        });
    }

    /** Eye/camera pivot point. */
    headPosition(target = new THREE.Vector3()): THREE.Vector3 {
        return target
            .copy(this.position)
            .setY(this.position.y + this.settings.character_height * 0.9);
    }

    dispose(): void {
        this.avatar.dispose();
    }

    private swimDepth(): number {
        return this.settings.character_height * 0.64;
    }

    private syncObject(): void {
        this.object.position.copy(this.position);
        this.object.rotation.y = this.yaw;
    }

    private async loadModel(url: string | null): Promise<void> {
        let next: Avatar;

        if (url) {
            try {
                next = await GltfCharacter.load(
                    url,
                    this.settings.character_height,
                );
            } catch (error) {
                console.warn(
                    'Failed to load character model, using the default character.',
                    error,
                );

                return;
            }
        } else if (this.avatar instanceof CharacterModel) {
            return;
        } else {
            next = new CharacterModel(this.settings.character_color);
        }

        if (url !== this.modelUrl) {
            next.dispose();

            return;
        }

        this.object.remove(this.avatar.root);
        this.avatar.dispose();
        this.avatar = next;
        this.object.add(next.root);
        this.applySettings(this.settings);
    }
}

function dampAngle(
    current: number,
    target: number,
    lambda: number,
    dt: number,
): number {
    let delta = ((target - current + Math.PI) % (Math.PI * 2)) - Math.PI;

    if (delta < -Math.PI) {
        delta += Math.PI * 2;
    }

    return current + delta * (1 - Math.exp(-lambda * dt));
}

const _up = new THREE.Vector3(0, 1, 0);
const _n = new THREE.Vector3();
