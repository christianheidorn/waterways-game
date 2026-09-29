import * as THREE from 'three/webgpu';
import { float, Fn, ivec2, mix, uniform, uv, vec2, vec4 } from 'three/tsl';
import type {
    FloatNode,
    FrameContext,
    TextureNode,
    Vec2Node,
    Vec3Node,
    Vec4Node,
} from './common';
import { isSkyDepth } from '../depth';
import { ScreenPass } from './common';

export type CompositeInputs = {
    color: TextureNode;
    /** GTAO (r = visibility). */
    ao: TextureNode | null;
    /** Contact shadows (r = visibility, g = linear depth) and the size of that buffer in pixels. */
    contact: { texture: TextureNode; size: Vec2Node } | null;
    /** Screen-space reflections (premultiplied), the reflective mask and view normals. */
    ssr: {
        reflection: Vec4Node;
        gloss: FloatNode;
        normal: Vec3Node;
    } | null;
    /** Light shafts in HDR scene units, before tinting. */
    rays: TextureNode | null;
};

/**
 * HDR lighting composite at the scene resolution, one pass for all screen-space lighting terms:
 * × ambient occlusion, × contact shadows (depth-aware bilateral upsample so shadows never bleed across
 * silhouettes), screen-space reflections, + light shafts (weighted by the air in front of each surface,
 * so close foreground is not washed out).
 */
export class Composite {
    readonly pass = new ScreenPass('Composite');
    readonly contactStrength = uniform(0);
    readonly rayColor = uniform(new THREE.Vector3());
    /** 0 leaves the scene colour untouched (the editor's unlit view modes). */
    readonly enabled = uniform(1);

    constructor(f: FrameContext, inputs: CompositeInputs) {
        const { ao, contact, ssr, rays } = inputs;

        const contactShadow = (
            vUv: Vec2Node,
            tex: TextureNode,
            size: Vec2Node,
        ) => {
            const z = f.linearDepth(vUv);
            const p = vUv.mul(size).sub(0.5);
            const base = p.floor();
            const frac = p.fract();
            const maxI = size.sub(1);
            let sum: FloatNode = float(0);
            let wsum: FloatNode = float(1e-4 * 4);

            for (const [ox, oy] of [
                [0, 0],
                [1, 0],
                [0, 1],
                [1, 1],
            ]) {
                const s = tex.load(
                    ivec2(base.add(vec2(ox, oy)).clamp(vec2(0), maxI)),
                );
                const bx = ox ? frac.x : frac.x.oneMinus();
                const by = oy ? frac.y : frac.y.oneMinus();
                const w = bx
                    .mul(by)
                    .mul(
                        s.y
                            .sub(z)
                            .abs()
                            .div(z.mul(0.03).add(0.05))
                            .mul(-3)
                            .exp(),
                    );
                sum = sum.add(s.x.mul(w));
                wsum = wsum.add(w);
            }

            return sum.div(wsum);
        };

        this.pass.fragment = Fn(() => {
            const vUv = uv();
            const c = inputs.color.sample(vUv).rgb.toVar();
            // Screen-space terms belong to surfaces only. The sky dome writes no depth, but three's GTAO
            // and SSR only recognise the standard far depth (1) as sky, not the reversed one (0): left
            // alone they shade the sky with the dome's box normals (a faint box around the world).
            const surface = float(1)
                .sub(isSkyDepth(f.rawDepth(vUv)).select(float(1), float(0)))
                .mul(this.enabled)
                .toVar();

            if (ao) {
                c.mulAssign(mix(1, ao.sample(vUv).r, surface.mul(0.8)));
            }

            if (contact) {
                c.mulAssign(
                    mix(
                        1,
                        contactShadow(vUv, contact.texture, contact.size),
                        this.contactStrength.mul(surface),
                    ),
                );
            }

            if (ssr) {
                const r = ssr.reflection;
                const view = f.viewPosition(vUv, f.rawDepth(vUv)).normalize();
                const ndv = ssr.normal.dot(view.negate()).max(0);
                const fresnel = ndv.oneMinus().pow(5).mul(0.98).add(0.02);
                const hit = r.a.greaterThan(0).select(float(1), float(0));
                const w = ssr.gloss
                    .mul(fresnel)
                    .mul(hit)
                    .mul(surface)
                    .clamp(0, 1);
                c.assign(c.mul(w.oneMinus()).add(r.rgb.mul(surface)));
            }

            if (rays) {
                // In-scattering builds up with the distance travelled through the air: close surfaces
                // (a trunk or foliage right in front of the camera) get little of it.
                const air = f
                    .linearDepth(vUv)
                    .div(-25)
                    .exp()
                    .oneMinus()
                    .mul(this.enabled);
                c.addAssign(rays.sample(vUv).rgb.mul(this.rayColor).mul(air));
            }

            return vec4(c, 1);
        })() as Vec4Node;
    }
}
