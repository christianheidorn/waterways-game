import * as THREE from 'three/webgpu';
import type { GameRenderer } from '../core/renderer';

type ShadowCaster = THREE.Object3D & { shadow: THREE.LightShadow };

/** Screen share of water the reflection turns on at, and (lower: hysteresis) off at. */
export const REFLECTION_ON = 0.03;
export const REFLECTION_OFF = 0.015;
/** Seconds the water takes to blend between the planar and the environment reflection. */
export const REFLECTION_FADE = 0.4;
/** Water farther than this (m) doesn't count towards the coverage (its reflection is tiny). */
const COVERAGE_DISTANCE = 1500;
const COVERAGE_COLS = 12;
const COVERAGE_ROWS = 8;
const _ndc = new THREE.Vector3();
const _dir = new THREE.Vector3();

/**
 * Share (0..1) of the screen showing the water at `level` within COVERAGE_DISTANCE: a grid of view rays
 * against the plane, each hit counted where the water there is at that level. Terrain in front of the
 * water is not tested (it only overestimates).
 */
export function waterCoverage(
    camera: THREE.PerspectiveCamera,
    level: number,
    levelAt: (x: number, z: number) => number | null,
): number {
    camera.updateMatrixWorld();
    const origin = camera.position;
    let hits = 0;

    for (let r = 0; r < COVERAGE_ROWS; r++) {
        for (let c = 0; c < COVERAGE_COLS; c++) {
            _ndc.set(
                ((c + 0.5) / COVERAGE_COLS) * 2 - 1,
                ((r + 0.5) / COVERAGE_ROWS) * 2 - 1,
                0.5,
            ).unproject(camera);
            _dir.subVectors(_ndc, origin).normalize();

            if (_dir.y > -1e-4) {
                continue;
            }

            const t = (level - origin.y) / _dir.y;

            if (t <= 0 || t > COVERAGE_DISTANCE) {
                continue;
            }

            const at = levelAt(origin.x + _dir.x * t, origin.z + _dir.z * t);

            if (at !== null && Math.abs(at - level) < 1) {
                hits++;
            }
        }
    }

    return hits / (COVERAGE_COLS * COVERAGE_ROWS);
}

/**
 * Planar reflection for the water level nearest to the viewer (lakes, sea, calm rivers).
 * Renders the scene from a camera mirrored across the plane y = level with an oblique near plane
 * (so nothing below the water leaks into the reflection) into a reduced-resolution texture.
 * Adapted from three.js' Reflector / ReflectorNode, but driven by the game: the plane is picked from
 * the water under the focus point and small foliage is left out.
 *
 * The water looks the reflection up through `textureMatrix` (world → texture UV of the camera the
 * reflection was rendered with), so a reflection rendered on an earlier frame (`interval` > 1) stays
 * anchored to the world while the camera moves.
 */
export class WaterReflection {
    readonly target: THREE.RenderTarget;
    readonly textureMatrix = new THREE.Matrix4();
    readonly camera = new THREE.PerspectiveCamera();
    level = 0;
    active = false;
    /** Render every n-th frame (reused in between). */
    interval = 1;
    private frame = 0;
    /** Mirrored camera positioned by prepare() for this frame's render(); null when skipped. */
    private prepared: THREE.PerspectiveCamera | null = null;
    private renderedLevel = Number.NaN;
    private scale = 0.5;
    private readonly plane = new THREE.Plane();
    private readonly normal = new THREE.Vector3(0, 1, 0);
    private readonly clipPlane = new THREE.Vector4();
    private readonly q = new THREE.Vector4();
    private readonly lookAt = new THREE.Vector3();
    private readonly rotation = new THREE.Matrix4();
    private readonly up = new THREE.Vector3();
    private readonly point = new THREE.Vector3();
    private readonly shadowLights: ShadowCaster[] = [];

