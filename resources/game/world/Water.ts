import * as THREE from 'three/webgpu';
import { gridWaterLevel } from './foliage/placement';
import { NO_WATER } from '../shared/types';
import type { EnvironmentSettings, RiverSpline } from '../shared/types';
import type { GameRenderer } from '../core/renderer';
import { mulberry32 } from '../util/noise';
import type { GridRect, Heightfield } from './Heightfield';
import { sampleSpline } from './Splines';
import { createFineMeshGeometry } from './water/fineMesh';
import type { FineMeshLayout } from './water/fineMesh';
import { bandEnergy, CASCADES, OPEN_FETCH } from './water/spectrum';
import { BODY_TABLE, WaterBodies } from './water/WaterBodies';
import {
    createSharedNodes,
    createWaterMaterial,
    createWaterUniforms,
} from './water/waterMaterial';
import type {
    WaterMaterial,
    WaterSharedNodes,
    WaterSurfaceLayer,
} from './water/waterMaterial';
import { WaterSurfaceData } from './water/WaterSurfaceData';
import { Ripples } from './water/Ripples';
import { Surf } from './water/Surf';
import { shoreFade, WaveField } from './water/WaveField';
import type { WaveSample } from './water/WaveField';
import type { WaterBody } from './water/bodySegmentation';

export type {
    WaterSurfaceLayer,
    WaterLayerContext,
} from './water/waterMaterial';
export type {
    WaterBody,
    WaterBodySettings,
    WaterBodyKind,
    WaterBodiesFile,
} from './water/bodySegmentation';

const CHUNK_CELLS = 64;

type WaterChunk = {
    col0: number;
    row0: number;
    mesh: THREE.Mesh | null;
};

/** Wave rendering: 'fft' = GPU FFT (WebGPU only), 'simple' = sum of waves (any backend). */
export type WaveMode = 'fft' | 'simple';

/** The water surface at a point, for gameplay (swimming, buoyancy, splashes). */
export type WaterSurfaceSample = {
    /** Still water level (m) and the surface height including waves (m). */
    level: number;
    height: number;
    normal: THREE.Vector3;
    /** Surface velocity (m/s): wave orbital motion plus the river current. */
    velocity: THREE.Vector3;
    /** Water depth below the still level (m). */
    depth: number;
    /** The water body there (null: the open ocean beyond the map). */
    body: WaterBody | null;
};

/**
 * Renders rivers, lakes and the ocean from a grid of surface heights (NO_WATER where dry).
 *
 * - Bodies (WaterBodies): the grid's connected pieces (lake / pond / river / sea) with per-body settings
 *   (wind exposure, fetch, wave height, choppiness, colours, surf), recomputed after water edits.
 * - Waves (WaveField): a fetch-limited JONSWAP spectrum in three cascades (swell, wind waves, chop),
 *   transformed by a GPU FFT on WebGPU (displacement with choppiness, normals, whitecaps from the
 *   Jacobian) or summed from its strongest waves on WebGL 2; each body scales the cascades by its own
 *   fetch-limited sea state. `sampleSurface` gives the same waves on the CPU for gameplay.
 * - Geometry: the map's water as 64-cell chunks at the water grid's resolution, a camera-centred fine
 *   mesh (0.25 m quads near the camera, clipmap rings with CDLOD morphing) where displacement reads close
 *   up, and a coarse ring for the ocean beyond the map.
 * - Shading (waterMaterial.ts): refraction and Beer–Lambert absorption from the scene behind, planar
 *   reflection, shore / rapids / river foam and whitecaps, subsurface glow through crests, glints that
 *   stay stable (sub-pixel slope variance goes into the roughness), catspaws from the travelling gusts.
 * - Extension: `addSurfaceLayer` adds displacement / slope / foam sources (surf, interaction ripples).
 */
export class Water {
    readonly group = new THREE.Group();
    material: WaterMaterial;
    readonly bodies: WaterBodies;
    readonly waves = new WaveField();
    readonly data: WaterSurfaceData;
    /** Beach surf: shore distance field, shoaling / breaking waves, swash (phase 11). */
    readonly surf: Surf;
    /** Interactive ripples around the player / camera (phase 12). */
    readonly ripples: Ripples;
    /** Where the ripple field centres (the player while playing); null: the camera. */
    interactionFocus: THREE.Vector3 | null = null;
    private readonly u = createWaterUniforms();
    private readonly waveTexture = createWaveTexture();
    private readonly shared: WaterSharedNodes = createSharedNodes();
    private reflectionNode: THREE.TextureNode;
    private reflectionTexture: THREE.Texture | null = null;
    private chunks: WaterChunk[] = [];
    private chunksPerSide: number;
    private ocean: THREE.Mesh | null = null;
    private readonly fine: THREE.Mesh;
    private readonly fineLayout: FineMeshLayout;
    private step: number;
    private riverFlow: Float32Array | null = null;
    private riverRect: GridRect | null = null;
    private renderer: GameRenderer | null = null;
    private mode: WaveMode = 'simple';
    private fftAllowed = true;
    private readonly layers: WaterSurfaceLayer[] = [];
    private env: EnvironmentSettings | null = null;
    /** Seconds until the bodies are re-segmented after a water edit (-1: none pending). */
    private segmentIn = 0;
    private tableVersion = -1;
    private tableDirty = true;
    private componentsVersion = -1;
    private surfTableIn = 0;
    /** Called whenever water meshes are rebuilt (e.g. to refresh shore wetness). */
    onRebuild: ((rect?: GridRect) => void) | null = null;
    /** Called after the bodies were re-segmented or their settings changed. */
    onBodiesChanged: ((reason: 'segmented' | 'settings') => void) | null = null;

