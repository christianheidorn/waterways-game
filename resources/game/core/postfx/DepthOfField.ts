import * as THREE from 'three/webgpu';
import {
    Break,
    cos,
    float,
    Fn,
    If,
    Loop,
    mix,
    sin,
    uniform,
    uv,
    vec2,
    vec4,
} from 'three/tsl';
import type { FloatNode, FrameContext, TextureNode, Vec4Node } from './common';
import { ScreenPass } from './common';

export type DofQuality = 'low' | 'high';

/** Full-frame 35 mm sensor height: focal length follows from the vertical field of view. */
const SENSOR_HEIGHT = 0.024;
const GOLDEN_ANGLE = 2.39996323;

/**
 * Physically based depth of field: CoC from focal length (vertical FOV on a 35 mm sensor), f-stop and
 * focus distance (manual, auto-focus on the screen centre, or a picked screen point), scatter-as-gather
 * bokeh at half resolution with near/far handling, full resolution composite. The focus distance lives
 * on the GPU (1×1 feedback target) and can be read back asynchronously with `readFocusDistance`.
 */
export class DepthOfField {
    readonly passes: ScreenPass[];
    readonly output: ScreenPass;
    private readonly focus: ScreenPass;
    /** Screen point auto-focus measures (TSL UV, origin top left). */
    readonly focusUv = uniform(new THREE.Vector2(0.5, 0.5));
    private readonly manual = uniform(0);
    private readonly dt = uniform(0);
    private readonly reset = uniform(1);
    private readonly focal = uniform(0.035);
    private readonly fStop = uniform(5.6);
    private readonly maxCoc = uniform(12);
    /** Image height in pixels the CoC is measured in (the output resolution). */
    private readonly imageHeight = uniform(1080);
    private readonly maxRadius = uniform(6);
    private readonly blades = uniform(0);
    private readonly aspect = uniform(1);
    private needsReset = true;

