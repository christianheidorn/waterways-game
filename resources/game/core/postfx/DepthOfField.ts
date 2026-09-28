import * as THREE from 'three';
import type { Blitter, FrameUniforms } from './common';
import {
    colorTarget,
    FRAME_UNIFORMS,
    fullscreenMaterial,
    scaledSize,
} from './common';

export type DofQuality = 'low' | 'high';

/** Full-frame 35 mm sensor height: focal length follows from the vertical field of view. */
const SENSOR_HEIGHT = 0.024;

/**
 * Signed circle of confusion in full-resolution pixels (negative = in front of the focus plane), from
 * the thin lens equation: c = (f² / N) · (z − z_f) / (z · (z_f − f)), scaled from the sensor to the
 * image height. `dof_max_blur` is specified at 1080p and scales with the render height.
 */
const COC = /* glsl */ `
    uniform sampler2D tFocus;
    uniform float uFocal;
    uniform float uFStop;
    uniform float uMaxCoc;

    float focusDistance() { return texture2D(tFocus, vec2(0.5)).r; }

    float circleOfConfusion(float z, float zf) {
        float c = (uFocal * uFocal / uFStop) * (z - zf) / (z * max(zf - uFocal, 1e-3));
        return clamp(c / ${SENSOR_HEIGHT.toFixed(3)} * uResolution.y, -uMaxCoc, uMaxCoc);
    }
`;

/** Auto / manual focus with smoothing, in a 1×1 feedback target (r = focus distance in metres). */
const FocusShader = /* glsl */ `
    ${FRAME_UNIFORMS}
    uniform sampler2D tPrevious;
    uniform vec2 uFocusUv;
    uniform float uManual;
    uniform float uDt;
    uniform float uReset;
    varying vec2 vUv;

    void main() {
        float target;

        if (uManual > 0.0) {
            target = uManual;
        } else {
            // Mean log depth of 9 taps in a small disc (robust against a single thin occluder).
            float acc = 0.0;
            float r = 0.012;

            for (int i = 0; i < 9; i++) {
                float a = float(i) * 2.39996323;
                vec2 o = i == 0 ? vec2(0.0) : vec2(cos(a), sin(a) * uResolution.x / uResolution.y) * r * sqrt(float(i) / 8.0);
                float d = rawDepth(clamp(uFocusUv + o, vec2(0.0), vec2(1.0)));
                acc += log(min(linearizeDepth(d), uFar));
            }

            target = exp(acc / 9.0);
        }

        float previous = texture2D(tPrevious, vec2(0.5)).r;
        float focus = target;

        if (uReset < 0.5 && previous > 0.0) {
            // Focus pulls ease in log space (perceptually even for near and far changes).
            float k = 1.0 - exp(-uDt * (uManual > 0.0 ? 10.0 : 4.0));
            focus = exp(mix(log(previous), log(target), k));
        }

        gl_FragColor = vec4(focus, 0.0, 0.0, 1.0);
    }
`;

/** Half resolution colour + signed CoC (alpha). Near-field CoC wins so foreground edges spread. */
const PrefilterShader = /* glsl */ `
    ${FRAME_UNIFORMS}
    ${COC}
    uniform sampler2D tColor;
    varying vec2 vUv;

    void main() {
        float zf = focusDistance();
        vec2 o = uTexel * 0.5;
        float c0 = circleOfConfusion(linearDepth(vUv + vec2(-o.x, -o.y)), zf);
        float c1 = circleOfConfusion(linearDepth(vUv + vec2(o.x, -o.y)), zf);
        float c2 = circleOfConfusion(linearDepth(vUv + vec2(-o.x, o.y)), zf);
        float c3 = circleOfConfusion(linearDepth(vUv + vec2(o.x, o.y)), zf);
        float near = min(min(c0, c1), min(c2, c3));
        float coc = near < 0.0 ? near : 0.25 * (c0 + c1 + c2 + c3);
        vec3 color = texture2D(tColor, vUv).rgb;

        // The gather spreads every sample over a large area: keep NaN / Inf out of it.
        if (any(isnan(color)) || any(isinf(color))) {
            color = vec3(0.0);
        }

        gl_FragColor = vec4(color, coc);
    }
`;

/**
 * Scatter-as-gather bokeh (after Gustafsson, "Bokeh depth of field in a single pass"): a golden-angle
 * spiral out to the maximum radius; each sample contributes where its own CoC covers the distance.
 * Samples behind the centre are limited to twice the centre's CoC, so blurry backgrounds never bleed
 * over sharp foregrounds while blurry foregrounds do spread over what's behind them. High quality uses a
 * denser spiral shaped into a hexagon (6 aperture blades) when stopped down, a disc when wide open.
 */
