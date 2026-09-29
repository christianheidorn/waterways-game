import * as THREE from 'three/webgpu';
import type {
    EnvironmentSettings,
    GraphicsSettings,
    QualityLevel,
} from '../shared/types';
import type { Atmosphere } from './Atmosphere';
import { withWeatherDefaults } from './Atmosphere';
import type { Heightfield } from './Heightfield';
import { Lightning } from './Lightning';
import { Precipitation } from './Precipitation';
import type { CloudQuality } from './SkyDome';
import type { TerrainMaterial } from './TerrainMaterial';
import type { Water } from './Water';
import { WeatherAudio } from './WeatherAudio';

export type WeatherWorld = {
    heights: Heightfield;
    material: TerrainMaterial;
    water: Water;
    /** Foliage sway strength (Foliage.setWind). */
    setFoliageWind?: (strength: number, dirX: number, dirZ: number) => void;
};

/** Seconds to cover ~63 % of a change in precipitation / lightning settings. */
const TAU = 0.9;

/**
 * Weather effects on top of the Atmosphere: rain / snow particles, lightning strikes with thunder,
 * gusting wind (foliage, water, rain slant, audio), wet ground that soaks up during rain and dries
 * afterwards, snow cover, and rain ripples on water. Every setting blends smoothly when changed.
 */
export class Weather {
    readonly precipitation: Precipitation;
    readonly lightning = new Lightning();
    readonly audio = new WeatherAudio();
    private env: EnvironmentSettings | null = null;
    private settled = false;
    // Blended values.
    private rain = 0;
    private snow = 0;
    private lightningRate = 0;
    private envWetness = 0;
    // Slowly accumulating ground state.
    private soaked = 0;
    private snowCover = 0;
    private time = 0;
    private nextStrike = 5;
    private windNow = 0;
    private effects: QualityLevel = 'medium';
    private readonly target = { rain: 0, snow: 0 };
    private readonly windDir = new THREE.Vector2(0, -1);
    private readonly windVec = new THREE.Vector2();
    private readonly light = new THREE.Color();
    private readonly top = new THREE.Vector3();
    private readonly ground = new THREE.Vector3();
    private readonly camPos = new THREE.Vector3();
    private terrainMin: number;

    constructor(
        private readonly scene: THREE.Scene,
        private readonly atmosphere: Atmosphere,
        private readonly world: WeatherWorld,
    ) {
        this.precipitation = new Precipitation();
        scene.add(this.precipitation.group, this.lightning.group);
        this.terrainMin = world.heights.minMax().min;
    }

    apply(input: EnvironmentSettings): void {
        const env = withWeatherDefaults(input);
        this.env = env;
        const base = env.ocean_enabled
            ? Math.max(env.sea_level, this.terrainMin)
            : this.terrainMin;
        this.atmosphere.setTerrainBase(base);

        if (!this.settled) {
            this.settled = true;
            const t = this.targets(env);
            this.rain = t.rain;
            this.snow = t.snow;
            this.lightningRate = env.lightning_frequency;
            this.envWetness = env.wetness;
            // A map saved with rain / snow starts soaked / snowed in.
            this.soaked = t.rain;
            this.snowCover = t.snow * 0.9;
        }
    }

    setQuality(graphics: Partial<GraphicsSettings>): void {
        this.effects = graphics.effects_quality ?? 'high';
        this.precipitation.setQuality(this.effects);
        this.atmosphere.setCloudQuality(
            (graphics.cloud_quality as CloudQuality | undefined) ?? 'medium',
        );
    }

