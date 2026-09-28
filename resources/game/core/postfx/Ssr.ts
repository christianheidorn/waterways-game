import * as THREE from 'three';
import type { Blitter, FrameUniforms } from './common';
import {
    colorTarget,
    FRAME_UNIFORMS,
    fullscreenMaterial,
    scaledSize,
} from './common';

export type SsrQuality = 'low' | 'high';

const QUALITY: Record<
    SsrQuality,
    { scale: number; steps: number; refine: number }
> = {
    low: { scale: 0.5, steps: 24, refine: 4 },
    high: { scale: 1, steps: 48, refine: 6 },
};

/** Live uniforms of the terrain material (world/TerrainMaterial) the gloss mask mirrors. */
export type TerrainSurface = Record<string, THREE.IUniform>;

/**
 * Screen-space reflections for wet ground (half or full resolution).
 *
 * There is no G-buffer, so the reflective mask is reconstructed: normals from depth, plus the terrain
 * material's own wetness inputs (shore wetness texture, rain wetness and the same puddle noise the
 * terrain shader uses), restricted to flat, locally planar surfaces (grass and foliage are not planar
 * in depth). Water keeps its planar reflections: pixels where the scene is nearer than the water
 * pre-pass (which hides the water) are water and excluded.
 *
 * The ray march runs in view space with growing steps and a binary refinement; hits fade at screen
 * edges, with distance and for rays facing the camera. Output: premultiplied reflection (rgb) and its
 * weight (Fresnel × gloss × confidence) in alpha.
 */
const SsrShader = /* glsl */ `
    ${FRAME_UNIFORMS}
    uniform sampler2D tColor;
    uniform sampler2D tWaterDepth;
    uniform float uHasWater;
    uniform sampler2D uWet;
    uniform sampler2D uNoise;
    uniform float uMapHalf;
    uniform float uCell;
    uniform float uRes;
    uniform float uWeatherWet;
    uniform float uIntensity;
    varying vec2 vUv;

    float glossMask(vec3 world, vec3 nWorld) {
        vec2 wp = world.xz;
        vec2 splatUv = ((wp + uMapHalf) / uCell + 0.5) / uRes;
        float inside = step(0.0, splatUv.x) * step(splatUv.x, 1.0) * step(0.0, splatUv.y) * step(splatUv.y, 1.0);
        float wet = texture2D(uWet, splatUv).r * inside;
        float gloss = wet * 0.8;

        if (uWeatherWet > 0.001) {
            vec4 macro = texture2D(uNoise, wp / 420.0);
            vec4 macro2 = texture2D(uNoise, wp / 97.0);
            float gw = uWeatherWet;
            float flatness = smoothstep(0.93, 0.99, nWorld.y);
            float hollow = (1.0 - macro2.b) * 0.55 + (1.0 - macro.g) * 0.45;
            float puddle = smoothstep(0.76 - gw * 0.14, 0.82 - gw * 0.14, hollow) * flatness * smoothstep(0.3, 0.8, gw) * 0.85;
            gloss = max(gloss, puddle) + gw * 0.1;
        }

        return gloss * smoothstep(0.75, 0.92, nWorld.y);
    }

    void main() {
        float d = rawDepth(vUv);

        if (isSky(d)) {
            gl_FragColor = vec4(0.0);
            return;
        }

        float z = linearizeDepth(d);

        // Water has its own planar reflection: exclude it (it is missing from the water pre-pass depth).
        if (uHasWater > 0.5) {
            float wz = linearizeDepth(texture2D(tWaterDepth, vUv).x);

            if (wz > z * 1.01 + 0.05) {
                gl_FragColor = vec4(0.0);
                return;
            }
        }

        vec3 p = viewPosition(vUv, d);
        vec3 n = viewNormal(vUv, p);
        vec3 world = (uViewInv * vec4(p, 1.0)).xyz;
        vec3 nWorld = normalize((uViewInv * vec4(n, 0.0)).xyz);
        float gloss = glossMask(world, nWorld);

        // Planarity: the depth Laplacian of a flat surface is ~0; grass, foliage and edges are not.
        float zl = linearDepth(vUv - vec2(uTexel.x, 0.0));
        float zr = linearDepth(vUv + vec2(uTexel.x, 0.0));
        float zb = linearDepth(vUv - vec2(0.0, uTexel.y));
        float zt = linearDepth(vUv + vec2(0.0, uTexel.y));
        float lap = (abs(zl + zr - 2.0 * z) + abs(zb + zt - 2.0 * z)) / z;
        gloss *= 1.0 - smoothstep(0.002, 0.01, lap);

        vec3 v = normalize(p);
        float ndv = max(dot(n, -v), 0.0);
        float fresnel = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
        float weight = gloss * fresnel * uIntensity;

        if (weight < 0.004 || z > 600.0) {
            gl_FragColor = vec4(0.0);
            return;
        }

        vec3 r = normalize(reflect(v, n));
        // Rays towards the camera leave the depth buffer almost immediately.
        float facing = 1.0 - smoothstep(-0.1, 0.5, r.z);

        float maxDistance = clamp(z * 8.0, 40.0, 1500.0);
        float t = 0.0;
        float stepLength = maxDistance / float(STEPS * STEPS) * 2.0 * (0.5 + ign(gl_FragCoord.xy));
        vec3 prev = p;
        vec3 hit = vec3(0.0);
        vec2 hitUv = vec2(-1.0);
        bool found = false;

        for (int i = 0; i < STEPS; i++) {
            t += stepLength * float(i + 1);
            vec3 q = p + r * t;

            if (q.z > -uNear) {
                break;
            }

            vec2 uv = viewToUv(q);

            if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) {
                break;
            }

            float sceneZ = linearDepth(uv);
            float delta = -q.z - sceneZ;
            float thickness = max(0.3, stepLength * float(i + 1) * 1.5 + sceneZ * 0.02);

            if (delta > 0.0 && delta < thickness) {
                // Binary refinement between the last miss and this hit.
                vec3 a = prev;
                vec3 b = q;

                for (int k = 0; k < REFINE; k++) {
                    vec3 m = 0.5 * (a + b);
                    vec2 muv = viewToUv(m);

                    if (-m.z - linearDepth(muv) > 0.0) {
                        b = m;
                    } else {
                        a = m;
                    }
                }

                hit = b;
                hitUv = viewToUv(b);
                found = true;
                break;
            }

            prev = q;
        }

        if (!found || isSky(rawDepth(hitUv))) {
            gl_FragColor = vec4(0.0);
            return;
        }

        vec2 edge = smoothstep(vec2(0.0), vec2(0.08), hitUv) * (1.0 - smoothstep(vec2(0.92), vec2(1.0), hitUv));
        float travelled = length(hit - p);
        float confidence = edge.x * edge.y * facing * (1.0 - smoothstep(0.6, 1.0, travelled / maxDistance));
        float w = clamp(weight * confidence, 0.0, 1.0);
        vec3 c = texture2D(tColor, hitUv).rgb;
        gl_FragColor = vec4(c * w, w);
    }
`;

