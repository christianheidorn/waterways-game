import * as THREE from 'three';
import { LUT_SIZE } from './ColorLut';
import { fullscreenMaterial, setDefine } from './common';

/**
 * The single display pass: everything between the HDR scene and the final anti-aliasing in one
 * full-screen draw (replaces three's OutputPass + a separate grading pass).
 *
 * Scene-referred (linear HDR): chromatic aberration (radial, per channel lookups), + bloom, + lens flare,
 * × eye adaptation, × white balance → tone mapping (renderer.toneMapping, exposure = base × 2^EV comp)
 * → sRGB. Display-referred: optional CAS-like sharpening (neighbours are tone mapped too), 3D LUT colour
 * grade blended by intensity, saturation / contrast, vignette, luma-weighted animated film grain,
 * letterbox bars, and ±½ LSB dither against banding in the 8-bit output.
 */
const OutputShader = /* glsl */ `
    precision highp sampler3D;
    uniform sampler2D tDiffuse;
    uniform sampler2D tBloom;
    uniform sampler2D tFlare;
    uniform sampler2D tExposure;
    uniform sampler3D tLut;
    uniform vec3 uWhiteBalance;
    uniform float uLutIntensity;
    uniform float saturation;
    uniform float contrast;
    uniform float vignette;
    uniform float sharpen;
    uniform float uAberration;
    uniform float uGrain;
    uniform vec2 uLetterbox;
    uniform vec2 texel;
    uniform float aspect;
    uniform float uFrame;
    varying vec2 vUv;

    #include <tonemapping_pars_fragment>

    float hash12(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
    }

    vec3 sceneAt(vec2 uv) {
        vec3 c;

        #if ABERRATION
            // Lateral chromatic aberration grows towards the edges (r pushed out, b pulled in).
            vec2 d = uv - 0.5;
            vec2 o = d * dot(d * vec2(aspect, 1.0), d * vec2(aspect, 1.0)) * uAberration * 0.014;
            c = vec3(
                texture2D(tDiffuse, uv - o).r,
                texture2D(tDiffuse, uv).g,
                texture2D(tDiffuse, uv + o).b
            );
            #if BLOOM
                c += vec3(texture2D(tBloom, uv - o).r, texture2D(tBloom, uv).g, texture2D(tBloom, uv + o).b);
            #endif
        #else
            c = texture2D(tDiffuse, uv).rgb;
            #if BLOOM
                c += texture2D(tBloom, uv).rgb;
            #endif
        #endif

        #if FLARE
            c += texture2D(tFlare, uv).rgb;
        #endif

        return c;
    }

    vec3 display(vec3 hdr, float exposure) {
        vec3 c = max(hdr, vec3(0.0)) * exposure * uWhiteBalance;

        #if defined( LINEAR_TONE_MAPPING )
            c = LinearToneMapping(c);
        #elif defined( REINHARD_TONE_MAPPING )
            c = ReinhardToneMapping(c);
        #elif defined( CINEON_TONE_MAPPING )
            c = CineonToneMapping(c);
        #elif defined( ACES_FILMIC_TONE_MAPPING )
            c = ACESFilmicToneMapping(c);
        #elif defined( AGX_TONE_MAPPING )
            c = AgXToneMapping(c);
        #elif defined( NEUTRAL_TONE_MAPPING )
            c = NeutralToneMapping(c);
        #endif

        #ifdef SRGB_TRANSFER
            c = sRGBTransferOETF(vec4(c, 1.0)).rgb;
        #endif

        return clamp(c, 0.0, 1.0);
    }

    void main() {
        #if AUTO_EXPOSURE
            float exposure = texture2D(tExposure, vec2(0.5)).r;
        #else
            float exposure = 1.0;
        #endif

        vec3 col = display(sceneAt(vUv), exposure);

        #if SHARPEN
            vec3 n = display(texture2D(tDiffuse, vUv + vec2(0.0, texel.y)).rgb, exposure);
            vec3 s = display(texture2D(tDiffuse, vUv - vec2(0.0, texel.y)).rgb, exposure);
            vec3 e = display(texture2D(tDiffuse, vUv + vec2(texel.x, 0.0)).rgb, exposure);
            vec3 w = display(texture2D(tDiffuse, vUv - vec2(texel.x, 0.0)).rgb, exposure);
            vec3 lo = min(col, min(min(n, s), min(e, w)));
            vec3 hi = max(col, max(max(n, s), max(e, w)));
            vec3 blur = (n + s + e + w) * 0.25;
            col = clamp(col + (col - blur) * sharpen * 2.5, lo, hi);
        #endif

        #if LUT
            vec3 graded = texture(tLut, col * ${((LUT_SIZE - 1) / LUT_SIZE).toFixed(6)} + ${(0.5 / LUT_SIZE).toFixed(6)}).rgb;
            col = mix(col, graded, uLutIntensity);
        #endif

        #if GRADE
            float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
            col = mix(vec3(l), col, saturation);
            col = (col - 0.5) * contrast + 0.5;
            vec2 vd = (vUv - 0.5) * vec2(aspect, 1.0);
            float r = length(vd) / length(vec2(aspect, 1.0) * 0.5);
            col *= 1.0 - vignette * 0.75 * smoothstep(0.25, 1.0, r);
        #endif

        #if GRAIN
            // Monochrome, animated; strongest in the mid-tones like film.
            float gl = clamp(dot(col, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
            float g = hash12(gl_FragCoord.xy + fract(uFrame * 0.618034) * 1000.0)
                + hash12(gl_FragCoord.xy * 1.37 + fract(uFrame * 0.414214) * 1000.0) - 1.0;
            col += g * uGrain * 0.09 * (0.25 + 3.0 * gl * (1.0 - gl));
        #endif

        // Dither to break up 8-bit banding in skies and fog.
        col += (hash12(gl_FragCoord.xy + fract(uFrame * 0.1) * 97.0) - 0.5) / 255.0;

        #if LETTERBOX
            if (vUv.y < uLetterbox.y || vUv.y > 1.0 - uLetterbox.y || vUv.x < uLetterbox.x || vUv.x > 1.0 - uLetterbox.x) {
                col = vec3(0.0);
            }
        #endif

        gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
`;

