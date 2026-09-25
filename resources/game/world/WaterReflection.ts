import * as THREE from 'three';

/**
 * Planar reflection for the water level nearest to the viewer (lakes, sea, calm rivers).
 * Renders the scene from a camera mirrored across the plane y = level with an oblique near plane
 * (so nothing below the water leaks into the reflection) into a half-resolution texture.
 * Adapted from three.js' Reflector.
 */
export class WaterReflection {
    readonly target: THREE.WebGLRenderTarget;
    readonly textureMatrix = new THREE.Matrix4();
    readonly camera = new THREE.PerspectiveCamera();
    level = 0;
    active = false;
    private scale = 0.5;
    private readonly plane = new THREE.Plane();
    private readonly normal = new THREE.Vector3(0, 1, 0);
    private readonly clipPlane = new THREE.Vector4();
    private readonly q = new THREE.Vector4();
    private readonly view = new THREE.Vector3();
    private readonly target3 = new THREE.Vector3();
    private readonly lookAt = new THREE.Vector3();
    private readonly rotation = new THREE.Matrix4();

    constructor() {
        this.target = new THREE.WebGLRenderTarget(1, 1, {
            type: THREE.HalfFloatType,
        });
        this.target.texture.generateMipmaps = false;
        this.target.texture.minFilter = THREE.LinearFilter;
    }

    setSize(width: number, height: number, scale: number): void {
        this.scale = scale;
        this.target.setSize(
            Math.max(1, Math.round(width * scale)),
            Math.max(1, Math.round(height * scale)),
        );
    }

    get enabled(): boolean {
        return this.scale > 0;
    }

    /**
     * Renders the reflection. `hide` is called before rendering to hide objects that must not be
     * reflected (water itself, dense grass) and `restore` afterwards.
     */
    render(
        renderer: THREE.WebGLRenderer,
        scene: THREE.Scene,
        camera: THREE.PerspectiveCamera,
        hide: () => void,
        restore: () => void,
    ): void {
        const plane = this.plane.setFromNormalAndCoplanarPoint(
            this.normal,
            new THREE.Vector3(0, this.level, 0),
        );

        // Camera below the water: no reflection.
        if (camera.position.y <= this.level + 0.05) {
            this.active = false;

            return;
        }

        const reflect = this.camera;
        const mirrorPos = new THREE.Vector3(
            camera.position.x,
            2 * this.level - camera.position.y,
            camera.position.z,
        );

        this.rotation.extractRotation(camera.matrixWorld);
        this.lookAt
            .set(0, 0, -1)
            .applyMatrix4(this.rotation)
            .add(camera.position);
        this.target3.copy(this.lookAt);
        this.target3.y = 2 * this.level - this.target3.y;
        const up = new THREE.Vector3(0, 1, 0).applyMatrix4(this.rotation);
        up.y = -up.y;

        reflect.position.copy(mirrorPos);
        reflect.up.copy(up);
        reflect.lookAt(this.target3);
        reflect.near = camera.near;
        reflect.far = camera.far;
        reflect.fov = camera.fov;
        reflect.aspect = camera.aspect;
        reflect.layers.mask = camera.layers.mask;
        reflect.updateMatrixWorld();
        reflect.updateProjectionMatrix();

        this.textureMatrix.set(
            0.5,
            0,
            0,
            0.5,
            0,
            0.5,
            0,
            0.5,
            0,
            0,
            0.5,
            0.5,
            0,
            0,
            0,
            1,
        );
        this.textureMatrix.multiply(reflect.projectionMatrix);
        this.textureMatrix.multiply(reflect.matrixWorldInverse);

        // Oblique near plane = water plane (Lengyel), with a small bias to hide seams.
        plane.applyMatrix4(reflect.matrixWorldInverse);
        this.clipPlane.set(
            plane.normal.x,
            plane.normal.y,
            plane.normal.z,
            plane.constant,
        );
        const p = reflect.projectionMatrix.elements;
        this.q.x = (Math.sign(this.clipPlane.x) + p[8]) / p[0];
        this.q.y = (Math.sign(this.clipPlane.y) + p[9]) / p[5];
        this.q.z = -1;
        this.q.w = (1 + p[10]) / p[14];
        this.clipPlane.multiplyScalar(2 / this.clipPlane.dot(this.q));
        p[2] = this.clipPlane.x;
        p[6] = this.clipPlane.y;
        p[10] = this.clipPlane.z + 1 - 0.003;
        p[14] = this.clipPlane.w;

        hide();
        const prevTarget = renderer.getRenderTarget();
        const prevShadowUpdate = renderer.shadowMap.needsUpdate;
        renderer.shadowMap.needsUpdate = false;
        renderer.setRenderTarget(this.target);
        renderer.clear();
        renderer.render(scene, reflect);
        renderer.setRenderTarget(prevTarget);
        renderer.shadowMap.needsUpdate = prevShadowUpdate;
        restore();
        this.active = true;
        this.view.copy(camera.position);
    }

    dispose(): void {
        this.target.dispose();
    }
}
