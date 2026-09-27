import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Sky } from 'three/addons/objects/Sky.js';
import type { TerrainLayer, TerrainMaterialRef } from '../shared/types';
import { SimplexNoise } from '../util/noise';
import { Heightfield } from '../world/Heightfield';
import { SplatMap } from '../world/SplatMap';
import { Terrain } from '../world/Terrain';
import { TerrainMaterial } from '../world/TerrainMaterial';

export type MaterialPreviewShape = 'sphere' | 'terrain' | 'plane';

export type MaterialPreviewOptions = {
    tileSize?: number;
    tint?: string;
    roughnessScale?: number;
    normalStrength?: number;
};

const PATCH_SIZE = 48;
const PATCH_RES = 129;

/**
 * Live preview of a terrain material, rendered with the game's own TerrainMaterial (anti-tiling,
 * triplanar cliffs, height blending) so what you see is what the terrain will look like.
 */
export class MaterialPreview {
    private readonly renderer: THREE.WebGLRenderer;
    private readonly scene = new THREE.Scene();
    private readonly camera = new THREE.PerspectiveCamera(40, 1, 0.05, 2000);
    private readonly controls: OrbitControls;
    private readonly material: TerrainMaterial;
    private readonly splat: SplatMap;
    private readonly terrain: Terrain;
    private readonly sphere: THREE.Mesh;
    private readonly plane: THREE.Mesh;
    private readonly sun = new THREE.DirectionalLight(0xffffff, 3);
    private readonly hemi = new THREE.HemisphereLight(0xbfd9ff, 0x4a4030, 0.25);
    private readonly sky = new Sky();
    private readonly envSky = new Sky();
    private readonly envScene = new THREE.Scene();
    private readonly pmrem: THREE.PMREMGenerator;
    private envTarget: THREE.WebGLRenderTarget | null = null;
    private shape: MaterialPreviewShape = 'sphere';
    private tileSize = 2;
    private frame = 0;
    private visible = true;
    private readonly resizeObserver: ResizeObserver;
    private readonly intersection: IntersectionObserver;

    constructor(private readonly canvas: HTMLCanvasElement) {
        this.renderer = new THREE.WebGLRenderer({
            canvas,
            antialias: true,
            alpha: false,
        });
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 0.5;
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFShadowMap;
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

        this.sky.scale.setScalar(5000);
        this.scene.add(this.sky);
        this.envSky.scale.setScalar(1000);
        this.envScene.add(this.envSky);
        this.pmrem = new THREE.PMREMGenerator(this.renderer);

        this.sun.castShadow = true;
        this.sun.shadow.mapSize.set(2048, 2048);
        this.sun.shadow.bias = -0.0005;
        this.sun.shadow.normalBias = 0.02;
        const sc = this.sun.shadow.camera;
        sc.left = sc.bottom = -30;
        sc.right = sc.top = 30;
        sc.near = 1;
        sc.far = 200;
        this.scene.add(this.sun, this.sun.target, this.hemi);

        // A single-layer "map" that covers the preview area.
        this.splat = new SplatMap(PATCH_RES);
        this.splat.fill(0);
        this.material = new TerrainMaterial(
            this.splat,
            PATCH_SIZE,
            PATCH_RES,
            1024,
        );

        this.terrain = new Terrain(createPatch(), this.material);
        this.terrain.group.traverse((o) => {
            o.castShadow = true;
            o.receiveShadow = true;
        });
        this.scene.add(this.terrain.group);

        this.sphere = new THREE.Mesh(
            new THREE.SphereGeometry(1, 128, 96),
            this.material,
        );
        this.sphere.castShadow = this.sphere.receiveShadow = true;
        this.plane = new THREE.Mesh(
            new THREE.PlaneGeometry(1, 1, 1, 1).rotateX(-Math.PI / 2),
            this.material,
        );
        this.plane.receiveShadow = true;
        this.scene.add(this.sphere, this.plane);

        this.controls = new OrbitControls(this.camera, canvas);
        this.controls.enableDamping = true;
        this.controls.maxPolarAngle = Math.PI * 0.49;

        this.setLight(15);
        this.applyShape();

        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(canvas);
        this.intersection = new IntersectionObserver((entries) => {
            this.visible = entries.some((e) => e.isIntersecting);
        });
        this.intersection.observe(canvas);
        this.resize();
        this.loop();
    }

    setMaterial(
        ref: TerrainMaterialRef,
        opts: MaterialPreviewOptions = {},
    ): void {
        const size = opts.tileSize ?? ref.tile_size ?? 2;
        const sizeChanged = size !== this.tileSize;
        this.tileSize = Math.max(0.05, size);

        const layer: TerrainLayer = {
            id: 0,
            slot: 0,
            name: ref.name,
            color: '#808080',
            color_secondary: '#808080',
            roughness: 0.85,
            noise_scale: 8,
            variation: 0.5,
            bump: 0.5,
            texture_url: null,
            texture_scale: this.tileSize,
            material_id: ref.id,
            material: ref,
            tint: opts.tint ?? '#ffffff',
            roughness_scale: opts.roughnessScale ?? 1,
            normal_strength: opts.normalStrength ?? 1,
            auto_min_height: null,
            auto_max_height: null,
            auto_min_slope: null,
            auto_max_slope: null,
            auto_priority: 0,
        };
        this.material.setLayers([layer]);

        if (sizeChanged) {
            this.applyShape();
        }
    }

