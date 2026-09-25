import * as THREE from 'three';
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

/** Screen-space inputs rendered by the game before the water is drawn. */
export type WaterSceneTextures = {
    color: THREE.Texture;
    depth: THREE.DepthTexture;
};

/**
 * Renders rivers, lakes and the ocean from a grid of surface heights (NO_WATER where dry).
 *
 * Shading model (per pixel):
 * - the opaque scene is rendered first (without water) into colour + depth textures;
 * - the true water thickness along the view ray comes from that depth, driving Beer–Lambert
 *   absorption, the water body colour, soft shorelines and depth-based foam;
 * - the scene behind is refracted through the wave normals and attenuated by the absorption;
 * - reflections (sky/sun) come from the standard PBR lighting, weighted by Fresnel;
 * - waves: a physically inspired spectrum normal map in three scrolling octaves plus a gentle
 *   vertex swell on deep water; rivers flow along the downhill surface gradient (flow mapping).
 */
export class Water {
    readonly group = new THREE.Group();
    readonly material: THREE.MeshStandardMaterial;
    readonly uniforms: Record<string, THREE.IUniform>;
    private chunks: WaterChunk[] = [];
    private chunksPerSide: number;
    private ocean: THREE.Mesh | null = null;
    private step: number;
    private heightTexture: THREE.DataTexture;

