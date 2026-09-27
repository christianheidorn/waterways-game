import * as THREE from 'three';
import type { EnvironmentSettings, ShadowQuality } from '../shared/types';
import { fogSunColor, fogSunParams, heightFogParams } from './HeightFog';
import { extinction, SkyDome, skyRadiance } from './SkyDome';
import type { CloudQuality, SkyParams } from './SkyDome';

const SHADOW_MAP_SIZES: Record<ShadowQuality, number> = {
    off: 0,
    low: 1024,
    medium: 2048,
    high: 4096,
    ultra: 8192,
};

/** Seconds for weather-driven values to cover ~63 % of a change (≈ 3 s to settle). */
const TRANSITION_TAU = 0.9;

/** Values that blend smoothly when the environment changes. */
type Look = {
    cloudCoverage: number;
    turbidity: number;
    fogDensity: number;
    exposure: number;
    heightFogHeight: number;
    heightFogDensity: number;
    overcast: number;
    darkness: number;
    windX: number;
    windZ: number;
    windStrength: number;
};

function emptyLook(): Look {
    return {
        cloudCoverage: 0,
        turbidity: 2,
        fogDensity: 0.0002,
        exposure: 0.5,
        heightFogHeight: 0,
        heightFogDensity: 0,
        overcast: 0,
        darkness: 0,
        windX: 0,
        windZ: 0,
        windStrength: 0,
    };
}

const smooth = (a: number, b: number, x: number) => {
    const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);

    return t * t * (3 - 2 * t);
};

/** Environment values, tolerating maps saved before the weather fields existed. */
export function withWeatherDefaults(env: EnvironmentSettings): EnvironmentSettings {
    return {
        ...env,
        weather: env.weather ?? 'clear',
        precipitation: env.precipitation ?? 0,
        lightning_frequency: env.lightning_frequency ?? 0,
        thunder_volume: env.thunder_volume ?? 0.7,
        wind_direction: env.wind_direction ?? 45,
        height_fog_height: env.height_fog_height ?? 0,
        height_fog_density: env.height_fog_density ?? 0.012,
        wetness: env.wetness ?? 0,
    };
}

/**
 * Sky dome (clouds, stars, moon), sun / moon + ambient lighting, image-based lighting from the sky,
 * distance + valley (height) fog and a sun shadow that follows the focus point (player or editor
 * camera target). Weather changes blend over a few seconds; lightning flashes come from Weather.
 */
export class Atmosphere {
    readonly sky: SkyDome;
    readonly sun: THREE.DirectionalLight;
    readonly hemi: THREE.HemisphereLight;
    readonly fog: THREE.FogExp2;
    /** Direction towards the sun (below the horizon at night). */
    readonly sunDirection = new THREE.Vector3();
    readonly moonDirection = new THREE.Vector3();
    /** Horizontal wind vector (x, z) scaled by wind strength, blended. */
    readonly wind = new THREE.Vector2();
    /** Lightning flash level (0-1+) and direction, driven by Weather. */
    flash = 0;
    readonly flashDirection = new THREE.Vector3(0, 1, 0);
    private flashLight: THREE.DirectionalLight;
    private pmrem: THREE.PMREMGenerator;
    private envTarget: THREE.WebGLRenderTarget | null = null;
    private envScene = new THREE.Scene();
    private envSky: SkyDome;
    private envDirty = true;
    private envTimer = 0;
    private shadowDistance = 220;
    private underwater = false;
    private env: EnvironmentSettings | null = null;
    private current = emptyLook();
    private target = emptyLook();
    private settled = false;
    private lightingDirty = true;
    private terrainBase = 0;
    private baseFogColor = new THREE.Color();
    private baseFogDensity = 0.0002;
    private readonly underwaterColor = new THREE.Color('#0d3a4a');
    private night = 0;
    // Scratch objects (no per-frame allocations).
    private readonly tmpColor = new THREE.Color();
    private readonly tmpColor2 = new THREE.Color();
    private readonly tmpDir = new THREE.Vector3();
    private readonly tmpCenter = new THREE.Vector3();
    private readonly lightRot = new THREE.Matrix4();
    private readonly lightRotInv = new THREE.Matrix4();
    private readonly origin = new THREE.Vector3();
    private readonly up = new THREE.Vector3(0, 1, 0);
    private readonly skyParams: SkyParams = {
        turbidity: 2,
        rayleigh: 1,
        mieCoefficient: 0.005,
        mieDirectionalG: 0.8,
    };