export type OutputParams = {
    exposure: number;
    whiteBalance: THREE.Vector3;
    lut: THREE.Data3DTexture | null;
    lutIntensity: number;
    saturation: number;
    contrast: number;
    vignette: number;
    sharpen: number;
    aberration: number;
    grain: number;
    /** Target aspect ratio (0 = off). */
    letterbox: number;
    bloom: THREE.Texture | null;
    flare: THREE.Texture | null;
    autoExposure: boolean;
};

export class OutputStage {
    readonly material: THREE.ShaderMaterial;
    private toneMapping: THREE.ToneMapping | -1 = -1;
    private colorSpace = '';

    constructor(exposure: THREE.IUniform, frame: THREE.IUniform<number>) {
        this.material = fullscreenMaterial({
            name: 'WaterwaysOutput',
            uniforms: {
                tDiffuse: { value: null },
                tBloom: { value: null },
                tFlare: { value: null },
                tExposure: exposure,
                tLut: { value: null },
                toneMappingExposure: { value: 1 },
                uWhiteBalance: { value: new THREE.Vector3(1, 1, 1) },
                uLutIntensity: { value: 1 },
                saturation: { value: 1 },
                contrast: { value: 1 },
                vignette: { value: 0 },
                sharpen: { value: 0 },
                uAberration: { value: 0 },
                uGrain: { value: 0 },
                uLetterbox: { value: new THREE.Vector2() },
                texel: { value: new THREE.Vector2(1, 1) },
                aspect: { value: 1 },
                uFrame: frame,
            },
            defines: {
                AUTO_EXPOSURE: 0,
                BLOOM: 0,
                FLARE: 0,
                LUT: 0,
                GRADE: 0,
                SHARPEN: 0,
                ABERRATION: 0,
                GRAIN: 0,
                LETTERBOX: 0,
            },
            fragmentShader: OutputShader,
        });
    }

