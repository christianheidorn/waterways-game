import * as THREE from 'three/webgpu';
import { float, Fn, If, Loop, uniform, uv, vec2, vec4 } from 'three/tsl';
import type { FrameContext, TextureNode, Vec2Node, Vec4Node } from './common';
import { ScreenPass } from './common';

export type MotionBlurQuality = 'low' | 'high';

/**
 * Per-pixel motion blur from the scene pass' motion vectors (camera, skinned and instanced motion); the
 * sky, which has no geometry, is reprojected with the camera matrices. The blur vector is the motion
 * during the shutter time (strength 1 = 180° shutter at 24 fps, frame rate independent), clamped to a
 * maximum length. Samples are centred on the pixel and jittered; a sample only contributes where its own
 * motion reaches the centre, so still foreground (the player) never smears into the moving background.
 */
export class MotionBlur {
    readonly pass = new ScreenPass('Motion blur');
    /** Previous view-projection × inverse current view-projection (un-jittered). */
    readonly reprojection = uniform(new THREE.Matrix4());
    private readonly shutter = uniform(1);
    private readonly maxLength = uniform(32);

    constructor(
        readonly quality: MotionBlurQuality,
        f: FrameContext,
        input: TextureNode,
        velocity: TextureNode,
    ) {
        const samples = quality === 'high' ? 24 : 10;
        const pass = this.pass;

        const motionAt = (p: Vec2Node): Vec2Node => {
            const result = velocity.sample(p).xy.mul(vec2(0.5, -0.5)).toVar();

            If(f.isSky(f.rawDepth(p)), () => {
                const ndc = vec4(
                    p.x.mul(2).sub(1),
                    p.y.mul(-2).add(1),
                    f.farDepth,
                    1,
                );
                const prev = this.reprojection.mul(ndc);
                const prevUv = prev.xy
                    .div(prev.w)
                    .mul(vec2(0.5, -0.5))
                    .add(0.5);
                result.assign(
                    prev.w.greaterThan(0).select(p.sub(prevUv), vec2(0)),
                );
            });

            return result;
        };

        /** Motion in pixels scaled to the shutter and clamped. */
        const blurVector = (p: Vec2Node): Vec2Node => {
            const v = motionAt(p).mul(pass.resolution).mul(this.shutter);
            const len = v.length();

            return len
                .greaterThan(this.maxLength)
                .select(v.mul(this.maxLength.div(len)), v);
        };

        pass.fragment = Fn(() => {
            const vUv = uv();
            const center = input.sample(vUv).rgb.toVar();
            const v = blurVector(vUv).toVar();
            const len = v.length().toVar();
            const result = vec4(center, 1).toVar();

            If(len.greaterThanEqual(0.5), () => {
                const texel = pass.resolution.reciprocal();
                const jitter = f.noise().sub(0.5).toVar();
                const sum = center.toVar();
                const weight = float(1).toVar();

                Loop(samples, ({ i }) => {
                    const t = float(i)
                        .add(0.5)
                        .add(jitter)
                        .div(samples)
                        .sub(0.5);
                    const sampleUv = vUv.add(v.mul(t).mul(texel)).toVar();
                    const dist = t.abs().mul(len);
                    // A sample counts when its own blur reaches back to this pixel.
                    const w = blurVector(sampleUv)
                        .length()
                        .div(dist.max(1e-3))
                        .clamp(0, 1);
                    sum.addAssign(input.sample(sampleUv).rgb.mul(w));
                    weight.addAssign(w);
                });

                result.assign(vec4(sum.div(weight), 1));
            });

            return result;
        })() as Vec4Node;
    }

    update(strength: number, dt: number, height: number): void {
        // Shutter: strength × 1/48 s, relative to the frame time the motion vectors cover.
        this.shutter.value = strength / 48 / Math.max(1 / 240, dt);
        this.maxLength.value = 48 * (height / 1080);
    }
}
