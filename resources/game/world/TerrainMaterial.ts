import * as THREE from 'three';
import type { TerrainLayer, TerrainMaterialRef } from '../shared/types';
import { SimplexNoise } from '../util/noise';
import type { SplatMap } from './SplatMap';
import { TERRAIN_SLOTS, TerrainTextures } from './TerrainTextures';

export type BrushOverlay = {
    x: number;
    z: number;
    radius: number;
    falloff: number;
    visible: boolean;
    color: THREE.Color;
};

/**
 * PBR terrain material: MeshStandardMaterial extended with
 *
 * - 8-layer splat blending with height-based transitions,
 * - per-layer PBR materials from the studio library (albedo, normal, roughness, AO, height)
 *   packed into texture arrays, sampled with anti-tiling (randomised offsets per noise cell),
 *   triplanar projection on steep slopes and a far-distance detail blend,
 * - procedural colour/noise shading for layers without a material,
 * - wet ground near water (darker, glossier), an editor brush overlay and grid.
 */
export class TerrainMaterial extends THREE.MeshStandardMaterial {
    readonly uniforms: Record<string, THREE.IUniform>;
    private textures: TerrainTextures;
    private layers: TerrainLayer[] = [];

    constructor(
        splat: SplatMap,
        size: number,
        resolution: number,
        textureSize = 1024,
    ) {
        super({ roughness: 1, metalness: 0, envMapIntensity: 0.45 });

        this.textures = this.createTextures(textureSize);
        const blankWet = new THREE.DataTexture(
            new Uint8Array([0]),
            1,
            1,
            THREE.RedFormat,
        );
        blankWet.needsUpdate = true;

        this.uniforms = {
            uSplat0: { value: splat.textures[0] },
            uSplat1: { value: splat.textures[1] },
            uNoise: { value: createNoiseTexture() },
            uAlbedoArr: { value: this.textures.albedoRough },
            uDetailArr: { value: this.textures.normalAoHeight },
            uWet: { value: blankWet },
            uMapHalf: { value: size / 2 },
            uCell: { value: size / (resolution - 1) },
            uRes: { value: resolution },
            uColorA: {
                value: Array.from({ length: 8 }, () => new THREE.Color()),
            },
            uColorB: {
                value: Array.from({ length: 8 }, () => new THREE.Color()),
            },
            // x: noise scale (m), y: variation, z: roughness, w: bump
            uParams: {
                value: Array.from(
                    { length: 8 },
                    () => new THREE.Vector4(8, 0.5, 0.9, 0.5),
                ),
            },
            // x: slot enabled, y: has material, z: tile size (m), w: height contrast
            uMat: {
                value: Array.from(
                    { length: 8 },
                    () => new THREE.Vector4(0, 0, 4, 1),
                ),
            },
            // x: roughness scale, y: normal strength, z: macro variation, w: unused
            uMat2: {
                value: Array.from(
                    { length: 8 },
                    () => new THREE.Vector4(1, 1, 0.5, 0),
                ),
            },
            uTint: {
                value: Array.from(
                    { length: 8 },
                    () => new THREE.Color(1, 1, 1),
                ),
            },
            uBrush: { value: new THREE.Vector4(0, 0, 0, 0.5) },
            uBrushVisible: { value: 0 },
            uBrushColor: { value: new THREE.Color(0.25, 0.75, 1) },
            uGridVisible: { value: 0 },
        };

        this.onBeforeCompile = (shader) => {
            Object.assign(shader.uniforms, this.uniforms);
            shader.vertexShader = shader.vertexShader
                .replace(
                    '#include <common>',
                    '#include <common>\nvarying vec3 vTerrainPos;\nvarying vec3 vTerrainNormal;',
                )
                .replace(
                    '#include <begin_vertex>',
                    '#include <begin_vertex>\nvTerrainPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvTerrainNormal = normalize(mat3(modelMatrix) * objectNormal);',
                );
            shader.fragmentShader = shader.fragmentShader
                .replace(
                    '#include <common>',
                    `#include <common>\n${FRAGMENT_PARS}`,
                )
                .replace('#include <map_fragment>', FRAGMENT_ALBEDO)
                .replace(
                    '#include <roughnessmap_fragment>',
                    'float roughnessFactor = terrainRoughness;',
                )
                .replace('#include <normal_fragment_maps>', FRAGMENT_NORMAL)
                .replace('#include <aomap_fragment>', FRAGMENT_AO)
                .replace('#include <emissivemap_fragment>', FRAGMENT_OVERLAY);
        };

        this.customProgramCacheKey = () => 'waterways-terrain-v2';
    }

