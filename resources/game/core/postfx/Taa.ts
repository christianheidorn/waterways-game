import * as THREE from 'three/webgpu';
import {
    abs,
    float,
    Fn,
    If,
    max,
    mix,
    select,
    uniform,
    uv,
    vec2,
    vec3,
    vec4,
    velocity,
} from 'three/tsl';
import { nearerDepth } from '../depth';
import type {
    FloatNode,
    TextureNode,
    Vec2Node,
    Vec3Node,
    Vec4Node,
} from './common';
import { luma, ScreenPass } from './common';

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

const toYCoCg = (c: Vec3Node): Vec3Node =>
    vec3(
        c.dot(vec3(0.25, 0.5, 0.25)),
        c.dot(vec3(0.5, 0, -0.5)),
        c.dot(vec3(-0.25, 0.5, -0.25)),
    );

const fromYCoCg = (c: Vec3Node): Vec3Node => {
    const t = c.x.sub(c.z);

    return vec3(t.add(c.y), c.x.add(c.z), t.sub(c.y));
};

/**
 * Temporal anti-aliasing at the scene resolution (Karis 2014 / Playdead INSIDE style), in HDR, as the
 * pre-WebGPU renderer did it:
 *
 * - The projection is jittered by a 16-sample Halton sequence; the current frame is reconstructed at the
 *   un-jittered pixel centres with a Blackman-Harris-like 3×3 filter, so the resolve target doesn't move
 *   with the jitter (a still image of sub-pixel detail — distant foliage, the horizon — stays still).
 * - History is reprojected with the motion vector of the closest 3×3 neighbour (edges follow the
 *   foreground) and sampled with a 5-tap Catmull-Rom filter, which keeps the resolve sharp.
 * - History is clipped towards the neighbourhood (variance clipping of the YCoCg distribution, clip not
 *   clamp) in a perceptual space (c / (1 + luma), exposure aware) so bright highlights don't ghost; the
 *   box is looser when still (less flicker) and tighter under motion (less ghosting).
 * - Blend factor: 5 % when still (≈ 20 samples of super-sampling), up to 20 % under fast motion; 100 %
 *   where the history is off-screen and after a reset (camera cut, resize).
 */
export class TemporalAA {
    readonly pass = new ScreenPass('TAA', { feedback: true });
    /** Current jitter (pixels, x right / y down): pixel p shows the scene at p + jitter. */
    private readonly jitter = uniform(new THREE.Vector2());
    private readonly reset = uniform(1);
    private readonly unjittered = new THREE.Matrix4();
    private readonly size = new THREE.Vector2();
    private index = 0;
    private needsReset = true;