    constructor(
        readonly surface: Heightfield,
        readonly terrain: Heightfield,
        rivers: RiverSpline[] = [],
    ) {
        this.group.name = 'Water';
        this.chunksPerSide = (surface.resolution - 1) / CHUNK_CELLS;
        this.step = surface.resolution > 600 ? 2 : 1;
        this.data = new WaterSurfaceData(surface, terrain, this.step);
        this.bodies = new WaterBodies(surface, terrain);
        this.surf = new Surf(
            this.data,
            surface,
            terrain,
            (row) => this.bodies.bodies[row - 1] ?? null,
        );
        this.layers.push(this.surf.layer());
        this.ripples = new Ripples((x, z) => {
            const level = this.levelAt(x, z);

            return level === null ? null : level - this.terrain.sample(x, z);
        });
        this.layers.push(this.ripples.layer());
        this.bodies.onChange = (reason) => {
            this.waves.invalidateWeights();
            this.tableDirty = true;

            if (reason === 'segmented') {
                this.data.setBodies(this.bodies.labels, (label) =>
                    this.bodies.rowOfLabel(label),
                );
            }

            // Body rows and surf flags feed the surf strength.
            this.surf.refresh();

            this.onBodiesChanged?.(reason);
        };
        this.u.mapHalf.value = surface.half;
        this.u.dataSize.value = this.data.size;
        this.u.dataSpacing.value = this.data.spacing;
        this.u.fineHalf.value = 0;
        const { material, reflection } = this.createMaterial();
        this.material = material;
        this.reflectionNode = reflection;

        const fine = createFineMeshGeometry();
        this.fineLayout = fine.layout;
        this.fine = new THREE.Mesh(fine.geometry, this.material);
        this.fine.name = 'Water_fine';
        this.fine.frustumCulled = false;
        this.fine.renderOrder = 2;
        this.fine.receiveShadow = true;
        this.fine.visible = false;
        this.group.add(this.fine);

        for (let cz = 0; cz < this.chunksPerSide; cz++) {
            for (let cx = 0; cx < this.chunksPerSide; cx++) {
                this.chunks.push({
                    col0: cx * CHUNK_CELLS,
                    row0: cz * CHUNK_CELLS,
                    mesh: null,
                });
            }
        }

        this.computeRiverFlow(rivers);
        this.rebuildRect({
            x0: 0,
            z0: 0,
            x1: surface.resolution - 1,
            z1: surface.resolution - 1,
        });
        this.segmentBodies();
    }

    // ------------------------------------------------------------------ setup

    /**
     * The renderer (once it exists): WebGPU runs the FFT waves unless the graphics settings turned them off.
     */
    setRenderer(renderer: GameRenderer): void {
        this.renderer = renderer;
        this.ripples.setRenderer(renderer);
        this.applyMode();
    }

    /** Graphics setting water_waves: FFT allowed (WebGPU) or the sum of waves everywhere. */
    setWaveQuality(fft: boolean): void {
        this.fftAllowed = fft;
        this.applyMode();
    }

    /** The environment last applied (null before the first). */
    get environment(): EnvironmentSettings | null {
        return this.env;
    }

    get waveMode(): WaveMode {
        return this.mode;
    }

    /** Adds a source of displacement / slope / foam (and its CPU sampler); rebuilds the material. */
    addSurfaceLayer(layer: WaterSurfaceLayer): void {
        this.layers.push(layer);
        this.rebuildMaterial();
    }

    removeSurfaceLayer(name: string): void {
        const i = this.layers.findIndex((l) => l.name === name);

        if (i >= 0) {
            this.layers.splice(i, 1);
            this.rebuildMaterial();
        }
    }

    /** Stored body ids and settings (water_bodies.json). */
    loadBodies(file: Parameters<WaterBodies['load']>[0]): void {
        this.bodies.load(file);
        this.segmentBodies();
    }

    private applyMode(): void {
        const backendFft =
            !!this.renderer &&
            !!(this.renderer.backend as { isWebGPUBackend?: boolean })
                .isWebGPUBackend;
        const mode: WaveMode = backendFft && this.fftAllowed ? 'fft' : 'simple';

        if (mode === this.mode && (mode === 'fft') === !!this.waves.fft) {
            return;
        }

        this.mode = mode;
        this.waves.setFft(mode === 'fft');
        this.rebuildMaterial();
    }

