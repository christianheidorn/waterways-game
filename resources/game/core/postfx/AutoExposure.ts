import * as THREE from 'three';
import type { Blitter } from './common';
import { colorTarget, fullscreenMaterial } from './common';

/** Side of the log-luminance target; mip 3 (16×16 = 256 texels) feeds the histogram. */
const LUM_SIZE = 128;
const HISTOGRAM_MIP = 3;
const HISTOGRAM_SIDE = LUM_SIZE >> HISTOGRAM_MIP;

/**
 * Metering key: log2 of (scene luminance × base exposure) the image is calibrated for. The Atmosphere's
 * base exposure already looks right on an average clear day, so a scene at this key gets a multiplier of 1.
 */
const METER_KEY = -2.95;

const LuminanceShader = /* glsl */ `
    uniform sampler2D tColor;
    uniform vec2 uSourceTexel;
    varying vec2 vUv;

    float lum(vec3 c) {
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        // NaN / Inf / negative guard (one bad pixel must not poison the exposure).
        return l > 0.0 && l < 65000.0 ? l : 0.0;
    }

    void main() {
        // Four bilinear taps spread over this texel's footprint (16 source texels).
        vec2 o = vec2(0.25) / ${LUM_SIZE.toFixed(1)};
        float l = log2(lum(texture2D(tColor, vUv + vec2(-o.x, -o.y)).rgb) + 1e-5)
            + log2(lum(texture2D(tColor, vUv + vec2(o.x, -o.y)).rgb) + 1e-5)
            + log2(lum(texture2D(tColor, vUv + vec2(-o.x, o.y)).rgb) + 1e-5)
            + log2(lum(texture2D(tColor, vUv + vec2(o.x, o.y)).rgb) + 1e-5);
        gl_FragColor = vec4(l * 0.25, 0.0, 0.0, 1.0);
    }
`;

/**
 * Eye adaptation, entirely on the GPU (no read-back stalls): the log-luminance target is mip-mapped
 * down to 16×16, a 1×1 pass builds a centre-weighted 64-bin histogram of those 256 samples, averages the
 * 50th-95th percentile (so small dark corners and the sun disc don't drive exposure) and eases the
 * previous frame's value towards the target (ping-pong 1×1 targets).
 *
 * Output texel: r = exposure multiplier applied on top of the base exposure (renderer.toneMappingExposure,
 * set by the Atmosphere from time of day and weather), g = its log2, b = metered log2 luminance.
 */
const AdaptShader = /* glsl */ `
    #define BINS 64
    uniform sampler2D tLum;
    uniform sampler2D tPrevious;
    uniform float uDt;
    uniform float uSpeed;
    uniform float uMinEv;
    uniform float uMaxEv;
    uniform float uBaseEv;
    uniform float uReset;
    varying vec2 vUv;

    const float LOG_MIN = -16.0;
    const float LOG_MAX = 8.0;

    void main() {
        float hist[BINS];

        for (int i = 0; i < BINS; i++) {
            hist[i] = 0.0;
        }

        float total = 0.0;

        for (int y = 0; y < ${HISTOGRAM_SIDE}; y++) {
            for (int x = 0; x < ${HISTOGRAM_SIDE}; x++) {
                float l = texelFetch(tLum, ivec2(x, y), ${HISTOGRAM_MIP}).r;
                vec2 p = (vec2(float(x), float(y)) + 0.5) / ${HISTOGRAM_SIDE.toFixed(1)} - 0.5;
                // Centre-weighted metering; the top of the frame (usually sky) counts a little less.
                float w = mix(1.0, 3.0, 1.0 - clamp(dot(p, p) * 3.0, 0.0, 1.0)) * (p.y > 0.25 ? 0.75 : 1.0);
                int bin = int(clamp((l - LOG_MIN) / (LOG_MAX - LOG_MIN), 0.0, 0.9999) * float(BINS));
                hist[bin] += w;
                total += w;
            }
        }

        float lowCut = total * 0.5;
        float highCut = total * 0.95;
        float acc = 0.0;
        float sum = 0.0;
        float weight = 0.0;

        for (int i = 0; i < BINS; i++) {
            float h = hist[i];
            // Portion of this bin inside the [lowCut, highCut] percentile window.
            float inside = clamp(min(acc + h, highCut) - max(acc, lowCut), 0.0, h);
            float center = LOG_MIN + (float(i) + 0.5) / float(BINS) * (LOG_MAX - LOG_MIN);
            sum += center * inside;
            weight += inside;
            acc += h;
        }

        float metered = sum / max(weight, 1e-4);
        // Partial adaptation (0.75): dark places should still feel darker than bright ones.
        float target = clamp(0.75 * (${METER_KEY.toFixed(2)} - (metered + uBaseEv)), uMinEv, uMaxEv);
        float previous = texture2D(tPrevious, vec2(0.5)).g;
        float ev;

        if (uReset > 0.5 || previous != previous) {
            ev = target;
        } else {
            // Adapting to brightness (exposure going down) is faster than adapting to the dark.
            float speed = uSpeed * (target < previous ? 1.6 : 1.0);
            ev = previous + (target - previous) * (1.0 - exp(-uDt * speed));
        }

        gl_FragColor = vec4(exp2(ev), ev, metered, 1.0);
    }
`;