    constructor() {
        this.target = new THREE.RenderTarget(1, 1, {
            type: THREE.HalfFloatType,
            generateMipmaps: false,
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
        });
        // Labels the pass in GPU captures and the profiler's render list.
        this.target.texture.name = 'Water reflection';
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
     * Decides whether the reflection renders this frame and positions the mirrored camera for it.
     * Returns that camera (e.g. to cull against its frustum before render()), or null when the frame
     * keeps the last image or there is no reflection (camera below the water).
     */
    prepare(
        camera: THREE.PerspectiveCamera,
        coordinateSystem: THREE.CoordinateSystem,
        reversedDepth: boolean,
    ): THREE.PerspectiveCamera | null {
        this.prepared = null;

        // Camera below the water: no reflection.
        if (camera.position.y <= this.level + 0.05) {
            this.active = false;

            return null;
        }

        // A skipped frame reuses the last image unless the plane changed or there is none yet.
        this.frame = (this.frame + 1) % Math.max(1, this.interval);

        if (
            this.frame !== 0 &&
            this.active &&
            this.renderedLevel === this.level
        ) {
            return null;
        }

        this.frame = 0;
        this.prepared = this.mirror(camera, coordinateSystem, reversedDepth);

        return this.prepared;
    }

    /**
     * Renders the reflection prepared this frame (nothing on skipped frames: the last image stays).
     * `hide` is called before rendering to hide objects that must not be reflected (water itself,
     * dense grass) and `restore` afterwards.
     */
    render(
        renderer: GameRenderer,
        scene: THREE.Scene,
        hide: () => void,
        restore: () => void,
    ): void {
        const reflect = this.prepared;

        if (!reflect) {
            return;
        }

        this.prepared = null;
        hide();
        const shadows = this.freezeShadows(scene);
        const prevTarget = renderer.getRenderTarget();
        const prevMrt = renderer.getMRT();
        const prevAutoClear = renderer.autoClear;
        // Cleared by the render pass itself (a separate clear() would be an extra pass on WebGPU).
        renderer.autoClear = true;
        renderer.setMRT(null);
        renderer.setRenderTarget(this.target);
        renderer.render(scene, reflect);
        renderer.setRenderTarget(prevTarget);
        renderer.setMRT(prevMrt);
        renderer.autoClear = prevAutoClear;

        for (const light of shadows) {
            light.shadow.autoUpdate = true;
        }

        restore();
        this.active = true;
        this.renderedLevel = this.level;
    }

    dispose(): void {
        this.target.dispose();
    }

    /** Positions the mirrored camera (oblique near plane = water plane) and updates `textureMatrix`. */
    private mirror(
        camera: THREE.PerspectiveCamera,
        coordinateSystem: THREE.CoordinateSystem,
        reversedDepth: boolean,
    ): THREE.PerspectiveCamera {
        const reflect = this.camera;

        this.rotation.extractRotation(camera.matrixWorld);
        this.lookAt
            .set(0, 0, -1)
            .applyMatrix4(this.rotation)
            .add(camera.position);
        this.lookAt.y = 2 * this.level - this.lookAt.y;
        this.up.set(0, 1, 0).applyMatrix4(this.rotation);
        this.up.y = -this.up.y;

        reflect.position.set(
            camera.position.x,
            2 * this.level - camera.position.y,
            camera.position.z,
        );
        reflect.up.copy(this.up);
        reflect.lookAt(this.lookAt);
        reflect.near = camera.near;
        reflect.far = camera.far;
        reflect.fov = camera.fov;
        reflect.aspect = camera.aspect;
        reflect.layers.mask = camera.layers.mask;
        // The renderer rebuilds the projection when the coordinate system or the depth direction
        // differs, which would drop the oblique clip plane below.
        reflect.coordinateSystem = coordinateSystem;
        (reflect as unknown as { _reversedDepth: boolean })._reversedDepth =
            reversedDepth;
        reflect.updateMatrixWorld();
        reflect.updateProjectionMatrix();

        // Clip space → texture UV with a top-left origin (render target convention on both backends).
        this.textureMatrix.set(
            0.5,
            0,
            0,
            0.5,
            0,
            -0.5,
            0,
            0.5,
            0,
            0,
            1,
            0,
            0,
            0,
            0,
            1,
        );
        this.textureMatrix.multiply(reflect.projectionMatrix);
        this.textureMatrix.multiply(reflect.matrixWorldInverse);

        // Oblique near plane = water plane (Lengyel), with a small bias to hide seams.
        const plane = this.plane
            .setFromNormalAndCoplanarPoint(
                this.normal,
                this.point.set(0, this.level, 0),
            )
            .applyMatrix4(reflect.matrixWorldInverse);
        this.clipPlane.set(
            plane.normal.x,
            plane.normal.y,
            plane.normal.z,
            plane.constant,
        );
        const p = reflect.projectionMatrix.elements;
        // View-space frustum corner opposite the clip plane on the far plane (clip z = 1, or 0 when
        // reversed): the new far plane passes through it, so the frustum loses as little as possible.
        this.q.x = (Math.sign(this.clipPlane.x) + p[8]) / p[0];
        this.q.y = (Math.sign(this.clipPlane.y) + p[9]) / p[5];
        this.q.z = -1;
        this.q.w = ((reversedDepth ? 0 : 1) + p[10]) / p[14];

        if (reversedDepth) {
            // Reversed (0..1, near = 1): the near plane is row 4 − row 3, so row 3 = row 4 − C·s.
            this.clipPlane.multiplyScalar(1 / this.clipPlane.dot(this.q));
            p[2] = -this.clipPlane.x;
            p[6] = -this.clipPlane.y;
            p[10] = -1 - this.clipPlane.z + 0.003;
            p[14] = -this.clipPlane.w;
        } else {
            const webGpuDepth =
                coordinateSystem === THREE.WebGPUCoordinateSystem;
            // WebGPU clip depth is 0..1 (OpenGL: -1..1), which halves the scale of the new third row.
            this.clipPlane.multiplyScalar(
                (webGpuDepth ? 1 : 2) / this.clipPlane.dot(this.q),
            );
            p[2] = this.clipPlane.x;
            p[6] = this.clipPlane.y;
            p[10] = this.clipPlane.z + (webGpuDepth ? 0 : 1) - 0.003;
            p[14] = this.clipPlane.w;
        }
        reflect.projectionMatrixInverse.copy(reflect.projectionMatrix).invert();

        return reflect;
    }

    /**
     * Shadow maps are view independent here (sun shadow centred on the focus point): the reflection
     * reuses the ones the main view renders instead of drawing them again for the mirrored camera.
     */
    private freezeShadows(scene: THREE.Scene): ShadowCaster[] {
        const frozen = this.shadowLights;
        frozen.length = 0;

        for (const child of scene.children) {
            const light = child as Partial<ShadowCaster>;

            if (light.castShadow && light.shadow?.autoUpdate) {
                light.shadow.autoUpdate = false;
                frozen.push(light as ShadowCaster);
            }
        }

        return frozen;
    }
}
