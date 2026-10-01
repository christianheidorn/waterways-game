import * as THREE from 'three/webgpu';
import type { CharacterRef, PlayerSettings } from '../shared/types';
import type { Input } from '../core/Input';
import type { Heightfield } from '../world/Heightfield';
import { STEP_HEIGHT } from '../world/collision/Collision';
import type { Capsule, CollisionWorld } from '../world/collision/Collision';
import { CharacterModel } from './CharacterModel';
import { GltfCharacter } from './GltfCharacter';
import {
    Breath,
    buoyancy,
    CLIMB_MAX,
    CLIMB_TIME,
    climbEase,
    climbTarget,
    floatDepth,
    HEAD_UNDER,
    shouldSwim,
    swimVelocity,
} from './swimming';
import { wadeSpeedFactor } from './wading';

export type PlayerEnvironment = {
    heights: Heightfield;
    waterLevelAt: (x: number, z: number) => number | null;
    /** Foliage and prop colliders (none: only the terrain collides). */
    collision?: CollisionWorld | null;
    /**
     * The water surface with its waves and current (Water.sampleSurface); without it swimmers float
     * on the still level.
     */
    surfaceAt?: (
        x: number,
        z: number,
    ) => { height: number; velocity: { x: number; z: number } } | null;
};

type Avatar = {
    root: THREE.Object3D;
    update: CharacterModel['update'];
    setColor: (color: THREE.ColorRepresentation) => void;
    dispose: () => void;
};

/**
 * Third-person character controller: walking/running on the heightfield with a slope limit,
 * jumping, and swimming wherever the water is deep enough. With a CollisionWorld the character is a
 * capsule: it slides along trunks, rocks and walls, steps up ledges up to STEP_HEIGHT and stands on
 * props and rocks. Movement is split into substeps of half the capsule radius, so sprinting never
 * tunnels through a thin trunk.
 */
export class Player {
    readonly object = new THREE.Group();
    readonly position = new THREE.Vector3();
    readonly velocity = new THREE.Vector3();
    /** Facing direction around Y (radians); 0 faces -Z. */
    yaw = 0;
    grounded = false;
    swimming = false;
    /** Water above the feet while walking (m; 0 on dry ground or swimming). */
    wadeDepth = 0;
    /** Swimming below the surface (diving, or still on the way back up). */
    diving = false;
    /** The head is under water. */
    headUnder = false;
    /** Water surface (with waves) at the character, null where dry. */
    surfaceHeight: number | null = null;
    /** Breath under water (1 full … 0 empty: the character has to surface). */
    readonly breath = new Breath();
    /** Climbing out of the water onto a bank or jetty (null when not). */
    private climb: {
        from: THREE.Vector3;
        to: THREE.Vector3;
        t: number;
    } | null = null;
    /** Body pitch (radians) while swimming up or down. */
    private bodyPitch = 0;
    /** Pivot at the hips that pitches the body while diving. */
    private readonly pitchPivot = new THREE.Group();
    private readonly pitchInner = new THREE.Group();
    private avatar: Avatar;
    private settings: PlayerSettings;
    private modelUrl: string | null = null;
    /** Library character (manifest.character); wins over settings.character_model_url. */
    private character: CharacterRef | null = null;
    private jumpBuffered = 0;
    private coyote = 0;
    private readonly normals: number[] = [];

    constructor(
        settings: PlayerSettings,
        character: CharacterRef | null = null,
    ) {
        this.settings = settings;
        this.character = character;
        this.object.name = 'Player';
        const model = new CharacterModel(settings.character_color);
        this.avatar = model;
        this.object.add(this.pitchPivot);
        this.pitchPivot.add(this.pitchInner);
        this.pitchInner.add(model.root);
        this.applySettings(settings);
    }

    /** Switch to a library character (null = back to settings.character_model_url / default). */
    setCharacter(character: CharacterRef | null): void {
        this.character = character;
        this.applySettings(this.settings);
    }