const GatherShader = /* glsl */ `
    uniform sampler2D tInput;
    uniform vec2 uHalfTexel;
    uniform float uMaxRadius;
    uniform float uRadScale;
    uniform float uBlades;
    varying vec2 vUv;

    #define GOLDEN_ANGLE 2.39996323

    void main() {
        vec4 center = texture2D(tInput, vUv);
        float centerSize = abs(center.a) * 0.5;
        vec3 color = center.rgb;
        float size = centerSize;
        float tot = 1.0;
        float radius = uRadScale;
        float angle = 0.0;

        for (int i = 0; i < MAX_SAMPLES; i++) {
            if (radius >= uMaxRadius) {
                break;
            }

            vec2 dir = vec2(cos(angle), sin(angle));
            float shape = 1.0;

            #if HEXAGON
                // Hexagon boundary relative to its circumcircle, rotated a little like a real aperture.
                float seg = mod(angle + 0.26, 1.04719755) - 0.52359878;
                shape = mix(1.0, 0.8660254 / cos(seg), uBlades);
            #endif

            vec4 s = texture2D(tInput, vUv + dir * radius * shape * uHalfTexel);
            float sampleSize = abs(s.a) * 0.5;

            if (s.a > center.a) {
                sampleSize = clamp(sampleSize, 0.0, centerSize * 2.0);
            }

            float m = smoothstep(radius - 0.5, radius + 0.5, sampleSize);
            color += mix(color / tot, s.rgb, m);
            size += mix(size / tot, sampleSize, m);
            tot += 1.0;
            radius += uRadScale / radius;
            angle += GOLDEN_ANGLE;
        }

        gl_FragColor = vec4(color / tot, size / tot);
    }
`;

/** Full resolution: sharp image where in focus, the half resolution bokeh elsewhere. */
const CompositeShader = /* glsl */ `
    ${FRAME_UNIFORMS}
    ${COC}
    uniform sampler2D tColor;
    uniform sampler2D tBlur;
    varying vec2 vUv;

    void main() {
        vec4 sharp = texture2D(tColor, vUv);
        float coc = circleOfConfusion(linearDepth(vUv), focusDistance());
        vec4 blur = texture2D(tBlur, vUv);
        // Blur sizes are half resolution pixels: below ~1 full-res pixel the sharp image is exact.
        float amount = smoothstep(0.35, 1.25, max(abs(coc) * 0.5, blur.a));
        gl_FragColor = vec4(mix(sharp.rgb, blur.rgb, amount), 1.0);
    }
`;

/**
 * Physically based depth of field: CoC from focal length (vertical FOV on a 35 mm sensor), f-stop and
 * focus distance (manual, auto-focus on the screen centre, or a picked screen point), bokeh gather at
 * half resolution with near/far handling, full resolution composite. Focus lives on the GPU; the
 * distance can be read back asynchronously (no stall) with `readFocusDistance`.
 */
export class DepthOfField {
    private readonly half: THREE.WebGLRenderTarget;
    private readonly blur: THREE.WebGLRenderTarget;
    private readonly focus: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
    private focusIndex = 0;
    private readonly focusMaterial: THREE.ShaderMaterial;
    private readonly prefilter: THREE.ShaderMaterial;
    private readonly gather: THREE.ShaderMaterial;
    private readonly composite: THREE.ShaderMaterial;
    private readonly focusUniform: THREE.IUniform<THREE.Texture | null> = {
        value: null,
    };
    private readonly cocUniforms: Record<string, THREE.IUniform>;
    private needsReset = true;
    readonly focusUv = new THREE.Vector2(0.5, 0.5);