    private createMaterial(): {
        material: WaterMaterial;
        reflection: THREE.TextureNode;
    } {
        return createWaterMaterial({
            u: this.u,
            shared: this.shared,
            waveTexture: this.waveTexture,
            levelTexture: this.data.gridTexture,
            dataTexture: this.data.dataTexture,
            bodyTable: this.bodies.table,
            fft: this.waves.fft,
            layers: this.layers,
        });
    }

    private rebuildMaterial(): void {
        const old = this.material;
        const { material, reflection } = this.createMaterial();
        material.envMapIntensity = old.envMapIntensity;
        this.material = material;
        this.reflectionNode = reflection;

        if (this.reflectionTexture) {
            reflection.value = this.reflectionTexture;
        }

        this.group.traverse((o) => {
            if (
                (o as THREE.Mesh).isMesh &&
                (o as THREE.Mesh).material === old
            ) {
                (o as THREE.Mesh).material = material;
            }
        });
        old.dispose();
    }

    // ------------------------------------------------------------------ rivers

    /** River splines changed: recompute their flow and rebuild the water they touch (before and after). */
    setRivers(rivers: RiverSpline[]): void {
        const before = this.riverRect;
        this.computeRiverFlow(rivers);
        const after = this.riverRect;
        const rect =
            before && after
                ? {
                      x0: Math.min(before.x0, after.x0),
                      z0: Math.min(before.z0, after.z0),
                      x1: Math.max(before.x1, after.x1),
                      z1: Math.max(before.z1, after.z1),
                  }
                : (before ?? after);

        if (rect) {
            this.data.update(rect, this.riverFlow);
            this.surf.rebuild(rect);
            this.buildChunksIn(rect);
            this.scheduleSegmentation();
        }
    }

    /**
     * Direction downstream along each river spline, splatted onto the surface grid within the river's
     * width (plus half its banks), fastest mid-stream. Downstream is the end with the lower water.
     */
    private computeRiverFlow(rivers: RiverSpline[]): void {
        const hf = this.surface;
        const res = hf.resolution;
        const usable = rivers.filter((r) => r.points.length >= 2);

        if (!usable.length) {
            this.riverFlow = null;
            this.riverRect = null;

            return;
        }

        const sum = new Float32Array(res * res * 2);
        const weight = new Float32Array(res * res);
        const levelAt = (x: number, z: number) => {
            const w = hf.contains(x, z) ? hf.sample(x, z) : NO_WATER;

            return w > NO_WATER + 1 ? w : this.terrain.sample(x, z);
        };
        let rect: GridRect | null = null;

        for (const river of usable) {
            let pts = sampleSpline(river.points, Math.max(1, hf.cell));
            const n = pts.length;
            const quarter = Math.max(1, Math.floor(n / 4));
            let head = 0;
            let tail = 0;

            for (let k = 0; k < quarter; k++) {
                head += levelAt(pts[k].x, pts[k].z);
                tail += levelAt(pts[n - 1 - k].x, pts[n - 1 - k].z);
            }

            if (tail > head + 1e-3) {
                pts = [...pts].reverse();
            }

            const half = Math.max(1, river.width / 2 + river.bank * 0.5);

            for (let k = 0; k + 1 < pts.length; k++) {
                const a = pts[k];
                const b = pts[k + 1];
                const len = Math.hypot(b.x - a.x, b.z - a.z);

                if (len < 1e-4) {
                    continue;
                }

                const tx = (b.x - a.x) / len;
                const tz = (b.z - a.z) / len;
                const g0 = hf.toGrid(
                    Math.min(a.x, b.x) - half,
                    Math.min(a.z, b.z) - half,
                );
                const g1 = hf.toGrid(
                    Math.max(a.x, b.x) + half,
                    Math.max(a.z, b.z) + half,
                );
                const c0 = Math.max(0, Math.floor(g0.gx));
                const r0 = Math.max(0, Math.floor(g0.gz));
                const c1 = Math.min(res - 1, Math.ceil(g1.gx));
                const r1 = Math.min(res - 1, Math.ceil(g1.gz));

                if (c0 > c1 || r0 > r1) {
                    continue;
                }

                rect = rect
                    ? {
                          x0: Math.min(rect.x0, c0),
                          z0: Math.min(rect.z0, r0),
                          x1: Math.max(rect.x1, c1),
                          z1: Math.max(rect.z1, r1),
                      }
                    : { x0: c0, z0: r0, x1: c1, z1: r1 };

                for (let r = r0; r <= r1; r++) {
                    for (let c = c0; c <= c1; c++) {
                        const px = hf.colToX(c) - a.x;
                        const pz = hf.rowToZ(r) - a.z;
                        const along = Math.min(
                            len,
                            Math.max(0, px * tx + pz * tz),
                        );
                        const d = Math.hypot(px - tx * along, pz - tz * along);

                        if (d >= half) {
                            continue;
                        }

                        const t = d / half;
                        // Mid-stream flows fastest; the weight also blends overlapping segments.
                        const w = 1 - t * t;
                        const i = r * res + c;
                        sum[i * 2] += tx * w;
                        sum[i * 2 + 1] += tz * w;
                        weight[i] = Math.max(weight[i], w);
                    }
                }
            }
        }

        for (let i = 0; i < res * res; i++) {
            const x = sum[i * 2];
            const z = sum[i * 2 + 1];
            const len = Math.hypot(x, z);

            if (len > 1e-5) {
                // Speed 0.3 at the banks to 0.55 mid-stream (the gradient may add more on steep runs).
                const speed = 0.3 + 0.25 * weight[i];
                sum[i * 2] = (x / len) * speed;
                sum[i * 2 + 1] = (z / len) * speed;
            }
        }

        this.riverFlow = sum;
        this.riverRect = rect;
    }

