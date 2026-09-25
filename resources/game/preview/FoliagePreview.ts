import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Sky } from 'three/addons/objects/Sky.js';
import type { FoliageType } from '../shared/types';
import { SimplexNoise } from '../util/noise';
import { Foliage, placementAllowed } from '../world/Foliage';
import type { FoliagePlacementContext } from '../world/Foliage';
import { Heightfield } from '../world/Heightfield';

export type PreviewMode = 'specimen' | 'scatter';

export type FoliagePreviewStats = {
    mode: PreviewMode;
    instances: number;
    trianglesLod0: number;
    trianglesLod1: number;
    /** Number of LOD geometries (1 for uploaded GLB models). */
    lodCount: number;
    drawCalls: number;
    /** Scatter mode: ground (m²) where the type's slope / height / water rules allow placement. */
    allowedArea: number;
    /** Scatter mode: area of the whole test patch in m². */
    patchArea: number;
    /** Scatter mode: achieved instances per 100 m² of allowed ground. */
    densityPer100: number;
    cullDistance: number;
    /** Whether the cull ring is drawn (cull distance smaller than the test patch). */
    cullRingVisible: boolean;
    /** true once an uploaded GLB model has replaced the procedural mesh. */
    usingModel: boolean;
};

/** Test patch dimensions (scatter mode). */
const PATCH_SIZE = 80;
const PATCH_RES = 129;
const WATER_LEVEL = 0.35;
const MEADOW_HEIGHT = 1.2;
const POND = { x: -17, z: 15, radius: 10, depth: 2.4 };
const HILL = { x: 14, z: -8, height: 27, sigma: 9.5 };
const CULL_RING_MAX = PATCH_SIZE;
const PLINTH_TILT = THREE.MathUtils.degToRad(14);
const RESCATTER_DELAY = 150;

/**
 * Framework-free live preview of a single foliage type, built on the real game classes
 * (Foliage, FoliageGeometry, Heightfield) so what you see is what the game renders.
 *
 * - specimen: three instances at min / mid / max scale on a turntable disk (the middle one sits
 *   on a tilted plinth to show "align to terrain normal").
 * - scatter: an 80 × 80 m test terrain with meadow, a 0–60° hill and a pond, filled exactly as a
 *   full-strength brush would, so density, slope, height and underwater rules are visible.
 */
export class FoliagePreview {
    onStats?: (stats: FoliagePreviewStats) => void;

    private readonly renderer: THREE.WebGLRenderer;
    private readonly scene = new THREE.Scene();
    private readonly camera: THREE.PerspectiveCamera;
    private readonly controls: OrbitControls;
    private readonly foliage = new Foliage();
    private readonly sun: THREE.DirectionalLight;
    private readonly sunDirection = new THREE.Vector3();
    private readonly pmrem: THREE.PMREMGenerator;
    private envTarget: THREE.WebGLRenderTarget | null = null;
    private readonly sky: Sky;

    private readonly heights: Heightfield;
    private readonly ctx: FoliagePlacementContext;
    private readonly scatterGroup = new THREE.Group();
    private readonly specimenGroup = new THREE.Group();
    private readonly terrain: THREE.Mesh<
        THREE.BufferGeometry,
        THREE.MeshStandardMaterial
    >;
    private readonly baseColors: Float32Array;
    private readonly cullRing: THREE.LineLoop<
        THREE.BufferGeometry,
        THREE.LineBasicMaterial
    >;
    private specimenDisk: THREE.Mesh | null = null;
    private plinth: THREE.Mesh | null = null;

    private type: FoliageType | null = null;
    private mode: PreviewMode = 'specimen';
    private showRules = false;
    private placementKey = '';
    private specimenKey = '';
    private frameKey = '';
    private rulesKey = '';
    private layoutGeometry: THREE.BufferGeometry | null = null;
    private rescatterTimer: ReturnType<typeof setTimeout> | null = null;
    private allowedArea = 0;
    private lastStats = '';
    private statsFrame = 0;

