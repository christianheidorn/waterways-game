import * as THREE from 'three/webgpu';
import {
    dot,
    exp,
    float,
    Fn,
    If,
    length,
    Loop,
    max,
    min,
    mix,
    select,
    sin,
    smoothstep,
    uniform,
    uv,
    vec2,
    vec3,
    vec4,
} from 'three/tsl';
import { causticPattern } from '../../world/waterPatterns';
import type {
    FloatNode,
    FrameContext,
    TextureNode,
    Vec2Node,
    Vec3Node,
    Vec4Node,
} from './common';
import { ScreenPass } from './common';

export type UnderwaterQuality = 'low' | 'high';

/** Light shaft samples along each view ray (0: no shafts). */
const SHAFT_STEPS: Record<UnderwaterQuality, number> = { low: 0, high: 10 };
/** Farthest a shaft sample reaches along the view (m). */
const SHAFT_REACH = 24;

/** Per-frame values from the water at the camera (Game: Water.underwaterLook + the sun). */
export type UnderwaterState = {
    /** Water surface height at the camera (m) and its slope there (∂h/∂x, ∂h/∂z). */
    surface: number;
    slopeX: number;
    slopeZ: number;
    /** Seconds (animations). */
    time: number;
    /** Extinction per metre (r, g, b): from the body's colour and clarity, like the water material. */
    sigma: THREE.Vector3;
    /** In-scattered light of the water (HDR), what distant things fade into. */
    fogColor: THREE.Color;
    /** Colour of the light shafts (HDR). */
    shaftColor: THREE.Color;
    /** Direction towards the sun. */
    sunDir: THREE.Vector3;
    /** Caustics: intensity (0 = off), cell size (m), depth they reach (m). */
    caustics: { intensity: number; scale: number; depth: number };
};

/**
 * The view under water (docs/ROADMAP.md phase 13), one full-screen pass over the HDR scene:
 *
 * - Waterline on the lens: each pixel's point on the near plane is tested against the surface at the
 *   camera (a plane with the local slope plus a small wobble), so a camera crossing the surface sees the
 *   picture split, with a thin dark meniscus along the line; only the part below is treated.
 * - Distortion: a slow screen-space wobble.
 * - Absorption and scattering: Beer–Lambert per channel over the view distance (depth buffer; the
 *   surface seen from below is in it too), fading into the water's in-scattered colour.
 * - Caustics: the same animated network as on shallow beds (waterPatterns.causticPattern), projected
 *   along the sun through the water above every surface under water — bed, rocks, props, the character.
 * - Light shafts (high): the caustic light sampled along the view ray, attenuated by the path down from
 *   the surface and back to the eye.
 *
 * The surface itself from below (Snell's window, total internal reflection) is drawn by the water
 * material (see waterMaterial.ts, back faces). Bypassed (no draw) while the camera is above water.
 */
export class Underwater {
    readonly pass = new ScreenPass('Underwater');
    readonly surface = uniform(0);
    readonly slope = uniform(new THREE.Vector2());
    readonly time = uniform(0);
    readonly sigma = uniform(new THREE.Vector3(0.3, 0.12, 0.08));
    readonly fogColor = uniform(new THREE.Color(0.02, 0.06, 0.07));
    readonly shaftColor = uniform(new THREE.Color(0, 0, 0));
    readonly sunDir = uniform(new THREE.Vector3(0, 1, 0));
    /** Caustics: x intensity, y cell size, z depth reached, w enabled. */
    readonly caustics = uniform(new THREE.Vector4(0.8, 2.5, 8, 1));