    // ------------------------------------------------------------------ weather & lighting

    /** Rain ripples (0-1), current (gusting) wind strength and direction the wind blows towards. */
    setWeather(
        rain: number,
        windStrength: number,
        windX: number,
        windZ: number,
    ): void {
        this.u.rain.value = rain;
        this.u.wind.value = windStrength;
        const len = Math.hypot(windX, windZ);

        if (len > 1e-4) {
            this.u.windDir.value.set(windX / len, windZ / len);
        }

        this.waves.setWind(windStrength, windX, windZ);
    }

    /** Travelling gusts (the foliage's gust field): strength, 1 / patch size and the field's downwind offset. */
    setGusts(gust: THREE.Vector2, offset: THREE.Vector2): void {
        this.u.gust.value.copy(gust);
        this.u.gustOffset.value.copy(offset);
    }

    /** Sun direction (towards the sun) and colour × intensity, for the subsurface glow through crests. */
    setLighting(sunDir: THREE.Vector3, sunColor: THREE.Color): void {
        this.u.sunDir.value.copy(sunDir);
        this.u.sunColor.value.copy(sunColor);
    }

    applyEnvironment(env: EnvironmentSettings): void {
        const u = this.u;
        const seaChanged =
            !this.env ||
            this.env.ocean_enabled !== env.ocean_enabled ||
            this.env.sea_level !== env.sea_level;
        this.env = env;
        u.shallow.value.set(env.water_shallow_color);
        u.deep.value.set(env.water_deep_color);
        u.clarity.value = env.water_clarity;
        u.wind.value = env.wind_strength;
        u.waveScale.value = env.wave_scale;
        u.waveStrength.value = env.wave_strength;
        u.waveSpeed.value = env.wave_speed;
        u.oceanSwell.value = env.wave_height;
        u.flowSpeed.value = env.flow_speed;
        u.refraction.value = env.water_refraction;
        u.foamEnabled.value = env.shore_foam ? 1 : 0;
        u.foamWidth.value = env.foam_width;
        u.foamIntensity.value = env.foam_intensity;
        u.rapids.value = env.rapids_foam ? 1 : 0;
        u.foamBreakup.value = env.foam_breakup ?? 0.6;
        u.roughness.value = env.water_roughness;
        u.whitecaps.value = env.whitecaps ?? 1;
        u.subsurface.value = env.water_subsurface ?? 1;
        this.material.envMapIntensity = env.water_reflectivity;
        this.waves.setWind(
            env.wind_strength,
            u.windDir.value.x,
            u.windDir.value.y,
            true,
        );
        this.tableDirty = true;
        this.setOcean(env.ocean_enabled, env.sea_level);

        if (seaChanged) {
            this.scheduleSegmentation(0);
        }
    }

    /**
     * Connect (or disconnect) the planar reflection of the nearest water level. `matrix` maps world
     * positions to reflection texture UVs (top-left origin).
     */
    setReflection(
        reflection: {
            texture: THREE.Texture;
            matrix: THREE.Matrix4;
            level: number;
            /** Blend over the environment reflection (fading in / out); default 1. */
            weight?: number;
        } | null,
    ): void {
        this.u.hasReflection.value = reflection ? (reflection.weight ?? 1) : 0;

        if (reflection) {
            this.reflectionTexture = reflection.texture;
            this.reflectionNode.value = reflection.texture;
            this.u.reflMatrix.value.copy(reflection.matrix);
            this.u.reflLevel.value = reflection.level;
        }
    }

    /**
     * The water level most worth reflecting: the water under the focus point, else the first water
     * found along the view direction.
     */
    dominantLevel(focus: THREE.Vector3, camera: THREE.Camera): number | null {
        const direct = this.levelAt(focus.x, focus.z);

        if (direct !== null) {
            return direct;
        }

        const dir = new THREE.Vector3();
        camera.getWorldDirection(dir);
        dir.y = 0;

        if (dir.lengthSq() < 1e-6) {
            return null;
        }

        dir.normalize();

        for (const d of [15, 40, 80, 150, 300, 600, 1200]) {
            const level = this.levelAt(
                camera.position.x + dir.x * d,
                camera.position.z + dir.z * d,
            );

            if (level !== null) {
                return level;
            }
        }

        return null;
    }

    // ------------------------------------------------------------------ per frame