    private resizeObserver: ResizeObserver;
    private intersectionObserver: IntersectionObserver | null = null;
    private onScreen = true;
    private running = false;
    private lastTime = 0;
    private idleTimer: ReturnType<typeof setTimeout> | null = null;
    private interacting = false;
    private disposed = false;

    constructor(private readonly canvas: HTMLCanvasElement) {
        this.renderer = new THREE.WebGLRenderer({
            canvas,
            antialias: true,
            alpha: false,
            powerPreference: 'high-performance',
        });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        // Same defaults as the game's environment settings (exposure 0.5, noon sun ≈ 3).
        this.renderer.toneMappingExposure = 0.5;
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFShadowMap;

        this.camera = new THREE.PerspectiveCamera(40, 1, 0.05, 5000);
        this.controls = new OrbitControls(this.camera, canvas);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.maxPolarAngle = THREE.MathUtils.degToRad(88);
        this.controls.autoRotateSpeed = 0.6;
        this.controls.addEventListener('start', this.onControlStart);
        this.controls.addEventListener('end', this.onControlEnd);

        // Sky + image based lighting, same setup as the game's Atmosphere.
        const elevation = 42;
        const azimuth = 62;
        this.sunDirection.setFromSphericalCoords(
            1,
            THREE.MathUtils.degToRad(90 - elevation),
            THREE.MathUtils.degToRad(azimuth),
        );
        this.sky = new Sky();
        this.sky.scale.setScalar(4000);
        configureSky(this.sky, this.sunDirection);
        this.scene.add(this.sky);

        this.pmrem = new THREE.PMREMGenerator(this.renderer);
        const envScene = new THREE.Scene();
        const envSky = new Sky();
        envSky.scale.setScalar(1000);
        configureSky(envSky, this.sunDirection);
        // The direct sun already comes from the directional light; keep it out of the IBL.
        envSky.material.uniforms.showSunDisc.value = 0;
        envScene.add(envSky);
        this.envTarget = this.pmrem.fromScene(envScene, 0, 0.1, 2000);
        envSky.geometry.dispose();
        envSky.material.dispose();
        this.scene.environment = this.envTarget.texture;
        this.scene.environmentIntensity = 0.55;

        this.sun = new THREE.DirectionalLight(0xfff6e8, 3);
        this.sun.castShadow = true;
        this.sun.shadow.mapSize.set(2048, 2048);
        this.sun.shadow.bias = -0.0004;
        this.sun.shadow.normalBias = 0.04;
        this.sun.shadow.radius = 3;
        this.scene.add(this.sun, this.sun.target);
        this.scene.add(new THREE.HemisphereLight(0xbfd9ff, 0x4a4030, 0.25));

        // Scatter test terrain.
        this.heights = buildTestTerrain();
        this.ctx = {
            heights: this.heights,
            waterLevelAt: (x, z) =>
                Math.hypot(x - POND.x, z - POND.z) < POND.radius
                    ? WATER_LEVEL
                    : null,
        };
        this.terrain = buildTerrainMesh(this.heights);
        this.baseColors = (
            this.terrain.geometry.getAttribute('color') as THREE.BufferAttribute
        ).array.slice() as Float32Array;
        this.scatterGroup.add(this.terrain);
        this.scatterGroup.add(buildSurroundings());
        this.scatterGroup.add(buildPond());
        this.cullRing = new THREE.LineLoop(
            new THREE.BufferGeometry().setAttribute(
                'position',
                new THREE.BufferAttribute(new Float32Array(160 * 3), 3),
            ),
            new THREE.LineBasicMaterial({
                color: 0xffffff,
                transparent: true,
                opacity: 0.55,
                depthWrite: false,
            }),
        );
        this.cullRing.frustumCulled = false;
        this.cullRing.visible = false;
        this.scatterGroup.add(this.cullRing);

        this.scene.add(
            this.scatterGroup,
            this.specimenGroup,
            this.foliage.group,
        );

        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(canvas);

        if ('IntersectionObserver' in window) {
            this.intersectionObserver = new IntersectionObserver((entries) => {
                this.onScreen = entries.some((e) => e.isIntersecting);
                this.updateLoop();
            });
            this.intersectionObserver.observe(canvas);
        }

        document.addEventListener('visibilitychange', this.updateLoop);
        this.applyMode();
        this.resize();
        this.updateLoop();
    }

