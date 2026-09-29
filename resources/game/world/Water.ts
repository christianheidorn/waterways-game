import * as THREE from 'three/webgpu';
import type { Node, NodeBuilder } from 'three/webgpu';
import {
    abs,
    attribute,
    cameraFar,
    cameraNear,
    cameraPosition,
    cameraViewMatrix,
    clamp,
    cos,
    dot,
    exp,
    float,
    floor,
    Fn,
    fract,
    If,
    length,
    max,
    mix,
    modelWorldMatrix,
    normalGeometry,
    normalize,
    perspectiveDepthToViewZ,
    positionGeometry,
    positionView,
    positionViewDirection,
    positionWorld,
    pow,
    screenUV,
    select,
    sin,
    smoothstep,
    texture,
    uniform,
    varying,
    vec2,
    vec3,
    vec4,
    viewportTexture,
} from 'three/tsl';
import { depthPrecision, isSkyDepth } from '../core/depth';
import { NO_WATER } from '../shared/types';
import type { EnvironmentSettings } from '../shared/types';
import { mulberry32 } from '../util/noise';
import type { GridRect, Heightfield } from './Heightfield';

const CHUNK_CELLS = 64;

type WaterChunk = {
    col0: number;
    row0: number;
    mesh: THREE.Mesh | null;
};

/**
 * Renders rivers, lakes and the ocean from a grid of surface heights (NO_WATER where dry).
 *
 * Shading model (per pixel, TSL node material drawn with the transparent objects, after the opaque scene):
 * - the opaque scene rendered so far is read back from the same scene pass (viewport colour + depth
 *   copies, taken once when the first water chunk is drawn), so there is no separate refraction pass
 *   and everything follows the pass resolution (dynamic resolution / temporal upscaling);
 * - the true water thickness along the view ray comes from that depth, driving Beer–Lambert
 *   absorption, the water body colour, soft shorelines and depth-based foam;
 * - the scene behind is refracted through the wave normals and attenuated by the absorption;
 * - reflections come from the standard PBR lighting (sky environment, sun specular) weighted by
 *   Fresnel; near the reflected water level the environment is replaced by the planar reflection;
 * - waves: a physically inspired spectrum normal map in three scrolling octaves plus a gentle
 *   vertex swell on deep water; rivers flow along the downhill surface gradient (flow mapping).
 */
export class Water {
    readonly group = new THREE.Group();
    readonly material: WaterMaterial;
    private readonly u = createWaterUniforms();
    private readonly waveTexture = createWaveTexture();
    private readonly reflectionNode: THREE.TextureNode;
    private chunks: WaterChunk[] = [];
    private chunksPerSide: number;
    private ocean: THREE.Mesh | null = null;
    private step: number;
    /** Called whenever water meshes are rebuilt (e.g. to refresh shore wetness). */
    onRebuild: (() => void) | null = null;