    constructor(
        private readonly renderer: THREE.WebGLRenderer,
        private readonly scene: THREE.Scene,
    ) {
        this.sky = new SkyDome('medium');
        this.sky.scale.setScalar(450000);
        this.sky.name = 'Sky';
        scene.add(this.sky);

        this.envSky = new SkyDome('low', false);
        this.envSky.scale.setScalar(1000);
        this.envScene.add(this.envSky);

        this.sun = new THREE.DirectionalLight(0xffffff, 3);
        this.sun.name = 'Sun';
        this.sun.castShadow = true;
        this.sun.shadow.bias = -0.0004;
        this.sun.shadow.normalBias = 0.6;
        scene.add(this.sun);
        scene.add(this.sun.target);

        this.flashLight = new THREE.DirectionalLight(0xc8d4ff, 0);
        this.flashLight.name = 'Lightning';
        this.flashLight.visible = false;
        scene.add(this.flashLight);
        scene.add(this.flashLight.target);

        this.hemi = new THREE.HemisphereLight(0xbfd9ff, 0x4a4030, 0.35);
        scene.add(this.hemi);

        this.fog = new THREE.FogExp2(0xbfd1e5, 0.0002);
        scene.fog = this.fog;

        this.pmrem = new THREE.PMREMGenerator(renderer);
    }

    apply(input: EnvironmentSettings): void {
        const env = withWeatherDefaults(input);
        this.env = env;
        const t = this.target;
        const precip = THREE.MathUtils.clamp(env.precipitation, 0, 1);
        const storm = THREE.MathUtils.clamp(env.lightning_frequency / 5, 0, 1);
        const snow = env.weather === 'snow' ? 1 : 0;
        const windRad = THREE.MathUtils.degToRad(env.wind_direction);

        t.cloudCoverage = THREE.MathUtils.clamp(env.cloud_coverage, 0, 1);
        t.turbidity = env.turbidity;
        // Falling rain / snow cuts visibility.
        t.fogDensity =
            env.fog_density + precip * (snow ? 0.0014 : 0.0007) + storm * 0.0002;
        t.exposure = env.exposure;
        t.heightFogHeight = env.height_fog_height;
        t.heightFogDensity = env.height_fog_height > 0 ? env.height_fog_density : 0;
        t.overcast = smooth(0.55, 1, t.cloudCoverage);
        t.darkness = THREE.MathUtils.clamp(
            smooth(0.75, 1, t.cloudCoverage) * 0.3 +
                precip * (snow ? 0.1 : 0.3) +
                storm * 0.35,
            0,
            0.92,
        );
        t.windStrength = env.wind_strength;
        t.windX = Math.sin(windRad);
        t.windZ = -Math.cos(windRad);

        if (!this.settled) {
            Object.assign(this.current, t);
            this.settled = true;
        }

        this.lightingDirty = true;
        this.envDirty = true;
    }

    /** Lowest ground (or sea) level: valley fog is measured from here. */
    setTerrainBase(height: number): void {
        this.terrainBase = height;
        this.lightingDirty = true;
    }