    setType(type: FoliageType): void {
        const previous = this.type;
        this.type = type;

        if (previous && previous.id !== type.id) {
            this.foliage.setTypes([]);
            this.foliage.load(null);
            this.placementKey = '';
            this.specimenKey = '';
            this.frameKey = '';
        }

        // Rebuilds geometry/material only when the visuals changed; placements are kept.
        this.foliage.setTypes([type]);
        this.rebuild(false);
    }

    setMode(mode: PreviewMode): void {
        if (mode === this.mode) {
            return;
        }

        this.mode = mode;
        this.placementKey = '';
        this.specimenKey = '';
        this.applyMode();
        this.rebuild(true);
        this.resetCamera();
    }

    setWind(strength: number): void {
        this.foliage.setWind(strength);
    }

    setShowRules(show: boolean): void {
        this.showRules = show;
        this.rulesKey = '';
        this.updateRulesOverlay();
    }

    resetCamera(): void {
        if (this.mode === 'scatter') {
            // Small plants get a closer look at the meadow; trees see the whole plot.
            const t = smoothstep(1, 8, this.typicalHeight());
            const dist = THREE.MathUtils.lerp(34, 97, t);
            this.controls.target.set(
                THREE.MathUtils.lerp(-5, 0, t),
                THREE.MathUtils.lerp(2, 5, t),
                THREE.MathUtils.lerp(5, 0, t),
            );
            this.camera.position
                .set(0.52, 0.45, 0.66)
                .normalize()
                .multiplyScalar(dist)
                .add(this.controls.target);
            this.camera.near = 0.1;
            this.camera.far = 3000;
            this.controls.minDistance = 2;
            this.controls.maxDistance = 400;
        } else {
            this.frameSpecimen();
        }

        this.camera.updateProjectionMatrix();
        this.controls.update();
    }

    /** Height of an average-scale instance in metres. */
    private typicalHeight(): number {
        const type = this.type;
        const geometry = type
            ? this.foliage.geometryOf(type.id)?.lods[0]
            : null;

        if (!type || !geometry) {
            return 10;
        }

        if (!geometry.boundingBox) {
            geometry.computeBoundingBox();
        }

        const box = geometry.boundingBox!;

        return (
            (box.max.y - box.min.y) * ((type.min_scale + type.max_scale) / 2)
        );
    }

    get stats(): FoliagePreviewStats {
        const type = this.type;
        const geometry = type ? this.foliage.geometryOf(type.id) : null;
        const lods = geometry?.lods ?? [];
        const lod0 = lods[0] ? triangleCount(lods[0]) : 0;
        const instances = this.foliage.instanceCount;
        const cull = type?.cull_distance ?? 0;

        return {
            mode: this.mode,
            instances,
            trianglesLod0: lod0,
            trianglesLod1: lods[1] ? triangleCount(lods[1]) : lod0,
            lodCount: lods.length,
            drawCalls: this.renderer.info.render.calls,
            allowedArea: this.mode === 'scatter' ? this.allowedArea : 0,
            patchArea: this.mode === 'scatter' ? PATCH_SIZE * PATCH_SIZE : 0,
            densityPer100:
                this.mode === 'scatter' && this.allowedArea > 0
                    ? (instances / this.allowedArea) * 100
                    : 0,
            cullDistance: cull,
            cullRingVisible: this.mode === 'scatter' && cull < CULL_RING_MAX,
            usingModel: !!type?.model_url && lods.length === 1,
        };
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }

