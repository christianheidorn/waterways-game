import * as THREE from 'three';
import type { Input } from '../core/Input';
import type { PlayerSettings } from '../shared/types';
import type { Heightfield } from '../world/Heightfield';

/**
 * Orbiting over-the-shoulder camera with mouse look (pointer lock), wheel zoom and terrain collision.
 */
export class ThirdPersonCamera {
    yaw = 0;
    pitch = -0.25;
    private distance: number;
    private targetDistance: number;
    private pivot = new THREE.Vector3();
    private initialized = false;

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
    }

    update(
        dt: number,
        input: Input,
        focus: THREE.Vector3,
        heights: Heightfield,
        locked: boolean,
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

        const pos = this.pivot.clone().lerp(desired, t);
        pos.y = Math.max(pos.y, heights.sample(pos.x, pos.z) + 0.4);
        this.camera.position.copy(pos);
        this.camera.lookAt(this.pivot);
    }
}

const _up = new THREE.Vector3(0, 1, 0);