    get textureSize(): number {
        return this.textures.size;
    }

    /** Change the resolution of the material texture arrays (reloads all materials). */
    setTextureSize(size: number): void {
        if (size === this.textures.size) {
            return;
        }

        this.textures.dispose();
        this.textures = this.createTextures(size);
        this.uniforms.uAlbedoArr.value = this.textures.albedoRough;
        this.uniforms.uDetailArr.value = this.textures.normalAoHeight;
        this.setLayers(this.layers);
    }

    setLayers(layers: TerrainLayer[]): void {
        this.layers = layers;
        const colorA = this.uniforms.uColorA.value as THREE.Color[];
        const colorB = this.uniforms.uColorB.value as THREE.Color[];
        const params = this.uniforms.uParams.value as THREE.Vector4[];
        const mat = this.uniforms.uMat.value as THREE.Vector4[];
        const mat2 = this.uniforms.uMat2.value as THREE.Vector4[];
        const tint = this.uniforms.uTint.value as THREE.Color[];
        const used = new Set<number>();

        for (let i = 0; i < TERRAIN_SLOTS; i++) {
            mat[i].x = 0;
        }

        for (const layer of layers) {
            const i = layer.slot;
            used.add(i);
            colorA[i].set(layer.color);
            colorB[i].set(layer.color_secondary);
            params[i].set(
                Math.max(0.1, layer.noise_scale),
                layer.variation,
                layer.roughness,
                layer.bump,
            );

            const ref = layerMaterial(layer);
            const tile = Math.max(
                0.05,
                layer.texture_scale || ref?.tile_size || 4,
            );
            mat[i].set(
                1,
                this.textures.isReady(i) && ref ? 1 : 0,
                tile,
                ref?.height_contrast ?? 1,
            );
            mat2[i].set(
                (layer.roughness_scale ?? 1) * (ref?.roughness_scale ?? 1),
                (layer.normal_strength ?? 1) * (ref?.normal_strength ?? 1),
                layer.variation,
                0,
            );
            tint[i]
                .set(layer.tint ?? '#ffffff')
                .multiply(new THREE.Color(ref?.tint ?? '#ffffff'));

            void this.textures.load(i, ref, layer.roughness);
        }

        for (let i = 0; i < TERRAIN_SLOTS; i++) {
            if (!used.has(i)) {
                this.textures.clear(i);
            }
        }
    }

    /** Wetness mask (R8, same grid as the splat map): 1 = soaked ground next to water. */
    setWetness(texture: THREE.Texture): void {
        this.uniforms.uWet.value = texture;
    }

    setBrush(brush: BrushOverlay): void {
        (this.uniforms.uBrush.value as THREE.Vector4).set(
            brush.x,
            brush.z,
            brush.radius,
            brush.falloff,
        );
        this.uniforms.uBrushVisible.value = brush.visible ? 1 : 0;
        (this.uniforms.uBrushColor.value as THREE.Color).copy(brush.color);
    }

    hideBrush(): void {
        this.uniforms.uBrushVisible.value = 0;
    }

    setGridVisible(visible: boolean): void {
        this.uniforms.uGridVisible.value = visible ? 1 : 0;
    }

    override dispose(): void {
        (this.uniforms.uNoise.value as THREE.Texture).dispose();
        this.textures.dispose();
        super.dispose();
    }

