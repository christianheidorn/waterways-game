import * as THREE from 'three';
import type { Input } from '../core/Input';
import type { Heightfield } from '../world/Heightfield';

/**
 * Unreal-style viewport camera:
 * - Right mouse + WASD/QE: fly, mouse look (wheel changes speed while flying)
 * - Middle mouse drag: pan
 * - Alt + left mouse: orbit around the point under the cursor
 * - Wheel: dolly towards the cursor
 * - F: frame the point under the cursor
 */
export class FlyCamera {
    yaw = 0;
    pitch = -0.45;
    speed: number;
    private velocity = new THREE.Vector3();
    private orbitPivot: THREE.Vector3 | null = null;
    private focusTarget: THREE.Vector3 | null = null;

    constructor(
        readonly camera: THREE.PerspectiveCamera,
        baseSpeed: number,
    ) {
        this.speed = baseSpeed;
    }

    setFromCamera(): void {
        const e = new THREE.Euler().setFromQuaternion(
            this.camera.quaternion,
            'YXZ',
        );
        this.yaw = e.y;
        this.pitch = e.x;
    }

    lookAt(target: THREE.Vector3): void {
        this.camera.lookAt(target);
        this.setFromCamera();
    }

    get flying(): boolean {
        return this.orbitPivot === null && this.focusTarget === null;
    }

    focus(point: THREE.Vector3, distance: number): void {
        const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(
            this.camera.quaternion,
        );
        this.focusTarget = point.clone().addScaledVector(dir, -distance);
    }

    update(
        dt: number,
        input: Input,
        heights: Heightfield,
        cursorHit: THREE.Vector3 | null,
    ): void {
        const rmb = input.buttons.has(2);
        const mmb = input.buttons.has(1);
        const orbit = input.alt && input.buttons.has(0);
        const cam = this.camera;

        if (rmb) {
            this.yaw -= input.deltaX * 0.0028;
            this.pitch -= input.deltaY * 0.0028;
            this.pitch = THREE.MathUtils.clamp(this.pitch, -1.55, 1.55);

            if (input.wheel !== 0) {
                this.speed = THREE.MathUtils.clamp(
                    this.speed * (input.wheel < 0 ? 1.25 : 0.8),
                    2,
                    5000,
                );
            }
        }

        if (orbit) {
            if (!this.orbitPivot) {
                this.orbitPivot =
                    cursorHit?.clone() ??
                    cam.position
                        .clone()
                        .add(
                            new THREE.Vector3(0, 0, -50).applyQuaternion(
                                cam.quaternion,
                            ),
                        );
            }

            const offset = cam.position.clone().sub(this.orbitPivot);
            const spherical = new THREE.Spherical().setFromVector3(offset);
            spherical.theta -= input.deltaX * 0.005;
            spherical.phi = THREE.MathUtils.clamp(
                spherical.phi - input.deltaY * 0.005,
                0.05,
                Math.PI - 0.05,
            );
            cam.position
                .copy(this.orbitPivot)
                .add(new THREE.Vector3().setFromSpherical(spherical));
            cam.lookAt(this.orbitPivot);
            this.setFromCamera();
        } else {
            this.orbitPivot = null;
        }

        if (!orbit) {
            cam.quaternion.setFromEuler(
                new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'),
            );
        }

        const boost = input.shift ? 3 : 1;
        const move = new THREE.Vector3();

        if (rmb) {
            if (input.isDown('KeyW')) move.z -= 1;
            if (input.isDown('KeyS')) move.z += 1;
            if (input.isDown('KeyA')) move.x -= 1;
            if (input.isDown('KeyD')) move.x += 1;
            if (input.isDown('KeyE')) move.y += 1;
            if (input.isDown('KeyQ')) move.y -= 1;
        }

        if (move.lengthSq() > 0) {
            this.focusTarget = null;
            move.normalize().applyQuaternion(cam.quaternion);
        }

        const target = move.multiplyScalar(this.speed * boost);
        this.velocity.lerp(target, 1 - Math.exp(-dt * 10));
        cam.position.addScaledVector(this.velocity, dt);

        if (mmb) {
            const altitude = Math.max(
                10,
                cam.position.y - heights.sample(cam.position.x, cam.position.z),
            );
            const panScale = altitude * 0.0018;
            const right = new THREE.Vector3(1, 0, 0).applyQuaternion(
                cam.quaternion,
            );
            const up = new THREE.Vector3(0, 1, 0).applyQuaternion(
                cam.quaternion,
            );
            cam.position.addScaledVector(right, -input.deltaX * panScale);
            cam.position.addScaledVector(up, input.deltaY * panScale);
        }

        if (!rmb && input.wheel !== 0 && input.pointerOverCanvas) {
            this.focusTarget = null;
            const toward = cursorHit
                ? cursorHit.clone().sub(cam.position)
                : new THREE.Vector3(0, 0, -1)
                      .applyQuaternion(cam.quaternion)
                      .multiplyScalar(100);
            const dist = toward.length();
            const step = Math.max(1, dist * 0.14) * -input.wheel;

            if (step < 0 || dist > 3) {
                cam.position.addScaledVector(
                    toward.normalize(),
                    Math.min(step, dist - 2),
                );
            }
        }

        if (this.focusTarget) {
            cam.position.lerp(this.focusTarget, 1 - Math.exp(-dt * 8));

            if (cam.position.distanceTo(this.focusTarget) < 0.5) {
                this.focusTarget = null;
            }
        }

        // Never go below the ground.
        const ground = heights.sample(cam.position.x, cam.position.z);

        if (cam.position.y < ground + 1.5) {
            cam.position.y = ground + 1.5;
        }

        cam.updateMatrixWorld();
    }
}