        this.disposed = true;
        this.renderer.setAnimationLoop(null);
        this.running = false;
        this.clearTimers();
        this.resizeObserver.disconnect();
        this.intersectionObserver?.disconnect();
        document.removeEventListener('visibilitychange', this.updateLoop);
        this.controls.removeEventListener('start', this.onControlStart);
        this.controls.removeEventListener('end', this.onControlEnd);
        this.controls.dispose();
        this.foliage.dispose();
        this.scene.remove(this.foliage.group);
        this.scene.traverse((obj) => {
            const mesh = obj as THREE.Mesh;

            if (mesh.geometry) {
                mesh.geometry.dispose();
            }

            if (mesh.material) {
                for (const m of Array.isArray(mesh.material)
                    ? mesh.material
                    : [mesh.material]) {
                    m.dispose();
                }
            }
        });
        this.envTarget?.dispose();
        this.pmrem.dispose();
        this.sun.shadow.map?.dispose();
        this.renderer.dispose();
        this.renderer.forceContextLoss();
        this.onStats = undefined;
    }

    // ------------------------------------------------------------------ building

    private applyMode(): void {
        const scatter = this.mode === 'scatter';
        this.scatterGroup.visible = scatter;
        this.specimenGroup.visible = !scatter;
        this.scene.fog = scatter ? new THREE.Fog(0xc4d4e2, 220, 900) : null;
        this.controls.autoRotate = !scatter && !this.interacting;
        const cam = this.sun.shadow.camera;
        const extent = scatter ? 58 : 20;
        cam.left = cam.bottom = -extent;
        cam.right = cam.top = extent;
        cam.near = 1;
        cam.far = 400;
        cam.updateProjectionMatrix();
        this.placeSun(new THREE.Vector3(0, 0, 0), scatter ? 150 : 60);
    }

    private placeSun(focus: THREE.Vector3, distance: number): void {
        this.sun.target.position.copy(focus);
        this.sun.position
            .copy(focus)
            .addScaledVector(this.sunDirection, distance);
        this.sun.target.updateMatrixWorld();
    }

    /** Re-place instances when placement-relevant settings changed. */
    private rebuild(immediate: boolean): void {
        const type = this.type;

        if (!type || this.disposed) {
            return;
        }

        if (this.mode === 'specimen') {
            this.layoutSpecimen();
        } else {
            const key = JSON.stringify([
                type.id,
                type.density,
                type.min_scale,
                type.max_scale,
                type.min_slope,
                type.max_slope,
                type.min_height,
                type.max_height,
                type.align_to_normal,
                type.random_yaw,
                type.allow_underwater,
            ]);

            if (key !== this.placementKey) {
                this.placementKey = key;

                if (this.rescatterTimer) {
                    clearTimeout(this.rescatterTimer);
                }

                if (immediate || !this.foliage.instanceCount) {
                    this.rescatterTimer = null;
                    this.scatter();
                } else {
                    this.rescatterTimer = setTimeout(() => {
                        this.rescatterTimer = null;
                        this.scatter();
                    }, RESCATTER_DELAY);
                }
            }

            this.updateRulesOverlay();
        }

        this.emitStats(true);
    }

    private scatter(): void {
        const type = this.type;

        if (!type || this.disposed) {
            return;
        }

        this.foliage.load(null);
        const half = PATCH_SIZE / 2;
        this.foliage.fill(this.ctx, type.id, 0, 0, Math.hypot(half, half), 1);
        this.allowedArea = this.computeAllowedArea(type);
        this.emitStats(true);
    }

    private computeAllowedArea(type: FoliageType): number {
        const hf = this.heights;
        const cellArea = hf.cell * hf.cell;
        let allowed = 0;

        for (let row = 0; row < hf.resolution - 1; row++) {
            for (let col = 0; col < hf.resolution - 1; col++) {
                const x = hf.colToX(col + 0.5);
                const z = hf.rowToZ(row + 0.5);

                if (placementAllowed(this.ctx, type, x, z)) {
                    allowed += cellArea;
                }
            }
        }

        return allowed;
    }

    private updateRulesOverlay(): void {
        const type = this.type;
        const attr = this.terrain.geometry.getAttribute(
            'color',
        ) as THREE.BufferAttribute;
        const colors = attr.array as Float32Array;
        const key =
            this.showRules && type
                ? JSON.stringify([
                      type.min_slope,
                      type.max_slope,
                      type.min_height,
                      type.max_height,
                      type.allow_underwater,
                  ])
                : 'off';

        if (key === this.rulesKey) {
            return;
        }

        this.rulesKey = key;
        colors.set(this.baseColors);

        if (this.showRules && type) {
            const hf = this.heights;
            const ok = new THREE.Color('#3fdc6a');
            const no = new THREE.Color('#e5484d');
            const c = new THREE.Color();

            for (let row = 0; row < hf.resolution; row++) {
                for (let col = 0; col < hf.resolution; col++) {
                    const i = hf.index(col, row) * 3;
                    const allowed = placementAllowed(
                        this.ctx,
                        type,
                        hf.colToX(col),
                        hf.rowToZ(row),
                    );
                    c.fromArray(colors, i).lerp(allowed ? ok : no, 0.5);
                    c.toArray(colors, i);
                }
            }
        }

        attr.needsUpdate = true;
    }

    private layoutSpecimen(): void {
        const type = this.type;

        if (!type) {
            return;
        }

        const geometry = this.foliage.geometryOf(type.id)?.lods[0] ?? null;

        if (!geometry) {
            return;
        }

        if (!geometry.boundingBox) {
            geometry.computeBoundingBox();
        }

        const key = JSON.stringify([
            type.id,
            type.min_scale,
            type.max_scale,
            type.random_yaw,
            type.align_to_normal,
            geometry.uuid,
        ]);

        if (key === this.specimenKey) {
            return;
        }

        this.specimenKey = key;
        this.layoutGeometry = geometry;

        const size = geometry.boundingBox!.getSize(new THREE.Vector3());
        // Only re-frame the camera when the specimen's extent changes (not on colour edits).
        const frameKey = [
            size.x,
            size.y,
            size.z,
            type.min_scale,
            type.max_scale,
        ]
            .map((v) => v.toFixed(2))
            .join();
        const relayout = frameKey !== this.frameKey;
        this.frameKey = frameKey;
        const maxScale = Math.max(type.min_scale, type.max_scale);
        const minScale = Math.min(type.min_scale, type.max_scale);
        const footprint = Math.max(size.x, size.z, 0.05) * maxScale;
        const spacing = Math.max(footprint * 1.2, size.y * maxScale * 0.3, 0.4);
        const plinthRadius = spacing * 0.42;
        const plinthHeight = Math.max(0.04, spacing * 0.06);
        const plinthY =
            (plinthHeight / 2) * Math.cos(PLINTH_TILT) +
            plinthRadius * Math.sin(PLINTH_TILT) -
            plinthHeight * 0.3;
        const top = new THREE.Vector3(0, plinthHeight / 2, 0).applyAxisAngle(
            new THREE.Vector3(0, 0, 1),
            PLINTH_TILT,
        );

        // Deterministic yaws so the turntable doesn't jump on every change.
        const yaws = type.random_yaw ? [0.6, 2.4, 4.3] : [0, 0, 0];
        const scales = [minScale, (minScale + maxScale) / 2, maxScale];
        const data: number[] = [];

        for (let i = 0; i < 3; i++) {
            const onPlinth = i === 1;
            const scale = scales[i];
            const x = onPlinth ? top.x : (i - 1) * spacing;
            const y = onPlinth ? plinthY + top.y : 0;
            data.push(
                x,
                y - 0.05 * scale,
                0,
                yaws[i],
                scale,
                0,
                onPlinth && type.align_to_normal ? PLINTH_TILT : 0,
            );
        }

        this.foliage.load({ version: 1, instances: { [type.id]: data } });

        // Ground disk + plinth sized to the specimen.
        const radius = spacing * 2.3;
        this.disposeSpecimenProps();
        this.specimenDisk = new THREE.Mesh(
            new THREE.CircleGeometry(radius, 96).rotateX(-Math.PI / 2),
            new THREE.MeshStandardMaterial({
                color: '#4b5e33',
                roughness: 0.95,
            }),
        );
        this.specimenDisk.receiveShadow = true;
        this.specimenDisk.position.y = -0.002;
        this.plinth = new THREE.Mesh(
            new THREE.CylinderGeometry(
                plinthRadius,
                plinthRadius,
                plinthHeight,
                64,
            ),
            new THREE.MeshStandardMaterial({
                color: '#6d675e',
                roughness: 0.8,
            }),
        );
        this.plinth.rotation.z = PLINTH_TILT;
        this.plinth.position.y = plinthY;
        this.plinth.castShadow = true;
        this.plinth.receiveShadow = true;
        this.specimenGroup.add(this.specimenDisk, this.plinth);

        const cam = this.sun.shadow.camera;
        const extent = Math.max(radius, size.y * maxScale) * 1.1;
        cam.left = cam.bottom = -extent;
        cam.right = cam.top = extent;
        cam.far = extent * 8;
        cam.updateProjectionMatrix();
        this.placeSun(
            new THREE.Vector3(0, (size.y * maxScale) / 2, 0),
            extent * 4,
        );

        if (relayout) {
            this.frameSpecimen();
        }
    }

    private frameSpecimen(): void {
        const type = this.type;
        const geometry = type
            ? this.foliage.geometryOf(type.id)?.lods[0]
            : null;

        if (!type || !geometry?.boundingBox) {
            this.controls.target.set(0, 1, 0);
            this.camera.position.set(4, 3, 8);

            return;
        }

        const size = geometry.boundingBox.getSize(new THREE.Vector3());
        const maxScale = Math.max(type.min_scale, type.max_scale);
        const footprint = Math.max(size.x, size.z, 0.05) * maxScale;
        const spacing = Math.max(footprint * 1.2, size.y * maxScale * 0.3, 0.4);
        const width = spacing * 2 + footprint;
        const height = size.y * maxScale;
        const aspect = Math.max(0.5, this.camera.aspect);
        const vFov = THREE.MathUtils.degToRad(this.camera.fov);
        const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
        const dist =
            Math.max(
                height / 2 / Math.tan(vFov / 2),
                width / 2 / Math.tan(hFov / 2),
            ) * 1.35;
        const target = new THREE.Vector3(0, height * 0.42, 0);
        this.controls.target.copy(target);
        this.camera.position.copy(target).add(
            // Look down more steeply on flat things (rocks, grass) than on tall trees.
            new THREE.Vector3(
                0.2,
                0.22 + 0.4 * THREE.MathUtils.clamp(1 - height / width, 0, 1),
                1,
            )
                .normalize()
                .multiplyScalar(dist),
        );
        this.camera.near = Math.max(0.01, dist / 200);
        this.camera.far = Math.max(500, dist * 60);
        this.camera.updateProjectionMatrix();
        this.controls.minDistance = dist * 0.15;
        this.controls.maxDistance = dist * 4;
        this.controls.update();
    }

    private disposeSpecimenProps(): void {
        for (const mesh of [this.specimenDisk, this.plinth]) {
            if (mesh) {
                this.specimenGroup.remove(mesh);
                mesh.geometry.dispose();
                (mesh.material as THREE.Material).dispose();
            }
        }

        this.specimenDisk = null;
        this.plinth = null;
    }

    // ------------------------------------------------------------------ loop

    private readonly updateLoop = (): void => {
        const shouldRun = !this.disposed && this.onScreen && !document.hidden;

        if (shouldRun === this.running) {
            return;
        }

        this.running = shouldRun;
        this.lastTime = performance.now();
        this.renderer.setAnimationLoop(shouldRun ? this.frame : null);
    };

    private readonly frame = (): void => {
        const now = performance.now();
        const dt = Math.min(0.1, (now - this.lastTime) / 1000);
        this.lastTime = now;
        const type = this.type;

        // A GLB model finished loading → re-frame around the new mesh.
        if (type && this.mode === 'specimen') {
            const geometry = this.foliage.geometryOf(type.id)?.lods[0];

            if (geometry && geometry !== this.layoutGeometry) {
                this.layoutSpecimen();
                this.emitStats(true);
            }
        }

        this.controls.update(dt);

        if (this.mode === 'scatter') {
            this.updateCullRing();
        }

        this.foliage.update(dt, this.camera);
        this.sky.material.uniforms.time.value += dt;
        this.renderer.render(this.scene, this.camera);

        if (++this.statsFrame % 20 === 0) {
            this.emitStats(false);
        }
    };

    private updateCullRing(): void {
        const cull = this.type?.cull_distance ?? Infinity;
        const visible = cull < CULL_RING_MAX;
        this.cullRing.visible = visible;

        if (!visible) {
            return;
        }

        const attr = this.cullRing.geometry.getAttribute(
            'position',
        ) as THREE.BufferAttribute;
        const segments = attr.count;
        const cx = this.camera.position.x;
        const cz = this.camera.position.z;

        for (let i = 0; i < segments; i++) {
            const a = (i / segments) * Math.PI * 2;
            const x = cx + Math.cos(a) * cull;
            const z = cz + Math.sin(a) * cull;
            const y = this.heights.contains(x, z)
                ? this.heights.sample(x, z)
                : MEADOW_HEIGHT - 0.05;
            attr.setXYZ(i, x, Math.max(y, WATER_LEVEL) + 0.2, z);
        }

        attr.needsUpdate = true;
    }

    private emitStats(force: boolean): void {
        if (!this.onStats) {
            return;
        }

        const stats = this.stats;
        const key = JSON.stringify(stats);

        if (!force && key === this.lastStats) {
            return;
        }

        this.lastStats = key;
        this.onStats(stats);
    }

    private resize(): void {
        const width = this.canvas.clientWidth;
        const height = this.canvas.clientHeight;

        if (width === 0 || height === 0) {
            return;
        }

        this.renderer.setSize(width, height, false);
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();

        if (!this.running) {
            this.renderer.render(this.scene, this.camera);
        }
    }

    private readonly onControlStart = (): void => {
        this.interacting = true;
        this.controls.autoRotate = false;

        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
    };

    private readonly onControlEnd = (): void => {
        this.interacting = false;

        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
        }

        this.idleTimer = setTimeout(() => {
            this.idleTimer = null;
            this.controls.autoRotate = this.mode === 'specimen';
        }, 4000);
    };

    private clearTimers(): void {
        if (this.rescatterTimer) {
            clearTimeout(this.rescatterTimer);
            this.rescatterTimer = null;
        }

        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
    }
}

