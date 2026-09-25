import * as THREE from 'three';
import { NO_WATER } from '../shared/types';
import type { EnvironmentSettings } from '../shared/types';
import { SimplexNoise } from '../util/noise';
import type { GridRect, Heightfield } from './Heightfield';

const CHUNK_CELLS = 64;

type WaterChunk = {
    col0: number;
    row0: number;
    mesh: THREE.Mesh | null;
};

/**
 * Renders water from a grid of surface heights (NO_WATER where dry). Each vertex carries the local
 * water depth (for colour/foam) and a flow vector derived from the surface slope (rivers flow downhill).
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
            uNormalMap: { value: createWaterNormalTexture() },
            uShallow: { value: new THREE.Color('#2fa3a0') },
            uDeep: { value: new THREE.Color('#0b2f45') },
            uClarity: { value: 4 },
            uWind: { value: 0.4 },
        };

        this.material = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            roughness: 0.04,
            metalness: 0.0,
            transparent: true,
            depthWrite: true,
            envMapIntensity: 1.1,
        });
        this.material.onBeforeCompile = (shader) => {
            Object.assign(shader.uniforms, this.uniforms);
            shader.vertexShader = shader.vertexShader
                .replace(
                    '#include <common>',
                    '#include <common>\nattribute float waterDepth;\nattribute vec2 waterFlow;\nvarying float vWaterDepth;\nvarying vec2 vWaterFlow;\nvarying vec3 vWaterPos;',
                )
                .replace(
                    '#include <begin_vertex>',
                    '#include <begin_vertex>\nvWaterDepth = waterDepth;\nvWaterFlow = waterFlow;\nvWaterPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
                );
            shader.fragmentShader = shader.fragmentShader
                .replace(
                    '#include <common>',
                    `#include <common>\n${WATER_PARS}`,
                )
                .replace('#include <map_fragment>', WATER_ALBEDO)
                .replace('#include <normal_fragment_maps>', WATER_NORMAL)
                .replace('#include <emissivemap_fragment>', WATER_EMISSIVE);
        };
        this.material.customProgramCacheKey = () => 'waterways-water-v2';

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
        (this.uniforms.uShallow.value as THREE.Color).set(
            env.water_shallow_color,
        );
        (this.uniforms.uDeep.value as THREE.Color).set(env.water_deep_color);
        this.uniforms.uClarity.value = env.water_clarity;
        this.uniforms.uWind.value = env.wind_strength;
        this.setOcean(env.ocean_enabled, env.sea_level);
    }

    update(dt: number): void {
        this.uniforms.uTime.value += dt;
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

    /** A large square ring around the map so the ocean extends to the horizon. */
    private createOceanRing(): THREE.BufferGeometry {
        const h = this.surface.half;
        const far = Math.max(40000, h * 20);
        const inner = [
            [-h, -h],
            [h, -h],
            [h, h],
            [-h, h],
        ];
        const outer = inner.map(([x, z]) => [
            Math.sign(x) * far,
            Math.sign(z) * far,
        ]);
        const positions: number[] = [];
        const depth: number[] = [];
        const flow: number[] = [];
        const index: number[] = [];

        for (let i = 0; i < 4; i++) {
            positions.push(inner[i][0], 0, inner[i][1]);
            depth.push(30);
            flow.push(0, 0);
        }

        for (let i = 0; i < 4; i++) {
            positions.push(outer[i][0], 0, outer[i][1]);
            depth.push(200);
            flow.push(0, 0);
        }

        for (let i = 0; i < 4; i++) {
            const a = i;
            const b = (i + 1) % 4;
            const c = 4 + i;
            const d = 4 + ((i + 1) % 4);
            index.push(a, c, b, b, c, d);
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
            'position',
            new THREE.Float32BufferAttribute(positions, 3),
        );
        geometry.setAttribute(
            'normal',
            new THREE.Float32BufferAttribute(
                Array.from({ length: 24 }, (_, i) => (i % 3 === 1 ? 1 : 0)),
                3,
            ),
        );
        geometry.setAttribute(
            'waterDepth',
            new THREE.Float32BufferAttribute(depth, 1),
        );
        geometry.setAttribute(
            'waterFlow',
            new THREE.Float32BufferAttribute(flow, 2),
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
                    // Extrapolate from wet neighbours so the surface tucks under the shore.
                    let sum = 0;
                    let cnt = 0;

                    for (let dz = -s; dz <= s; dz += s) {
                        for (let dx = -s; dx <= s; dx += s) {
                            const v = hf.get(c + dx, r + dz);

                            if (v > NO_WATER + 1) {
                                sum += v;
                                cnt++;
                            }
                        }
                    }

                    h = cnt ? sum / cnt : this.terrain.get(c, r) - 2;
                }

                level[k] = h;
                positions[k * 3] = hf.colToX(c);
                positions[k * 3 + 1] = h;
                positions[k * 3 + 2] = hf.rowToZ(r);
                depth[k] = isWet[k] ? h - this.terrain.get(c, r) : -0.5;
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

        const index: number[] = [];

        for (let j = 0; j < n - 1; j++) {
            for (let i = 0; i < n - 1; i++) {
                const a = j * n + i;
                const b = (j + 1) * n + i;
                const c = j * n + i + 1;
                const d = (j + 1) * n + i + 1;

                if (isWet[a] || isWet[b] || isWet[c] || isWet[d]) {
                    index.push(a, b, c, c, b, d);
                }
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

/** Tileable ripple normal map built from layered simplex noise on a torus. */
function createWaterNormalTexture(): THREE.DataTexture {
    const size = 256;
    const noise = new SimplexNoise(97);
    const heights = new Float32Array(size * size);
    const tau = Math.PI * 2;

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const a = (x / size) * tau;
            const b = (y / size) * tau;
            let h = 0;
            let amp = 1;

            for (let o = 0; o < 4; o++) {
                const f = 1.2 * (1 << o);
                h +=
                    amp *
                    noise.noise2D(
                        Math.cos(a) * f + Math.sin(b) * f * 0.7 + o * 13.1,
                        Math.sin(a) * f + Math.cos(b) * f * 0.7 - o * 7.7,
                    );
                amp *= 0.5;
            }

            heights[y * size + x] = h;
        }
    }

    const data = new Uint8Array(size * size * 4);

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const hl = heights[y * size + ((x - 1 + size) % size)];
            const hr = heights[y * size + ((x + 1) % size)];
            const hd = heights[((y - 1 + size) % size) * size + x];
            const hu = heights[((y + 1) % size) * size + x];
            const v = new THREE.Vector3(
                (hl - hr) * 2.5,
                (hd - hu) * 2.5,
                1,
            ).normalize();
            const i = (y * size + x) * 4;
            data[i] = Math.round((v.x * 0.5 + 0.5) * 255);
            data[i + 1] = Math.round((v.y * 0.5 + 0.5) * 255);
            data[i + 2] = Math.round((v.z * 0.5 + 0.5) * 255);
            data[i + 3] = Math.round(((heights[y * size + x] + 1.5) / 3) * 255);
        }
    }

    const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;

    return texture;
}

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
uniform highp sampler2D uHeights;
uniform float uMapHalf;
uniform float uCell;
uniform float uRes;
float waterFoam = 0.0;