    setShape(shape: MaterialPreviewShape): void {
        this.shape = shape;
        this.applyShape();
    }

    /** Sun position by hour of day (6 = sunrise, 12 = noon, 18 = sunset). */
    setLight(timeOfDay: number): void {
        const elevation = Math.max(
            -5,
            Math.sin(((timeOfDay - 6) / 12) * Math.PI) * 62,
        );
        const dir = new THREE.Vector3().setFromSphericalCoords(
            1,
            THREE.MathUtils.degToRad(90 - elevation),
            THREE.MathUtils.degToRad(200 + (timeOfDay - 12) * 15),
        );

        for (const sky of [this.sky, this.envSky]) {
            const u = sky.material.uniforms;
            u.turbidity.value = 2.5;
            u.rayleigh.value = 1.2;
            u.mieCoefficient.value = 0.005;
            u.mieDirectionalG.value = 0.8;
            u.sunPosition.value.copy(dir);
            u.cloudCoverage.value = 0.2;
        }

        this.envSky.material.uniforms.showSunDisc.value = 0;
        const up = THREE.MathUtils.clamp(elevation / 25, 0, 1);
        this.sun.color.set('#ffb070').lerp(new THREE.Color('#fff6e8'), up);
        this.sun.intensity =
            elevation < -2 ? 0 : THREE.MathUtils.lerp(0.4, 3.2, up);
        this.sun.position.copy(dir).multiplyScalar(80);
        this.hemi.intensity = THREE.MathUtils.lerp(0.08, 0.25, up);

        this.envTarget?.dispose();
        this.envTarget = this.pmrem.fromScene(this.envScene, 0, 0.1, 2000);
        this.scene.environment = this.envTarget.texture;
        this.scene.environmentIntensity = 0.55;
    }

    resetCamera(): void {
        const t = this.tileSize;

        switch (this.shape) {
            case 'sphere': {
                const r = this.sphere.scale.x;
                this.camera.position.set(r * 2.2, r * 1.4, r * 2.6);
                this.controls.target.set(0, r, 0);
                break;
            }
            case 'plane':
                this.camera.position.set(t * 0.9, t * 1.6, t * 1.4);
                this.controls.target.set(0, 0, 0);
                break;
            default:
                this.camera.position.set(
                    PATCH_SIZE * 0.42,
                    PATCH_SIZE * 0.3,
                    PATCH_SIZE * 0.5,
                );
                this.controls.target.set(0, 3, 0);
        }

        this.controls.update();
    }

    dispose(): void {
        cancelAnimationFrame(this.frame);
        this.resizeObserver.disconnect();
        this.intersection.disconnect();
        this.controls.dispose();
        this.terrain.dispose();
        this.sphere.geometry.dispose();
        this.plane.geometry.dispose();
        this.material.dispose();
        this.splat.dispose();
        this.envTarget?.dispose();
        this.pmrem.dispose();
        this.sky.material.dispose();
        this.envSky.material.dispose();
        this.renderer.dispose();
        this.renderer.forceContextLoss();
    }

    private applyShape(): void {
        const t = this.tileSize;
        // Sphere shows about one texture repeat around its circumference, plane two repeats.
        const r = THREE.MathUtils.clamp(t * 0.45, 0.4, 12);
        this.sphere.scale.setScalar(r);
        this.sphere.position.set(0, r, 0);
        this.plane.scale.setScalar(THREE.MathUtils.clamp(t * 2, 1, 40));
        this.plane.position.set(0, 0.01, 0);

        this.sphere.visible = this.shape === 'sphere';
        this.plane.visible = this.shape === 'plane' || this.shape === 'sphere';
        this.terrain.group.visible = this.shape === 'terrain';
        this.resetCamera();
    }

    private resize(): void {
        const w = this.canvas.clientWidth || 300;
        const h = this.canvas.clientHeight || 200;
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
    }

    private loop = (): void => {
        this.frame = requestAnimationFrame(this.loop);

        if (!this.visible || document.hidden) {
            return;
        }

        this.controls.update();
        this.terrain.updateLod(this.camera);
        this.renderer.render(this.scene, this.camera);
    };
}

/** Rolling test terrain with a steep rocky face so triplanar projection is visible. */
function createPatch(): Heightfield {
    const hf = new Heightfield(PATCH_RES, PATCH_SIZE);
    const noise = new SimplexNoise(7);

    for (let r = 0; r < PATCH_RES; r++) {
        for (let c = 0; c < PATCH_RES; c++) {
            const x = hf.colToX(c);
            const z = hf.rowToZ(r);
            const hills = noise.fbm(x / 18, z / 18, 4) * 2.2;
            // A cliff band rising towards the north-east.
            const cliff = 7 / (1 + Math.exp(-(x - z) * 0.45 + 5));
            hf.set(c, r, hills + cliff + noise.noise2D(x / 4, z / 4) * 0.25);
        }
    }

    return hf;
}