    /** Advances the waves (and the FFT), follows the camera with the fine mesh, re-segments after edits. */
    update(dt: number, camera?: THREE.Camera): void {
        this.u.time.value += dt;

        if (this.segmentIn >= 0) {
            this.segmentIn -= dt;

            if (this.segmentIn < 0) {
                this.segmentBodies();
            }
        }

        this.waves.update(dt * (this.env?.wave_speed ?? 1), this.renderer);

        if (this.waves.version !== this.componentsVersion) {
            this.componentsVersion = this.waves.version;
            this.uploadComponents();
            this.tableDirty = true;
        }

        if (this.tableDirty) {
            this.writeTable();
        }

        // Surf follows the (gusting) wind a few times a second.
        this.surf.setTime(this.u.time.value * (this.env?.wave_speed ?? 1));
        this.surfTableIn -= dt;

        if (this.surfTableIn < 0) {
            this.writeSurfTable();
        }

        if (camera) {
            this.placeFineMesh(camera);
        }

        const focus = this.interactionFocus ?? camera?.position;

        if (focus) {
            this.ripples.update(dt, focus);
        }
    }

    /** Water surface height at a world position (still level, no waves), or null when dry. */
    levelAt(x: number, z: number): number | null {
        if (!this.surface.contains(x, z)) {
            return this.ocean ? this.ocean.position.y : null;
        }

        // Interpolated between wet neighbours for smooth swimming heights.
        return gridWaterLevel(this.surface, x, z);
    }

    /**
     * The water surface at a world position with its waves (CPU, for gameplay: swimming, buoyancy,
     * splashes) or null when dry. The waves are the sum of the spectrum's strongest waves with the
     * body's weights: exact for the WebGL 2 surface, a close approximation of the FFT surface (its long
     * waves match; the fine chop is left out). Extra surface layers add their own `sample`.
     */
    sampleSurface(
        x: number,
        z: number,
        out?: WaterSurfaceSample,
    ): WaterSurfaceSample | null {
        const level = this.levelAt(x, z);

        if (level === null) {
            return null;
        }

        const result = out ?? {
            level: 0,
            height: 0,
            normal: new THREE.Vector3(),
            velocity: new THREE.Vector3(),
            depth: 0,
            body: null,
        };
        const inside = this.surface.contains(x, z);
        const depth = inside ? this.data.depthAt(x, z) : 40;
        const row = inside ? this.data.bodyRowAt(x, z) : 0;
        const body = inside ? this.bodies.at(x, z) : null;
        const table = this.bodies.table.image.data as Float32Array;
        const at = (entry: number, c: number) =>
            table[(entry * 256 + row) * 4 + c];
        const weights: [number, number, number] = [
            at(BODY_TABLE.waves, 0),
            at(BODY_TABLE.waves, 1),
            at(BODY_TABLE.waves, 2),
        ];
        const edge = Math.min(
            1,
            Math.max(
                0,
                (this.surface.half - Math.max(Math.abs(x), Math.abs(z))) / 60,
            ),
        );
        const fade =
            shoreFade(depth) * (inside ? edge * edge * (3 - 2 * edge) : 0);
        const sample = this.waveSample;
        this.waves.sample(
            x,
            z,
            weights,
            at(BODY_TABLE.waves, 3),
            fade,
            sample,
            this.u.time.value * (this.env?.wave_speed ?? 1),
        );
        const layer = this.layerSample;
        layer.height = 0;
        layer.slopeX = 0;
        layer.slopeZ = 0;
        layer.velocity.set(0, 0, 0);

        const waveTime = this.u.time.value * (this.env?.wave_speed ?? 1);

        for (const l of this.layers) {
            l.sample?.(x, z, waveTime, layer);
        }

        if (inside) {
            this.surf.sample(x, z, layer, depth);
        }

        result.level = level;
        result.depth = depth;
        result.body = body;
        result.height = level + sample.height + layer.height;
        result.normal
            .set(
                sample.normal.x / sample.normal.y - layer.slopeX,
                1,
                sample.normal.z / sample.normal.y - layer.slopeZ,
            )
            .normalize();
        const flow = inside
            ? this.data.flowAt(x, z, this.flowSample)
            : { x: 0, z: 0 };
        // River current: the shader's flow speeds (0-1) are ~1.5 m/s at full speed.
        const current = 1.5 * (this.env?.flow_speed ?? 1);
        result.velocity
            .copy(sample.velocity)
            .add(layer.velocity)
            .add(new THREE.Vector3(flow.x * current, 0, flow.z * current));

        return result;
    }

    private readonly waveSample: WaveSample = {
        height: 0,
        normal: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
    };
    private readonly layerSample = {
        height: 0,
        slopeX: 0,
        slopeZ: 0,
        velocity: new THREE.Vector3(),
    };
    private readonly flowSample = { x: 0, z: 0 };