    applySettings(settings: PlayerSettings): void {
        this.settings = settings;
        this.avatar.setColor(settings.character_color);

        const url = this.character?.model_url ?? settings.character_model_url;

        if (url !== this.modelUrl) {
            this.modelUrl = url;
            void this.loadModel(url);
        }

        const scale = settings.character_height / 1.8;
        // Body pitch turns about the hips.
        this.pitchPivot.position.y = settings.character_height * 0.55;
        this.pitchInner.position.y = -settings.character_height * 0.55;

        if (this.avatar instanceof CharacterModel) {
            this.avatar.root.scale.setScalar(scale);
        }
    }

    spawn(x: number, z: number, yaw: number, env: PlayerEnvironment): void {
        this.position.set(x, env.heights.sample(x, z), z);
        const water = env.waterLevelAt(x, z);

        if (water !== null && water > this.position.y) {
            this.position.y =
                water - floatDepth(this.settings.character_height);
        }

        this.velocity.set(0, 0, 0);
        this.yaw = yaw;
        this.climb = null;
        this.diving = false;
        this.breath.reset();
        this.syncObject();
    }

    /**
     * @param cameraYaw yaw of the camera so movement is camera-relative
     * @param cameraPitch pitch of the camera (swimming under water follows the view)
     */
    update(
        dt: number,
        input: Input,
        cameraYaw: number,
        env: PlayerEnvironment,
        cameraPitch = 0,
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
        const sample =
            water !== null
                ? (env.surfaceAt?.(this.position.x, this.position.z) ?? null)
                : null;
        const surface = sample ? sample.height : (water ?? 0);
        this.surfaceHeight = water !== null ? surface : null;
        const height = s.character_height;

        if (this.climb) {
            this.updateClimb(dt, s.run_speed);

            return;
        }

        this.swimming = shouldSwim(
            water,
            surface,
            ground,
            this.position.y,
            height,
            this.swimming,
        );
        this.headUnder =
            water !== null &&
            this.position.y + height * 0.9 < surface - HEAD_UNDER;
        this.breath.update(dt, this.headUnder);

        if (this.swimming && water !== null) {
            this.wadeDepth = 0;
            const floatY = surface - floatDepth(height);
            const diveKey =
                input.isDown('KeyC') ||
                input.isDown('ControlLeft') ||
                input.isDown('ControlRight');
            const down = diveKey && !this.breath.empty;
            const up = input.isDown('Space') || this.breath.empty;
            const submerged = this.position.y < floatY - 0.35 || down;
            this.diving = submerged;
            const target = swimVelocity(
                { forward, strafe, up: up && submerged, down, sprint: running },
                cameraYaw,
                cameraPitch,
                submerged,
                s.swim_speed,
                _swim,
            );
            // Rivers carry the swimmer along.
            const drift = sample?.velocity;
            const accel = 1 - Math.exp(-dt * 3);
            this.velocity.x +=
                (target.x + (drift?.x ?? 0) * 0.7 - this.velocity.x) * accel;
            this.velocity.z +=
                (target.z + (drift?.z ?? 0) * 0.7 - this.velocity.z) * accel;
            const active =
                submerged && (down || up || Math.abs(target.y) > 0.05);
            this.velocity.y +=
                buoyancy(
                    this.position.y,
                    this.velocity.y,
                    floatY,
                    target.y,
                    active,
                ) * dt;

            // Space at the surface: a hop (out of the water onto a low bank, or just a splash).
            if (
                !submerged &&
                this.jumpBuffered > 0 &&
                Math.abs(this.position.y - floatY) < 0.35
            ) {
                this.velocity.y = s.jump_velocity * 0.7;
                this.jumpBuffered = 0;
            }

            this.grounded = false;

            if (!submerged && wish.lengthSq() > 0.04) {
                this.tryClimbOut(wish, surface, hf, env.collision ?? null);

                if (this.climb) {
                    this.updateClimb(dt, s.run_speed);

                    return;
                }
            }
        } else {
            this.diving = false;
            // Wading: deeper water slows the legs down.
            this.wadeDepth =
                water !== null ? Math.max(0, water - this.position.y) : 0;
            const speed =
                (running ? s.run_speed : s.walk_speed) *
                wadeSpeedFactor(this.wadeDepth, s.character_height);
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
            }
        }