    constructor(
        readonly quality: DofQuality,
        uniforms: FrameUniforms,
        private readonly blitter: Blitter,
        width: number,
        height: number,
    ) {
        const hw = scaledSize(width, 0.5);
        const hh = scaledSize(height, 0.5);
        this.half = colorTarget(hw, hh);
        this.blur = colorTarget(hw, hh);
        const one = () =>
            colorTarget(1, 1, {
                minFilter: THREE.NearestFilter,
                magFilter: THREE.NearestFilter,
            });
        this.focus = [one(), one()];
        this.cocUniforms = {
            tFocus: this.focusUniform,
            uFocal: { value: 0.035 },
            uFStop: { value: 5.6 },
            uMaxCoc: { value: 12 },
        };
        this.focusMaterial = fullscreenMaterial({
            name: 'WaterwaysAutofocus',
            uniforms: {
                ...uniforms,
                tPrevious: { value: null },
                uFocusUv: { value: this.focusUv },
                uManual: { value: 0 },
                uDt: { value: 0 },
                uReset: { value: 1 },
            },
            fragmentShader: FocusShader,
        });
        this.prefilter = fullscreenMaterial({
            name: 'WaterwaysDofPrefilter',
            uniforms: {
                ...uniforms,
                ...this.cocUniforms,
                tColor: { value: null },
            },
            fragmentShader: PrefilterShader,
        });
        this.gather = fullscreenMaterial({
            name: 'WaterwaysBokeh',
            uniforms: {
                tInput: { value: this.half.texture },
                uHalfTexel: { value: new THREE.Vector2(1 / hw, 1 / hh) },
                uMaxRadius: { value: 6 },
                uRadScale: { value: quality === 'high' ? 0.4 : 0.9 },
                uBlades: { value: 0 },
            },
            defines: {
                MAX_SAMPLES: quality === 'high' ? 768 : 160,
                HEXAGON: quality === 'high' ? 1 : 0,
            },
            fragmentShader: GatherShader,
        });
        this.composite = fullscreenMaterial({
            name: 'WaterwaysDofComposite',
            uniforms: {
                ...uniforms,
                ...this.cocUniforms,
                tColor: { value: null },
                tBlur: { value: this.blur.texture },
            },
            fragmentShader: CompositeShader,
        });
    }

    setSize(width: number, height: number): void {
        const hw = scaledSize(width, 0.5);
        const hh = scaledSize(height, 0.5);
        this.half.setSize(hw, hh);
        this.blur.setSize(hw, hh);
        (this.gather.uniforms.uHalfTexel.value as THREE.Vector2).set(
            1 / hw,
            1 / hh,
        );
    }

    reset(): void {
        this.needsReset = true;
    }

    render(
        input: THREE.Texture,
        output: THREE.WebGLRenderTarget,
        camera: THREE.PerspectiveCamera,
        params: {
            focusDistance: number;
            aperture: number;
            maxBlur: number;
            height: number;
            dt: number;
        },
    ): void {
        // Focus (1×1 feedback).
        const read = this.focus[this.focusIndex];
        const write = this.focus[1 - this.focusIndex];
        const fu = this.focusMaterial.uniforms;
        fu.tPrevious.value = read.texture;
        fu.uManual.value = params.focusDistance;
        fu.uDt.value = params.dt;
        fu.uReset.value = this.needsReset ? 1 : 0;
        this.blitter.draw(this.focusMaterial, write);
        this.focusIndex = 1 - this.focusIndex;
        this.focusUniform.value = write.texture;
        this.needsReset = false;

        const fovY = THREE.MathUtils.degToRad(camera.getEffectiveFOV());
        const c = this.cocUniforms;
        c.uFocal.value = (0.5 * SENSOR_HEIGHT) / Math.tan(fovY / 2);
        c.uFStop.value = Math.max(0.7, params.aperture);
        const maxCoc = Math.max(1, params.maxBlur * (params.height / 1080));
        c.uMaxCoc.value = maxCoc;

        this.prefilter.uniforms.tColor.value = input;
        this.blitter.draw(this.prefilter, this.half);

        const g = this.gather.uniforms;
        g.uMaxRadius.value = maxCoc * 0.5 + 0.5;
        g.uBlades.value = THREE.MathUtils.smoothstep(params.aperture, 2, 4);
        this.blitter.draw(this.gather, this.blur);

        this.composite.uniforms.tColor.value = input;
        this.blitter.draw(this.composite, output);
    }

    /** Last focus distance in metres, read back without stalling the GPU (resolves a frame or two later). */
    async readFocusDistance(renderer: THREE.WebGLRenderer): Promise<number> {
        const target = this.focus[this.focusIndex];
        const buffer = new Uint16Array(4);
        await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1, buffer);

        return THREE.DataUtils.fromHalfFloat(buffer[0]);
    }

    dispose(): void {
        this.half.dispose();
        this.blur.dispose();
        this.focus[0].dispose();
        this.focus[1].dispose();
        this.focusMaterial.dispose();
        this.prefilter.dispose();
        this.gather.dispose();
        this.composite.dispose();
    }
}