    /** Bodies listing for agents and the editor. */
    describeBodies(): (ReturnType<WaterBodies['describe']> & {
        waves: ReturnType<Water['describeWaves']>;
    })[] {
        const dir = { x: this.waves.windDir.x, z: this.waves.windDir.y };

        return this.bodies.bodies.map((b) => ({
            ...this.bodies.describe(b, dir, OPEN_FETCH),
            waves: this.describeWaves(b),
        }));
    }

    /** Current sea state of a body: significant wave height and peak wavelength (for agents). */
    describeWaves(body: WaterBody): {
        significant_height_m: number;
        cascade_weights: number[];
    } {
        const w = this.waves.weights(body, 1);
        const variance = CASCADES.reduce(
            (sum, c, i) =>
                sum +
                bandEnergy(this.waves.reference, c.kMin, c.kMax) * w[i] * w[i],
            0,
        );

        return {
            significant_height_m:
                Math.round(4 * Math.sqrt(variance) * 100) / 100,
            cascade_weights: w.map((v) => Math.round(v * 100) / 100),
        };
    }

    /** Rebuilds the water meshes that overlap the rect (after water painting or terrain sculpting). */
    rebuildRect(rect: GridRect): void {
        this.ripples.invalidate();
        this.onRebuild?.(rect);
        this.data.update(rect, this.riverFlow);
        this.surf.rebuild(rect);
        this.buildChunksIn(rect);
        this.scheduleSegmentation();
    }

    /** Re-segments the bodies now (e.g. before an agent lists them). */
    flushBodies(): void {
        if (this.segmentIn >= 0) {
            this.segmentBodies();
        }
    }

    hasWater(): boolean {
        return this.chunks.some((c) => c.mesh !== null) || this.ocean !== null;
    }

    dispose(): void {
        for (const chunk of this.chunks) {
            chunk.mesh?.geometry.dispose();
        }

        this.fine.geometry.dispose();
        this.ocean?.geometry.dispose();
        this.material.dispose();
        this.waveTexture.dispose();
        this.data.dispose();
        this.surf.dispose();
        this.ripples.dispose();
        this.bodies.dispose();
        this.waves.dispose();
    }

    private scheduleSegmentation(delay = 0.4): void {
        this.segmentIn =
            this.segmentIn >= 0 ? Math.min(this.segmentIn, delay) : delay;
    }

    private segmentBodies(): void {
        this.segmentIn = -1;
        this.bodies.segment({
            riverFlow: this.riverFlow,
            seaLevel: this.env?.ocean_enabled ? this.env.sea_level : null,
            wallLimit: Math.max(4, this.surface.cell * 1.5),
        });
        let maxFetch = 50;
        const dir = this.waves.windDir;

        for (const b of this.bodies.bodies) {
            maxFetch = Math.max(
                maxFetch,
                this.bodies.fetch(b, dir.x, dir.y, OPEN_FETCH),
            );
        }

        this.waves.setMaxFetch(this.ocean ? OPEN_FETCH : maxFetch);
    }

    private writeSurfTable(): void {
        this.surfTableIn = 0.3;
        this.surf.writeTable(this.bodies.bodies, {
            strength: this.waves.windStrength,
            x: this.waves.windDir.x,
            z: this.waves.windDir.y,
        });
    }

    /** Painted surf changed in `rect` (full-res grid): the field around it is recomputed. */
    surfPainted(rect?: GridRect): void {
        this.surf.rebuild(rect);
    }

    private writeTable(): void {
        this.writeSurfTable();
        this.tableDirty = false;
        this.tableVersion = this.waves.version;
        this.bodies.writeTable((b) => this.waves.weights(b, 1), {
            choppiness: 1,
        });
        const ref = this.waves.reference;
        this.u.slopeVar.value.fromArray(this.waves.slopeVariance);
        this.u.heightStd.value.fromArray(
            CASCADES.map((c) => Math.sqrt(bandEnergy(ref, c.kMin, c.kMax))),
        );
    }

    private uploadComponents(): void {
        const a = this.u.compA.array as THREE.Vector4[];
        const b = this.u.compB.array as THREE.Vector4[];
        const comps = this.waves.components;

        for (let i = 0; i < a.length; i++) {
            const c = comps[i];

            if (c) {
                a[i].set(c.kx, c.kz, c.amp, c.phase);
                b[i].set(c.omega, c.cascade, 0, 0);
            } else {
                a[i].set(1, 0, 0, 0);
                b[i].set(0, 0, 0, 0);
            }
        }
    }

    /**
     * Centres the fine mesh under the camera (in steps of twice its coarsest spacing), scaled up with the
     * camera's height above the water so it never gets finer than the screen can show.
     */
    private placeFineMesh(camera: THREE.Camera): void {
        const p = camera.position;
        const level = this.levelAt(p.x, p.z) ?? this.dominantLevel(p, camera);
        const height = level === null ? Infinity : Math.abs(p.y - level);

        if (!this.surface.contains(p.x, p.z) && !this.ocean) {
            this.hideFine();

            return;
        }

        if (
            !Number.isFinite(height) ||
            height > 300 ||
            !this.chunks.some((c) => c.mesh)
        ) {
            this.hideFine();

            return;
        }

        const scale =
            2 ** Math.max(0, Math.ceil(Math.log2(Math.max(1, height / 12))));
        const snap = this.fineLayout.coarsest * 2 * scale;
        const cx = Math.round(p.x / snap) * snap;
        const cz = Math.round(p.z / snap) * snap;
        this.fine.position.set(cx, 0, cz);
        this.fine.scale.set(scale, 1, scale);
        this.fine.visible = true;
        this.u.fineCenter.value.set(cx, cz);
        this.u.fineHalf.value = this.fineLayout.half * scale;
        this.u.fineScale.value = scale;
    }