    constructor(
        readonly quality: DofQuality,
        f: FrameContext,
        input: TextureNode,
    ) {
        const focus = (this.focus = new ScreenPass('DoF', {
            size: [1, 1],
            filter: THREE.NearestFilter,
            feedback: true,
        }));
        focus.fragment = Fn(() => {
            const target = float(0).toVar();

            If(this.manual.greaterThan(0), () => {
                target.assign(this.manual);
            }).Else(() => {
                // Mean log depth of 9 taps in a small disc (robust against a single thin occluder).
                const acc = float(0).toVar();

                for (let i = 0; i < 9; i++) {
                    const a = i * GOLDEN_ANGLE;
                    const r = 0.012 * Math.sqrt(i / 8);
                    const o =
                        i === 0
                            ? vec2(0)
                            : vec2(
                                  Math.cos(a) * r,
                                  this.aspect.mul(Math.sin(a) * r),
                              );
                    const d = f.rawDepth(this.focusUv.add(o).clamp(0, 1));
                    acc.addAssign(f.linearize(d).min(f.far).log());
                }

                target.assign(acc.div(9).exp());
            });

            const previous = focus.previous.sample(vec2(0.5)).r;
            const result = target.toVar();

            If(this.reset.lessThan(0.5).and(previous.greaterThan(0)), () => {
                // Focus pulls ease in log space (perceptually even for near and far changes).
                const k = this.dt
                    .negate()
                    .mul(this.manual.greaterThan(0).select(10, 4))
                    .exp()
                    .oneMinus();
                result.assign(mix(previous.log(), target.log(), k).exp());
            });

            return vec4(result, 0, 0, 1);
        })() as Vec4Node;

        const focusDistance = focus.getTextureNode().sample(vec2(0.5)).r;

        /**
         * Signed circle of confusion in output pixels (negative = in front of the focus plane), from the
         * thin lens equation: c = (f² / N) · (z − z_f) / (z · (z_f − f)), scaled from the sensor to the
         * image height.
         */
        const coc = (z: FloatNode, zf: FloatNode): FloatNode =>
            this.focal
                .mul(this.focal)
                .div(this.fStop)
                .mul(z.sub(zf))
                .div(z.mul(zf.sub(this.focal).max(1e-3)))
                .div(SENSOR_HEIGHT)
                .mul(this.imageHeight)
                .clamp(this.maxCoc.negate(), this.maxCoc);

        // Half resolution colour + signed CoC (alpha). Near-field CoC wins so foreground edges spread.
        const prefilter = new ScreenPass('DoF', { scale: 0.5 });
        prefilter.fragment = Fn(() => {
            const vUv = uv();
            const zf = focusDistance;
            // Offsets of the four full resolution texels under this half resolution texel.
            const o = prefilter.resolution.reciprocal().mul(0.25);
            const c0 = coc(f.linearDepth(vUv.sub(o)), zf);
            const c1 = coc(f.linearDepth(vUv.add(vec2(o.x, o.y.negate()))), zf);
            const c2 = coc(f.linearDepth(vUv.add(vec2(o.x.negate(), o.y))), zf);
            const c3 = coc(f.linearDepth(vUv.add(o)), zf);
            const near = c0.min(c1).min(c2.min(c3));
            const size = near
                .lessThan(0)
                .select(near, c0.add(c1).add(c2).add(c3).mul(0.25));
            // The gather spreads every sample over a large area: keep NaN / Inf out of it.
            const color = input.sample(vUv).rgb.clamp(0, 65000);

            return vec4(color, size);
        })() as Vec4Node;

        /**
         * Scatter-as-gather bokeh (after Gustafsson, "Bokeh depth of field in a single pass"): a golden
         * angle spiral out to the maximum radius; each sample contributes where its own CoC covers the
         * distance. Samples behind the centre are limited to twice the centre's CoC, so blurry
         * backgrounds never bleed over sharp foregrounds while blurry foregrounds do spread over what is
         * behind them. High quality uses a denser spiral shaped into a hexagon (6 aperture blades) when
         * stopped down, a disc when wide open.
         */
        const gather = new ScreenPass('DoF', { scale: 0.5 });
        const half = prefilter.getTextureNode();
        const radScale = quality === 'high' ? 0.4 : 0.9;
        const maxSamples = quality === 'high' ? 768 : 160;
        gather.fragment = Fn(() => {
            const vUv = uv();
            const halfTexel = gather.resolution.reciprocal();
            const center = half.sample(vUv).toVar();
            const centerSize = center.a.abs().mul(0.5).toVar();
            const color = center.rgb.toVar();
            const size = centerSize.toVar();
            const tot = float(1).toVar();
            const radius = float(radScale).toVar();
            const angle = float(0).toVar();

            Loop(maxSamples, () => {
                If(radius.greaterThanEqual(this.maxRadius), () => {
                    Break();
                });

                const dir = vec2(cos(angle), sin(angle));
                let shape: FloatNode = float(1);

                if (quality === 'high') {
                    // Hexagon boundary relative to its circumcircle, rotated a little like a real aperture.
                    const seg = angle.add(0.26).mod(1.04719755).sub(0.52359878);
                    shape = mix(
                        float(1),
                        float(0.8660254).div(cos(seg)),
                        this.blades,
                    );
                }

                const s = half
                    .sample(vUv.add(dir.mul(radius.mul(shape)).mul(halfTexel)))
                    .toVar();
                const sampleSize = s.a.abs().mul(0.5).toVar();

                If(s.a.greaterThan(center.a), () => {
                    sampleSize.assign(sampleSize.clamp(0, centerSize.mul(2)));
                });

                const m = sampleSize.smoothstep(
                    radius.sub(0.5),
                    radius.add(0.5),
                );
                color.addAssign(mix(color.div(tot), s.rgb, m));
                size.addAssign(mix(size.div(tot), sampleSize, m));
                tot.addAssign(1);
                radius.addAssign(float(radScale).div(radius));
                angle.addAssign(GOLDEN_ANGLE);
            });

            return vec4(color.div(tot), size.div(tot));
        })() as Vec4Node;

        // Full resolution: the sharp image where in focus, the half resolution bokeh elsewhere.
        const composite = new ScreenPass('DoF');
        const blurred = gather.getTextureNode();
        composite.fragment = Fn(() => {
            const vUv = uv();
            const sharp = input.sample(vUv).rgb;
            const c = coc(f.linearDepth(vUv), focusDistance);
            const blur = blurred.sample(vUv);
            // Blur sizes are half resolution pixels: below ~1 output pixel the sharp image is exact.
            const amount = c.abs().mul(0.5).max(blur.a).smoothstep(0.35, 1.25);

            return vec4(mix(sharp, blur.rgb, amount), 1);
        })() as Vec4Node;

        this.passes = [focus, prefilter, gather, composite];
        this.output = composite;
    }

    /** Resolution relative to the drawing buffer (the post chain's scale). */
    setScale(scale: number): void {
        this.passes[1].scale = 0.5 * scale;
        this.passes[2].scale = 0.5 * scale;
        this.passes[3].scale = scale;
    }

    resetFocus(): void {
        this.needsReset = true;
    }

    update(
        camera: THREE.PerspectiveCamera,
        params: {
            focusDistance: number;
            aperture: number;
            maxBlur: number;
            height: number;
            dt: number;
        },
    ): void {
        this.manual.value = params.focusDistance;
        this.dt.value = params.dt;
        this.reset.value = this.needsReset ? 1 : 0;
        this.needsReset = false;
        const fovY = THREE.MathUtils.degToRad(camera.getEffectiveFOV());
        this.focal.value = (0.5 * SENSOR_HEIGHT) / Math.tan(fovY / 2);
        this.fStop.value = Math.max(0.7, params.aperture);
        // dof_max_blur is specified at 1080p and scales with the image height.
        const maxCoc = Math.max(1, params.maxBlur * (params.height / 1080));
        this.maxCoc.value = maxCoc;
        this.imageHeight.value = params.height;
        this.aspect.value = camera.aspect;
        this.maxRadius.value = maxCoc * 0.5 + 0.5;
        this.blades.value = THREE.MathUtils.smoothstep(params.aperture, 2, 4);
    }

    /** Last focus distance in metres, read back without stalling the GPU (resolves a frame or two later). */
    async readFocusDistance(renderer: THREE.Renderer): Promise<number> {
        const data = await renderer.readRenderTargetPixelsAsync(
            this.focus.renderTarget,
            0,
            0,
            1,
            1,
        );

        return data instanceof Uint16Array
            ? THREE.DataUtils.fromHalfFloat(data[0])
            : Number(data[0]);
    }
}