export class AutoExposure {
    private readonly lumTarget: THREE.WebGLRenderTarget;
    private readonly adapt: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
    private index = 0;
    private readonly lumMaterial: THREE.ShaderMaterial;
    private readonly adaptMaterial: THREE.ShaderMaterial;
    private needsReset = true;

    constructor(
        /** Shared uniform all consumers read the multiplier texture from. */
        private readonly output: THREE.IUniform<THREE.Texture | null>,
        private readonly blitter: Blitter,
    ) {
        this.lumTarget = colorTarget(LUM_SIZE, LUM_SIZE, {
            generateMipmaps: true,
            minFilter: THREE.LinearMipmapNearestFilter,
        });
        this.adapt = [
            colorTarget(1, 1, {
                minFilter: THREE.NearestFilter,
                magFilter: THREE.NearestFilter,
            }),
            colorTarget(1, 1, {
                minFilter: THREE.NearestFilter,
                magFilter: THREE.NearestFilter,
            }),
        ];
        this.lumMaterial = fullscreenMaterial({
            name: 'WaterwaysLogLuminance',
            uniforms: {
                tColor: { value: null },
                uSourceTexel: { value: new THREE.Vector2() },
            },
            fragmentShader: LuminanceShader,
        });
        this.adaptMaterial = fullscreenMaterial({
            name: 'WaterwaysEyeAdaptation',
            uniforms: {
                tLum: { value: this.lumTarget.texture },
                tPrevious: { value: null },
                uDt: { value: 0 },
                uSpeed: { value: 1 },
                uMinEv: { value: -2 },
                uMaxEv: { value: 2 },
                uBaseEv: { value: 0 },
                uReset: { value: 1 },
            },
            fragmentShader: AdaptShader,
        });
    }

    reset(): void {
        this.needsReset = true;
    }

    /** Meters `input` (HDR, before exposure) and updates the shared multiplier texture. */
    update(
        input: THREE.Texture,
        dt: number,
        baseExposure: number,
        minEv: number,
        maxEv: number,
        speed: number,
    ): void {
        this.lumMaterial.uniforms.tColor.value = input;
        this.blitter.draw(this.lumMaterial, this.lumTarget);

        const read = this.adapt[this.index];
        const write = this.adapt[1 - this.index];
        const u = this.adaptMaterial.uniforms;
        u.tPrevious.value = read.texture;
        u.uDt.value = dt;
        u.uSpeed.value = Math.max(0.01, speed);
        u.uMinEv.value = Math.min(minEv, maxEv);
        u.uMaxEv.value = Math.max(minEv, maxEv);
        u.uBaseEv.value = Math.log2(Math.max(1e-4, baseExposure));
        u.uReset.value = this.needsReset ? 1 : 0;
        this.blitter.draw(this.adaptMaterial, write);
        this.index = 1 - this.index;
        this.needsReset = false;
        this.output.value = write.texture;
    }

    /** The current adaptation texture (for debugging / read-back in tests). */
    get target(): THREE.WebGLRenderTarget {
        return this.adapt[1 - this.index];
    }

    dispose(): void {
        this.lumTarget.dispose();
        this.adapt[0].dispose();
        this.adapt[1].dispose();
        this.lumMaterial.dispose();
        this.adaptMaterial.dispose();
    }
}