function configureSky(sky: Sky, sunDirection: THREE.Vector3): void {
    const u = sky.material.uniforms;
    u.turbidity.value = 4;
    u.rayleigh.value = 1.3;
    u.mieCoefficient.value = 0.006;
    u.mieDirectionalG.value = 0.8;
    u.sunPosition.value.copy(sunDirection);

    if (u.cloudCoverage) {
        u.cloudCoverage.value = 0.25;
    }
}

function triangleCount(geometry: THREE.BufferGeometry): number {
    const index = geometry.getIndex();

    return Math.round(
        (index ? index.count : geometry.getAttribute('position').count) / 3,
    );
}

function smoothstep(a: number, b: number, v: number): number {
    const t = Math.min(1, Math.max(0, (v - a) / (b - a)));

    return t * t * (3 - 2 * t);
}

/** Meadow + gaussian hill (0 → ~60° slopes, up to ~28 m) + a pond dipping below the water level. */
function buildTestTerrain(): Heightfield {
    const hf = new Heightfield(PATCH_RES, PATCH_SIZE);
    const noise = new SimplexNoise(4242);
    const half = PATCH_SIZE / 2;

    for (let row = 0; row < hf.resolution; row++) {
        for (let col = 0; col < hf.resolution; col++) {
            const x = hf.colToX(col);
            const z = hf.rowToZ(row);
            let h = MEADOW_HEIGHT + noise.fbm(x / 16, z / 16, 3) * 0.35;
            const hr2 = (x - HILL.x) ** 2 + (z - HILL.z) ** 2;
            const hill = Math.exp(-hr2 / (2 * HILL.sigma * HILL.sigma));
            h += HILL.height * hill + hill * noise.fbm(x / 6, z / 6, 3) * 1.1;
            const d = Math.hypot(x - POND.x, z - POND.z) / POND.radius;

            if (d < 1) {
                h -= POND.depth * (1 - d * d) ** 2;
            }

            const edge = smoothstep(
                half - 6,
                half,
                Math.max(Math.abs(x), Math.abs(z)),
            );
            hf.set(col, row, h * (1 - edge) + MEADOW_HEIGHT * edge);
        }
    }

    return hf;
}

