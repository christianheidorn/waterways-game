import * as THREE from 'three';
import type { Blitter, FrameUniforms } from './common';
import {
    colorTarget,
    FRAME_UNIFORMS,
    fullscreenMaterial,
    scaledSize,
} from './common';

export type GodRayQuality = 'low' | 'medium' | 'high';

/** Resolution scale, samples per pass and number of passes (effective taps = samples^passes). */
const QUALITY: Record<
    GodRayQuality,
    { scale: number; samples: number; passes: number }
> = {
    low: { scale: 0.25, samples: 24, passes: 1 },
    medium: { scale: 0.25, samples: 16, passes: 2 },
    high: { scale: 0.5, samples: 20, passes: 3 },
};

/**
 * Occlusion mask: bright sky around the light source emits, everything with depth occludes. Emission is
 * the sky's own (display referred, clamped) brightness above a threshold inside an angular window, so
 * clouds in front of the sun naturally weaken and break up the shafts.
 */
const MaskShader = /* glsl */ `
    ${FRAME_UNIFORMS}
    uniform sampler2D tColor;
    uniform vec3 uLightDirView;
    uniform float uExposure;
    uniform vec2 uMaskTexel;
    varying vec2 vUv;

    void main() {
        // 2×2 depth taps over this texel's footprint so thin occluders (branches) survive the low resolution.
        vec2 o = uMaskTexel * 0.25;
        float d = min(min(rawDepth(vUv + vec2(-o.x, -o.y)), rawDepth(vUv + vec2(o.x, -o.y))),
                      min(rawDepth(vUv + vec2(-o.x, o.y)), rawDepth(vUv + vec2(o.x, o.y))));

        if (!isSky(d)) {
            gl_FragColor = vec4(0.0);
            return;
        }

        vec3 dir = normalize(viewPosition(vUv, 1.0));
        float c = max(dot(dir, uLightDirView), 0.0);
        float window = pow(c, 24.0) + pow(c, 256.0);
        vec3 sky = texture2D(tColor, vUv).rgb * uExposure;
        vec3 emit = max(sky - 0.8, vec3(0.0));
        emit = min(emit, vec3(2.0));
        gl_FragColor = vec4(emit * window, 1.0);
    }
`;

/** One radial blur pass towards the light's screen position (GPU Gems 3 ch. 13, iterated). */
const BlurShader = /* glsl */ `
    uniform sampler2D tInput;
    uniform vec2 uLightUv;
    uniform float uStepScale;
    uniform float uFrame;
    uniform float uPass;
    varying vec2 vUv;

    float ign(vec2 px) {
        px += 5.588238 * mod(uFrame + uPass * 17.0, 64.0);
        return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715))));
    }

    void main() {
        vec2 delta = (uLightUv - vUv) * uStepScale / float(SAMPLES);
        vec2 uv = vUv + delta * ign(gl_FragCoord.xy);
        vec3 sum = vec3(0.0);
        float weight = 0.0;
        float decay = 1.0;

        for (int i = 0; i < SAMPLES; i++) {
            vec2 inside = step(vec2(0.0), uv) * step(uv, vec2(1.0));
            sum += texture2D(tInput, uv).rgb * decay * inside.x * inside.y;
            weight += decay;
            decay *= DECAY;
            uv += delta;
        }

        gl_FragColor = vec4(sum / weight, 1.0);
    }
`;

/**
 * Screen-space volumetric light scattering from the sun (or moon at night): a low resolution occlusion
 * mask from depth + sky brightness, then 1-3 iterated radial blur passes towards the light. The result
 * (in HDR scene units) is added in the HDR composite, tinted by the light colour and faded as the light
 * leaves the screen, goes behind the camera or below the horizon.
 */
export class GodRays {
    private readonly a: THREE.WebGLRenderTarget;
    private readonly b: THREE.WebGLRenderTarget;
    private readonly mask: THREE.ShaderMaterial;
    private readonly blur: THREE.ShaderMaterial;
    private readonly settings: (typeof QUALITY)[GodRayQuality];
    readonly lightUv = new THREE.Vector2();
    private readonly lightDirView = new THREE.Vector3();
    private readonly tmp = new THREE.Vector4();
    /** 0-1: how much of the effect is visible this frame (0 skips the passes). */
    visibility = 0;