    update(dt: number, camera: THREE.Camera): void {
        const env = this.env;

        if (!env) {
            return;
        }

        this.time += dt;
        const k = 1 - Math.exp(-dt / TAU);
        const t = this.targets(env);
        this.rain += (t.rain - this.rain) * k;
        this.snow += (t.snow - this.snow) * k;
        this.lightningRate +=
            (env.lightning_frequency - this.lightningRate) * k;
        this.envWetness += (env.wetness - this.envWetness) * k;

        // Ground soaks within ~15 s of rain and dries over a couple of minutes.
        if (this.rain > this.soaked) {
            this.soaked += (this.rain - this.soaked) * (1 - Math.exp(-dt / 15));
        } else {
            this.soaked = Math.max(this.rain, this.soaked - dt / 150);
        }

        const snowTarget = this.snow * 0.9;
        this.snowCover +=
            (snowTarget - this.snowCover) *
            (1 - Math.exp(-dt / (snowTarget > this.snowCover ? 12 : 90)));

        // ---- wind with gusts (stronger and more erratic in storms)
        const storm = THREE.MathUtils.clamp(this.lightningRate / 5, 0, 1);
        const base = env.wind_strength;
        const s = this.time;
        const gustNoise =
            Math.sin(s * 0.31) * 0.5 +
            Math.sin(s * 0.77 + 1.3) * 0.3 +
            Math.sin(s * 1.9 + 4.1) * 0.2;
        const gust =
            Math.max(0, gustNoise) * (0.25 + storm * 0.6 + this.rain * 0.15);
        this.windNow =
            base * (1 + gust) + storm * 0.25 * Math.max(0, gustNoise);
        const aw = this.atmosphere.wind;
        const len = aw.length();

        if (len > 1e-4) {
            this.windDir.set(aw.x / len, aw.y / len);
        }

        this.windVec.copy(this.windDir).multiplyScalar(this.windNow);
        this.world.setFoliageWind?.(
            this.windNow,
            this.windDir.x,
            this.windDir.y,
        );

        // ---- ground & water
        const wet = THREE.MathUtils.clamp(
            Math.max(this.envWetness, this.soaked * 0.9) *
                (1 - this.snowCover * 0.6),
            0,
            1,
        );
        this.world.material.setWeather(wet, this.snowCover);
        this.world.water.setWeather(
            this.rain,
            this.windNow,
            this.windDir.x,
            this.windDir.y,
        );

        // ---- particles
        camera.getWorldPosition(this.camPos);
        const underwater = this.atmosphere.isUnderwater;
        this.atmosphere.ambientColor(this.light);
        this.light.addScalar(this.atmosphere.flash * 0.6);
        this.precipitation.update(
            dt,
            camera,
            this.rain,
            this.snow,
            this.windVec,
            this.light,
            underwater,
        );

        // ---- lightning
        this.updateLightning(dt);

        this.audio.setAmbience(
            underwater ? this.rain * 0.3 : this.rain,
            this.windNow * (underwater ? 0.2 : 1),
        );
    }

    dispose(): void {
        this.scene.remove(this.precipitation.group, this.lightning.group);
        this.precipitation.dispose();
        this.lightning.dispose();
        this.audio.dispose();
    }

    /** Trigger a strike now (debugging / screenshots); `angle` is the compass angle in radians (atan2(z, x)). */
    strike(distance?: number, angle?: number): void {
        this.spawnStrike(distance, angle);
    }

    private targets(env: EnvironmentSettings): { rain: number; snow: number } {
        const p = THREE.MathUtils.clamp(env.precipitation, 0, 1);

        return env.weather === 'snow'
            ? { rain: 0, snow: p }
            : { rain: p, snow: 0 };
    }

    private updateLightning(dt: number): void {
        const rate = this.env?.lightning_frequency ?? 0;

        if (rate > 0.01) {
            this.nextStrike -= dt;

            if (this.nextStrike <= 0) {
                this.spawnStrike();
                // Exponentially distributed gaps with a short minimum.
                this.nextStrike =
                    0.4 + (-Math.log(1 - Math.random() * 0.999) * 60) / rate;
            }
        } else {
            this.nextStrike = 2 + Math.random() * 4;
        }

        this.lightning.update(dt);
        const a = this.atmosphere;
        a.flash = this.lightning.level;

        if (this.lightning.level > 0) {
            a.flashDirection
                .copy(this.lightning.origin)
                .sub(this.camPos)
                .normalize();
        }
    }

    private spawnStrike(distance?: number, direction?: number): void {
        const env = this.env;
        const heights = this.world.heights;
        // Mostly distant strikes; the odd close one.
        const d = distance ?? 250 + Math.pow(Math.random(), 1.6) * 4200;
        const angle = direction ?? Math.random() * Math.PI * 2;
        const gx = this.camPos.x + Math.cos(angle) * d;
        const gz = this.camPos.z + Math.sin(angle) * d;
        const inside = heights.contains(gx, gz);
        const groundY = inside ? heights.sample(gx, gz) : this.terrainMin;
        const cloudY =
            Math.max(this.camPos.y, groundY) + 900 + Math.random() * 700;
        this.ground.set(gx, groundY, gz);
        this.top.set(
            gx + (Math.random() - 0.5) * 500,
            cloudY,
            gz + (Math.random() - 0.5) * 500,
        );
        // Low effects quality: flashes only. Otherwise ~60 % cloud-to-ground bolts.
        const bolt = this.effects !== 'low' && Math.random() < 0.6;
        const strength =
            0.5 + Math.random() * 0.5 + Math.max(0, 1 - d / 1500) * 0.5;
        this.lightning.strike(this.top, this.ground, bolt, strength);
        const volume = env?.thunder_volume ?? 0.7;
        this.audio.thunder(this.camPos.distanceTo(this.ground), volume);
    }
}