function buildTerrainMesh(
    hf: Heightfield,
): THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> {
    const segments = hf.resolution - 1;
    const geometry = new THREE.PlaneGeometry(
        hf.size,
        hf.size,
        segments,
        segments,
    ).rotateX(-Math.PI / 2);
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const grass = new THREE.Color('#5d7a36');
    const dryGrass = new THREE.Color('#6f7440');
    const rock = new THREE.Color('#665d50');
    const sand = new THREE.Color('#b4a47c');
    const mud = new THREE.Color('#4a4032');
    const c = new THREE.Color();
    const noise = new SimplexNoise(99);

    // PlaneGeometry rotated -90° about X: vertex (ix, iy) lands at column ix, row iy.
    for (let row = 0; row < hf.resolution; row++) {
        for (let col = 0; col < hf.resolution; col++) {
            const i = row * hf.resolution + col;
            const x = hf.colToX(col);
            const z = hf.rowToZ(row);
            const y = hf.get(col, row);
            pos.setXYZ(i, x, y, z);
            const slope = hf.slope(x, z);
            c.copy(grass).lerp(dryGrass, smoothstep(12, 26, y) * 0.8);
            c.multiplyScalar(0.9 + noise.noise2D(x / 6, z / 6) * 0.1);
            c.lerp(
                rock,
                smoothstep(34, 50, slope) *
                    (0.75 + noise.noise2D(x / 3, z / 3) * 0.25),
            );

            if (Math.hypot(x - POND.x, z - POND.z) < POND.radius) {
                c.lerp(
                    sand,
                    1 - smoothstep(WATER_LEVEL + 0.1, WATER_LEVEL + 0.5, y),
                );
                c.lerp(
                    mud,
                    1 - smoothstep(WATER_LEVEL - 1.2, WATER_LEVEL - 0.2, y),
                );
            }

            c.toArray(colors, i * 3);
        }
    }

    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({
            vertexColors: true,
            roughness: 0.95,
            metalness: 0,
        }),
    );
    mesh.receiveShadow = true;
    mesh.name = 'PreviewTerrain';

    return mesh;
}