    private hideFine(): void {
        this.fine.visible = false;
        this.u.fineHalf.value = 0;
    }

    private buildChunksIn(rect: GridRect): void {
        for (const chunk of this.chunks) {
            if (
                rect.x1 < chunk.col0 - 1 ||
                rect.x0 > chunk.col0 + CHUNK_CELLS + 1 ||
                rect.z1 < chunk.row0 - 1 ||
                rect.z0 > chunk.row0 + CHUNK_CELLS + 1
            ) {
                continue;
            }

            this.buildChunk(chunk);
        }
    }

    private setOcean(enabled: boolean, level: number): void {
        if (!enabled) {
            if (this.ocean) {
                this.group.remove(this.ocean);
                this.ocean.geometry.dispose();
                this.ocean = null;
            }

            return;
        }

        if (!this.ocean) {
            this.ocean = new THREE.Mesh(this.createOceanRing(), this.material);
            this.ocean.name = 'Ocean';
            this.ocean.receiveShadow = true;
            this.group.add(this.ocean);
        }

        this.ocean.position.y = level;
    }

    /** A large square ring around the map, subdivided near the map so the swell reads correctly. */
    private createOceanRing(): THREE.BufferGeometry {
        const h = this.surface.half;
        const far = Math.max(40000, h * 20);
        // Rings of increasing size: map edge → 2× → 5× → far.
        const radii = [h, h * 1.4, h * 2.2, h * 5, far];
        const positions: number[] = [];
        const index: number[] = [];
        const perSide = 16;

        const ringVerts = (r: number): number => {
            const start = positions.length / 3;

            for (let side = 0; side < 4; side++) {
                for (let i = 0; i < perSide; i++) {
                    const t = -1 + (2 * i) / perSide;
                    const [x, z] =
                        side === 0
                            ? [t * r, -r]
                            : side === 1
                              ? [r, t * r]
                              : side === 2
                                ? [-t * r, r]
                                : [-r, -t * r];
                    positions.push(x, 0, z);
                }
            }

            return start;
        };

        const starts = radii.map(ringVerts);
        const n = perSide * 4;

        for (let k = 0; k < starts.length - 1; k++) {
            for (let i = 0; i < n; i++) {
                const a = starts[k] + i;
                const b = starts[k] + ((i + 1) % n);
                const c = starts[k + 1] + i;
                const d = starts[k + 1] + ((i + 1) % n);
                index.push(a, c, b, b, c, d);
            }
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
            'position',
            new THREE.Float32BufferAttribute(positions, 3),
        );
        geometry.setAttribute(
            'normal',
            new THREE.Float32BufferAttribute(
                Array.from({ length: positions.length }, (_, i) =>
                    i % 3 === 1 ? 1 : 0,
                ),
                3,
            ),
        );
        geometry.setAttribute(
            'waterFine',
            new THREE.Float32BufferAttribute(
                new Float32Array(positions.length / 3),
                1,
            ),
        );
        geometry.setIndex(index);
        fixWinding(geometry);

        return geometry;
    }

    /** One chunk of the map's water from the resampled grid (WaterSurfaceData): levels and cell mask. */
    private buildChunk(chunk: WaterChunk): void {
        const s = this.step;
        const d = this.data;
        const n = CHUNK_CELLS / s + 1;
        const i0 = chunk.col0 / s;
        const j0 = chunk.row0 / s;

        if (chunk.mesh) {
            this.group.remove(chunk.mesh);
            chunk.mesh.geometry.dispose();
            chunk.mesh = null;
        }

        const index: number[] = [];

        for (let j = 0; j < n - 1; j++) {
            for (let i = 0; i < n - 1; i++) {
                if (d.mask[(j0 + j) * d.size + i0 + i]) {
                    const a = j * n + i;
                    const b = (j + 1) * n + i;
                    index.push(a, b, a + 1, a + 1, b, b + 1);
                }
            }
        }

        if (!index.length) {
            return;
        }

        const positions = new Float32Array(n * n * 3);

        for (let j = 0; j < n; j++) {
            for (let i = 0; i < n; i++) {
                const k = j * n + i;
                positions[k * 3] = d.x(i0 + i);
                positions[k * 3 + 1] = d.level[(j0 + j) * d.size + i0 + i];
                positions[k * 3 + 2] = d.z(j0 + j);
            }
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
            'position',
            new THREE.BufferAttribute(positions, 3),
        );
        geometry.setAttribute(
            'waterFine',
            new THREE.BufferAttribute(new Float32Array(n * n), 1),
        );
        geometry.setIndex(index);
        geometry.computeVertexNormals();
        geometry.computeBoundingSphere();

        if (geometry.boundingSphere) {
            // Waves lift the surface a little above its still level.
            geometry.boundingSphere.radius += 4;
        }

        const mesh = new THREE.Mesh(geometry, this.material);
        mesh.receiveShadow = true;
        mesh.renderOrder = 2;
        mesh.name = `Water_${chunk.col0}_${chunk.row0}`;
        chunk.mesh = mesh;
        this.group.add(mesh);
    }
}