    constructor(
        input: TextureNode,
        depth: TextureNode,
        motion: TextureNode,
        /** Exposure the image will be displayed with (perceptual weighting). */
        exposure: FloatNode,
        private readonly camera: THREE.PerspectiveCamera,
    ) {
        const pass = this.pass;
        const history = pass.previous;

        const compress = (c: Vec3Node): Vec3Node => {
            const e = c.max(0).mul(exposure);

            return toYCoCg(e.div(luma(e).add(1)));
        };
        const expand = (y: Vec3Node): Vec3Node => {
            const c = fromYCoCg(y);

            return c.div(max(float(1).sub(luma(c)), 1e-3)).div(exposure);
        };

        // Catmull-Rom with 5 bilinear taps (the four corner taps have negligible weight).
        const sampleHistory = (p: Vec2Node, size: Vec2Node): Vec3Node => {
            const pos = p.mul(size);
            const center = pos.sub(0.5).floor().add(0.5);
            const f = pos.sub(center);
            const w0 = f.mul(f.mul(float(1).sub(f.mul(0.5))).sub(0.5));
            const w1 = f.mul(f).mul(f.mul(1.5).sub(2.5)).add(1);
            const w2 = f.mul(f.mul(float(2).sub(f.mul(1.5))).add(0.5));
            const w3 = f.mul(f).mul(f.mul(0.5).sub(0.5));
            const w12 = w1.add(w2);
            const tc0 = center.sub(1).div(size);
            const tc3 = center.add(2).div(size);
            const tc12 = center.add(w2.div(w12)).div(size);
            const tap = (x: FloatNode, y: FloatNode) =>
                history.sample(vec2(x, y)).rgb as Vec3Node;
            const c = tap(tc12.x, tc0.y)
                .mul(w12.x.mul(w0.y))
                .add(tap(tc0.x, tc12.y).mul(w0.x.mul(w12.y)))
                .add(tap(tc12.x, tc12.y).mul(w12.x.mul(w12.y)))
                .add(tap(tc3.x, tc12.y).mul(w3.x.mul(w12.y)))
                .add(tap(tc12.x, tc3.y).mul(w12.x.mul(w3.y)));
            const wsum = w12.x
                .mul(w0.y)
                .add(w0.x.mul(w12.y))
                .add(w12.x.mul(w12.y))
                .add(w3.x.mul(w12.y))
                .add(w12.x.mul(w3.y));

            return c.div(wsum).max(0);
        };

        const clipAabb = (
            lo: Vec3Node,
            hi: Vec3Node,
            q: Vec3Node,
        ): Vec3Node => {
            const extents = hi.sub(lo).mul(0.5).max(1e-5);
            const mid = hi.add(lo).mul(0.5);
            const v = q.sub(mid);
            const a = abs(v.div(extents));
            const m = max(a.x, max(a.y, a.z));

            return select(m.greaterThan(1), mid.add(v.div(m)), q);
        };

        pass.fragment = Fn(() => {
            const vUv = uv();
            const size = pass.resolution;
            const texel = size.reciprocal();
            const m1 = vec3(0).toVar();
            const m2 = vec3(0).toVar();
            const lo = vec3(1e9).toVar();
            const hi = vec3(-1e9).toVar();
            const filtered = vec3(0).toVar();
            const wsum = float(0).toVar();
            const closest = depth.sample(vUv).r.toVar();
            const closestOffset = vec2(0).toVar();

            for (let y = -1; y <= 1; y++) {
                for (let x = -1; x <= 1; x++) {
                    const o = vec2(x, y);
                    const p = vUv.add(o.mul(texel));
                    const c = compress(input.sample(p).rgb as Vec3Node).toVar();
                    // Pixel (x, y) shows the scene at its centre + jitter, relative to this pixel.
                    const d = o.add(this.jitter);
                    const w = d.dot(d).mul(-2.29).exp();
                    filtered.addAssign(c.mul(w));
                    wsum.addAssign(w);
                    m1.addAssign(c);
                    m2.addAssign(c.mul(c));
                    lo.assign(lo.min(c));
                    hi.assign(hi.max(c));

                    if (x !== 0 || y !== 0) {
                        const z = depth.sample(p).r;

                        If(nearerDepth(z, closest).notEqual(closest), () => {
                            closest.assign(z);
                            closestOffset.assign(o);
                        });
                    }
                }
            }

            const current = filtered.div(wsum).toVar();
            // Motion vectors are NDC deltas (y up): → UV (y down).
            const motionUv = motion
                .sample(vUv.add(closestOffset.mul(texel)))
                .xy.mul(vec2(0.5, -0.5))
                .toVar();
            const historyUv = vUv.sub(motionUv).toVar();
            const result = current.toVar();
            const offscreen = historyUv
                .lessThan(vec2(0))
                .any()
                .or(historyUv.greaterThan(vec2(1)).any());

            If(this.reset.lessThan(0.5).and(offscreen.not()), () => {
                const past = compress(sampleHistory(historyUv, size));
                const mu = m1.div(9);
                const sigma = m2.div(9).sub(mu.mul(mu)).abs().sqrt();
                const motionPx = motionUv.mul(size).length();
                const gamma = mix(1.25, 0.9, motionPx.div(4).clamp(0, 1));
                const boxLo = lo.max(mu.sub(sigma.mul(gamma)));
                const boxHi = hi.min(mu.add(sigma.mul(gamma)));
                const alpha = mix(0.05, 0.2, motionPx.div(6).clamp(0, 1));
                result.assign(
                    mix(clipAabb(boxLo, boxHi, past), current, alpha),
                );
            });

            return vec4(expand(result).max(0), 1);
        })() as Vec4Node;
    }

    /** Drops the history (camera cut); the next frame starts from the current image. */
    resetHistory(): void {
        this.needsReset = true;
    }

    /**
     * Jitters the camera for this frame's scene render (`width` × `height`: the scene pass size) and keeps
     * the motion vectors un-jittered. Call right before the pipeline renders, `end()` right after.
     */
    begin(width: number, height: number): void {
        const camera = this.camera;

        if (width !== this.size.x || height !== this.size.y) {
            // Resized targets hold no history.
            this.size.set(width, height);
            this.needsReset = true;
        }

        this.reset.value = this.needsReset ? 1 : 0;
        this.needsReset = false;
        this.index = (this.index + 1) % JITTER.length;
        const [jx, jy] = JITTER[this.index];
        this.jitter.value.set(jx, jy);
        camera.updateProjectionMatrix();
        this.unjittered.copy(camera.projectionMatrix);
        (velocity as unknown as VelocityNode).setProjectionMatrix(
            this.unjittered,
        );
        camera.setViewOffset(width, height, jx, jy, width, height);
    }

    end(): void {
        this.camera.clearViewOffset();
        (velocity as unknown as VelocityNode).setProjectionMatrix(null);
    }
}

type VelocityNode = { setProjectionMatrix(matrix: THREE.Matrix4 | null): void };