/** Neutral ground around the test patch so it reads as a plot rather than a floating tile. */
function buildSurroundings(): THREE.Object3D {
    const far = 900;
    const half = PATCH_SIZE / 2;
    const shape = new THREE.Shape()
        .moveTo(-far, -far)
        .lineTo(far, -far)
        .lineTo(far, far)
        .lineTo(-far, far)
        .closePath();
    shape.holes.push(
        new THREE.Path()
            .moveTo(-half, -half)
            .lineTo(-half, half)
            .lineTo(half, half)
            .lineTo(half, -half)
            .closePath(),
    );
    const outer = new THREE.Mesh(
        new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2),
        new THREE.MeshStandardMaterial({ color: '#66704f', roughness: 1 }),
    );
    outer.position.y = MEADOW_HEIGHT - 0.04;
    outer.receiveShadow = true;
    outer.name = 'PreviewSurroundings';

    return outer;
}

function buildPond(): THREE.Mesh {
    const water = new THREE.Mesh(
        new THREE.CircleGeometry(POND.radius, 64).rotateX(-Math.PI / 2),
        new THREE.MeshStandardMaterial({
            color: '#2f6f8c',
            roughness: 0.08,
            metalness: 0.1,
            transparent: true,
            opacity: 0.72,
            depthWrite: false,
        }),
    );
    water.position.set(POND.x, WATER_LEVEL, POND.z);
    water.renderOrder = 2;
    water.name = 'PreviewPond';

    return water;
}
