import * as THREE from 'three';
import type { Blitter, FrameUniforms } from './common';
import { colorTarget, FRAME_UNIFORMS, fullscreenMaterial } from './common';

/** Radical inverse (Halton) in the given base, for 1-based indices. */
function halton(index: number, base: number): number {
    let f = 1;
    let r = 0;

    for (let i = index; i > 0; i = Math.floor(i / base)) {
        f /= base;
        r += f * (i % base);
    }

    return r;
}

/** 16 sub-pixel offsets (pixels, -0.5..0.5) from the Halton(2, 3) sequence. */
const JITTER = Array.from({ length: 16 }, (_, i) => [
    halton(i + 1, 2) - 0.5,
    halton(i + 1, 3) - 0.5,
]);

/**
 * Temporal anti-aliasing resolve (Karis 2014 / Playdead INSIDE style), in scene-linear HDR:
 *
 * - The projection is jittered by a 16-sample Halton sequence; the current frame is reconstructed at the
 *   un-jittered pixel centre with a Blackman-Harris-like 3×3 filter.
 * - History is reprojected with the depth of the closest 3×3 neighbour (camera motion from the previous
 *   un-jittered view-projection, plus a velocity buffer for dynamic objects such as the player) and
 *   sampled with a 5-tap Catmull-Rom filter, which keeps the resolve sharp.
 * - History is clipped towards the neighbourhood (variance clipping of the YCoCg distribution, clip not
 *   clamp) in a perceptual space (c / (1 + luma), exposure aware) so bright highlights don't ghost.
 * - Blend factor: 5 % when still (≈ 20 samples of super-sampling for stills / photo mode), up to 20 %
 *   under fast motion; 100 % on disocclusion off-screen or after a reset (camera cut, resize).
 */
const TaaShader = /* glsl */ `
    ${FRAME_UNIFORMS}
    uniform sampler2D tColor;
    uniform sampler2D tHistory;
    uniform sampler2D tExposure;
    uniform sampler2D tVelocity;
    uniform float uExposure;
    uniform float uReset;
    uniform vec2 uJitterPx;
    varying vec2 vUv;

    vec3 toYCoCg(vec3 c) {
        return vec3(
            dot(c, vec3(0.25, 0.5, 0.25)),
            dot(c, vec3(0.5, 0.0, -0.5)),
            dot(c, vec3(-0.25, 0.5, -0.25))
        );
    }

    vec3 fromYCoCg(vec3 c) {
        float t = c.x - c.z;
        return vec3(t + c.y, c.x + c.z, t - c.y);
    }

    float exposureScale() {
        #if AUTO_EXPOSURE
            return uExposure * texture2D(tExposure, vec2(0.5)).r;
        #else
            return uExposure;
        #endif
    }

    // Perceptual (tone-mapped) space so statistics and blending are not dominated by HDR highlights.
    vec3 compress(vec3 c, float e) {
        c = max(c, vec3(0.0)) * e;
        return toYCoCg(c / (1.0 + luma(c)));
    }

    vec3 expand(vec3 y, float e) {
        vec3 c = fromYCoCg(y);
        return c / max(1.0 - luma(c), 1e-3) / e;
    }

    vec3 sampleHistory(vec2 uv) {
        // Catmull-Rom with 5 bilinear taps (the four corner taps have negligible weight).
        vec2 size = uResolution;
        vec2 pos = uv * size;
        vec2 center = floor(pos - 0.5) + 0.5;
        vec2 f = pos - center;
        vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
        vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
        vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
        vec2 w3 = f * f * (-0.5 + 0.5 * f);
        vec2 w12 = w1 + w2;
        vec2 tc0 = (center - 1.0) / size;
        vec2 tc3 = (center + 2.0) / size;
        vec2 tc12 = (center + w2 / w12) / size;
        vec3 c = texture2D(tHistory, vec2(tc12.x, tc0.y)).rgb * (w12.x * w0.y)
            + texture2D(tHistory, vec2(tc0.x, tc12.y)).rgb * (w0.x * w12.y)
            + texture2D(tHistory, tc12).rgb * (w12.x * w12.y)
            + texture2D(tHistory, vec2(tc3.x, tc12.y)).rgb * (w3.x * w12.y)
            + texture2D(tHistory, vec2(tc12.x, tc3.y)).rgb * (w12.x * w3.y);
        float wsum = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
        return max(c / wsum, vec3(0.0));
    }

    vec3 clipAabb(vec3 lo, vec3 hi, vec3 center, vec3 q) {
        vec3 extents = max(0.5 * (hi - lo), vec3(1e-5));
        vec3 mid = 0.5 * (hi + lo);
        vec3 v = q - mid;
        vec3 a = abs(v / extents);
        float m = max(a.x, max(a.y, a.z));
        return m > 1.0 ? mid + v / m : q;
    }

    void main() {
        ivec2 px = ivec2(gl_FragCoord.xy);
        ivec2 maxPx = ivec2(uResolution) - 1;
        float e = exposureScale();

        vec3 m1 = vec3(0.0);
        vec3 m2 = vec3(0.0);
        vec3 lo = vec3(1e9);
        vec3 hi = vec3(-1e9);
        vec3 filtered = vec3(0.0);
        float wsum = 0.0;
        float closest = 1.0;
        vec2 closestOffset = vec2(0.0);

        for (int y = -1; y <= 1; y++) {
            for (int x = -1; x <= 1; x++) {
                ivec2 p = clamp(px + ivec2(x, y), ivec2(0), maxPx);
                vec3 c = compress(texelFetch(tColor, p, 0).rgb, e);
                // The pixel (x, y) sampled the scene at (x, y) - jitter relative to this pixel's centre.
                vec2 d = vec2(float(x), float(y)) - uJitterPx;
                float w = exp(-2.29 * dot(d, d));
                filtered += c * w;
                wsum += w;
                m1 += c;
                m2 += c * c;
                lo = min(lo, c);
                hi = max(hi, c);
                float z = texelFetch(tDepth, p, 0).x;

                if (z < closest) {
                    closest = z;
                    closestOffset = vec2(float(x), float(y));
                }
            }
        }

        filtered /= wsum;

        // Reprojection: camera motion from depth, or the object velocity where one was rendered.
        vec2 uvClosest = vUv + closestOffset * uTexel;
        vec4 prevClip = uReproj * vec4(uvClosest * 2.0 - 1.0, closest * 2.0 - 1.0, 1.0);
        vec2 motion = uvClosest - (prevClip.xy / prevClip.w * 0.5 + 0.5);

        #if VELOCITY
            vec4 vel = texture2D(tVelocity, uvClosest);

            if (vel.a > 0.5) {
                motion = vel.xy;
            }
        #endif

        vec2 historyUv = vUv - motion;
        vec3 current = filtered;
        vec3 result;

        if (uReset > 0.5 || any(lessThan(historyUv, vec2(0.0))) || any(greaterThan(historyUv, vec2(1.0))) || prevClip.w <= 0.0) {
            result = current;
        } else {
            vec3 history = compress(sampleHistory(historyUv), e);
            vec3 mu = m1 / 9.0;
            vec3 sigma = sqrt(abs(m2 / 9.0 - mu * mu));
            float motionPx = length(motion * uResolution);
            // Tighter box under motion (less ghosting), looser when still (less flicker).
            float gamma = mix(1.25, 0.9, clamp(motionPx / 4.0, 0.0, 1.0));
            vec3 boxLo = max(lo, mu - gamma * sigma);
            vec3 boxHi = min(hi, mu + gamma * sigma);
            history = clipAabb(boxLo, boxHi, clamp(mu, boxLo, boxHi), history);
            float alpha = mix(0.05, 0.2, clamp(motionPx / 6.0, 0.0, 1.0));
            result = mix(history, current, alpha);
        }

        vec3 outColor = expand(result, e);

        // Guard against NaN / Inf from the scene (they would stick in the history forever).
        if (any(isnan(outColor)) || any(isinf(outColor))) {
            outColor = vec3(0.0);
        }

        gl_FragColor = vec4(outColor, 1.0);
    }
`;