    constructor(
        readonly surface: Heightfield,
        readonly terrain: Heightfield,
    ) {
        this.group.name = 'Water';
        this.chunksPerSide = (surface.resolution - 1) / CHUNK_CELLS;
        this.step = surface.resolution > 600 ? 2 : 1;
        this.u.gridSpacing.value = surface.cell * this.step;
        this.u.mapHalf.value = surface.half;
        const { material, reflection } = createWaterMaterial(
            this.u,
            this.waveTexture,
        );
        this.material = material;
        this.reflectionNode = reflection;

        for (let cz = 0; cz < this.chunksPerSide; cz++) {
            for (let cx = 0; cx < this.chunksPerSide; cx++) {
                this.chunks.push({
                    col0: cx * CHUNK_CELLS,
                    row0: cz * CHUNK_CELLS,
                    mesh: null,
                });
            }
        }

        this.rebuildRect({
            x0: 0,
            z0: 0,
            x1: surface.resolution - 1,
            z1: surface.resolution - 1,
        });
    }

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
    }

    applyEnvironment(env: EnvironmentSettings): void {
        const u = this.u;
        u.shallow.value.set(env.water_shallow_color);
        u.deep.value.set(env.water_deep_color);
        u.clarity.value = env.water_clarity;
        u.wind.value = env.wind_strength;
        u.waveScale.value = env.wave_scale;
        u.waveStrength.value = env.wave_strength;
        u.waveSpeed.value = env.wave_speed;
        u.waveHeight.value = env.wave_height;
        u.flowSpeed.value = env.flow_speed;
        u.refraction.value = env.water_refraction;
        u.foamEnabled.value = env.shore_foam ? 1 : 0;
        u.foamWidth.value = env.foam_width;
        u.foamIntensity.value = env.foam_intensity;
        u.rapids.value = env.rapids_foam ? 1 : 0;
        u.roughness.value = env.water_roughness;
        this.material.envMapIntensity = env.water_reflectivity;
        this.setOcean(env.ocean_enabled, env.sea_level);
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
        } | null,
    ): void {
        this.u.hasReflection.value = reflection ? 1 : 0;

        if (reflection) {
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

    update(dt: number): void {
        this.u.time.value += dt;
    }

    /** Water surface height at a world position, or null when dry. */
    levelAt(x: number, z: number): number | null {
        if (!this.surface.contains(x, z)) {
            return this.ocean ? this.ocean.position.y : null;
        }

        const { gx, gz } = this.surface.toGrid(x, z);
        const c = Math.round(gx);
        const r = Math.round(gz);
        const v = this.surface.get(c, r);

        if (v <= NO_WATER + 1) {
            return null;
        }

        // Interpolate between wet neighbours for smooth swimming heights.
        let sum = 0;
        let count = 0;

        for (let dz = 0; dz <= 1; dz++) {
            for (let dx = 0; dx <= 1; dx++) {
                const s = this.surface.get(
                    Math.floor(gx) + dx,
                    Math.floor(gz) + dz,
                );

                if (s > NO_WATER + 1) {
                    sum += s;
                    count++;
                }
            }
        }

        return count ? sum / count : v;
    }

    /** Rebuilds the water meshes that overlap the rect (after water painting or terrain sculpting). */
    rebuildRect(rect: GridRect): void {
        this.onRebuild?.();

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

    hasWater(): boolean {
        return this.chunks.some((c) => c.mesh !== null) || this.ocean !== null;
    }

    dispose(): void {
        for (const chunk of this.chunks) {
            chunk.mesh?.geometry.dispose();
        }

        this.ocean?.geometry.dispose();
        this.material.dispose();
        this.waveTexture.dispose();
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
        const depth: number[] = [];
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
                    depth.push(r <= h ? 15 : 60);
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
            'waterDepth',
            new THREE.Float32BufferAttribute(depth, 1),
        );
        geometry.setAttribute(
            'waterFlow',
            new THREE.Float32BufferAttribute(
                new Float32Array((positions.length / 3) * 2),
                2,
            ),
        );
        geometry.setIndex(index);
        fixWinding(geometry);

        return geometry;
    }

    private buildChunk(chunk: WaterChunk): void {
        const s = this.step;
        const hf = this.surface;
        const res = hf.resolution;
        const n = CHUNK_CELLS / s + 1;
        const wet = (c: number, r: number) => hf.get(c, r) > NO_WATER + 1;

        // Quick reject: any wet sample in or bordering the chunk?
        let any = false;

        for (
            let r = Math.max(0, chunk.row0 - s);
            r <= Math.min(res - 1, chunk.row0 + CHUNK_CELLS + s) && !any;
            r++
        ) {
            for (
                let c = Math.max(0, chunk.col0 - s);
                c <= Math.min(res - 1, chunk.col0 + CHUNK_CELLS + s);
                c++
            ) {
                if (wet(c, r)) {
                    any = true;
                    break;
                }
            }
        }

        if (chunk.mesh) {
            this.group.remove(chunk.mesh);
            chunk.mesh.geometry.dispose();
            chunk.mesh = null;
        }

        if (!any) {
            return;
        }

        const count = n * n;
        const positions = new Float32Array(count * 3);
        const depth = new Float32Array(count);
        const flow = new Float32Array(count * 2);
        const level = new Float32Array(count);
        const isWet = new Uint8Array(count);

        for (let j = 0; j < n; j++) {
            for (let i = 0; i < n; i++) {
                const c = chunk.col0 + i * s;
                const r = chunk.row0 + j * s;
                const k = j * n + i;
                let h = hf.get(c, r);

                if (h > NO_WATER + 1) {
                    isWet[k] = 1;
                } else {
                    // Extrapolate from the lowest wet neighbour so the surface tucks under the shore
                    // without climbing up towards a higher neighbouring pool.
                    let lowest = Infinity;

                    for (let dz = -s; dz <= s; dz += s) {
                        for (let dx = -s; dx <= s; dx += s) {
                            const v = hf.get(c + dx, r + dz);

                            if (v > NO_WATER + 1) {
                                lowest = Math.min(lowest, v);
                            }
                        }
                    }

                    h = Number.isFinite(lowest)
                        ? lowest
                        : this.terrain.get(c, r) - 2;
                }

                level[k] = h;
                positions[k * 3] = hf.colToX(c);
                positions[k * 3 + 1] = h;
                positions[k * 3 + 2] = hf.rowToZ(r);
                depth[k] = isWet[k]
                    ? Math.max(0, h - this.terrain.get(c, r))
                    : 0;
            }
        }

        // Flow follows the downhill surface gradient.
        for (let j = 0; j < n; j++) {
            for (let i = 0; i < n; i++) {
                const k = j * n + i;
                const l = level[j * n + Math.max(0, i - 1)];
                const rr = level[j * n + Math.min(n - 1, i + 1)];
                const u = level[Math.max(0, j - 1) * n + i];
                const d = level[Math.min(n - 1, j + 1) * n + i];
                const gx = (l - rr) / (2 * hf.cell * s);
                const gz = (u - d) / (2 * hf.cell * s);
                const mag = Math.hypot(gx, gz);
                const speed = Math.min(1, mag * 40);
                flow[k * 2] = mag > 1e-5 ? (gx / mag) * speed : 0;
                flow[k * 2 + 1] = mag > 1e-5 ? (gz / mag) * speed : 0;
            }
        }

        // Never stretch a quad across a big level jump (that would draw a vertical sheet of water).
        const wallLimit = Math.max(1.5, hf.cell * s * 0.5);
        const index: number[] = [];

        for (let j = 0; j < n - 1; j++) {
            for (let i = 0; i < n - 1; i++) {
                const a = j * n + i;
                const b = (j + 1) * n + i;
                const c = j * n + i + 1;
                const d = (j + 1) * n + i + 1;

                if (!(isWet[a] || isWet[b] || isWet[c] || isWet[d])) {
                    continue;
                }

                const lo = Math.min(level[a], level[b], level[c], level[d]);
                const hi = Math.max(level[a], level[b], level[c], level[d]);

                if (hi - lo > wallLimit) {
                    continue;
                }

                index.push(a, b, c, c, b, d);
            }
        }

        if (!index.length) {
            return;
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
            'position',
            new THREE.BufferAttribute(positions, 3),
        );
        geometry.setAttribute(
            'waterDepth',
            new THREE.BufferAttribute(depth, 1),
        );
        geometry.setAttribute('waterFlow', new THREE.BufferAttribute(flow, 2));
        geometry.setIndex(index);
        geometry.computeVertexNormals();
        geometry.computeBoundingSphere();

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

/** Material inputs (TSL uniforms), updated from the environment and the weather. */
function createWaterUniforms() {
    return {
        time: uniform(0),
        shallow: uniform(new THREE.Color('#2fa3a0')),
        deep: uniform(new THREE.Color('#0b2f45')),
        clarity: uniform(4),
        wind: uniform(0.4),
        waveScale: uniform(8),
        waveStrength: uniform(0.6),
        waveSpeed: uniform(1),
        waveHeight: uniform(0.15),
        flowSpeed: uniform(1),
        refraction: uniform(0.5),
        foamEnabled: uniform(1),
        foamWidth: uniform(1.2),
        foamIntensity: uniform(0.6),
        rapids: uniform(1),
        roughness: uniform(0.06),
        reflMatrix: uniform(new THREE.Matrix4()),
        reflLevel: uniform(0),
        hasReflection: uniform(0),
        // Weather (Weather.ts): rain ripple intensity and the wind direction (x, z).
        rain: uniform(0),
        windDir: uniform(new THREE.Vector2(0.8, 0.6)),
        // Surface mesh: vertex spacing of the water chunks (m) and the half size of the map.
        gridSpacing: uniform(8),
        mapHalf: uniform(1e6),
    };
}

type WaterUniforms = ReturnType<typeof createWaterUniforms>;

/** Long directional swells: direction, wavelength (m) and relative amplitude. */
const SWELLS: { dir: [number, number]; length: number; amp: number }[] = [
    { dir: [1, 0.25], length: 42, amp: 0.6 },
    { dir: [0.7, -0.7], length: 23, amp: 0.3 },
    { dir: [0.2, 1], length: 13, amp: 0.1 },
];

/**
 * MeshStandardNodeMaterial with two water-specific hooks: the planar reflection replaces the
 * environment radiance near the reflected level, and the water blends into the scene underneath at
 * the waterline (soft shores).
 */
class WaterMaterial extends THREE.MeshStandardNodeMaterial {
    /** Planar reflection colour and its weight (0 = environment only). */
    planarNode: Node<'vec3'> | null = null;
    planarWeightNode: Node<'float'> | null = null;
    /** Scene colour under the water surface and the 0-1 shore blend towards the water shading. */
    underNode: Node<'vec3'> | null = null;
    shoreNode: Node<'float'> | null = null;
    /** Copy of the scene depth behind the water: its format has to match the depth buffer's. */
    sceneDepth: THREE.DepthTexture | null = null;

    override setup(builder: NodeBuilder): void {
        if (this.sceneDepth) {
            this.sceneDepth.type = builder.renderer.reversedDepthBuffer
                ? THREE.FloatType
                : THREE.UnsignedIntType;
        }

        super.setup(builder);
    }

    override setupEnvironment(
        builder: NodeBuilder,
    ): THREE.EnvironmentNode | null {
        const env = super.setupEnvironment(builder);

        if (!this.planarNode || !this.planarWeightNode) {
            return env;
        }

        return new PlanarEnvironmentNode(
            env?.envNode ?? null,
            this.planarNode,
            this.planarWeightNode,
        );
    }

    override setupOutput(builder: NodeBuilder, outputNode: Node): Node {
        if (!this.underNode || !this.shoreNode) {
            return super.setupOutput(builder, outputNode);
        }

        const rgba = outputNode as Node<'vec4'>;

        return super.setupOutput(
            builder,
            vec4(mix(this.underNode, rgba.rgb, this.shoreNode), rgba.a),
        );
    }
}

/** Sky environment lighting whose specular radiance is then blended towards the planar reflection. */
class PlanarEnvironmentNode extends THREE.EnvironmentNode {
    constructor(
        envNode: Node | null,
        private readonly planar: Node<'vec3'>,
        private readonly weight: Node<'float'>,
    ) {
        super(envNode);
    }

    override setup(builder: NodeBuilder): undefined {
        if (this.envNode) {
            super.setup(builder);
        }

        const radiance = (builder.context as { radiance: Node<'vec3'> })
            .radiance;
        radiance.assign(mix(radiance, this.planar, this.weight));

        return undefined;
    }
}

/** Per-drop hash (Dave Hoskins' hash22). */
const rippleHash = (p: Node<'vec2'>): Node<'vec2'> => {
    const q = fract(
        vec3(p.x, p.y, p.x).mul(vec3(0.1031, 0.103, 0.0973)),
    ).toVar();
    q.addAssign(dot(q, q.yzx.add(33.33)));

    return fract(vec2(q.x, q.x).add(q.yz).mul(q.zy));
};

/** Expanding rings from rain drops: one drop per cell and layer; returns the slope (d height / d xz). */
const rainRipples = (p: Node<'vec2'>, t: Node<'float'>): Node<'vec2'> => {
    let slope: Node<'vec2'> = vec2(0);

    for (let layer = 0; layer < 3; layer++) {
        const q = p.mul(2.3 + layer * 0.7).add(layer * 17.31);
        const cell = floor(q);
        const f = fract(q);
        const h = rippleHash(cell.add(layer * 3.7));
        const phase = fract(t.mul(1.1 + layer * 0.2).add(h.x.mul(7)));
        const d = f.sub(h.mul(0.4).add(0.3));
        const dist = length(d);
        const x = dist.sub(phase.mul(0.42));
        const fade = phase.oneMinus();
        const ring = sin(x.mul(45))
            .mul(exp(x.mul(x).mul(-500)))
            .mul(fade.mul(fade));
        slope = slope.add(d.div(max(dist, 1e-3)).mul(ring));
    }

    return slope;
};

/** The water material and its planar reflection texture node (for swapping in the reflection). */
function createWaterMaterial(
    u: WaterUniforms,
    waveTexture: THREE.Texture,
): { material: WaterMaterial; reflection: THREE.TextureNode } {
    const material = new WaterMaterial({
        color: 0xffffff,
        metalness: 0,
        envMapIntensity: 1,
    });
    // Drawn after the opaque scene (it reads it back); alpha stays 1, so blending is a plain overwrite.
    material.transparent = true;
    material.depthWrite = true;
    material.name = 'Water';

    const waterDepth = attribute<'float'>('waterDepth', 'float');
    const waterFlow = varying(attribute<'vec2'>('waterFlow', 'vec2'));
    const waveTime = u.time.mul(u.waveSpeed);

    // ---- vertex: long swells on deep water, with the matching geometric normal
    const swell = Fn(() => {
        const p = modelWorldMatrix.mul(vec4(positionGeometry, 1)).xz;
        // Calm towards the map edge: the chunks meet the coarse ocean ring there, and a surface both
        // meshes keep flat stays watertight (no crack flickering along the seam). The ring itself is far
        // too coarse to carry these wavelengths anyway.
        const edge = u.mapHalf.sub(max(abs(p.x), abs(p.y)));
        const amp = u.waveHeight
            .mul(u.wind.mul(0.5).add(0.5))
            .mul(smoothstep(0.5, 4, waterDepth))
            .mul(smoothstep(0, 60, edge));
        let h: Node<'float'> = float(0);
        let grad: Node<'vec2'> = vec2(0);

        SWELLS.forEach((s, i) => {
            const len = Math.hypot(s.dir[0], s.dir[1]);
            const dir = vec2(s.dir[0] / len, s.dir[1] / len);
            const k = (Math.PI * 2) / s.length;
            const speed = Math.sqrt(9.81 / k);
            const arg = dot(dir, p).sub(waveTime.mul(speed)).mul(k);
            // Swells shorter than a few vertex spacings alias into regular bands across the mesh.
            const resolved = smoothstep(
                u.gridSpacing.mul(2.5),
                u.gridSpacing.mul(4),
                float(s.length),
            );
            // Wave groups: a slow modulation along and across the crests, so a swell doesn't read as
            // endless parallel lines across a lake (its slope is left out of the normal: it is small).
            const group = sin(
                dot(vec2(dir.y.negate(), dir.x), p)
                    .mul((Math.PI * 2) / (s.length * 4.7))
                    .add(i * 1.7),
            )
                .mul(sin(dot(dir, p).mul((Math.PI * 2) / (s.length * 7.3))))
                .mul(0.4)
                .add(0.6);
            const a = resolved.mul(group).mul(s.amp);
            h = h.add(sin(arg).mul(a));
            grad = grad.add(dir.mul(cos(arg).mul(a.mul(k))));
        });

        return vec3(h, grad).mul(amp);
    })();
    material.positionNode = positionGeometry.add(vec3(0, swell.x, 0));
    const geoNormal = varying(
        normalize(
            normalGeometry.add(vec3(swell.y.negate(), 0, swell.z.negate())),
        ),
    );

    // ---- fragment
    const wave = (uv: Node<'vec2'>) => texture(waveTexture, uv);
    const waveNormal = (uv: Node<'vec2'>) => wave(uv).xyz.mul(2).sub(1);
    const pos = positionWorld;
    const viewDist = length(positionView);
    const fragDepth = positionView.z.negate();

    // Scene behind the water: one colour and one depth copy per frame, sampled through clones.
    const sceneColorBase = viewportTexture(
        screenUV,
        null,
        createFramebufferTexture(),
    );
    material.sceneDepth = new THREE.DepthTexture(1, 1);
    const sceneDepthBase = new THREE.ViewportDepthTextureNode(
        screenUV,
        null,
        material.sceneDepth,
    );
    const sceneColor = (uv: Node<'vec2'>) =>
        sceneColorBase.sample(uv).rgb as Node<'vec3'>;
    // Perspective depth → positive view-space distance. Nothing behind the water (open sea beyond
    // the terrain, out to the far plane) counts as bottomless, not as the far plane: water that
    // reaches the far plane would otherwise turn shallow (and see-through) right at the horizon.
    const sceneDistance = (uv: Node<'vec2'>) => {
        const depth = sceneDepthBase.sample(uv).x;

        return select(
            isSkyDepth(depth),
            float(1e6),
            perspectiveDepthToViewZ(depth, cameraNear, cameraFar).negate(),
        );
    };
    // Thickness below a few depth buffer steps is quantisation noise (banding that TAA jitter turns into
    // shimmer on distant water): never resolve less than that, which fades far shores to deep water.
    const resolvable = (thickness: Node<'float'>) =>
        max(thickness, depthPrecision(fragDepth, cameraNear).mul(4));

    const viewDir = normalize(cameraPosition.sub(pos));
    const cosV = max(abs(viewDir.y), 0.08);
    // Path length through the water along the view ray (m) and the approximate vertical depth.
    const thickness = resolvable(
        max(sceneDistance(screenUV).sub(fragDepth), 0),
    );
    const vertical = thickness.mul(cosV);

    // Foam: soft bubbly band along every intersection (shores, rocks, reeds) + rapids on fast rivers.
    const wind = u.windDir;
    const bubblesA = wave(
        pos.xz
            .div(3.3)
            .add(wind.mul(waveTime.mul(0.015)))
            .add(waterFlow.mul(waveTime.mul(0.2))),
    ).a;
    const bubblesB = wave(
        pos.xz.div(1.7).sub(wind.yx.mul(waveTime.mul(0.022))),
    ).a;
    const bubbles = bubblesA.mul(0.6).add(bubblesB.mul(0.4));
    const edge = smoothstep(0, max(u.foamWidth, 0.01), vertical).oneMinus();
    const lap = sin(
        waveTime.mul(1.3).sub(vertical.mul(5).div(max(u.foamWidth, 0.05))),
    )
        .mul(0.5)
        .add(0.5);
    const shoreFoam = u.foamEnabled
        .mul(edge)
        .mul(smoothstep(0.15, 0.55, bubbles.add(edge.mul(0.35).mul(lap))));
    const flowSpeed = length(waterFlow);
    const rapids = u.rapids
        .mul(smoothstep(0.45, 1, flowSpeed))
        .mul(smoothstep(0.25, 0.6, bubbles));
    // Far away the bubble texture minifies into a solid band, so fade foam out with distance.
    const foamFade = smoothstep(40, 220, viewDist).oneMinus();
    const foam = clamp(
        shoreFoam.add(rapids).mul(u.foamIntensity).mul(1.5).mul(foamFade),
        0,
        1,
    );

    // Water body colour (in-scattering): shallow → deep with optical depth.
    const clarity = max(u.clarity, 0.05);
    const optical = exp(thickness.negate().div(clarity)).oneMinus();
    const body = mix(u.shallow, u.deep, smoothstep(0, 1, optical));
    material.colorNode = vec4(
        mix(body.mul(optical).mul(0.9), vec3(0.9, 0.93, 0.95), foam),
        1,
    );
    material.roughnessNode = mix(u.roughness.add(u.rain.mul(0.05)), 0.6, foam);

    // Wave normals.
    const worldNormal = Fn(() => {
        const uv = pos.xz.div(max(u.waveScale, 0.1));

        // River flow mapping: two phases of the same layer, cross-faded to hide the reset.
        const flow = waterFlow.mul(u.flowSpeed).mul(0.9);
        const ph0 = fract(waveTime.mul(0.25));
        const ph1 = fract(waveTime.mul(0.25).add(0.5));
        const fw = abs(ph0.sub(0.5)).mul(2);
        const flowN = mix(
            waveNormal(uv.sub(flow.mul(ph0))),
            waveNormal(uv.sub(flow.mul(ph1)).add(0.5)),
            fw,
        );

        const big = waveNormal(uv.mul(0.27).add(wind.mul(waveTime.mul(0.011))));
        const rotated = vec2(
            uv.x.mul(0.8).sub(uv.y.mul(0.6)),
            uv.x.mul(0.6).add(uv.y.mul(0.8)),
        );
        const hasFlow = smoothstep(0.02, 0.2, flowSpeed);
        const mid = mix(
            waveNormal(rotated.mul(0.9).sub(wind.mul(waveTime.mul(0.023)))),
            flowN,
            hasFlow,
        );
        const fine = waveNormal(
            uv
                .mul(3.1)
                .add(vec2(wind.y.negate(), wind.x).mul(waveTime.mul(0.05))),
        );

        const fade = mix(1, 0.35, smoothstep(60, 900, viewDist));
        const strength = u.waveStrength
            .mul(u.wind.mul(0.45).add(0.55))
            .mul(fade);
        const slope = big.xy
            .div(big.z)
            .mul(0.9)
            .add(mid.xy.div(mid.z))
            .add(
                fine.xy
                    .div(fine.z)
                    .mul(0.45)
                    .mul(smoothstep(20, 150, viewDist).oneMinus()),
            )
            .mul(strength.mul(0.35))
            .mul(foam.mul(0.7).oneMinus())
            // Calm the surface in very shallow water.
            .mul(smoothstep(0, 0.4, vertical).mul(0.7).add(0.3))
            .toVar();

        If(u.rain.greaterThan(0.001), () => {
            slope.addAssign(
                rainRipples(pos.xz, u.time).mul(
                    u.rain
                        .mul(0.35)
                        .mul(smoothstep(12, 60, viewDist).oneMinus()),
                ),
            );
        });

        // Combine with the geometric (swell) normal, flattened with distance: far away its crests
        // shrink to a few pixels and read as regular bands.
        const geo = normalize(
            mix(
                normalize(geoNormal),
                vec3(0, 1, 0),
                smoothstep(150, 900, viewDist).mul(0.6),
            ),
        );

        return normalize(
            vec3(
                geo.x.div(geo.y).sub(slope.x),
                1,
                geo.z.div(geo.y).sub(slope.y),
            ),
        );
    })();
    const normal = worldNormal.transformDirection(cameraViewMatrix);
    material.normalNode = normal;

    // Refraction: offset the scene lookup along the wave normal, more in deeper water (screen UVs
    // point down, view-space y up).
    const offset = vec2(normal.x, normal.y.negate()).mul(
        u.refraction.mul(0.08).mul(smoothstep(0, 2.5, thickness)),
    );
    const bentUv = clamp(screenUV.add(offset), 0.001, 0.999);
    // Don't refract things that are in front of the water surface.
    const refractUv = select(
        sceneDistance(bentUv).lessThan(fragDepth),
        screenUV,
        bentUv,
    );
    const refractThickness = resolvable(
        max(sceneDistance(refractUv).sub(fragDepth), 0),
    );
    // Beer–Lambert absorption tinted by the shallow colour (red is absorbed first).
    const sigma = vec3(1)
        .sub(clamp(u.shallow.mul(1.4), 0, 0.98))
        .mul(1.6)
        .div(clarity)
        .add(float(0.02).div(clarity));
    const transmittance = exp(sigma.negate().mul(refractThickness));
    const nDotV = clamp(dot(normal, positionViewDirection), 0, 1);
    const fresnel = pow(nDotV.oneMinus(), 5).mul(0.98).add(0.02);
    material.emissiveNode = sceneColor(refractUv)
        .mul(transmittance)
        .mul(fresnel.oneMinus())
        .mul(foam.oneMinus());

    // Planar reflection of the dominant level, for the pixels on (or near) that level.
    const reflClip = u.reflMatrix.mul(vec4(pos.x, u.reflLevel, pos.z, 1));
    const reflUv = clamp(
        reflClip.xy
            .div(reflClip.w)
            .add(
                vec2(normal.x, normal.y.negate()).mul(
                    u.refraction.mul(0.02).add(0.012),
                ),
            ),
        0.001,
        0.999,
    );
    // Black until a reflection is connected (weight 0). Its own placeholder: nodes that start on the
    // same texture share one binding, and the shader's sampling mode (filtered or texel fetch) is
    // chosen from the placeholder's filters.
    const placeholder = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    placeholder.minFilter = placeholder.magFilter = THREE.LinearFilter;
    placeholder.needsUpdate = true;
    const reflection = texture(placeholder, reflUv);
    material.planarNode = reflection.rgb;
    material.planarWeightNode = u.hasReflection.mul(
        smoothstep(0.4, 2, abs(pos.y.sub(u.reflLevel))).oneMinus(),
    );

    // Blend seamlessly into the ground at the waterline.
    material.underNode = sceneColor(screenUV);
    material.shoreNode = smoothstep(0, 0.18, vertical);

    return { material, reflection };
}

/** Colour copy target for the scene behind the water: no mipmaps (only sampled at full detail). */
function createFramebufferTexture(): THREE.FramebufferTexture {
    const target = new THREE.FramebufferTexture(1, 1);
    target.name = 'Water scene colour';
    target.minFilter = THREE.LinearFilter;
    target.magFilter = THREE.LinearFilter;
    target.generateMipmaps = false;

    return target;
}