    constructor(
        readonly quality: GodRayQuality,
        uniforms: FrameUniforms,
        private readonly blitter: Blitter,
        width: number,
        height: number,
    ) {
        this.settings = QUALITY[quality];
        const w = scaledSize(width, this.settings.scale);
        const h = scaledSize(height, this.settings.scale);
        this.a = colorTarget(w, h);
        this.b = colorTarget(w, h);
        this.mask = fullscreenMaterial({
            name: 'WaterwaysGodRayMask',
            uniforms: {
                ...uniforms,
                tColor: { value: null },
                uLightDirView: { value: this.lightDirView },
                uExposure: { value: 1 },
                uMaskTexel: { value: new THREE.Vector2(1 / w, 1 / h) },
            },
            fragmentShader: MaskShader,
        });
        this.blur = fullscreenMaterial({
            name: 'WaterwaysGodRayBlur',
            uniforms: {
                tInput: { value: null },
                uLightUv: { value: this.lightUv },
                uStepScale: { value: 1 },
                uPass: { value: 0 },
                uFrame: uniforms.uFrame,
            },
            defines: {
                SAMPLES: this.settings.samples,
                DECAY: this.settings.passes > 1 ? '0.985' : '0.965',
            },
            fragmentShader: BlurShader,
        });
    }

    get texture(): THREE.Texture {
        return (this.settings.passes % 2 === 1 ? this.b : this.a).texture;
    }

    setSize(width: number, height: number): void {
        const w = scaledSize(width, this.settings.scale);
        const h = scaledSize(height, this.settings.scale);
        this.a.setSize(w, h);
        this.b.setSize(w, h);
        (this.mask.uniforms.uMaskTexel.value as THREE.Vector2).set(
            1 / w,
            1 / h,
        );
    }

    /**
     * Projects the light direction to the screen; returns the visibility factor (sets `visibility`).
     * `viewProj` is the un-jittered view-projection, `view` the view matrix.
     */
    locate(
        lightDir: THREE.Vector3,
        camera: THREE.Camera,
        viewProj: THREE.Matrix4,
    ): number {
        this.lightDirView
            .copy(lightDir)
            .transformDirection(camera.matrixWorldInverse);
        const p = this.tmp.set(lightDir.x, lightDir.y, lightDir.z, 0);
        p.applyMatrix4(viewProj);

        if (p.w <= 1e-4) {
            this.visibility = 0;

            return 0;
        }

        this.lightUv.set((p.x / p.w) * 0.5 + 0.5, (p.y / p.w) * 0.5 + 0.5);
        // Fade as the light moves beyond the screen edge (rays still stream in from just outside).
        const dx = Math.max(0, Math.abs(this.lightUv.x - 0.5) - 0.5);
        const dy = Math.max(0, Math.abs(this.lightUv.y - 0.5) - 0.5);
        const off = Math.hypot(dx, dy);
        const facing = THREE.MathUtils.smoothstep(
            -this.lightDirView.z,
            0.05,
            0.35,
        );
        this.visibility =
            facing * (1 - THREE.MathUtils.smoothstep(off, 0.1, 0.6));

        return this.visibility;
    }

    render(sceneColor: THREE.Texture, exposure: number): void {
        const s = this.settings;
        this.mask.uniforms.tColor.value = sceneColor;
        this.mask.uniforms.uExposure.value = exposure;
        this.blitter.draw(this.mask, this.a);

        let read = this.a;
        let write = this.b;

        for (let i = 0; i < s.passes; i++) {
            this.blur.uniforms.tInput.value = read.texture;
            this.blur.uniforms.uPass.value = i;
            // Pass i covers 1/samples^i of the ray: first pass spans the full distance, later passes fill in.
            this.blur.uniforms.uStepScale.value =
                (s.passes > 1 ? 0.9 : 0.75) / Math.pow(s.samples, i * 0.85);
            this.blitter.draw(this.blur, write);
            [read, write] = [write, read];
        }
    }

    dispose(): void {
        this.a.dispose();
        this.b.dispose();
        this.mask.dispose();
        this.blur.dispose();
    }
}