export class Taa {
    private targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
    private index = 0;
    private frame = 0;
    private needsReset = true;
    private readonly material: THREE.ShaderMaterial;
    /** Current jitter in pixels. */
    readonly jitterPx = new THREE.Vector2();

    constructor(
        uniforms: FrameUniforms,
        exposure: THREE.IUniform,
        private readonly blitter: Blitter,
        width: number,
        height: number,
    ) {
        this.targets = [colorTarget(width, height), colorTarget(width, height)];
        this.material = fullscreenMaterial({
            name: 'WaterwaysTAA',
            uniforms: {
                ...uniforms,
                tColor: { value: null },
                tHistory: { value: null },
                tExposure: exposure,
                tVelocity: { value: null },
                uExposure: { value: 1 },
                uReset: { value: 1 },
                uJitterPx: { value: this.jitterPx },
            },
            defines: { AUTO_EXPOSURE: 0, VELOCITY: 0 },
            fragmentShader: TaaShader,
        });
    }

    /** Advances the jitter sequence and returns the jitter for this frame in pixels. */
    nextJitter(): THREE.Vector2 {
        this.frame = (this.frame + 1) % JITTER.length;
        const j = JITTER[this.frame];

        return this.jitterPx.set(j[0], j[1]);
    }

    reset(): void {
        this.needsReset = true;
    }

    setSize(width: number, height: number): void {
        this.targets[0].setSize(width, height);
        this.targets[1].setSize(width, height);
        this.needsReset = true;
    }

    render(
        input: THREE.Texture,
        exposure: number,
        autoExposure: boolean,
        velocity: THREE.Texture | null,
    ): THREE.WebGLRenderTarget {
        const read = this.targets[this.index];
        const write = this.targets[1 - this.index];
        const m = this.material;
        const u = m.uniforms;
        u.tColor.value = input;
        u.tHistory.value = read.texture;
        u.uExposure.value = exposure;
        u.uReset.value = this.needsReset ? 1 : 0;
        u.tVelocity.value = velocity;
        const ae = autoExposure ? 1 : 0;
        const vel = velocity ? 1 : 0;

        if (m.defines.AUTO_EXPOSURE !== ae || m.defines.VELOCITY !== vel) {
            m.defines.AUTO_EXPOSURE = ae;
            m.defines.VELOCITY = vel;
            m.needsUpdate = true;
        }

        this.blitter.draw(m, write);
        this.index = 1 - this.index;
        this.needsReset = false;

        return write;
    }

    dispose(): void {
        this.targets[0].dispose();
        this.targets[1].dispose();
        this.material.dispose();
    }
}
