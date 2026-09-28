import type * as THREE from 'three';
import type { Blitter, FrameUniforms } from './common';
import { FRAME_UNIFORMS, fullscreenMaterial } from './common';

export type MotionBlurQuality = 'low' | 'high';

/**
 * Per-pixel motion blur from depth reprojection (camera motion: current vs previous un-jittered
 * view-projection) plus the velocity buffer for dynamic objects. The blur vector is the motion during
 * the shutter time (strength 1 = 180° shutter at 24 fps, frame rate independent), clamped to a maximum
 * length. Samples are centred on the pixel and jittered; a sample only contributes where its own motion
 * reaches the centre, so still foreground (the player) never smears into the moving background.
 */
const MotionBlurShader = /* glsl */ `
    ${FRAME_UNIFORMS}
    uniform sampler2D tColor;
    uniform sampler2D tVelocity;
    uniform float uScale;
    uniform float uMaxLength;
    varying vec2 vUv;

    vec2 motionAt(vec2 uv) {
        #if VELOCITY
            vec4 v = texture2D(tVelocity, uv);

            if (v.a > 0.5) {
                return v.xy;
            }
        #endif

        float d = rawDepth(uv);
        vec4 prev = uReproj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
        return prev.w > 0.0 ? uv - (prev.xy / prev.w * 0.5 + 0.5) : vec2(0.0);
    }

    /** Motion in pixels scaled to the shutter and clamped. */
    vec2 blurVector(vec2 uv) {
        vec2 v = motionAt(uv) * uResolution * uScale;
        float len = length(v);
        return len > uMaxLength ? v * (uMaxLength / len) : v;
    }

    void main() {
        vec3 center = texture2D(tColor, vUv).rgb;
        vec2 v = blurVector(vUv);
        float len = length(v);

        if (len < 0.5) {
            gl_FragColor = vec4(center, 1.0);
            return;
        }

        float jitter = ign(gl_FragCoord.xy) - 0.5;
        vec3 sum = center;
        float weight = 1.0;

        for (int i = 0; i < SAMPLES; i++) {
            float t = (float(i) + 0.5 + jitter) / float(SAMPLES) - 0.5;
            vec2 uv = vUv + v * t * uTexel;
            float dist = abs(t) * len;
            // A sample counts when its own blur reaches back to this pixel.
            float w = clamp(length(blurVector(uv)) / max(dist, 1e-3), 0.0, 1.0);
            sum += texture2D(tColor, uv).rgb * w;
            weight += w;
        }

        gl_FragColor = vec4(sum / weight, 1.0);
    }
`;

export class MotionBlur {
    private readonly material: THREE.ShaderMaterial;

    constructor(
        readonly quality: MotionBlurQuality,
        uniforms: FrameUniforms,
        private readonly blitter: Blitter,
    ) {
        this.material = fullscreenMaterial({
            name: 'WaterwaysMotionBlur',
            uniforms: {
                ...uniforms,
                tColor: { value: null },
                tVelocity: { value: null },
                uScale: { value: 1 },
                uMaxLength: { value: 32 },
            },
            defines: { SAMPLES: quality === 'high' ? 24 : 10, VELOCITY: 0 },
            fragmentShader: MotionBlurShader,
        });
    }

    render(
        input: THREE.Texture,
        output: THREE.WebGLRenderTarget,
        params: {
            strength: number;
            dt: number;
            height: number;
            velocity: THREE.Texture | null;
        },
    ): void {
        const m = this.material;
        const u = m.uniforms;
        u.tColor.value = input;
        u.tVelocity.value = params.velocity;
        // Shutter: strength × 1/48 s, relative to the frame time the motion vectors cover.
        u.uScale.value = params.strength / 48 / Math.max(1 / 240, params.dt);
        u.uMaxLength.value = 48 * (params.height / 1080);
        const vel = params.velocity ? 1 : 0;

        if (m.defines.VELOCITY !== vel) {
            m.defines.VELOCITY = vel;
            m.needsUpdate = true;
        }

        this.blitter.draw(m, output);
    }

    dispose(): void {
        this.material.dispose();
    }
}