        const collision = env.collision?.enabled ? env.collision : null;
        const capsule = this.capsule();
        const travel = Math.hypot(this.velocity.x, this.velocity.z) * dt;
        const steps = collision
            ? Math.min(
                  16,
                  Math.max(1, Math.ceil(travel / (capsule.radius * 0.5))),
              )
            : 1;

        for (let i = 0; i < steps; i++) {
            this.integrate(dt / steps, hf, collision, capsule);
        }

        const hs = Math.hypot(this.velocity.x, this.velocity.z);

        if (hs > 0.2) {
            const targetYaw = Math.atan2(-this.velocity.x, -this.velocity.z);
            this.yaw = dampAngle(this.yaw, targetYaw, 12, dt);
        }

        // Swimming up / down pitches the body (about the hips).
        const pitchTarget =
            this.swimming && this.diving
                ? THREE.MathUtils.clamp(
                      Math.atan2(this.velocity.y, Math.max(hs, 0.4)),
                      -1.1,
                      1.1,
                  )
                : 0;
        this.bodyPitch +=
            (pitchTarget - this.bodyPitch) * (1 - Math.exp(-dt * 5));
        this.pitchPivot.rotation.x = this.bodyPitch;
        this.syncObject();
        this.avatar.update(dt, {
            speed: this.swimming ? Math.hypot(hs, this.velocity.y) : hs,
            runSpeed: s.run_speed,
            grounded: this.grounded,
            swimming: this.swimming,
            verticalVelocity: this.velocity.y,
        });
    }

    /**
     * Pushing against a bank or jetty at the surface: when the ledge ahead is at most CLIMB_MAX above
     * the water, the character pulls itself out (updateClimb animates it).
     */
    private tryClimbOut(
        wish: THREE.Vector3,
        surface: number,
        hf: Heightfield,
        collision: CollisionWorld | null,
    ): void {
        const r = this.capsule().radius;
        const len = Math.hypot(wish.x, wish.z);
        const dx = wish.x / len;
        const dz = wish.z / len;
        const reach = r + 0.45;
        const ax = this.position.x + dx * reach;
        const az = this.position.z + dz * reach;

        if (!hf.contains(ax, az)) {
            return;
        }

        let ledge = hf.sample(ax, az);
        let onCollider = false;

        if (collision?.enabled) {
            const top = collision.supportHeight(
                ax,
                az,
                r * 0.6,
                surface + CLIMB_MAX,
            );

            if (top > ledge) {
                ledge = top;
                onCollider = true;
            }
        }

        const target = climbTarget(ledge, surface, this.position.y);

        // Not up a cliff face: the ground there must be walkable.
        if (
            target === null ||
            (!onCollider && hf.slope(ax, az) > this.settings.max_slope + 10)
        ) {
            return;
        }

        // Stand clear of the edge.
        const stand = r * 0.6;
        this.climb = {
            from: this.position.clone(),
            to: new THREE.Vector3(ax + dx * stand, target, az + dz * stand),
            t: 0,
        };
        this.yaw = Math.atan2(-dx, -dz);
        this.velocity.set(0, 0, 0);
        this.swimming = false;
        this.diving = false;
    }

    private updateClimb(dt: number, runSpeed: number): void {
        const c = this.climb!;
        c.t = Math.min(1, c.t + dt / CLIMB_TIME);
        const e = climbEase(c.t);
        this.position.set(
            c.from.x + (c.to.x - c.from.x) * e.forward,
            c.from.y + (c.to.y - c.from.y) * e.up,
            c.from.z + (c.to.z - c.from.z) * e.forward,
        );
        this.wadeDepth = 0;

        if (c.t >= 1) {
            this.climb = null;
            this.grounded = true;
        }

        this.bodyPitch *= 1 - Math.min(1, dt * 8);
        this.pitchPivot.rotation.x = this.bodyPitch;
        this.syncObject();
        this.avatar.update(dt, {
            speed: 0.5,
            runSpeed,
            grounded: c.t > 0.6,
            swimming: false,
            verticalVelocity: c.t < 0.6 ? 2 : 0,
        });
    }

    /** Climbing out of the water right now. */
    get climbing(): boolean {
        return this.climb !== null;
    }

    /** The collision capsule (radius from the character height). */
    capsule(): Capsule {
        const h = this.settings.character_height;

        return {
            radius: THREE.MathUtils.clamp(h * 0.17, 0.15, 0.6),
            height: h,
            step: STEP_HEIGHT,
        };
    }

    /** Moves by the velocity for `dt`: colliders, map bounds, ground (terrain or what it stands on). */
    private integrate(
        dt: number,
        hf: Heightfield,
        collision: CollisionWorld | null,
        capsule: Capsule,
    ): void {
        const s = this.settings;
        const next = _next
            .copy(this.position)
            .addScaledVector(this.velocity, dt);

        // Keep inside the map.
        const limit = hf.half - 1;
        next.x = THREE.MathUtils.clamp(next.x, -limit, limit);
        next.z = THREE.MathUtils.clamp(next.z, -limit, limit);

        let groundAtNext = hf.sample(next.x, next.z);
        let onCollider = false;

        if (collision) {
            const { normals, ceiling } = collision.resolveCapsule(
                next,
                capsule,
                this.normals,
            );

            // Slide: drop the part of the velocity going into what was hit.
            for (let k = 0; k < normals.length; k += 2) {
                const into =
                    this.velocity.x * normals[k] +
                    this.velocity.z * normals[k + 1];

                if (into < 0) {
                    this.velocity.x -= normals[k] * into;
                    this.velocity.z -= normals[k + 1] * into;
                }
            }

            if (ceiling && this.velocity.y > 0) {
                this.velocity.y = 0;
            }

            next.x = THREE.MathUtils.clamp(next.x, -limit, limit);
            next.z = THREE.MathUtils.clamp(next.z, -limit, limit);
            groundAtNext = hf.sample(next.x, next.z);
            // Step up onto (or land on) rocks, props and floors no higher than a step.
            const top = collision.supportHeight(
                next.x,
                next.z,
                capsule.radius,
                Math.max(this.position.y, next.y) + capsule.step,
            );

            if (top > groundAtNext) {
                groundAtNext = top;
                onCollider = true;
            }
        }

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
        if (
            this.grounded &&
            !onCollider &&
            hf.slope(next.x, next.z) > s.max_slope + 5
        ) {
            const n = hf.normal(next.x, next.z, _n);
            this.velocity.x += n.x * s.gravity * dt;
            this.velocity.z += n.z * s.gravity * dt;
        }

        this.position.copy(next);
    }

    get height(): number {
        return this.settings.character_height;
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

    private syncObject(): void {
        this.object.position.copy(this.position);
        this.object.rotation.y = this.yaw;
    }

    private async loadModel(url: string | null): Promise<void> {
        let next: Avatar;

        if (url) {
            try {
                const library =
                    this.character?.model_url === url ? this.character : null;
                next = await GltfCharacter.load(
                    url,
                    library?.height ?? this.settings.character_height,
                    library?.animations ?? {},
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

        this.pitchInner.remove(this.avatar.root);
        this.avatar.dispose();
        this.avatar = next;
        this.pitchInner.add(next.root);
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
const _next = new THREE.Vector3();
const _swim = { x: 0, y: 0, z: 0 };