    constructor(
        readonly quality: UnderwaterQuality,
        f: FrameContext,
        input: TextureNode,
    ) {
        const steps = SHAFT_STEPS[quality];
        const t = this.time;

        this.pass.fragment = Fn(() => {
            const vUv = uv();
            const camPos = f.cameraWorld.mul(vec4(0, 0, 0, 1)).xyz.toVar();
            // View ray through this pixel (any finite depth gives a point on it).
            const dirView = f.viewPosition(vUv, float(0.5)).normalize().toVar();
            const dirWorld = f.cameraWorld
                .mul(vec4(dirView, 0))
                .xyz.normalize()
                .toVar();
            const waveAt = (xz: Vec2Node): FloatNode =>
                this.surface
                    .add(dot(this.slope, xz.sub(camPos.xz)))
                    .add(sin(xz.x.mul(1.7).add(t.mul(1.3))).mul(0.012))
                    .add(sin(xz.y.mul(2.3).sub(t.mul(1.1))).mul(0.01));
            // Where this pixel's ray leaves the lens (near plane): above or below the surface?
            const nearPoint = camPos.add(
                dirWorld.mul(f.near.div(dirView.z.negate().max(1e-3))),
            );
            const lens = nearPoint.y.sub(waveAt(nearPoint.xz)).toVar();
            const under = smoothstep(0.003, -0.003, lens).toVar();
            const above = input.sample(vUv).rgb;
            const result = above.toVar();

            If(under.greaterThan(0), () => {
                const wobble = vec2(
                    sin(vUv.y.mul(23).add(t.mul(2.2))),
                    sin(vUv.x.mul(19).add(t.mul(1.8)).add(1.3)),
                ).mul(0.0022);
                const suv = vUv.add(wobble).clamp(0.001, 0.999);
                const c = input.sample(suv).rgb.toVar();
                const depth = f.rawDepth(suv);
                const sky = f.isSky(depth);
                const vp = f.viewPosition(suv, depth);
                const dist = select(sky, float(1e4), length(vp)).toVar();
                const wp = f.cameraWorld.mul(vec4(vp, 1)).xyz;
                const sun = this.sunDir;
                const sunUp = smoothstep(0.02, 0.25, sun.y);

                // Caustics on everything under water (the terrain's own are switched off meanwhile).
                const k = this.caustics;
                If(
                    k.w
                        .greaterThan(0.5)
                        .and(sky.not())
                        .and(dist.lessThan(40)),
                    () => {
                        const below = this.surface.sub(wp.y).max(0);
                        const shift = sun.xz.div(max(sun.y, 0.3)).mul(below);
                        const pattern = causticPattern(
                            wp.xz.add(shift).div(max(k.y, 0.1)),
                            t.mul(0.45),
                        );
                        const reach = smoothstep(0.05, 0.4, below).mul(
                            float(1).sub(smoothstep(k.z.mul(0.4), k.z, below)),
                        );
                        // Far away the network is finer than a pixel (it would alias into noise).
                        const fade = float(1).sub(smoothstep(8, 40, dist));
                        c.mulAssign(
                            pattern
                                .mul(k.x)
                                .mul(reach)
                                .mul(sunUp)
                                .mul(fade)
                                .mul(2.5)
                                .add(1),
                        );
                    },
                );

                // Absorption along the view and in-scattering; deeper water is darker.
                const camBelow = this.surface.sub(camPos.y).max(0);
                const dim = exp(this.sigma.mul(camBelow.mul(-0.6)));
                const trans = exp(this.sigma.mul(dist.negate())) as Vec3Node;
                const water = c
                    .mul(trans)
                    .add(
                        (this.fogColor as unknown as Vec3Node)
                            .mul(dim)
                            .mul(vec3(1).sub(trans)),
                    )
                    .toVar();

                if (steps > 0) {
                    // Light shafts: caustic light gathered along the ray (jittered start, TAA smooths).
                    const reach = min(dist, SHAFT_REACH);
                    const stepLen = reach.div(steps);
                    const jitter = f.noise(3);
                    const sigmaAvg = dot(this.sigma, vec3(1 / 3));
                    const acc = float(0).toVar();
                    Loop(steps, ({ i }: { i: THREE.Node<'int'> }) => {
                        const s = float(i).add(jitter).mul(stepLen);
                        const p = camPos.add(dirWorld.mul(s));
                        const pb = this.surface.sub(p.y).max(0);
                        const q = p.xz.add(sun.xz.div(max(sun.y, 0.3)).mul(pb));
                        const a = sin(
                            q.x
                                .mul(0.9)
                                .add(sin(q.y.mul(0.7).add(t.mul(0.3))).mul(1.5))
                                .add(t.mul(0.4)),
                        );
                        const b = sin(
                            q.y
                                .mul(1.1)
                                .add(sin(q.x.mul(0.6).sub(t.mul(0.25))).mul(1.5))
                                .sub(t.mul(0.3)),
                        );
                        const shaft = smoothstep(0.35, 0.95, a.mul(b).abs());
                        acc.addAssign(
                            shaft.mul(exp(sigmaAvg.mul(s.add(pb)).negate())),
                        );
                    });
                    water.addAssign(
                        (this.shaftColor as unknown as Vec3Node)
                            .mul(acc)
                            .mul(stepLen)
                            .mul(sunUp),
                    );
                }

                result.assign(mix(above, water, under));
            });

            // The meniscus: a thin dark line where the surface crosses the lens.
            const line = exp(lens.div(0.004).pow(2).negate());
            result.mulAssign(float(1).sub(line.mul(0.45)));

            return vec4(result, 1);
        })() as Vec4Node;
    }

    /** Copies the frame's water / light values into the uniforms. */
    set(state: UnderwaterState): void {
        this.surface.value = state.surface;
        this.slope.value.set(state.slopeX, state.slopeZ);
        this.time.value = state.time;
        this.sigma.value.copy(state.sigma);
        this.fogColor.value.copy(state.fogColor);
        this.shaftColor.value.copy(state.shaftColor);
        this.sunDir.value.copy(state.sunDir);
        const c = state.caustics;
        this.caustics.value.set(
            c.intensity,
            c.scale,
            c.depth,
            c.intensity > 0 ? 1 : 0,
        );
    }
}