    constructor(
        readonly surface: Heightfield,
        readonly terrain: Heightfield,
    ) {
        this.group.name = 'Water';
        this.chunksPerSide = (surface.resolution - 1) / CHUNK_CELLS;
        this.step = surface.resolution > 600 ? 2 : 1;

        this.heightTexture = new THREE.DataTexture(
            terrain.data,
            terrain.resolution,
            terrain.resolution,
            THREE.RedFormat,
            THREE.FloatType,
        );
        this.heightTexture.minFilter = this.heightTexture.magFilter =
            THREE.NearestFilter;
        this.heightTexture.generateMipmaps = false;
        this.heightTexture.needsUpdate = true;

        this.uniforms = {
            uTime: { value: 0 },
            uHeights: { value: this.heightTexture },
            uMapHalf: { value: terrain.half },
            uCell: { value: terrain.cell },
            uRes: { value: terrain.resolution },
            uNormalMap: { value: createWaveTexture() },
            uShallow: { value: new THREE.Color('#2fa3a0') },
            uDeep: { value: new THREE.Color('#0b2f45') },
            uClarity: { value: 4 },
            uWind: { value: 0.4 },
            uWaveScale: { value: 8 },
            uWaveStrength: { value: 0.6 },
            uWaveSpeed: { value: 1 },
            uWaveHeight: { value: 0.15 },
            uFlowSpeed: { value: 1 },
            uRefraction: { value: 0.5 },
            uFoamEnabled: { value: 1 },
            uFoamWidth: { value: 1.2 },
            uFoamIntensity: { value: 0.6 },
            uRapids: { value: 1 },
            uSceneColor: { value: null },
            uSceneDepth: { value: null },
            uHasScene: { value: 0 },
            uViewport: { value: new THREE.Vector2(1, 1) },
            uCameraNear: { value: 0.1 },
            uCameraFar: { value: 20000 },
            uReflection: { value: null },
            uReflMatrix: { value: new THREE.Matrix4() },
            uReflLevel: { value: 0 },
            uHasReflection: { value: 0 },
        };

        this.material = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            roughness: 0.06,
            metalness: 0.0,
            envMapIntensity: 1,
        });
        this.material.onBeforeCompile = (shader) => {
            Object.assign(shader.uniforms, this.uniforms);
            shader.vertexShader = shader.vertexShader
                .replace(
                    '#include <common>',
                    `#include <common>\n${WATER_VERTEX_PARS}`,
                )
                .replace('#include <beginnormal_vertex>', WATER_VERTEX_NORMAL)
                .replace('#include <begin_vertex>', WATER_VERTEX_BEGIN);
            shader.fragmentShader = shader.fragmentShader
                .replace(
                    '#include <common>',
                    `#include <common>\n${WATER_PARS}`,
                )
                .replace('#include <map_fragment>', WATER_ALBEDO)
                .replace('#include <roughnessmap_fragment>', WATER_ROUGHNESS)
                .replace('#include <normal_fragment_maps>', WATER_NORMAL)
                .replace('#include <emissivemap_fragment>', WATER_EMISSIVE)
                .replace('#include <lights_fragment_maps>', WATER_REFLECTION)
                .replace('#include <opaque_fragment>', WATER_OUTPUT);
        };
        this.material.customProgramCacheKey = () => 'waterways-water-v4';

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

    applyEnvironment(env: EnvironmentSettings): void {
        const u = this.uniforms;
        (u.uShallow.value as THREE.Color).set(env.water_shallow_color);
        (u.uDeep.value as THREE.Color).set(env.water_deep_color);
        u.uClarity.value = env.water_clarity;
        u.uWind.value = env.wind_strength;
        u.uWaveScale.value = env.wave_scale;
        u.uWaveStrength.value = env.wave_strength;
        u.uWaveSpeed.value = env.wave_speed;
        u.uWaveHeight.value = env.wave_height;
        u.uFlowSpeed.value = env.flow_speed;
        u.uRefraction.value = env.water_refraction;
        u.uFoamEnabled.value = env.shore_foam ? 1 : 0;
        u.uFoamWidth.value = env.foam_width;
        u.uFoamIntensity.value = env.foam_intensity;
        u.uRapids.value = env.rapids_foam ? 1 : 0;
        this.material.roughness = env.water_roughness;
        this.material.envMapIntensity = env.water_reflectivity;
        this.setOcean(env.ocean_enabled, env.sea_level);
    }

    /** Connect the opaque-scene prepass (colour + depth) used for refraction and thickness. */
    setSceneTextures(
        textures: WaterSceneTextures | null,
        width = 1,
        height = 1,
    ): void {
        this.uniforms.uSceneColor.value = textures?.color ?? null;
        this.uniforms.uSceneDepth.value = textures?.depth ?? null;
        this.uniforms.uHasScene.value = textures ? 1 : 0;
        (this.uniforms.uViewport.value as THREE.Vector2).set(width, height);
    }

    /** Connect (or disconnect) the planar reflection of the nearest water level. */
    setReflection(
        reflection: {
            texture: THREE.Texture;
            matrix: THREE.Matrix4;
            level: number;
        } | null,
    ): void {
        this.uniforms.uHasReflection.value = reflection ? 1 : 0;

        if (reflection) {
            this.uniforms.uReflection.value = reflection.texture;
            (this.uniforms.uReflMatrix.value as THREE.Matrix4).copy(
                reflection.matrix,
            );
            this.uniforms.uReflLevel.value = reflection.level;
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

    update(dt: number, camera: THREE.PerspectiveCamera): void {
        this.uniforms.uTime.value += dt;
        this.uniforms.uCameraNear.value = camera.near;
        this.uniforms.uCameraFar.value = camera.far;
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
        this.heightTexture.needsUpdate = true;

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
        (this.uniforms.uNormalMap.value as THREE.Texture).dispose();
        this.heightTexture.dispose();
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

const WATER_VERTEX_PARS = /* glsl */ `
attribute float waterDepth;
attribute vec2 waterFlow;
varying float vWaterDepth;
varying vec2 vWaterFlow;
varying vec3 vWaterPos;
uniform float uTime;
uniform float uWaveHeight;
uniform float uWaveSpeed;
uniform float uWind;

// Sum of three long directional swells. Returns (height, dh/dx, dh/dz) for unit amplitude.
vec3 waterSwell(vec2 p) {
    float t = uTime * uWaveSpeed;
    vec3 acc = vec3(0.0);
    vec2 dirs[3];
    dirs[0] = normalize(vec2(1.0, 0.25));
    dirs[1] = normalize(vec2(0.7, -0.7));
    dirs[2] = normalize(vec2(0.2, 1.0));
    float lens[3];
    lens[0] = 42.0; lens[1] = 23.0; lens[2] = 13.0;
    float amps[3];
    amps[0] = 0.6; amps[1] = 0.3; amps[2] = 0.1;
    for (int i = 0; i < 3; i++) {
        float k = 6.2831853 / lens[i];
        float c = sqrt(9.81 / k);
        float arg = k * (dot(dirs[i], p) - c * t);
        acc.x += amps[i] * sin(arg);
        acc.yz += amps[i] * k * cos(arg) * dirs[i];
    }
    return acc;
}
`;

const WATER_VERTEX_NORMAL = /* glsl */ `
vec3 wWorld = (modelMatrix * vec4(position, 1.0)).xyz;
float swellAmp = uWaveHeight * (0.5 + uWind * 0.5) * smoothstep(0.5, 4.0, waterDepth);
vec3 swell = waterSwell(wWorld.xz) * swellAmp;
vec3 objectNormal = normalize(normal + vec3(-swell.y, 0.0, -swell.z));
#ifdef USE_TANGENT
    vec3 objectTangent = vec3(tangent.xyz);
#endif
`;

const WATER_VERTEX_BEGIN = /* glsl */ `
#include <begin_vertex>
transformed.y += swell.x;
vWaterDepth = waterDepth;
vWaterFlow = waterFlow;
vWaterPos = wWorld + vec3(0.0, swell.x, 0.0);
`;

const WATER_PARS = /* glsl */ `
varying float vWaterDepth;
varying vec2 vWaterFlow;
varying vec3 vWaterPos;
uniform float uTime;
uniform sampler2D uNormalMap;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform float uClarity;
uniform float uWind;
uniform float uWaveScale;
uniform float uWaveStrength;
uniform float uWaveSpeed;
uniform float uFlowSpeed;
uniform float uRefraction;
uniform float uFoamEnabled;
uniform float uFoamWidth;
uniform float uFoamIntensity;
uniform float uRapids;
uniform highp sampler2D uHeights;
uniform float uMapHalf;
uniform float uCell;
uniform float uRes;
uniform sampler2D uSceneColor;
uniform sampler2D uSceneDepth;
uniform float uHasScene;
uniform vec2 uViewport;
uniform float uCameraNear;
uniform float uCameraFar;
uniform sampler2D uReflection;
uniform mat4 uReflMatrix;
uniform float uReflLevel;
uniform float uHasReflection;

float waterFoam = 0.0;
float waterThickness = 0.0;   // path length through water along the view ray (m)
float waterVertical = 0.0;    // approximate vertical depth below the surface (m)
vec2 waterScreenUv = vec2(0.0);

float terrainHeightAt(vec2 xz) {
    vec2 g = clamp((xz + uMapHalf) / uCell, vec2(0.0), vec2(uRes - 1.001));
    ivec2 i = ivec2(floor(g));
    vec2 f = fract(g);
    float h00 = texelFetch(uHeights, i, 0).r;
    float h10 = texelFetch(uHeights, i + ivec2(1, 0), 0).r;
    float h01 = texelFetch(uHeights, i + ivec2(0, 1), 0).r;
    float h11 = texelFetch(uHeights, i + ivec2(1, 1), 0).r;
    return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}

float sceneViewDistance(vec2 uv) {
    float d = texture2D(uSceneDepth, uv).r;
    // Perspective depth → positive view-space distance.
    return (uCameraNear * uCameraFar) / (uCameraFar - d * (uCameraFar - uCameraNear));
}

vec3 waveNormal(vec2 uv) {
    return texture2D(uNormalMap, uv).xyz * 2.0 - 1.0;
}
`;

const WATER_ALBEDO = /* glsl */ `
{
    vec3 viewDir = normalize(cameraPosition - vWaterPos);
    float cosV = max(abs(viewDir.y), 0.08);
    waterScreenUv = gl_FragCoord.xy / uViewport;

    if (uHasScene > 0.5) {
        waterThickness = max(sceneViewDistance(waterScreenUv) - vViewPosition.z, 0.0);
        waterVertical = waterThickness * cosV;
    } else {
        bool inside = abs(vWaterPos.x) < uMapHalf && abs(vWaterPos.z) < uMapHalf;
        waterVertical = inside ? max(vWaterPos.y - terrainHeightAt(vWaterPos.xz), 0.0) : vWaterDepth;
        waterThickness = waterVertical / cosV;
    }

    // Foam: soft bubbly band along every intersection (shores, rocks, reeds) + rapids on fast rivers.
    float t = uTime * uWaveSpeed;
    vec2 wind = vec2(0.8, 0.6);
    float bubblesA = texture2D(uNormalMap, vWaterPos.xz / 3.3 + wind * t * 0.015 + vWaterFlow * t * 0.2).a;
    float bubblesB = texture2D(uNormalMap, vWaterPos.xz / 1.7 - wind.yx * t * 0.022).a;
    float bubbles = bubblesA * 0.6 + bubblesB * 0.4;
    float edge = 1.0 - smoothstep(0.0, max(uFoamWidth, 0.01), waterVertical);
    float lap = 0.5 + 0.5 * sin(t * 1.3 - waterVertical * 5.0 / max(uFoamWidth, 0.05));
    float shoreFoam = uFoamEnabled * edge * smoothstep(0.15, 0.55, bubbles + edge * 0.35 * lap);
    float speed = length(vWaterFlow);
    float rapids = uRapids * smoothstep(0.45, 1.0, speed) * smoothstep(0.25, 0.6, bubbles);
    // Far away the bubble texture minifies into a solid band, so fade foam out with distance.
    float foamFade = 1.0 - smoothstep(40.0, 220.0, length(vViewPosition));
    waterFoam = clamp((shoreFoam + rapids) * uFoamIntensity * 1.5 * foamFade, 0.0, 1.0);

    // Water body colour (in-scattering): shallow → deep with optical depth.
    float optical = 1.0 - exp(-waterThickness / max(uClarity, 0.05));
    vec3 body = mix(uShallow, uDeep, smoothstep(0.0, 1.0, optical));
    diffuseColor.rgb = body * optical * 0.9;
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9, 0.93, 0.95), waterFoam);
    diffuseColor.a = 1.0;
}
`;

const WATER_ROUGHNESS = /* glsl */ `
float roughnessFactor = mix(roughness, 0.6, waterFoam);
`;

const WATER_NORMAL = /* glsl */ `
#include <normal_fragment_maps>
{
    float t = uTime * uWaveSpeed;
    vec2 wind = normalize(vec2(0.8, 0.6));
    vec2 uv = vWaterPos.xz / max(uWaveScale, 0.1);

    // River flow mapping: two phases of the same layer, cross-faded to hide the reset.
    vec2 flow = vWaterFlow * uFlowSpeed * 0.9;
    float ph0 = fract(t * 0.25);
    float ph1 = fract(t * 0.25 + 0.5);
    float fw = abs(ph0 - 0.5) * 2.0;
    vec3 flowN = mix(waveNormal(uv - flow * ph0), waveNormal(uv - flow * ph1 + 0.5), fw);

    vec3 big = waveNormal(uv * 0.27 + wind * t * 0.011);
    vec3 mid = waveNormal(vec2(uv.x * 0.8 - uv.y * 0.6, uv.x * 0.6 + uv.y * 0.8) * 0.9 - wind * t * 0.023);
    vec3 fine = waveNormal(uv * 3.1 + vec2(-wind.y, wind.x) * t * 0.05);
    float hasFlow = smoothstep(0.02, 0.2, length(vWaterFlow));
    mid = mix(mid, flowN, hasFlow);

    float dist = length(vViewPosition);
    float fade = mix(1.0, 0.35, smoothstep(60.0, 900.0, dist));
    float strength = uWaveStrength * (0.55 + uWind * 0.45) * fade;
    vec2 slope = (big.xy / big.z * 0.9 + mid.xy / mid.z + fine.xy / fine.z * 0.45 * (1.0 - smoothstep(20.0, 150.0, dist))) * strength * 0.35;
    slope *= 1.0 - waterFoam * 0.7;
    // Calm the surface in very shallow water.
    slope *= smoothstep(0.0, 0.4, waterVertical) * 0.7 + 0.3;

    // Combine with the geometric (swell) normal in world space, then back to view space.
    vec3 geoWorld = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
    vec3 worldN = normalize(vec3(geoWorld.x / geoWorld.y - slope.x, 1.0, geoWorld.z / geoWorld.y - slope.y));
    normal = normalize((viewMatrix * vec4(worldN, 0.0)).xyz);
}
`;

const WATER_EMISSIVE = /* glsl */ `
#include <emissivemap_fragment>
if (uHasScene > 0.5) {
    // Refraction: offset the scene lookup along the wave normal, more in deeper water.
    vec3 nView = normal;
    vec2 offset = nView.xy * uRefraction * 0.08 * smoothstep(0.0, 2.5, waterThickness);
    vec2 ruv = clamp(waterScreenUv + offset, vec2(0.001), vec2(0.999));
    // Don't refract things that are in front of the water surface.
    if (sceneViewDistance(ruv) < vViewPosition.z) {
        ruv = waterScreenUv;
    }
    float thick = max(sceneViewDistance(ruv) - vViewPosition.z, 0.0);
    vec3 behind = texture2D(uSceneColor, ruv).rgb;

    // Beer–Lambert absorption tinted by the shallow colour (red is absorbed first).
    vec3 sigma = (vec3(1.0) - clamp(uShallow * 1.4, 0.0, 0.98)) * 1.6 / max(uClarity, 0.05) + 0.02 / max(uClarity, 0.05);
    vec3 transmittance = exp(-sigma * thick);

    vec3 V = normalize(vViewPosition);
    float NdotV = clamp(dot(nView, V), 0.0, 1.0);
    float fresnel = 0.02 + 0.98 * pow(1.0 - NdotV, 5.0);

    totalEmissiveRadiance += behind * transmittance * (1.0 - fresnel) * (1.0 - waterFoam);
}
`;

const WATER_REFLECTION = /* glsl */ `
#include <lights_fragment_maps>
#if defined( RE_IndirectSpecular )
if (uHasReflection > 0.5) {
    float onPlane = 1.0 - smoothstep(0.4, 2.0, abs(vWaterPos.y - uReflLevel));
    if (onPlane > 0.0) {
        vec4 rc = uReflMatrix * vec4(vWaterPos.x, uReflLevel, vWaterPos.z, 1.0);
        vec2 ruv = rc.xy / rc.w + normal.xy * (0.012 + uRefraction * 0.02);
        vec3 planar = texture2D(uReflection, clamp(ruv, vec2(0.001), vec2(0.999))).rgb;
        radiance = mix(radiance, planar, onPlane);
    }
}
#endif
`;

const WATER_OUTPUT = /* glsl */ `
if (uHasScene > 0.5) {
    // Blend seamlessly into the ground at the waterline.
    vec3 under = texture2D(uSceneColor, waterScreenUv).rgb;
    outgoingLight = mix(under, outgoingLight, smoothstep(0.0, 0.18, waterVertical));
}
#include <opaque_fragment>
`;