// Bilinear terrain height from the float heightmap (manual filtering; float textures aren't always filterable).
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

float waterDepthHere() {
    vec2 inside = step(abs(vWaterPos.xz), vec2(uMapHalf));
    // Outside the map (ocean ring) use the vertex depth.
    return inside.x * inside.y > 0.5 ? vWaterPos.y - terrainHeightAt(vWaterPos.xz) : vWaterDepth;
}

vec3 waterSampleNormal(vec2 uv) {
    return texture2D(uNormalMap, uv).xyz * 2.0 - 1.0;
}
`;

const WATER_ALBEDO = /* glsl */ `
{
    float rawDepth = waterDepthHere();
    float depth = max(rawDepth, 0.0);
    float absorb = 1.0 - exp(-depth / max(uClarity, 0.1));
    vec3 col = mix(uShallow, uDeep, absorb);
    diffuseColor.rgb = col;

    // Shoreline foam: thin band where the water is shallow, broken up by the ripple texture.
    float foamNoise = texture2D(uNormalMap, vWaterPos.xz / 9.0 + vec2(uTime * 0.02, 0.0)).a;
    float shore = 1.0 - smoothstep(0.0, 0.55 + foamNoise * 0.5, depth);
    float speed = length(vWaterFlow);
    float rapids = smoothstep(0.55, 1.0, speed) * smoothstep(0.45, 0.8, foamNoise);
    waterFoam = clamp(shore * smoothstep(0.35, 0.75, foamNoise + shore * 0.4) + rapids * 0.6, 0.0, 1.0);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.95, 0.96), waterFoam * 0.85);

    // Transparent at the shore, increasingly opaque with depth.
    diffuseColor.a = clamp(0.35 + absorb * 0.65 + waterFoam * 0.5, 0.0, 1.0) * smoothstep(0.0, 0.15, rawDepth);
    if (diffuseColor.a < 0.003) discard;
}
`;

const WATER_NORMAL = /* glsl */ `
#include <normal_fragment_maps>
{
    vec2 flow = vWaterFlow * 1.6;
    float t = uTime * 0.35;
    float p0 = fract(t);
    float p1 = fract(t + 0.5);
    float blend = abs(p0 - 0.5) * 2.0;
    vec2 wind = vec2(0.012, 0.008) * (0.5 + uWind) * uTime;
    vec2 uv = vWaterPos.xz / 7.5;

    vec3 n0 = waterSampleNormal(uv - flow * p0 + wind);
    vec3 n1 = waterSampleNormal(uv - flow * p1 + wind + 0.37);
    vec3 nFlow = mix(n0, n1, blend);
    vec3 nBig = waterSampleNormal(vWaterPos.xz / 38.0 + wind * 0.4 - flow * 0.1);
    vec3 nFine = waterSampleNormal(vWaterPos.xz / 2.1 - wind * 1.7);
    vec3 n = normalize(vec3((nFlow.xy + nBig.xy * 0.8 + nFine.xy * 0.35) * (0.35 + uWind * 0.45), 1.0));
    n = normalize(mix(n, vec3(0.0, 0.0, 1.0), waterFoam * 0.6));

    vec3 worldN = normalize(vec3(n.x, n.z, n.y));
    normal = normalize((viewMatrix * vec4(worldN, 0.0)).xyz);
}
`;

const WATER_EMISSIVE = /* glsl */ `
#include <emissivemap_fragment>
{
    // Cheap subsurface glow on shallow water so it doesn't read as flat paint.
    float depth = max(waterDepthHere(), 0.0);
    totalEmissiveRadiance += uShallow * 0.06 * exp(-depth / (uClarity * 0.5));
}
`;