export class Ssr {
    private readonly target: THREE.WebGLRenderTarget;
    private readonly material: THREE.ShaderMaterial;
    private readonly settings: (typeof QUALITY)[SsrQuality];

    constructor(
        readonly quality: SsrQuality,
        uniforms: FrameUniforms,
        private readonly blitter: Blitter,
        width: number,
        height: number,
    ) {
        this.settings = QUALITY[quality];
        this.target = colorTarget(
            scaledSize(width, this.settings.scale),
            scaledSize(height, this.settings.scale),
        );
        const blank = new THREE.DataTexture(
            new Uint8Array([0, 0, 0, 255]),
            1,
            1,
        );
        blank.needsUpdate = true;
        this.material = fullscreenMaterial({
            name: 'WaterwaysSSR',
            uniforms: {
                ...uniforms,
                tColor: { value: null },
                tWaterDepth: { value: null },
                uHasWater: { value: 0 },
                uWet: { value: blank },
                uNoise: { value: blank },
                uMapHalf: { value: 1 },
                uCell: { value: 1 },
                uRes: { value: 1 },
                uWeatherWet: { value: 0 },
                uIntensity: { value: 1 },
            },
            defines: {
                STEPS: this.settings.steps,
                REFINE: this.settings.refine,
            },
            fragmentShader: SsrShader,
        });
    }

    get texture(): THREE.Texture {
        return this.target.texture;
    }

    /** Links the terrain material uniforms (shared objects, so they stay live). */
    setSurface(surface: TerrainSurface | null): void {
        const u = this.material.uniforms;

        for (const key of [
            'uWet',
            'uNoise',
            'uMapHalf',
            'uCell',
            'uRes',
            'uWeatherWet',
        ]) {
            if (surface?.[key]) {
                u[key] = surface[key];
            }
        }

        this.material.needsUpdate = true;
    }

    setSize(width: number, height: number): void {
        this.target.setSize(
            scaledSize(width, this.settings.scale),
            scaledSize(height, this.settings.scale),
        );
    }

    render(sceneColor: THREE.Texture, waterDepth: THREE.Texture | null): void {
        const u = this.material.uniforms;
        u.tColor.value = sceneColor;
        u.tWaterDepth.value = waterDepth;
        u.uHasWater.value = waterDepth ? 1 : 0;
        this.blitter.draw(this.material, this.target);
    }

    dispose(): void {
        this.target.dispose();
        this.material.dispose();
    }
}