    setCloudQuality(quality: CloudQuality): void {
        this.sky.setCloudQuality(quality);
        this.envSky.setCloudQuality(quality === 'off' ? 'off' : 'low');
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

    /** Blend weather, relight, and keep the shadow frustum centred on the focus point. */
    update(dt: number, focus: THREE.Vector3): void {
        this.blend(dt);

        // Clouds drift with the wind (accumulated so direction changes never jump).
        const u = this.sky.uniforms;
        const drift = (0.004 + this.current.windStrength * 0.01) * dt;
        u.cloudOffset.value.x -= this.current.windX * drift;
        u.cloudOffset.value.y -= this.current.windZ * drift;
        u.time.value += dt;
        this.envSky.uniforms.cloudOffset.value.copy(u.cloudOffset.value);

        if (this.lightingDirty || this.flash > 0 || this.flashLight.visible) {
            this.relight();
        }

        // Snap the shadow centre to texels in light space to avoid shimmering.
        const texel =
            (this.shadowDistance * 2) / Math.max(1, this.sun.shadow.mapSize.x);
        const lightDir = this.lightDirection();
        const center = this.tmpCenter.copy(focus);
        this.lightRot.lookAt(this.origin, this.tmpDir.copy(lightDir).negate(), this.up);
        this.lightRotInv.copy(this.lightRot).invert();
        center.applyMatrix4(this.lightRotInv);
        center.x = Math.round(center.x / texel) * texel;
        center.y = Math.round(center.y / texel) * texel;
        center.applyMatrix4(this.lightRot);

        this.sun.target.position.copy(center);
        this.sun.position
            .copy(center)
            .addScaledVector(lightDir, this.shadowDistance * 3 + 1500);
        this.sun.target.updateMatrixWorld();

        this.envTimer -= dt;

        if (this.envDirty && this.envTimer <= 0 && this.flash <= 0.01) {
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
        // Restores the sun in-scattering that applyFog() switched off below the surface.
        this.lightingDirty = true;
    }

    get isUnderwater(): boolean {
        return this.underwater;
    }

    get environment(): EnvironmentSettings | null {
        return this.env;
    }

    /** 0 = day, 1 = full night. */
    get nightAmount(): number {
        return this.night;
    }

    /** Blended overcast / storm darkness (0-1), for effects that should match the sky. */
    get darkness(): number {
        return this.current.darkness;
    }

    /** Ambient light colour scaled for unlit effects (rain, snow). */
    ambientColor(out: THREE.Color): THREE.Color {
        return out
            .copy(this.hemi.color)
            .multiplyScalar(this.hemi.intensity * 2.2)
            .addScaledVector(this.sun.color, this.sun.intensity * 0.12);
    }

    dispose(): void {
        this.envTarget?.dispose();
        this.pmrem.dispose();
        this.sky.dispose();
        this.envSky.dispose();
        this.flashLight.dispose();
    }

    // ---------------------------------------------------------------- internals

    private blend(dt: number): void {
        const k = 1 - Math.exp(-dt / TRANSITION_TAU);
        const c = this.current;
        const t = this.target;
        let moving = false;

        for (const key of Object.keys(t) as (keyof Look)[]) {
            const d = t[key] - c[key];

            if (Math.abs(d) > Math.abs(t[key]) * 1e-4 + 1e-7) {
                c[key] += d * k;
                moving = true;
            } else {
                c[key] = t[key];
            }
        }

        const len = Math.hypot(c.windX, c.windZ) || 1;
        this.wind.set((c.windX / len) * c.windStrength, (c.windZ / len) * c.windStrength);

        if (moving) {
            this.lightingDirty = true;
            this.envDirty = true;
        }
    }

    private lightDirection(): THREE.Vector3 {
        return this.sunDirection.y > -0.05 ? this.sunDirection : this.moonDirection;
    }

    private relight(): void {
        this.lightingDirty = false;
        const env = this.env;

        if (!env) {
            return;
        }

        const c = this.current;
        const flash = this.flash;

        // Sun elevation follows a simple day curve: sunrise 6h, noon 12h (≈62°), sunset 18h.
        const dayPhase = ((env.time_of_day - 6) / 12) * Math.PI;
        const elevation = Math.sin(dayPhase) * 62;
        const azimuth = env.sun_azimuth + (env.time_of_day - 12) * 15;
        const phi = THREE.MathUtils.degToRad(90 - elevation);
        const theta = THREE.MathUtils.degToRad(azimuth);
        this.sunDirection.setFromSphericalCoords(1, phi, theta);
        // The moon rides roughly opposite the sun, a little higher so it shows most of the night.
        this.moonDirection
            .copy(this.sunDirection)
            .negate()
            .add(this.tmpDir.set(0.15, 0.3, 0.1))
            .normalize();

        const night = smooth(2, -8, elevation);
        this.night = night;
        const sunUp = THREE.MathUtils.clamp(elevation / 25, 0, 1);
        const cov = c.cloudCoverage;
        const overcast = c.overcast;
        const dark = c.darkness;

        const p = this.skyParams;
        p.turbidity = c.turbidity + overcast * 4;
        p.rayleigh = 1 + cov * 0.8;
        p.mieCoefficient = 0.004 + cov * 0.012;
        p.mieDirectionalG = 0.8;

        for (const sky of [this.sky, this.envSky]) {
            const u = sky.uniforms;
            u.turbidity.value = p.turbidity;
            u.rayleigh.value = p.rayleigh;
            u.mieCoefficient.value = p.mieCoefficient;
            u.mieDirectionalG.value = p.mieDirectionalG;
            u.sunPosition.value.copy(this.sunDirection);
            u.moonPosition.value.copy(this.moonDirection);
            u.cloudCoverage.value = cov;
            u.cloudDensity.value = 0.35 + cov * 0.65;
            u.cloudSoftness.value = THREE.MathUtils.lerp(0.22, 0.7, overcast);
            u.cloudDarkness.value = dark;
            u.overcast.value = overcast;
            u.night.value = night * (1 - overcast * 0.9);
            u.flash.value = flash;
            u.flashDirection.value.copy(this.flashDirection);
        }

        // ---- direct light: sun by day, moon by night
        const sunColor = extinction(this.sunDirection.y, p, this.tmpColor);
        const maxC = Math.max(sunColor.r, sunColor.g, sunColor.b, 1e-4);
        sunColor.multiplyScalar(1 / maxC);
        const cloudBlock = 1 - cov * 0.5 - overcast * 0.38;

        if (this.sunDirection.y > -0.05) {
            this.sun.color.copy(sunColor).lerp(this.tmpColor2.set('#fff4e6'), 0.25);
            this.sun.intensity =
                THREE.MathUtils.lerp(0.35, 3.2, sunUp) *
                smooth(-3, 3, elevation) *
                Math.max(0.05, cloudBlock) *
                (1 - dark * 0.5);
        } else {
            this.sun.color.set('#9fb4e0');
            this.sun.intensity =
                0.22 *
                smooth(-4, -12, elevation) *
                smooth(-0.05, 0.25, this.moonDirection.y) *
                (1 - overcast * 0.8);
        }

        // ---- ambient
        const skyTint = this.tmpColor2.set('#bfd9ff').lerp(this.tmpColor.set('#c9ced6'), overcast);
        this.hemi.color.copy(skyTint);

        if (night > 0.99) {
            this.hemi.color.set('#5c6f99');
        }

        const dayAmbient =
            THREE.MathUtils.lerp(0.1, 0.25, sunUp) * (1 + cov * 0.8) * (1 - dark * 0.45);
        this.hemi.intensity =
            THREE.MathUtils.lerp(dayAmbient, 0.09, night) + flash * 1.4;
        this.hemi.groundColor.set('#4a4030').multiplyScalar(1 - night * 0.6);

        // ---- lightning flash light from the strike direction
        this.flashLight.visible = flash > 0.005;
        this.flashLight.intensity = flash * 5;
        this.flashLight.position.copy(this.flashDirection).multiplyScalar(1000);
        this.flashLight.target.position.set(0, 0, 0);
        this.flashLight.target.updateMatrixWorld();

        // Overcast skies and nights would look muddy at the same exposure: compensate a little.
        this.renderer.toneMappingExposure =
            c.exposure * (1 + overcast * 0.3 + dark * 0.25) * (1 + night * 0.9);
        this.scene.environmentIntensity = 0.55 * (1 - dark * 0.3) + flash * 0.8;

        // ---- fog colour = the sky's horizon radiance so distant terrain melts into the sky
        const horizon = this.baseFogColor.setRGB(0, 0, 0);
        const dir = this.tmpDir;

        for (let i = 0; i < 4; i++) {
            const a = theta + (i * Math.PI) / 2 + Math.PI / 4;
            dir.set(Math.sin(a), 0.03, Math.cos(a)).normalize();
            horizon.add(skyRadiance(dir, this.sunDirection, p, this.tmpColor));
        }

        horizon.multiplyScalar(0.25);
        // Radiance towards the sun beyond the average becomes fog in-scattering.
        dir.set(this.sunDirection.x, 0.03, this.sunDirection.z).normalize();
        const sunward = skyRadiance(dir, this.sunDirection, p, this.tmpColor);
        const lum = horizon.r * 0.2126 + horizon.g * 0.7152 + horizon.b * 0.0722;
        // Overcast desaturation + cloud deck at the horizon (matches the sky shader).
        horizon.lerp(this.tmpColor2.setRGB(lum * 0.93, lum * 0.97, lum * 1.04), overcast * 0.85);
        horizon.multiplyScalar(1 - overcast * 0.25);
        const cloudLum = lum * 1.3 * (1 - dark * 0.6);
        horizon.lerp(this.tmpColor2.setRGB(cloudLum, cloudLum, cloudLum * 1.03), cov * 0.45);
        horizon.add(this.tmpColor2.setRGB(0.0024, 0.0034, 0.0062).multiplyScalar(night * 1.4));
        horizon.addScaledVector(this.tmpColor2.setRGB(0.55, 0.6, 0.8), flash * 0.15);

        fogSunColor.x = Math.max(0, sunward.r - horizon.r);
        fogSunColor.y = Math.max(0, sunward.g - horizon.g);
        fogSunColor.z = Math.max(0, sunward.b - horizon.b);
        fogSunParams.x = this.sunDirection.x;
        fogSunParams.y = this.sunDirection.y;
        fogSunParams.z = this.sunDirection.z;
        fogSunParams.w = smooth(-4, 2, elevation) * (1 - overcast * 0.85) * 0.8;

        this.baseFogDensity = c.fogDensity;

        for (const sky of [this.sky, this.envSky]) {
            sky.uniforms.horizonColor.value.copy(horizon);
            sky.uniforms.horizonFog.value = THREE.MathUtils.clamp(
                0.2 + c.fogDensity / 0.0016 + overcast * 0.35,
                0,
                1,
            );
        }

        this.applyFog();
    }

    private applyFog(): void {
        const c = this.current;

        if (this.underwater) {
            this.fog.color.copy(this.underwaterColor);
            this.fog.density = 0.08;
            heightFogParams.z = 0;
            fogSunParams.w = 0;
        } else {
            this.fog.color.copy(this.baseFogColor);
            this.fog.density = this.baseFogDensity;
            const height = Math.max(1, c.heightFogHeight);
            heightFogParams.x = this.terrainBase;
            heightFogParams.y = 3.2 / height;
            heightFogParams.z = c.heightFogHeight > 0.5 ? c.heightFogDensity : 0;
        }
    }

    private regenerateEnvironment(): void {
        this.envDirty = false;
        const target = this.pmrem.fromScene(this.envScene, 0, 0.1, 2000);
        this.envTarget?.dispose();
        this.envTarget = target;
        this.scene.environment = target.texture;
    }
}
