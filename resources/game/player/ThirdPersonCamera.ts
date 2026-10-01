import * as THREE from 'three/webgpu';
import type { Input } from '../core/Input';
import type { PlayerSettings } from '../shared/types';
import type { Heightfield } from '../world/Heightfield';
import type { CollisionWorld } from '../world/collision/Collision';

/** Distance (m) the camera keeps in front of a trunk or wall it would otherwise clip into. */
const WALL_MARGIN = 0.3;
/** Distance (m) the camera keeps from the water surface (the lens never sits on the waterline). */
const WATER_MARGIN = 0.3;

/** The water around the camera: its surface height (null where dry) and which side the view belongs on. */
export type CameraWater = {
    surfaceAt: (x: number, z: number) => number | null;
    /** The character is under water (diving): the camera follows it below the surface. */
    under: boolean;
};

/**
 * Orbiting over-the-shoulder camera with mouse look (pointer lock), wheel zoom and terrain collision.
 * With a CollisionWorld it also pulls in (at once) in front of trunks, rocks and buildings between it
 * and the character, and eases back out once the view is clear.
 */
export class ThirdPersonCamera {
    yaw = 0;
    pitch = -0.25;
    private distance: number;
    private targetDistance: number;
    private pivot = new THREE.Vector3();
    private initialized = false;
    /** Current share (0…1) of the desired distance the camera may use (collision pull-in). */
    private reach = 1;
    /** Eased vertical correction (m) that keeps the camera off the waterline. */
    private waterShift = 0;

    constructor(
        readonly camera: THREE.PerspectiveCamera,
        private settings: PlayerSettings,
    ) {
        this.distance = this.targetDistance = settings.camera_distance;
    }

    applySettings(settings: PlayerSettings): void {
        this.settings = settings;
        this.targetDistance = settings.camera_distance;
        this.camera.fov = settings.fov;
        this.camera.updateProjectionMatrix();
    }

    reset(yaw: number): void {
        this.yaw = yaw;
        this.pitch = -0.2;
        this.initialized = false;
        this.reach = 1;
        this.waterShift = 0;
    }

    update(
        dt: number,
        input: Input,
        focus: THREE.Vector3,
        heights: Heightfield,
        locked: boolean,
        collision: CollisionWorld | null = null,
        water: CameraWater | null = null,
    ): void {
        const s = this.settings;

        if (locked) {
            const sens = 0.0022 * s.mouse_sensitivity;
            this.yaw -= input.deltaX * sens;
            this.pitch -= input.deltaY * sens * (s.invert_y ? -1 : 1);
        }

        this.pitch = THREE.MathUtils.clamp(this.pitch, -1.35, 0.85);

        if (input.wheel !== 0) {
            this.targetDistance = THREE.MathUtils.clamp(
                this.targetDistance * (1 + input.wheel * 0.12),
                1.2,
                40,
            );
        }

        this.distance +=
            (this.targetDistance - this.distance) * (1 - Math.exp(-dt * 10));

        const pivotTarget = focus.clone();
        pivotTarget.y += s.camera_height - s.character_height * 0.9;

        if (!this.initialized) {
            this.pivot.copy(pivotTarget);
            this.initialized = true;
        } else {
            this.pivot.lerp(pivotTarget, 1 - Math.exp(-dt * 18));
        }

        const offset = new THREE.Vector3(0, 0, this.distance).applyEuler(
            new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'),
        );
        // Over-the-shoulder shift.
        const right = new THREE.Vector3(1, 0, 0).applyAxisAngle(_up, this.yaw);
        const desired = this.pivot
            .clone()
            .add(offset)
            .addScaledVector(right, Math.min(0.6, this.distance * 0.08));

        // Pull the camera in if terrain is between it and the pivot.
        let t = 1;

        for (let i = 1; i <= 12; i++) {
            const f = i / 12;
            const p = this.pivot.clone().lerp(desired, f);

            if (p.y < heights.sample(p.x, p.z) + 0.4) {
                t = Math.max(0.05, (i - 1) / 12);
                break;
            }
        }

        if (collision?.enabled) {
            const hit = collision.raycast(this.pivot, desired);

            if (hit) {
                const length = Math.max(1e-3, this.pivot.distanceTo(desired));
                t = Math.min(t, Math.max(0.02, hit.t - WALL_MARGIN / length));
            }
        }

        // Pull in at once, ease back out.
        this.reach =
            t < this.reach
                ? t
                : this.reach + (t - this.reach) * (1 - Math.exp(-dt * 4));

        const pos = this.pivot.clone().lerp(desired, this.reach);
        const floor = heights.sample(pos.x, pos.z) + 0.4;
        pos.y = Math.max(pos.y, floor);

        // Stay on the character's side of the water surface: above while it swims at the surface,
        // below while it dives. The correction eases in, so surfacing / diving sweeps the lens through
        // the waterline once instead of hovering on it.
        let shift = 0;
        const surface = water?.surfaceAt(pos.x, pos.z) ?? null;

        if (surface !== null && water) {
            if (water.under && surface - WATER_MARGIN > floor) {
                shift = Math.min(0, surface - WATER_MARGIN - pos.y);
            } else if (!water.under) {
                shift = Math.max(0, surface + WATER_MARGIN - pos.y);
            }
        }

        this.waterShift += (shift - this.waterShift) * (1 - Math.exp(-dt * 6));
        pos.y = Math.max(pos.y + this.waterShift, floor);
        this.camera.position.copy(pos);
        this.camera.lookAt(this.pivot);
    }
}

const _up = new THREE.Vector3(0, 1, 0);
