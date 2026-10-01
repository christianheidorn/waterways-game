import * as THREE from 'three/webgpu';
import { mix, normalize, positionLocal, smoothstep, uniform } from 'three/tsl';
import type { GameRenderer } from '../core/renderer';
import type { EnvironmentSettings, ShadowQuality } from '../shared/types';
import {
    createHeightFogNode,
    fogSunColor,
    fogSunParams,
    heightFogParams,
} from './HeightFog';
import {
    CLOUD_HEIGHT,
    CloudShadowBake,
    cloudShadowNode,
    extinction,
    SkyDome,
    skyRadiance,
} from './SkyDome';
import type { CloudShadowInputs } from './SkyDome';
import type { CloudQuality, SkyParams } from './SkyDome';
import { SunShadows } from './SunShadows';

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

const LOOK_KEYS = Object.keys(emptyLook()) as (keyof Look)[];

const smooth = (a: number, b: number, x: number) => {
    const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);

    return t * t * (3 - 2 * t);
};

/** Environment values, tolerating maps saved before the weather fields existed. */
export function withWeatherDefaults(
    env: EnvironmentSettings,
): EnvironmentSettings {
    return {
        ...env,
        weather: env.weather ?? 'clear',
        precipitation: env.precipitation ?? 0,
        falling_leaves: env.falling_leaves ?? 0,
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
 * camera target; a live near cascade over a cached far one, see SunShadows). Weather changes blend
 * over a few seconds; lightning flashes come from Weather.
 */
export class Atmosphere {
    readonly sky: SkyDome;
    readonly sun: THREE.DirectionalLight;
    readonly sunShadows: SunShadows;
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
    private envTarget: THREE.RenderTarget | null = null;
    private envScene = new THREE.Scene();
    private envSky: SkyDome;
    /** Radiance of the ground below the horizon in the sky reflections (see createEnvGround). */
    private readonly envGroundColor = uniform(
        new THREE.Color(0.05, 0.05, 0.05),
    );
    private readonly envGround: THREE.Mesh<
        THREE.SphereGeometry,
        THREE.MeshBasicNodeMaterial
    >;
    private groundWet = 0;
    private groundSnow = 0;
    private readonly skies: SkyDome[];
    private envDirty = true;
    private envTimer = 0;
    private underwater = false;
    /** Cloud shadow inputs (light direction, strength) and the graphics switch. */
    private readonly cloudShadow: CloudShadowInputs = {
        lightDir: uniform(new THREE.Vector3(0, 1, 0)),
        strength: uniform(0),
        base: uniform(0),
        baked: null,
    };
    private cloudShadowsEnabled = true;
    /**
     * Bounce light inputs (world/bounce/BounceLight): the sun / moon irradiance and the sky's
     * irradiance on open flat ground (hemisphere light + environment), before the debug view's
     * switch-off.
     */
    readonly bounceSun = new THREE.Color();
    readonly bounceSky = new THREE.Color();
    /** Share of the hemisphere ground colour and the reflections' ground kept (the bounce light replaces it). */
    private groundBounce = 1;
    /** "Bounce light only" view: every other light off. */
    private lightsOff = false;
    private env: EnvironmentSettings | null = null;
    private current = emptyLook();
    private target = emptyLook();
    private settled = false;
    private lightingDirty = true;
    private terrainBase = 0;
    private baseFogColor = new THREE.Color();
    private deckColor = new THREE.Color();
    private baseFogDensity = 0.0002;
    private readonly underwaterColor = new THREE.Color('#0d3a4a');
    private night = 0;
    // Scratch objects (no per-frame allocations).
    private readonly tmpColor = new THREE.Color();
    private readonly tmpColor2 = new THREE.Color();
    private readonly zenithColor = new THREE.Color();
    private readonly tmpDir = new THREE.Vector3();
    private readonly skyParams: SkyParams = {
        turbidity: 2,
        rayleigh: 1,
        mieCoefficient: 0.005,
        mieDirectionalG: 0.8,
    };

    constructor(
        private readonly renderer: GameRenderer,
        private readonly scene: THREE.Scene,
    ) {
        this.sky = new SkyDome('medium');
        this.sky.scale.setScalar(450000);
        this.sky.name = 'Sky';
        this.cloudShadow.baked = new CloudShadowBake(this.sky);
        scene.add(this.sky);

        this.envSky = new SkyDome('low', false);
        this.envSky.scale.setScalar(1000);
        this.envGround = this.createEnvGround();
        this.envScene.add(this.envSky, this.envGround);
        this.skies = [this.sky, this.envSky];

        this.sun = new THREE.DirectionalLight(0xffffff, 3);
        this.sun.name = 'Sun';
        this.sun.castShadow = true;
        scene.add(this.sun);
        scene.add(this.sun.target);
        this.sunShadows = new SunShadows(this.sun, scene, (position) =>
            cloudShadowNode(this.sky, this.cloudShadow, position),
        );

        this.flashLight = new THREE.DirectionalLight(0xc8d4ff, 0);
        this.flashLight.name = 'Lightning';
        // Always in the scene (intensity 0 between strikes): with node materials, a change in the set
        // of active lights recompiles every material, which stalled each strike for seconds.
        scene.add(this.flashLight);
        scene.add(this.flashLight.target);

        this.hemi = new THREE.HemisphereLight(0xbfd9ff, 0x4a4030, 0.35);
        scene.add(this.hemi);

        this.fog = new THREE.FogExp2(0xbfd1e5, 0.0002);
        scene.fog = this.fog;
        // Distance + height fog with sun in-scattering for every node material (replaces scene.fog).
        scene.fogNode = createHeightFogNode(this.fog);

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
            env.fog_density +
            precip * (snow ? 0.0006 : 0.0004) +
            storm * 0.0001;
        t.exposure = env.exposure;
        t.heightFogHeight = env.height_fog_height;
        t.heightFogDensity =
            env.height_fog_height > 0 ? env.height_fog_density : 0;
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
        // Refresh the sky reflections on the next frame (time of day changes are not blended).
        this.envTimer = 0;
    }

    /** Lowest ground (or sea) level: valley fog is measured from here. */
    setTerrainBase(height: number): void {
        this.terrainBase = height;
        this.cloudShadow.base.value = height;
        this.lightingDirty = true;
    }

    /**
     * Ground state seen in the sky reflections: rain-soaked ground is darker, snow much brighter. Small
     * changes are ignored (the reflections re-render at most every 0.25 s anyway).
     */
    setGround(wet: number, snow: number): void {
        if (
            Math.abs(wet - this.groundWet) < 0.02 &&
            Math.abs(snow - this.groundSnow) < 0.02
        ) {
            return;
        }

        this.groundWet = wet;
        this.groundSnow = snow;
        this.lightingDirty = true;
        this.envDirty = true;
    }

    setCloudQuality(quality: CloudQuality): void {
        this.sky.setCloudQuality(quality);
        this.envSky.setCloudQuality(quality === 'off' ? 'off' : 'low');
        this.envDirty = true;
    }

    /** Light left under the clouds at a world position (light shafts from cloud gaps). */
    cloudLight(position: THREE.Node<'vec3'>): THREE.Node<'float'> {
        return cloudShadowNode(this.sky, this.cloudShadow, position);
    }

    /** Valley fog density (1/m) at a position: its base density below the fog top, 0 above. */
    valleyFogAt(position: THREE.Vector3): number {
        const c = this.current;

        if (this.underwater || c.heightFogHeight <= 0.5) {
            return 0;
        }

        const above = position.y - this.terrainBase;

        return (
            c.heightFogDensity *
            Math.exp(
                -Math.max(0, above) * (3.2 / Math.max(1, c.heightFogHeight)),
            )
        );
    }

    /**
     * How much of the uniform ground light (the hemisphere light's ground colour and the ground in
     * the sky reflections) stays: lowered while the bounce light lights the scene from the real ground.
     */
    setGroundBounce(scale: number): void {
        if (Math.abs(scale - this.groundBounce) < 1e-3) {
            return;
        }

        this.groundBounce = scale;
        this.lightingDirty = true;
        this.envDirty = true;
    }

    /** Switches the sun, moon, sky and lightning light off (the "Bounce light only" view). */
    setLightsOff(off: boolean): void {
        if (off !== this.lightsOff) {
            this.lightsOff = off;
            this.lightingDirty = true;
        }
    }

    /** Drifting cloud shadows (graphics cloud_shadows); their strength is per map. */
    setCloudShadows(enabled: boolean): void {
        this.cloudShadowsEnabled = enabled;
        this.lightingDirty = true;
    }

    setShadowQuality(quality: ShadowQuality, distance: number): void {
        this.sunShadows.configure(quality, distance);
        const on = this.sunShadows.cascade !== null;
        this.renderer.shadowMap.enabled = on;
        this.sun.castShadow = on;
    }

    /** Shadow casters changed (terrain or foliage edits): refreshes the cached far shadow. */
    invalidateShadows(): void {
        this.sunShadows.invalidate();
    }

    /** Blend weather, relight, and keep the shadow cascades centred on the focus point. */
    update(dt: number, focus: THREE.Vector3): void {
        this.blend(dt);

        // Clouds drift with the wind (accumulated so direction changes never jump).
        const u = this.sky.uniforms;
        const drift = (0.004 + this.current.windStrength * 0.01) * dt;
        u.cloudOffset.value.x -= this.current.windX * drift;
        u.cloudOffset.value.y -= this.current.windZ * drift;
        u.time.value += dt;
        this.envSky.uniforms.cloudOffset.value.copy(u.cloudOffset.value);

        if (
            this.lightingDirty ||
            this.flash > 0 ||
            this.flashLight.intensity > 0
        ) {
            this.relight();
        }

        // Only the direction matters for the lighting; the shadow cascades are placed separately.
        const lightDir = this.lightDirection();
        this.cloudShadow.lightDir.value.copy(lightDir);
        // Cloud shadow mask baked around where the focus's light ray meets the cloud layer.
        const rise =
            Math.max(0, this.cloudShadow.base.value + CLOUD_HEIGHT - focus.y) /
            Math.max(lightDir.y, 0.12);
        this.cloudShadow.baked?.update(
            this.renderer,
            focus.x + lightDir.x * rise,
            focus.z + lightDir.z * rise,
            this.cloudShadow.strength.value > 0.001 &&
                this.sky.uniforms.cloudCoverage.value > 0.001,
        );
        this.sun.target.position.copy(focus);
        this.sun.position.copy(focus).add(lightDir);
        this.sun.target.updateMatrixWorld();
        this.sunShadows.update(dt, focus, lightDir);

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
        const k = this.sun.intensity * 0.12;
        out.copy(this.hemi.color).multiplyScalar(this.hemi.intensity * 2.2);
        out.r += this.sun.color.r * k;
        out.g += this.sun.color.g * k;
        out.b += this.sun.color.b * k;

        return out;
    }

    dispose(): void {
        this.envTarget?.dispose();
        this.cloudShadow.baked?.dispose();
        this.pmrem.dispose();
        this.sky.dispose();
        this.envSky.dispose();
        this.envGround.geometry.dispose();
        this.envGround.material.dispose();
        this.flashLight.dispose();
    }

    // ---------------------------------------------------------------- internals

    private blend(dt: number): void {
        const k = 1 - Math.exp(-dt / TRANSITION_TAU);
        const c = this.current;
        const t = this.target;
        let moving = false;

        for (const key of LOOK_KEYS) {
            const d = t[key] - c[key];

            if (Math.abs(d) > Math.abs(t[key]) * 1e-4 + 1e-7) {
                c[key] += d * k;
                moving = true;
            } else {
                c[key] = t[key];
            }
        }

        const len = Math.hypot(c.windX, c.windZ) || 1;
        this.wind.set(
            (c.windX / len) * c.windStrength,
            (c.windZ / len) * c.windStrength,
        );

        if (moving) {
            this.lightingDirty = true;
            this.envDirty = true;
        }
    }

    /** Sky irradiance (hemisphere sky colour × intensity) and sun / moon light (colour × intensity). */
    skyAndSunLight(sky: THREE.Color, sun: THREE.Color): void {
        sky.copy(this.hemi.color).multiplyScalar(this.hemi.intensity);
        sun.copy(this.sun.color).multiplyScalar(this.sun.intensity);
    }

    /** Direction towards the light that is up: the sun by day, the moon by night. */
    lightDirection(): THREE.Vector3 {
        return this.sunDirection.y > -0.05
            ? this.sunDirection
            : this.moonDirection;
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

        // ---- cloud deck brightness: daylight through a closed cloud layer, darker in storms
        const dir = this.tmpDir;
        const zenith = skyRadiance(
            dir.set(0, 1, 0),
            this.sunDirection,
            p,
            this.zenithColor,
        );
        const zenithLum =
            zenith.r * 0.2126 + zenith.g * 0.7152 + zenith.b * 0.0722;
        const deckLum = zenithLum * 1.2 * (1 - dark * 0.8) + 0.012 * night;
        const deck = this.deckColor.setRGB(
            deckLum * 0.95,
            deckLum * 0.98,
            deckLum * 1.04,
        );
        deck.add(
            this.tmpColor2.setRGB(0.55, 0.6, 0.8).multiplyScalar(flash * 0.3),
        );

        // ---- fog colour = the sky's horizon radiance so distant terrain melts into the sky
        const horizon = this.baseFogColor.setRGB(0, 0, 0);

        for (let i = 0; i < 4; i++) {
            const a = theta + (i * Math.PI) / 2 + Math.PI / 4;
            dir.set(Math.sin(a), 0.03, Math.cos(a)).normalize();
            horizon.add(skyRadiance(dir, this.sunDirection, p, this.tmpColor));
        }

        horizon.multiplyScalar(0.25);
        // Radiance towards the sun beyond the average becomes fog in-scattering.
        dir.set(this.sunDirection.x, 0.03, this.sunDirection.z).normalize();
        const sunward = skyRadiance(dir, this.sunDirection, p, this.tmpColor);
        // Thin haze on clear days reads better darker than the (very bright) horizon; in thick fog it
        // brightens towards the horizon so the terrain melts into the sky.
        const fogginess = THREE.MathUtils.clamp(
            (c.fogDensity - 0.0002) / 0.001,
            0,
            1,
        );
        const fogScale = THREE.MathUtils.lerp(0.16, 0.32, fogginess);
        fogSunColor.x = Math.max(0, sunward.r - horizon.r) * fogScale;
        fogSunColor.y = Math.max(0, sunward.g - horizon.g) * fogScale;
        fogSunColor.z = Math.max(0, sunward.b - horizon.b) * fogScale;
        horizon.multiplyScalar(fogScale);
        // Under a cloud deck the horizon is the deck itself (matches the sky shader).
        horizon.lerp(
            this.tmpColor2.copy(deck).multiplyScalar(0.85),
            Math.min(1, overcast * 1.1),
        );
        horizon.add(
            this.tmpColor2
                .setRGB(0.012, 0.018, 0.032)
                .multiplyScalar(night * (1 - overcast)),
        );
        horizon.add(
            this.tmpColor2.setRGB(0.55, 0.6, 0.8).multiplyScalar(flash * 0.15),
        );
        fogSunParams.x = this.sunDirection.x;
        fogSunParams.y = this.sunDirection.y;
        fogSunParams.z = this.sunDirection.z;
        fogSunParams.w = smooth(-4, 2, elevation) * (1 - overcast * 0.9) * 0.5;
        // Cloud shadows: strongest with scattered clouds; a closed deck is one big shadow already
        // (the sun is dimmed instead), so they fade out as it closes.
        this.cloudShadow.strength.value = this.cloudShadowsEnabled
            ? THREE.MathUtils.clamp(env.cloud_shadow_strength ?? 0.6, 0, 1) *
              (1 - overcast * 0.7) *
              smooth(-2, 4, elevation)
            : 0;
        this.baseFogDensity = c.fogDensity;

        for (const sky of this.skies) {
            const u = sky.uniforms;
            u.turbidity.value = p.turbidity;
            u.rayleigh.value = p.rayleigh;
            u.mieCoefficient.value = p.mieCoefficient;
            u.mieDirectionalG.value = p.mieDirectionalG;
            u.sunPosition.value.copy(this.sunDirection);
            u.moonPosition.value.copy(this.moonDirection);
            u.cloudCoverage.value = cov;
            u.cloudDensity.value = 0.35 + cov * 0.65;
            u.cloudSoftness.value = THREE.MathUtils.lerp(0.22, 0.55, overcast);
            u.cloudDarkness.value = dark;
            u.overcast.value = overcast;
            u.night.value = night * (1 - overcast * 0.9);
            u.flash.value = flash;
            u.flashDirection.value.copy(this.flashDirection);
            u.deckColor.value.copy(deck);
            u.horizonColor.value.copy(horizon);
            u.horizonFog.value = Math.max(fogginess, overcast * 0.6);
        }

        // ---- direct light: sun by day, moon by night
        const sunColor = extinction(this.sunDirection.y, p, this.tmpColor);
        const maxC = Math.max(sunColor.r, sunColor.g, sunColor.b, 1e-4);
        sunColor.multiplyScalar(1 / maxC);
        // Scattered clouds dim the sun a little; a closed deck leaves only soft, shadowless light.
        const cloudBlock = 1 - cov * 0.4 - overcast * 0.55;

        if (this.sunDirection.y > -0.05) {
            this.sun.color
                .copy(sunColor)
                .lerp(this.tmpColor2.set('#fff4e6'), 0.25);
            this.sun.intensity =
                THREE.MathUtils.lerp(0.35, 3.2, sunUp) *
                smooth(-3, 3, elevation) *
                Math.max(0.03, cloudBlock) *
                (1 - dark * 0.6);
        } else {
            this.sun.color.set('#9fb4e0');
            this.sun.intensity =
                0.3 *
                smooth(-4, -12, elevation) *
                smooth(-0.05, 0.25, this.moonDirection.y) *
                (1 - overcast * 0.8);
        }

        // ---- ambient
        this.hemi.color
            .set('#bfd9ff')
            .lerp(this.tmpColor2.set('#c3c9d2'), overcast);

        if (night > 0) {
            this.hemi.color.lerp(this.tmpColor2.set('#5c6f99'), night);
        }

        const dayAmbient =
            THREE.MathUtils.lerp(0.1, 0.25, sunUp) *
            (1 + cov * 0.5) *
            (1 - dark * 0.6);
        this.hemi.intensity =
            THREE.MathUtils.lerp(dayAmbient, 0.1, night) + flash * 1.1;
        this.hemi.groundColor
            .set('#4a4030')
            .multiplyScalar((1 - night * 0.6) * this.groundBounce);

        // ---- lightning flash light from the strike direction
        this.flashLight.intensity = flash > 0.005 ? flash * 2.5 : 0;
        this.flashLight.position.copy(this.flashDirection).multiplyScalar(1000);
        this.flashLight.target.position.set(0, 0, 0);
        this.flashLight.target.updateMatrixWorld();

        // Nights would be pitch black at daylight exposure: open up (a gentle "eye adaptation").
        this.renderer.toneMappingExposure = c.exposure * (1 + night * 0.8);
        this.scene.environmentIntensity =
            0.55 * (1 - dark * 0.35) + flash * 0.8;

        this.updateEnvGround(zenith, deck, overcast);
        this.bounceSun.copy(this.sun.color).multiplyScalar(this.sun.intensity);

        if (this.lightsOff) {
            this.sun.intensity = 0;
            this.hemi.intensity = 0;
            this.flashLight.intensity = 0;
            this.scene.environmentIntensity = 0;
        }

        this.applyFog();
    }

    /**
     * Ground radiance for the lower half of the sky reflections: what flat terrain renders at with the
     * current lights (Lambert: albedo / π × direct irradiance + albedo × sky irradiance), divided by the
     * environment intensity the reflections are scaled with when sampled. Without it every surface that
     * faces sideways or down (characters, rocks, trunks) is lit from below by the bright horizon.
     */
    private updateEnvGround(
        zenith: THREE.Color,
        deck: THREE.Color,
        overcast: number,
    ): void {
        // Typical terrain albedo (grass, soil); rain darkens it, snow brightens it.
        const albedo = THREE.MathUtils.lerp(
            0.25 * (1 - this.groundWet * 0.35),
            0.75,
            this.groundSnow,
        );
        const envIntensity = Math.max(0.05, this.scene.environmentIntensity);
        // Sky radiance averaged over the upper hemisphere (the horizon is brighter than the zenith on
        // clear days; under a closed deck the deck is all there is).
        const sky = this.tmpColor2
            .copy(zenith)
            .multiplyScalar(1.4)
            .lerp(deck, Math.min(1, overcast * 1.2));
        const e = this.envGroundColor.value;
        // Direct light on flat ground (sun or moon; lightning never reaches the reflections).
        const cosSun = Math.max(0, this.lightDirection().y);
        e.copy(this.sun.color).multiplyScalar(
            (this.sun.intensity * cosSun) / Math.PI,
        );
        // Hemisphere light: the sky colour for an up-facing surface.
        e.r += (this.hemi.color.r * this.hemi.intensity) / Math.PI;
        e.g += (this.hemi.color.g * this.hemi.intensity) / Math.PI;
        e.b += (this.hemi.color.b * this.hemi.intensity) / Math.PI;
        e.multiplyScalar(1 / envIntensity);
        // Sky light, already in environment units.
        e.add(sky);
        e.multiplyScalar(albedo * this.groundBounce);
        // Sky irradiance on open flat ground: the hemisphere light's sky colour plus the environment's
        // sky hemisphere (π × its average radiance).
        this.bounceSky
            .copy(this.hemi.color)
            .multiplyScalar(this.hemi.intensity)
            .add(
                this.tmpColor2
                    .copy(sky)
                    .multiplyScalar(Math.PI * this.scene.environmentIntensity),
            );
    }

    /**
     * Lower hemisphere of the environment scene: a ground dome in `envGroundColor` that fades into the
     * horizon (fog) colour just below the horizon, where the distant terrain disappears in the haze.
     * Drawn before the sky, which is projected onto the far plane and fails the depth test behind it.
     */
    private createEnvGround(): THREE.Mesh<
        THREE.SphereGeometry,
        THREE.MeshBasicNodeMaterial
    > {
        const material = new THREE.MeshBasicNodeMaterial({
            side: THREE.BackSide,
        });
        material.fog = false;
        material.lights = false;
        const up = normalize(positionLocal).y;
        material.colorNode = mix(
            this.envGroundColor,
            this.envSky.uniforms.horizonColor,
            smoothstep(-0.08, 0, up),
        );
        const geometry = new THREE.SphereGeometry(
            500,
            24,
            6,
            0,
            Math.PI * 2,
            Math.PI / 2,
            Math.PI / 2,
        );
        const ground = new THREE.Mesh(geometry, material);
        ground.name = 'EnvGround';
        ground.frustumCulled = false;

        return ground;
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
            heightFogParams.z =
                c.heightFogHeight > 0.5 ? c.heightFogDensity : 0;
        }
    }

    private regenerateEnvironment(): void {
        this.envDirty = false;
        // Re-rendered into the same target: materials keep their environment binding (no rebuilds).
        const target = this.pmrem.fromScene(this.envScene, 0, 0.1, 2000, {
            renderTarget: this.envTarget,
        });
        this.envTarget = target;
        this.scene.environment = target.texture;
    }
}
