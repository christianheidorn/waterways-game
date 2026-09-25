import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import type { EnvironmentSettings, ShadowQuality } from '../shared/types';

const SHADOW_MAP_SIZES: Record<ShadowQuality, number> = {
    off: 0,
    low: 1024,
    medium: 2048,
    high: 4096,
    ultra: 8192,
};

/**
 * Sky dome, sun + ambient lighting, image-based lighting from the sky, fog and a sun shadow
 * that follows the focus point (player or editor camera target).
 */
export class Atmosphere {
    readonly sky: Sky;
    readonly sun: THREE.DirectionalLight;
    readonly hemi: THREE.HemisphereLight;
    readonly fog: THREE.FogExp2;
    readonly sunDirection = new THREE.Vector3();
    private pmrem: THREE.PMREMGenerator;
    private envTarget: THREE.WebGLRenderTarget | null = null;
    private envScene = new THREE.Scene();
    private envSky: Sky;
    private envDirty = true;
    private envTimer = 0;
    private shadowDistance = 220;
    private underwater = false;
    private env: EnvironmentSettings | null = null;
    private baseFogColor = new THREE.Color();
    private baseFogDensity = 0.0002;
    private readonly underwaterColor = new THREE.Color('#0d3a4a');

    constructor(
        private readonly renderer: THREE.WebGLRenderer,
        private readonly scene: THREE.Scene,
    ) {
        this.sky = new Sky();
        this.sky.scale.setScalar(450000);
        this.sky.name = 'Sky';
        scene.add(this.sky);

        this.envSky = new Sky();
        this.envSky.scale.setScalar(1000);
        this.envScene.add(this.envSky);

        this.sun = new THREE.DirectionalLight(0xffffff, 3);
        this.sun.name = 'Sun';
        this.sun.castShadow = true;
        this.sun.shadow.bias = -0.0004;
        this.sun.shadow.normalBias = 0.6;
        scene.add(this.sun);
        scene.add(this.sun.target);

        this.hemi = new THREE.HemisphereLight(0xbfd9ff, 0x4a4030, 0.35);
        scene.add(this.hemi);

        this.fog = new THREE.FogExp2(0xbfd1e5, 0.0002);
        scene.fog = this.fog;

        this.pmrem = new THREE.PMREMGenerator(renderer);
    }

    apply(env: EnvironmentSettings): void {
        this.env = env;
        this.renderer.toneMappingExposure = env.exposure;

        // Sun elevation follows a simple day curve: sunrise 6h, noon 12h (≈62°), sunset 18h.
        const dayPhase = ((env.time_of_day - 6) / 12) * Math.PI;
        const elevation = Math.sin(dayPhase) * 62;
        const azimuth = env.sun_azimuth + (env.time_of_day - 12) * 15;
        const phi = THREE.MathUtils.degToRad(90 - elevation);
        const theta = THREE.MathUtils.degToRad(azimuth);
        this.sunDirection.setFromSphericalCoords(1, phi, theta);

        for (const sky of [this.sky, this.envSky]) {
            const u = sky.material.uniforms;
            u.turbidity.value = env.turbidity;
            u.rayleigh.value = 1 + env.cloud_coverage * 0.8;
            u.mieCoefficient.value = 0.004 + env.cloud_coverage * 0.012;
            u.mieDirectionalG.value = 0.8;
            u.sunPosition.value.copy(this.sunDirection);
            u.cloudCoverage.value = env.cloud_coverage;
            u.cloudDensity.value = 0.25 + env.cloud_coverage * 0.5;
            u.cloudSpeed.value = 0.00001 + env.wind_strength * 0.00003;
        }

        const sunUp = THREE.MathUtils.clamp(elevation / 25, 0, 1);
        const night = elevation < -4;
        const warm = new THREE.Color('#ffb070');
        const noon = new THREE.Color('#fff6e8');
        this.sun.color.copy(warm).lerp(noon, sunUp);
        this.sun.intensity = night
            ? 0
            : THREE.MathUtils.lerp(0.4, 3.2, sunUp) *
              (1 - env.cloud_coverage * 0.55);
        this.hemi.intensity = night
            ? 0.06
            : THREE.MathUtils.lerp(0.1, 0.25, sunUp) *
              (1 + env.cloud_coverage * 0.6);

        // Fog colour approximates the horizon colour of the sky.
        const horizonDay = new THREE.Color('#b9cde0');
        const horizonDusk = new THREE.Color('#d9a27a');
        const horizonNight = new THREE.Color('#0b1220');
        const fogColor = horizonDusk.clone().lerp(horizonDay, sunUp);

        if (elevation < 2) {
            fogColor.lerp(
                horizonNight,
                THREE.MathUtils.clamp((2 - elevation) / 10, 0, 1),
            );
        }

        fogColor.lerp(new THREE.Color('#9aa5ae'), env.cloud_coverage * 0.5);
        this.baseFogColor.copy(fogColor);
        this.baseFogDensity = env.fog_density;
        this.applyFog();
        this.envDirty = true;
    }