/** Ensure all triangles face up. */
function fixWinding(geometry: THREE.BufferGeometry): void {
    const pos = geometry.getAttribute('position');
    const index = geometry.getIndex();

    if (!index) {
        return;
    }

    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();

    for (let i = 0; i < index.count; i += 3) {
        a.fromBufferAttribute(pos, index.getX(i));
        b.fromBufferAttribute(pos, index.getX(i + 1));
        c.fromBufferAttribute(pos, index.getX(i + 2));
        const ny = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);

        if (ny < 0) {
            const t = index.getX(i + 1);
            index.setX(i + 1, index.getX(i + 2));
            index.setX(i + 2, t);
        }
    }
}

/**
 * Tileable wave normal map from a sum of directional sine waves with integer wave vectors
 * (so it tiles perfectly) following a wind-driven spectrum: long waves along the wind, short
 * capillary ripples in all directions. RGB = normal, A = tileable foam/bubble noise.
 */
function createWaveTexture(): THREE.DataTexture {
    const size = 256;
    const rand = mulberry32(4242);
    const waves: { kx: number; ky: number; amp: number; phase: number }[] = [];

    for (let i = 0; i < 96; i++) {
        // Wavenumber 2..40 (cycles per tile), amplitude ~ k^-1.6 (steeper for short waves).
        const k = 2 + Math.pow(rand(), 1.6) * 38;
        // Directional spread around the wind (+X), wider for short waves.
        const spread = 0.35 + (k / 40) * 1.4;
        const angle = (rand() * 2 - 1) * spread + (rand() < 0.12 ? Math.PI : 0);
        const kx = Math.round(Math.cos(angle) * k);
        const ky = Math.round(Math.sin(angle) * k);

        if (kx === 0 && ky === 0) {
            continue;
        }

        waves.push({
            kx,
            ky,
            amp: Math.pow(Math.hypot(kx, ky), -1.6),
            phase: rand() * Math.PI * 2,
        });
    }

    const foamWaves: { kx: number; ky: number; amp: number; phase: number }[] =
        [];

    for (let i = 0; i < 64; i++) {
        const k = 6 + rand() * 40;
        const angle = rand() * Math.PI * 2;
        const kx = Math.round(Math.cos(angle) * k);
        const ky = Math.round(Math.sin(angle) * k);
        foamWaves.push({
            kx,
            ky,
            amp: 1 / Math.max(1, Math.hypot(kx, ky)),
            phase: rand() * Math.PI * 2,
        });
    }

    const data = new Uint8Array(size * size * 4);
    const tau = Math.PI * 2;
    let maxGrad = 0;
    const grads = new Float32Array(size * size * 2);
    const foam = new Float32Array(size * size);
    let foamMin = Infinity;
    let foamMax = -Infinity;

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            let dx = 0;
            let dy = 0;

            for (const w of waves) {
                const arg = (tau * (w.kx * x + w.ky * y)) / size + w.phase;
                const c = Math.cos(arg) * w.amp * tau;
                dx += c * w.kx;
                dy += c * w.ky;
            }

            let f = 0;

            for (const w of foamWaves) {
                f +=
                    Math.sin((tau * (w.kx * x + w.ky * y)) / size + w.phase) *
                    w.amp;
            }

            const i = y * size + x;
            grads[i * 2] = dx;
            grads[i * 2 + 1] = dy;
            maxGrad = Math.max(maxGrad, Math.hypot(dx, dy));
            foam[i] = Math.abs(f);
            foamMin = Math.min(foamMin, foam[i]);
            foamMax = Math.max(foamMax, foam[i]);
        }
    }

    const scale = 1.4 / maxGrad;

    for (let i = 0; i < size * size; i++) {
        const nx = -grads[i * 2] * scale;
        const ny = -grads[i * 2 + 1] * scale;
        const len = Math.hypot(nx, ny, 1);
        data[i * 4] = Math.round(((nx / len) * 0.5 + 0.5) * 255);
        data[i * 4 + 1] = Math.round(((ny / len) * 0.5 + 0.5) * 255);
        data[i * 4 + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
        // Ridged foam noise: bright thin cells, dark gaps.
        const fn = 1 - (foam[i] - foamMin) / (foamMax - foamMin);
        data[i * 4 + 3] = Math.round(Math.pow(fn, 3) * 255);
    }

    const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 8;
    texture.needsUpdate = true;

    return texture;
}
