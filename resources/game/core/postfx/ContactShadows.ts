import * as THREE from 'three/webgpu';
import { Break, float, Fn, If, Loop, uniform, uv, vec4 } from 'three/tsl';
import type { FrameContext, Vec4Node } from './common';
import { ScreenPass } from './common';

const STEPS = 16;

/**
 * Screen-space contact shadows (half the scene resolution): a short ray march from each surface towards
 * the light through the depth buffer catches the small-scale occlusion shadow maps miss (feet, rocks and
 * grass bases, crevices). The ray length scales with distance so the effect stays a few pixels long.
 * Output: r = light visibility (1 = unshadowed), g = linear depth (for the bilateral upsample).
 */
export class ContactShadows {
    readonly pass = new ScreenPass('Contact shadows', {
        filter: THREE.NearestFilter,
    });
    /** Direction towards the light in view space. */
    readonly lightDirView = uniform(new THREE.Vector3(0, 1, 0));

    constructor(f: FrameContext) {
        const pass = this.pass;
        pass.fragment = Fn(() => {
            const vUv = uv();
            const texel = pass.resolution.reciprocal();
            const d = f.rawDepth(vUv);
            const z = f.linearize(d);
            const result = vec4(1, z, 0, 1).toVar();

            If(f.isSky(d).not(), () => {
                const p = f.viewPosition(vUv, d).toVar();
                const n = f.viewNormal(vUv, p, texel).toVar();
                const ndl = n.dot(this.lightDirView).toVar();

                // Faces turned away from the light are already dark (and self-shadow in the shadow map).
                If(ndl.greaterThan(0.02).and(z.lessThan(400)), () => {
                    // About 5 % of the distance: a few dozen pixels on screen at any range.
                    const rayLength = z.mul(0.05).clamp(0.3, 4);
                    // Assumed occluder thickness: rays towards a light behind the camera pass behind an
                    // occluder's front face, so this must cover rocks and bushes (not a trunk metres away).
                    const thickness = z
                        .mul(0.05)
                        .add(0.3)
                        .clamp(0.3, 4)
                        .toVar();
                    // Start slightly off the surface (along the normal) to avoid self-intersection.
                    const origin = p.add(n.mul(z.mul(0.004).add(0.03))).toVar();
                    const stepVec = this.lightDirView
                        .mul(rayLength.div(STEPS))
                        .toVar();
                    const jitter = f.noise().toVar();
                    const occlusion = float(0).toVar();
                    const bias = z.mul(0.003).add(0.02).toVar();

                    Loop(STEPS, ({ i }) => {
                        const t = float(i).add(jitter);
                        const q = origin.add(stepVec.mul(t)).toVar();
                        const suv = f.viewToUv(q).toVar();

                        If(
                            suv.x
                                .lessThan(0)
                                .or(suv.y.lessThan(0))
                                .or(suv.x.greaterThan(1))
                                .or(suv.y.greaterThan(1)),
                            () => {
                                Break();
                            },
                        );

                        const delta = q.z.negate().sub(f.linearDepth(suv));

                        If(
                            delta
                                .greaterThan(bias)
                                .and(delta.lessThan(thickness)),
                            () => {
                                // Fade with distance along the ray so the shadow tapers off.
                                occlusion.assign(t.div(STEPS).oneMinus());
                                Break();
                            },
                        );
                    });

                    // Grazing light: fade to avoid acne on surfaces almost parallel to the light.
                    occlusion.mulAssign(
                        ndl
                            .smoothstep(0.02, 0.2)
                            .mul(z.smoothstep(200, 400).oneMinus()),
                    );
                    result.x.assign(occlusion.oneMinus());
                });
            });

            return result;
        })() as Vec4Node;
    }

    setLight(lightDir: THREE.Vector3, camera: THREE.Camera): void {
        this.lightDirView.value
            .copy(lightDir)
            .transformDirection(camera.matrixWorldInverse);
    }
}