    setShadowQuality(quality: ShadowQuality, distance: number): void {
        const size = SHADOW_MAP_SIZES[quality];
        this.shadowDistance = distance;
        this.renderer.shadowMap.enabled = size > 0;
        this.sun.castShadow = size > 0;

        if (size > 0 && this.sun.shadow.mapSize.x !== size) {
            this.sun.shadow.mapSize.set(size, size);
            this.sun.shadow.map?.dispose();
            this.sun.shadow.map = null;
        }

        const cam = this.sun.shadow.camera;
        cam.left = cam.bottom = -distance;
        cam.right = cam.top = distance;
        cam.near = 1;
        cam.far = distance * 6 + 4000;
        cam.updateProjectionMatrix();
        this.renderer.shadowMap.needsUpdate = true;
    }

    /** Keep the shadow frustum centred on the focus point, snapped to texels to avoid shimmering. */
    update(dt: number, focus: THREE.Vector3): void {
        const texel =
            (this.shadowDistance * 2) / Math.max(1, this.sun.shadow.mapSize.x);
        const center = focus.clone();
        // Snap in light space.
        const lightRot = new THREE.Matrix4().lookAt(
            new THREE.Vector3(),
            this.sunDirection.clone().negate(),
            new THREE.Vector3(0, 1, 0),
        );
        const inv = lightRot.clone().invert();
        center.applyMatrix4(inv);
        center.x = Math.round(center.x / texel) * texel;
        center.y = Math.round(center.y / texel) * texel;
        center.applyMatrix4(lightRot);

        this.sun.target.position.copy(center);
        this.sun.position
            .copy(center)
            .addScaledVector(this.sunDirection, this.shadowDistance * 3 + 1500);
        this.sun.target.updateMatrixWorld();

        this.sky.material.uniforms.time.value += dt;
        this.envTimer -= dt;

        if (this.envDirty && this.envTimer <= 0) {
            this.regenerateEnvironment();
            this.envTimer = 0.25;
        }
    }

    setUnderwater(underwater: boolean, shallowColor?: string): void {
        if (underwater === this.underwater) {
            return;
        }

        this.underwater = underwater;

        if (shallowColor) {
            this.underwaterColor.set(shallowColor).multiplyScalar(0.35);
        }

        this.applyFog();
    }

    get environment(): EnvironmentSettings | null {
        return this.env;
    }

    dispose(): void {
        this.envTarget?.dispose();
        this.pmrem.dispose();
        this.sky.material.dispose();
        this.envSky.material.dispose();
    }

    private applyFog(): void {
        if (this.underwater) {
            this.fog.color.copy(this.underwaterColor);
            this.fog.density = 0.08;
        } else {
            this.fog.color.copy(this.baseFogColor);
            this.fog.density = this.baseFogDensity;
        }
    }

    private regenerateEnvironment(): void {
        this.envDirty = false;
        const target = this.pmrem.fromScene(this.envScene, 0, 0.1, 2000);
        this.envTarget?.dispose();
        this.envTarget = target;
        this.scene.environment = target.texture;
        this.scene.environmentIntensity = 0.55;
    }
}