    /** Updates uniforms / defines for this frame. `width` / `height`: render resolution (for texel). */
    update(
        renderer: THREE.WebGLRenderer,
        input: THREE.Texture,
        p: OutputParams,
        width: number,
        height: number,
        canvasAspect: number,
    ): void {
        const m = this.material;
        const u = m.uniforms;

        if (
            this.toneMapping !== renderer.toneMapping ||
            this.colorSpace !== renderer.outputColorSpace
        ) {
            this.toneMapping = renderer.toneMapping;
            this.colorSpace = renderer.outputColorSpace;
            const d = m.defines;

            for (const key of [
                'LINEAR_TONE_MAPPING',
                'REINHARD_TONE_MAPPING',
                'CINEON_TONE_MAPPING',
                'ACES_FILMIC_TONE_MAPPING',
                'AGX_TONE_MAPPING',
                'NEUTRAL_TONE_MAPPING',
                'SRGB_TRANSFER',
            ]) {
                delete d[key];
            }

            const mapping: Partial<Record<THREE.ToneMapping, string>> = {
                [THREE.LinearToneMapping]: 'LINEAR_TONE_MAPPING',
                [THREE.ReinhardToneMapping]: 'REINHARD_TONE_MAPPING',
                [THREE.CineonToneMapping]: 'CINEON_TONE_MAPPING',
                [THREE.ACESFilmicToneMapping]: 'ACES_FILMIC_TONE_MAPPING',
                [THREE.AgXToneMapping]: 'AGX_TONE_MAPPING',
                [THREE.NeutralToneMapping]: 'NEUTRAL_TONE_MAPPING',
            };
            const define = mapping[renderer.toneMapping];

            if (define) {
                d[define] = '';
            }

            if (
                THREE.ColorManagement.getTransfer(renderer.outputColorSpace) ===
                THREE.SRGBTransfer
            ) {
                d.SRGB_TRANSFER = '';
            }

            m.needsUpdate = true;
        }

        u.tDiffuse.value = input;
        u.tBloom.value = p.bloom;
        u.tFlare.value = p.flare;
        u.tLut.value = p.lut;
        u.toneMappingExposure.value = p.exposure;
        (u.uWhiteBalance.value as THREE.Vector3).copy(p.whiteBalance);
        u.uLutIntensity.value = p.lutIntensity;
        u.saturation.value = p.saturation;
        u.contrast.value = p.contrast;
        u.vignette.value = p.vignette;
        u.sharpen.value = p.sharpen;
        u.uAberration.value = p.aberration;
        u.uGrain.value = p.grain;
        (u.texel.value as THREE.Vector2).set(1 / width, 1 / height);
        u.aspect.value = canvasAspect;

        const bars = u.uLetterbox.value as THREE.Vector2;

        if (p.letterbox > 0.1) {
            bars.set(
                Math.max(0, (1 - p.letterbox / canvasAspect) / 2),
                Math.max(0, (1 - canvasAspect / p.letterbox) / 2),
            );
        } else {
            bars.set(0, 0);
        }

        setDefine(m, 'AUTO_EXPOSURE', p.autoExposure ? 1 : 0);
        setDefine(m, 'BLOOM', p.bloom ? 1 : 0);
        setDefine(m, 'FLARE', p.flare ? 1 : 0);
        setDefine(m, 'LUT', p.lut && p.lutIntensity > 0.001 ? 1 : 0);
        setDefine(
            m,
            'GRADE',
            Math.abs(p.saturation - 1) > 0.001 ||
                Math.abs(p.contrast - 1) > 0.001 ||
                p.vignette > 0.001
                ? 1
                : 0,
        );
        setDefine(m, 'SHARPEN', p.sharpen > 0.001 ? 1 : 0);
        setDefine(m, 'ABERRATION', p.aberration > 0.001 ? 1 : 0);
        setDefine(m, 'GRAIN', p.grain > 0.001 ? 1 : 0);
        setDefine(m, 'LETTERBOX', bars.x > 0.0005 || bars.y > 0.0005 ? 1 : 0);
    }

    dispose(): void {
        this.material.dispose();
    }
}