    private createTextures(size: number): TerrainTextures {
        const textures = new TerrainTextures(size);
        textures.onSlotReady = (slot, ready) => {
            const mat = this.uniforms?.uMat.value as
                | THREE.Vector4[]
                | undefined;

            if (mat) {
                mat[slot].y = ready ? 1 : 0;
            }
        };

        return textures;
    }
}

/** The material a layer renders with: its library material, or its legacy uploaded albedo. */
function layerMaterial(layer: TerrainLayer): TerrainMaterialRef | null {
    if (layer.material?.maps.albedo) {
        return layer.material;
    }

    if (layer.texture_url) {
        return {
            id: -1,
            name: layer.name,
            maps: {
                albedo: layer.texture_url,
                normal: null,
                roughness: null,
                ao: null,
                height: null,
            },
            tile_size: layer.texture_scale,
            tint: '#ffffff',
            roughness_scale: 1,
            normal_strength: 1,
            height_contrast: 1,
        };
    }

    return null;
}

/** Tiling multi-octave noise texture: R/G/B/A = four independent tileable noise fields. */
function createNoiseTexture(): THREE.DataTexture {
    const size = 256;
    const data = new Uint8Array(size * size * 4);
    const fields = [
        new SimplexNoise(11),
        new SimplexNoise(23),
        new SimplexNoise(37),
        new SimplexNoise(51),
    ];
    const freqs = [4, 8, 16, 2];

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            // Map onto a torus so the texture tiles seamlessly.
            const a = (x / size) * Math.PI * 2;
            const b = (y / size) * Math.PI * 2;

            for (let c = 0; c < 4; c++) {
                const f = freqs[c] / (Math.PI * 2);
                const nx = Math.cos(a) * f;
                const ny = Math.sin(a) * f;
                const nz = Math.cos(b) * f;
                const nw = Math.sin(b) * f;
                // 4D torus embedding approximated with two 2D lookups.
                const n =
                    fields[c].fbm(nx * 3 + nz * 1.7, ny * 3 + nw * 1.7, 4) *
                        0.6 +
                    fields[c].noise2D(nz * 5 + 11.3, nw * 5 - 7.1) * 0.4;
                data[(y * size + x) * 4 + c] = Math.max(
                    0,
                    Math.min(255, Math.round((n * 0.5 + 0.5) * 255)),
                );
            }
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

const FRAGMENT_PARS = /* glsl */ `
varying vec3 vTerrainPos;
varying vec3 vTerrainNormal;
uniform sampler2D uSplat0;
uniform sampler2D uSplat1;
uniform sampler2D uNoise;
uniform sampler2D uWet;
uniform highp sampler2DArray uAlbedoArr;
uniform highp sampler2DArray uDetailArr;
uniform float uMapHalf;
uniform float uCell;
uniform float uRes;
uniform vec3 uColorA[8];
uniform vec3 uColorB[8];
uniform vec4 uParams[8];
uniform vec4 uMat[8];
uniform vec4 uMat2[8];
uniform vec3 uTint[8];
uniform vec4 uBrush;
uniform float uBrushVisible;
uniform vec3 uBrushColor;
uniform float uGridVisible;

float terrainRoughness = 1.0;
float terrainBump = 0.0;       // procedural bump height (layers without material)
float terrainAO = 1.0;
vec3 terrainWorldNormal = vec3(0.0, 1.0, 0.0);

vec3 perturbNormalTerrain(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDir) {
    vec3 vSigmaX = normalize(dFdx(surf_pos.xyz));
    vec3 vSigmaY = normalize(dFdy(surf_pos.xyz));
    vec3 R1 = cross(vSigmaY, surf_norm);
    vec3 R2 = cross(surf_norm, vSigmaX);
    float fDet = dot(vSigmaX, R1) * faceDir;
    vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
    return normalize(abs(fDet) * surf_norm - vGrad);
}

// Anti-tiling: two lookups with per-cell random offsets, cross-faded by a low-frequency noise
// (after Inigo Quilez, "texture repetition", technique 3). Samples albedo+rough and detail with
// the same blend so the maps stay consistent.
void sampleLayer(vec2 uv, float layer, vec2 ddx, vec2 ddy, float k, out vec4 albedoRough, out vec4 detail) {
    float l = k * 8.0;
    float f = fract(l);
    float ia = floor(l);
    float ib = ia + 1.0;
    vec2 oa = sin(vec2(3.0, 7.0) * ia);
    vec2 ob = sin(vec2(3.0, 7.0) * ib);
    vec4 a1 = textureGrad(uAlbedoArr, vec3(uv + oa, layer), ddx, ddy);
    vec4 b1 = textureGrad(uAlbedoArr, vec3(uv + ob, layer), ddx, ddy);
    vec4 a2 = textureGrad(uDetailArr, vec3(uv + oa, layer), ddx, ddy);
    vec4 b2 = textureGrad(uDetailArr, vec3(uv + ob, layer), ddx, ddy);
    float t = smoothstep(0.2, 0.8, f - 0.1 * dot(a1.rgb - b1.rgb, vec3(1.0)));
    albedoRough = mix(a1, b1, t);
    detail = mix(a2, b2, t);
}

// Tangent-space normal from the packed detail map (OpenGL convention; v grows southwards on the
// ground so green is flipped), scaled by strength.
vec3 unpackNormal(vec4 detail, float strength) {
    vec2 xy = (detail.rg * 2.0 - 1.0) * strength;
    xy.y = -xy.y;
    return vec3(xy, sqrt(max(1.0 - dot(xy, xy), 0.05)));
}
`;

const FRAGMENT_ALBEDO = /* glsl */ `
{
    vec3 wpos = vTerrainPos;
    vec2 wp = wpos.xz;
    vec3 N = normalize(vTerrainNormal);
    vec2 splatUv = ((wp + uMapHalf) / uCell + 0.5) / uRes;
    vec4 s0 = texture2D(uSplat0, splatUv);
    vec4 s1 = texture2D(uSplat1, splatUv);
    float w[8];
    w[0] = s0.r; w[1] = s0.g; w[2] = s0.b; w[3] = s0.a;
    w[4] = s1.r; w[5] = s1.g; w[6] = s1.b; w[7] = s1.a;

    float dist = length(vViewPosition);
    vec4 macro = texture2D(uNoise, wp / 420.0);
    vec4 macro2 = texture2D(uNoise, wp / 97.0);
    float tileNoise = texture2D(uNoise, wp / 61.0).a;

    // Triplanar weights for steep ground (cliffs); flat ground only uses the top projection.
    vec3 tw = pow(abs(N), vec3(4.0));
    tw /= (tw.x + tw.y + tw.z);
    bool steep = tw.y < 0.97;
    vec3 axisSign = sign(N);

    // Screen-space derivatives of world position (for mip selection with textureGrad).
    vec3 dpx = dFdx(wpos);
    vec3 dpy = dFdy(wpos);

    // ---- pass 1: sample every active layer
    vec3 lAlbedo[8];
    vec3 lNormal[8];
    float lRough[8];
    float lAO[8];
    float lHeight[8];
    float farFade = smoothstep(35.0, 220.0, dist);
    float normalFade = 1.0 - 0.75 * smoothstep(60.0, 450.0, dist);

    for (int i = 0; i < 8; i++) {
        w[i] *= uMat[i].x;
        lAlbedo[i] = vec3(0.0);
        lNormal[i] = N;
        lRough[i] = 1.0;
        lAO[i] = 1.0;
        lHeight[i] = 0.5;

        if (w[i] < 0.004) continue;

        if (uMat[i].y > 0.5) {
            float tile = uMat[i].z;
            float li = float(i);
            vec4 ar;
            vec4 dt;
            vec2 uvT = wp / tile;
            sampleLayer(uvT, li, dpx.xz / tile, dpy.xz / tile, tileNoise, ar, dt);

            // Far away, blend with a 4× larger lookup to break visible repetition.
            vec4 farAR = textureGrad(uAlbedoArr, vec3(uvT * 0.23 + 0.31, li), dpx.xz / tile * 0.23, dpy.xz / tile * 0.23);
            ar.rgb = mix(ar.rgb, mix(ar.rgb, farAR.rgb, 0.5), farFade);

            float strength = uMat2[i].y * normalFade;
            vec3 tnY = unpackNormal(dt, strength);
            vec3 albedo = ar.rgb;
            float rough = ar.a;
            float ao = dt.b;
            float h = dt.a;
            // Whiteout-blended triplanar normal (Ben Golus); top projection only on flat ground.
            vec3 nY = vec3(tnY.x + N.x, abs(tnY.z) * N.y, tnY.y + N.z);
            vec3 nSum = nY * tw.y;

            if (steep) {
                vec2 uvX = vec2(wpos.z * axisSign.x, -wpos.y) / tile;
                vec2 uvZ = vec2(-wpos.x * axisSign.z, -wpos.y) / tile;
                vec2 gxX = vec2(dpx.z * axisSign.x, -dpx.y) / tile;
                vec2 gyX = vec2(dpy.z * axisSign.x, -dpy.y) / tile;
                vec2 gxZ = vec2(-dpx.x * axisSign.z, -dpx.y) / tile;
                vec2 gyZ = vec2(-dpy.x * axisSign.z, -dpy.y) / tile;
                vec4 arX = textureGrad(uAlbedoArr, vec3(uvX, li), gxX, gyX);
                vec4 dtX = textureGrad(uDetailArr, vec3(uvX, li), gxX, gyX);
                vec4 arZ = textureGrad(uAlbedoArr, vec3(uvZ, li), gxZ, gyZ);
                vec4 dtZ = textureGrad(uDetailArr, vec3(uvZ, li), gxZ, gyZ);
                vec3 tnX = unpackNormal(dtX, strength);
                vec3 tnZ = unpackNormal(dtZ, strength);
                tnX.x *= axisSign.x;
                tnZ.x *= -axisSign.z;
                vec3 nX = vec3(abs(tnX.z) * N.x, -tnX.y + N.y, tnX.x + N.z);
                vec3 nZ = vec3(tnZ.x + N.x, -tnZ.y + N.y, abs(tnZ.z) * N.z);
                nSum += nX * tw.x + nZ * tw.z;
                albedo = albedo * tw.y + arX.rgb * tw.x + arZ.rgb * tw.z;
                rough = rough * tw.y + arX.a * tw.x + arZ.a * tw.z;
                ao = ao * tw.y + dtX.b * tw.x + dtZ.b * tw.z;
                h = h * tw.y + dtX.a * tw.x + dtZ.a * tw.z;
            }

            // Gentle macro variation so large areas don't look uniform.
            albedo *= 0.9 + (macro2.g - 0.5) * 0.25 * uMat2[i].z + macro.r * 0.12;
            lAlbedo[i] = albedo * uTint[i];
            lNormal[i] = normalize(nSum);
            lRough[i] = clamp(rough * uMat2[i].x, 0.03, 1.0);
            lAO[i] = ao;
            lHeight[i] = clamp((h - 0.5) * uMat[i].w + 0.5, 0.0, 1.0);
        } else {
            // Procedural fallback: two colours mixed by noise.
            vec4 n = texture2D(uNoise, wp / uParams[i].x);
            vec4 nFine = texture2D(uNoise, wp / (uParams[i].x * 0.23));
            float t = clamp((n.b * 0.65 + nFine.r * 0.35 - 0.5) * (1.0 + uParams[i].y * 3.0) + 0.5, 0.0, 1.0);
            vec3 c = mix(uColorA[i], uColorB[i], smoothstep(0.2, 0.8, t) * uParams[i].y + (1.0 - uParams[i].y) * 0.25);
            c *= 0.92 + nFine.g * 0.16;
            c *= 0.88 + macro.r * 0.2 + (macro2.g - 0.5) * 0.08;
            lAlbedo[i] = c;
            lRough[i] = uParams[i].z;
            lHeight[i] = n.r * 0.6 + n.g * 0.4;
            lAO[i] = 1.0;
        }
    }

    // ---- pass 2: height-based blend weights (sharp, natural transitions)
    float best = -1.0;
    for (int i = 0; i < 8; i++) {
        if (w[i] >= 0.004) best = max(best, w[i] + lHeight[i] * 0.5);
    }

    float total = 0.0;
    for (int i = 0; i < 8; i++) {
        float b = w[i] >= 0.004 ? max(w[i] + lHeight[i] * 0.5 - best + 0.18, 0.0) : 0.0;
        w[i] = b;
        total += b;
    }

    vec3 albedo = vec3(0.0);
    vec3 nrm = vec3(0.0);
    float rough = 0.0;
    float ao = 0.0;
    float bumpH = 0.0;

    if (total < 1e-4) {
        albedo = uColorA[0];
        nrm = N;
        rough = 0.9;
        ao = 1.0;
    } else {
        for (int i = 0; i < 8; i++) {
            float wi = w[i] / total;
            if (wi <= 0.0) continue;
            albedo += lAlbedo[i] * wi;
            nrm += lNormal[i] * wi;
            rough += lRough[i] * wi;
            ao += lAO[i] * wi;
            bumpH += (uMat[i].y > 0.5 ? 0.0 : lHeight[i] * uParams[i].w) * wi;
        }
    }

    // Wet ground along water: darker, glossier, smoother.
    float wet = texture2D(uWet, splatUv).r;
    albedo *= mix(1.0, 0.55, wet);
    rough = mix(rough, 0.12, wet * 0.85);
    nrm = normalize(mix(nrm, N, wet * 0.5));

    diffuseColor.rgb *= albedo;
    terrainRoughness = clamp(rough, 0.03, 1.0);
    terrainAO = mix(1.0, ao, 0.85);
    terrainBump = bumpH;
    terrainWorldNormal = normalize(nrm);
}
`;

const FRAGMENT_NORMAL = /* glsl */ `
#include <normal_fragment_maps>
{
    normal = normalize((viewMatrix * vec4(terrainWorldNormal, 0.0)).xyz);
    // Procedural bump for layers without a material; faded with distance to avoid moiré.
    float bumpFade = 1.0 - smoothstep(40.0, 260.0, length(vViewPosition));
    vec2 dH = vec2(dFdx(terrainBump), dFdy(terrainBump)) * 0.22 * bumpFade;
    normal = perturbNormalTerrain(-vViewPosition, normal, dH, faceDirection);
}
`;

const FRAGMENT_AO = /* glsl */ `
reflectedLight.indirectDiffuse *= terrainAO;
reflectedLight.indirectSpecular *= terrainAO;
`;

const FRAGMENT_OVERLAY = /* glsl */ `
#include <emissivemap_fragment>
if (uBrushVisible > 0.5) {
    float d = length(vTerrainPos.xz - uBrush.xy);
    float px = fwidth(d) * 1.5;
    float outer = 1.0 - smoothstep(0.0, px, abs(d - uBrush.z));
    float innerR = uBrush.z * (1.0 - uBrush.w);
    float inner = (1.0 - smoothstep(0.0, px, abs(d - innerR))) * 0.6;
    float fill = (1.0 - smoothstep(innerR, uBrush.z, d)) * step(d, uBrush.z) * 0.12;
    float dot_ = 1.0 - smoothstep(0.0, px * 2.0, d - px * 2.0);
    totalEmissiveRadiance += uBrushColor * (outer + inner + fill + dot_);
}
if (uGridVisible > 0.5) {
    vec2 g = abs(fract(vTerrainPos.xz / 100.0 - 0.5) - 0.5) / fwidth(vTerrainPos.xz / 100.0);
    float line = 1.0 - min(min(g.x, g.y), 1.0);
    totalEmissiveRadiance += vec3(0.6) * line * 0.25;
}
`;
