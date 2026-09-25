import * as THREE from 'three';
import type { TerrainLayer } from '../shared/types';
import { SimplexNoise } from '../util/noise';
import type { SplatMap } from './SplatMap';

const LAYER_TEX_SIZE = 512;

export type BrushOverlay = {
    x: number;
    z: number;
    radius: number;
    falloff: number;
    visible: boolean;
    color: THREE.Color;
};

/**
 * PBR terrain material: MeshStandardMaterial extended with 8-layer splat blending (height-aware),
 * procedural detail or uploaded albedo textures per layer, bump detail and an editor brush overlay.
 */
export class TerrainMaterial extends THREE.MeshStandardMaterial {
    readonly uniforms: Record<string, THREE.IUniform>;
    private layerTexture: THREE.DataArrayTexture;
    private layerTexData: Uint8Array;
    private layerTexUrls: (string | null)[] = Array.from(
        { length: 8 },
        () => null,
    );

    constructor(splat: SplatMap, size: number, resolution: number) {
        super({ roughness: 1, metalness: 0, envMapIntensity: 0.45 });

        this.layerTexData = new Uint8Array(
            LAYER_TEX_SIZE * LAYER_TEX_SIZE * 4 * 8,
        );
        this.layerTexture = new THREE.DataArrayTexture(
            this.layerTexData,
            LAYER_TEX_SIZE,
            LAYER_TEX_SIZE,
            8,
        );
        this.layerTexture.wrapS = this.layerTexture.wrapT =
            THREE.RepeatWrapping;
        this.layerTexture.minFilter = THREE.LinearMipmapLinearFilter;
        this.layerTexture.magFilter = THREE.LinearFilter;
        this.layerTexture.generateMipmaps = true;
        this.layerTexture.colorSpace = THREE.SRGBColorSpace;
        this.layerTexture.anisotropy = 8;
        this.layerTexture.needsUpdate = true;

        this.uniforms = {
            uSplat0: { value: splat.textures[0] },
            uSplat1: { value: splat.textures[1] },
            uNoise: { value: createNoiseTexture() },
            uLayerTex: { value: this.layerTexture },
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
            // x: has texture, y: texture scale (m), z: slot enabled
            uTexParams: {
                value: Array.from(
                    { length: 8 },
                    () => new THREE.Vector3(0, 4, 0),
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
                    '#include <common>\nvarying vec3 vTerrainPos;',
                )
                .replace(
                    '#include <begin_vertex>',
                    '#include <begin_vertex>\nvTerrainPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
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
                .replace('#include <emissivemap_fragment>', FRAGMENT_OVERLAY);
        };

        this.customProgramCacheKey = () => 'waterways-terrain-v1';
    }

    setLayers(layers: TerrainLayer[]): void {
        const colorA = this.uniforms.uColorA.value as THREE.Color[];
        const colorB = this.uniforms.uColorB.value as THREE.Color[];
        const params = this.uniforms.uParams.value as THREE.Vector4[];
        const tex = this.uniforms.uTexParams.value as THREE.Vector3[];

        for (let i = 0; i < 8; i++) {
            tex[i].z = 0;
        }

        for (const layer of layers) {
            const i = layer.slot;
            colorA[i].set(layer.color);
            colorB[i].set(layer.color_secondary);
            params[i].set(
                Math.max(0.1, layer.noise_scale),
                layer.variation,
                layer.roughness,
                layer.bump,
            );
            tex[i].y = Math.max(0.1, layer.texture_scale);
            tex[i].z = 1;

            if (layer.texture_url !== this.layerTexUrls[i]) {
                this.layerTexUrls[i] = layer.texture_url;
                tex[i].x = 0;

                if (layer.texture_url) {
                    void this.loadLayerTexture(i, layer.texture_url);
                }
            } else {
                tex[i].x = layer.texture_url ? tex[i].x : 0;
            }
        }
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

    private async loadLayerTexture(slot: number, url: string): Promise<void> {
        const image = await new THREE.ImageLoader()
            .loadAsync(url)
            .catch(() => null);

        if (!image || this.layerTexUrls[slot] !== url) {
            return;
        }

        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = LAYER_TEX_SIZE;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });

        if (!ctx) {
            return;
        }

        ctx.drawImage(image, 0, 0, LAYER_TEX_SIZE, LAYER_TEX_SIZE);
        const pixels = ctx.getImageData(
            0,
            0,
            LAYER_TEX_SIZE,
            LAYER_TEX_SIZE,
        ).data;
        this.layerTexData.set(
            pixels,
            slot * LAYER_TEX_SIZE * LAYER_TEX_SIZE * 4,
        );
        this.layerTexture.addLayerUpdate(slot);
        this.layerTexture.needsUpdate = true;
        (this.uniforms.uTexParams.value as THREE.Vector3[])[slot].x = 1;
    }

    override dispose(): void {
        (this.uniforms.uNoise.value as THREE.Texture).dispose();
        this.layerTexture.dispose();
        super.dispose();
    }
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
uniform sampler2D uSplat0;
uniform sampler2D uSplat1;
uniform sampler2D uNoise;
uniform highp sampler2DArray uLayerTex;
uniform float uMapHalf;
uniform float uCell;
uniform float uRes;
uniform vec3 uColorA[8];
uniform vec3 uColorB[8];
uniform vec4 uParams[8];
uniform vec3 uTexParams[8];
uniform vec4 uBrush;
uniform float uBrushVisible;
uniform vec3 uBrushColor;
uniform float uGridVisible;

float terrainRoughness = 1.0;
float terrainHeight = 0.0;

vec3 perturbNormalTerrain(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDir) {
    vec3 vSigmaX = normalize(dFdx(surf_pos.xyz));
    vec3 vSigmaY = normalize(dFdy(surf_pos.xyz));
    vec3 R1 = cross(vSigmaY, surf_norm);
    vec3 R2 = cross(surf_norm, vSigmaX);
    float fDet = dot(vSigmaX, R1) * faceDir;
    vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
    return normalize(abs(fDet) * surf_norm - vGrad);
}
`;

const FRAGMENT_ALBEDO = /* glsl */ `
{
    vec2 wp = vTerrainPos.xz;
    vec2 splatUv = ((wp + uMapHalf) / uCell + 0.5) / uRes;
    vec4 s0 = texture2D(uSplat0, splatUv);
    vec4 s1 = texture2D(uSplat1, splatUv);
    float w[8];
    w[0] = s0.r; w[1] = s0.g; w[2] = s0.b; w[3] = s0.a;
    w[4] = s1.r; w[5] = s1.g; w[6] = s1.b; w[7] = s1.a;

    // Macro variation breaks up repetition at a distance.
    vec4 macro = texture2D(uNoise, wp / 420.0);
    vec4 macro2 = texture2D(uNoise, wp / 97.0);

    // Per-layer "height" from noise for height-based blending (sharper, natural transitions).
    float hts[8];
    float best = -1.0;
    for (int i = 0; i < 8; i++) {
        float enabled = uTexParams[i].z;
        w[i] *= enabled;
        vec4 n = texture2D(uNoise, wp / uParams[i].x);
        hts[i] = n.r * 0.6 + n.g * 0.4;
        best = max(best, w[i] + hts[i] * 0.45);
    }

    float total = 0.0;
    for (int i = 0; i < 8; i++) {
        float b = max(w[i] + hts[i] * 0.45 - best + 0.2, 0.0) * step(0.002, w[i]);
        w[i] = b;
        total += b;
    }

    if (total < 1e-4) {
        w[0] = 1.0;
        total = 1.0;
    }

    vec3 albedo = vec3(0.0);
    float rough = 0.0;
    float bumpH = 0.0;

    for (int i = 0; i < 8; i++) {
        float wi = w[i] / total;
        if (wi <= 0.0) continue;

        vec4 n = texture2D(uNoise, wp / uParams[i].x);
        vec4 nFine = texture2D(uNoise, wp / (uParams[i].x * 0.23));
        float t = clamp((n.b * 0.65 + nFine.r * 0.35 - 0.5) * (1.0 + uParams[i].y * 3.0) + 0.5, 0.0, 1.0);
        vec3 c = mix(uColorA[i], uColorB[i], smoothstep(0.2, 0.8, t) * uParams[i].y + (1.0 - uParams[i].y) * 0.25);

        if (uTexParams[i].x > 0.5) {
            vec3 texel = texture(uLayerTex, vec3(wp / uTexParams[i].y, float(i))).rgb;
            vec3 texel2 = texture(uLayerTex, vec3(wp / (uTexParams[i].y * 3.7) + 0.37, float(i))).rgb;
            c = mix(texel, texel2, 0.35) * mix(vec3(1.0), uColorA[i] * 2.0, 0.15);
        }

        c *= 0.92 + nFine.g * 0.16;
        albedo += c * wi;
        rough += uParams[i].z * wi;
        bumpH += (nFine.a * 0.6 + n.g * 0.4) * uParams[i].w * wi;
    }

    albedo *= 0.88 + macro.r * 0.2 + (macro2.g - 0.5) * 0.08;
    diffuseColor.rgb *= albedo;
    terrainRoughness = clamp(rough, 0.04, 1.0);
    terrainHeight = bumpH;
}
`;

const FRAGMENT_NORMAL = /* glsl */ `
#include <normal_fragment_maps>
{
    // Fade bump detail with distance to avoid shimmering moiré far away.
    float bumpFade = 1.0 - smoothstep(40.0, 260.0, length(vViewPosition));
    vec2 dH = vec2(dFdx(terrainHeight), dFdy(terrainHeight)) * 0.22 * bumpFade;
    normal = perturbNormalTerrain(-vViewPosition, normal, dH, faceDirection);
}
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
