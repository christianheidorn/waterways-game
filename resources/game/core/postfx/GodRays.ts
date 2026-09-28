import * as THREE from 'three/webgpu';
import { float, Fn, If, Loop, uniform, uv, vec2, vec3, vec4 } from 'three/tsl';
import type { FrameContext, TextureNode, Vec4Node } from './common';
import { ScreenPass } from './common';

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

const tmp = new THREE.Vector4();

/**
 * Screen-space volumetric light scattering from the sun (or moon at night): a low resolution occlusion
 * mask from depth + sky brightness, then 1-3 iterated radial blur passes towards the light (GPU Gems 3
 * ch. 13). The result (HDR scene units) is added in the lighting composite, tinted by the light colour
 * and faded as the light leaves the screen, goes behind the camera or below the horizon.
 */
export class GodRays {
    readonly passes: ScreenPass[] = [];
    /** Light position in screen UV (TSL convention, origin top left). */
    readonly lightUv = uniform(new THREE.Vector2(0.5, 0.5));
    private readonly lightDirView = uniform(new THREE.Vector3(0, 0, -1));
    private readonly exposure = uniform(1);
    readonly settings: (typeof QUALITY)[GodRayQuality];
    /** 0-1: how much of the effect is visible this frame (0 skips the passes). */
    visibility = 0;

    constructor(
        readonly quality: GodRayQuality,
        f: FrameContext,
        sceneColor: TextureNode,
    ) {
        const s = (this.settings = QUALITY[quality]);

        // Occlusion mask: bright sky around the light emits, everything with depth occludes. Emission is
        // the sky's own (display referred, clamped) brightness above a threshold inside an angular window,
        // so clouds in front of the sun naturally weaken and break up the shafts.
        const mask = new ScreenPass('Light shafts');
        mask.fragment = Fn(() => {
            const vUv = uv();
            // 2×2 depth taps over this texel's footprint so thin occluders (branches) survive.
            const o = mask.resolution.reciprocal().mul(0.25);
            const d = f
                .rawDepth(vUv.add(vec2(o.x.negate(), o.y.negate())))
                .min(f.rawDepth(vUv.add(vec2(o.x, o.y.negate()))))
                .min(f.rawDepth(vUv.add(vec2(o.x.negate(), o.y))))
                .min(f.rawDepth(vUv.add(o)));
            const result = vec4(0).toVar();

            If(f.isSky(d), () => {
                const dir = f.viewPosition(vUv, float(1)).normalize();
                const c = dir.dot(this.lightDirView).max(0);
                const window = c.pow(24).add(c.pow(256));
                const sky = sceneColor.sample(vUv).rgb.mul(this.exposure);
                const emit = sky.sub(0.8).max(0).min(2);
                result.assign(vec4(emit.mul(window), 1));
            });

            return result;
        })() as Vec4Node;
        this.passes.push(mask);

        let input = mask;

        for (let pass = 0; pass < s.passes; pass++) {
            const blur = new ScreenPass('Light shafts');
            const source = input.getTextureNode();
            const decay = s.passes > 1 ? 0.985 : 0.965;
            // Pass i covers 1/samples^i of the ray: the first spans the full distance, later ones fill in.
            const stepScale =
                (s.passes > 1 ? 0.9 : 0.75) / Math.pow(s.samples, pass * 0.85);
            blur.fragment = Fn(() => {
                const vUv = uv();
                const delta = this.lightUv
                    .sub(vUv)
                    .mul(stepScale / s.samples)
                    .toVar();
                const p = vUv.add(delta.mul(f.noise(pass * 17))).toVar();
                const sum = vec3(0).toVar();
                const weight = float(0).toVar();
                const w = float(1).toVar();

                Loop(s.samples, () => {
                    const inside = p
                        .greaterThanEqual(vec2(0))
                        .all()
                        .and(p.lessThanEqual(vec2(1)).all());
                    sum.addAssign(
                        source
                            .sample(p)
                            .rgb.mul(w)
                            .mul(inside.select(float(1), float(0))),
                    );
                    weight.addAssign(w);
                    w.mulAssign(decay);
                    p.addAssign(delta);
                });

                return vec4(sum.div(weight), 1);
            })() as Vec4Node;
            this.passes.push(blur);
            input = blur;
        }
    }

    /** The shafts (after the last blur pass). */
    get output(): ScreenPass {
        return this.passes[this.passes.length - 1];
    }

    /** Resolution relative to the drawing buffer, given the scene pass' scale. */
    setSceneScale(scale: number): void {
        for (const pass of this.passes) {
            pass.scale = this.settings.scale * scale;
        }
    }

    /**
     * Projects the light direction to the screen; returns the visibility factor (sets `visibility`).
     * `viewProj` is the un-jittered view-projection.
     */
    locate(
        lightDir: THREE.Vector3,
        camera: THREE.Camera,
        viewProj: THREE.Matrix4,
        exposure: number,
    ): number {
        this.exposure.value = exposure;
        const view = this.lightDirView.value
            .copy(lightDir)
            .transformDirection(camera.matrixWorldInverse);
        const p = tmp.set(lightDir.x, lightDir.y, lightDir.z, 0);
        p.applyMatrix4(viewProj);

        if (p.w <= 1e-4) {
            this.visibility = 0;

            return 0;
        }

        const u = (p.x / p.w) * 0.5 + 0.5;
        const v = 0.5 - (p.y / p.w) * 0.5;
        this.lightUv.value.set(u, v);
        // Fade as the light moves beyond the screen edge (rays still stream in from just outside).
        const dx = Math.max(0, Math.abs(u - 0.5) - 0.5);
        const dy = Math.max(0, Math.abs(v - 0.5) - 0.5);
        const off = Math.hypot(dx, dy);
        const facing = THREE.MathUtils.smoothstep(-view.z, 0.05, 0.35);
        this.visibility =
            facing * (1 - THREE.MathUtils.smoothstep(off, 0.1, 0.6));

        return this.visibility;
    }

    /** Skips every pass (consumers read `black`) while the shafts are invisible. */
    setActive(active: boolean, black: THREE.Texture): void {
        for (const pass of this.passes) {
            pass.setBypass(active ? null : black);
        }
    }
}
