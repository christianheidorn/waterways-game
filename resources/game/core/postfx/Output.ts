import * as THREE from 'three/webgpu';
import {
    float,
    Fn,
    hash,
    mix,
    screenCoordinate,
    sRGBTransferOETF,
    toneMapping,
    texture,
    uniform,
    uv,
    vec2,
    vec3,
    vec4,
} from 'three/tsl';
import { colorGradeLut, LUT_SIZE } from './ColorLut';
import type {
    FloatNode,
    TextureNode,
    Vec2Node,
    Vec3Node,
    Vec4Node,
} from './common';
import { luma } from './common';

/** Which optional parts of the display transform exist (a change rebuilds the output graph). */
export type OutputFeatures = {
    aberration: boolean;
    sharpen: boolean;
    lut: boolean;
    grade: boolean;
    grain: boolean;
    letterbox: boolean;
};

export type OutputInputs = {
    /** Final HDR image (scene-linear). */
    hdr: TextureNode;
    bloom: TextureNode | null;
    flare: TextureNode | null;
    /** Eye adaptation multiplier. */
    eye: FloatNode | null;
};

/**
 * The display transform, split in two so anti-aliasing / spatial upscaling can sit in between:
 *
 * - `display`: scene-referred chromatic aberration (radial, per channel lookups), + bloom, + lens flare,
 *   × eye adaptation × white balance → tone mapping (renderer.toneMapping; base exposure =
 *   renderer.toneMappingExposure × 2^EV compensation) → sRGB. Display-referred: CAS-like sharpening
 *   (neighbours are tone mapped too), 3D LUT grade blended by intensity, saturation / contrast, vignette.
 * - `finish` (at the output resolution): luma-weighted animated film grain, ±½ LSB dither against
 *   banding in the 8-bit output, letterbox bars.
 */
export class OutputStage {
    readonly exposure = uniform(1);
    readonly whiteBalance = uniform(new THREE.Vector3(1, 1, 1));
    readonly lutIntensity = uniform(1);
    readonly saturation = uniform(1);
    readonly contrast = uniform(1);
    readonly vignette = uniform(0);
    readonly sharpen = uniform(0);
    readonly aberration = uniform(0);
    readonly grain = uniform(0);
    /** Letterbox bar sizes in UV (x: pillarbox, y: letterbox). */
    readonly letterbox = uniform(new THREE.Vector2());
    /** Canvas aspect ratio (width / height). */
    readonly aspect = uniform(1);
    readonly frame = uniform(0);
    readonly lut = texture(colorGradeLut('neutral'));

    display(
        inputs: OutputInputs,
        features: OutputFeatures,
        mapping: THREE.ToneMapping,
        srgb: boolean,
    ): Vec4Node {
        const { hdr, bloom, flare, eye } = inputs;

        const sceneAt = (p: Vec2Node): Vec3Node => {
            let c: Vec3Node;

            if (features.aberration) {
                // Lateral chromatic aberration grows towards the edges (r pushed out, b pulled in).
                const d = p.sub(0.5);
                const da = d.mul(vec2(this.aspect, 1));
                const o = d.mul(da.dot(da)).mul(this.aberration.mul(0.014));
                const split = (t: TextureNode) =>
                    vec3(
                        t.sample(p.sub(o)).r,
                        t.sample(p).g,
                        t.sample(p.add(o)).b,
                    );
                c = split(hdr);

                if (bloom) {
                    c = c.add(split(bloom));
                }
            } else {
                c = hdr.sample(p).rgb;

                if (bloom) {
                    c = c.add(bloom.sample(p).rgb);
                }
            }

            if (flare) {
                c = c.add(flare.sample(p).rgb);
            }

            return c;
        };

        const scale = eye
            ? this.whiteBalance.mul(eye)
            : (this.whiteBalance as unknown as Vec3Node);

        const toDisplay = (c: Vec3Node): Vec3Node => {
            const mapped = toneMapping(
                mapping,
                this.exposure,
                vec4(c.max(0).mul(scale), 1),
            ) as unknown as Vec4Node;
            const encoded = srgb
                ? (sRGBTransferOETF(mapped.rgb) as unknown as Vec3Node)
                : mapped.rgb;

            return encoded.clamp(0, 1);
        };

        return Fn(() => {
            const vUv = uv();
            const col = toDisplay(sceneAt(vUv)).toVar();

            if (features.sharpen) {
                const size = hdr.size(
                    float(0),
                ) as unknown as THREE.Node<'ivec2'>;
                const texel = vec2(size).reciprocal();
                const at = (x: number, y: number) =>
                    toDisplay(hdr.sample(vUv.add(texel.mul(vec2(x, y)))).rgb);
                const n = at(0, -1);
                const s = at(0, 1);
                const e = at(1, 0);
                const w = at(-1, 0);
                const lo = col.min(n.min(s).min(e.min(w)));
                const hi = col.max(n.max(s).max(e.max(w)));
                const blur = n.add(s).add(e).add(w).mul(0.25);
                col.assign(
                    col
                        .add(col.sub(blur).mul(this.sharpen.mul(2.5)))
                        .clamp(lo, hi),
                );
            }

            if (features.lut) {
                // Trilinear lookup in the slice strip: bilinear in red / green, blended between blue slices.
                const n = LUT_SIZE;
                const blue = col.b.mul(n - 1);
                const b0 = blue.floor().min(n - 2);
                const x = col.r.mul(n - 1).add(0.5);
                const y = col.g
                    .mul(n - 1)
                    .add(0.5)
                    .div(n);
                const slice = (b: FloatNode) =>
                    this.lut.sample(
                        vec2(
                            b
                                .mul(n)
                                .add(x)
                                .div(n * n),
                            y,
                        ),
                    ).rgb;
                const graded = mix(slice(b0), slice(b0.add(1)), blue.sub(b0));
                col.assign(mix(col, graded, this.lutIntensity));
            }

            if (features.grade) {
                col.assign(mix(vec3(luma(col)), col, this.saturation));
                col.assign(col.sub(0.5).mul(this.contrast).add(0.5));
                const vd = vUv.sub(0.5).mul(vec2(this.aspect, 1));
                const r = vd
                    .length()
                    .div(vec2(this.aspect, 1).mul(0.5).length());
                col.mulAssign(
                    this.vignette
                        .mul(0.75)
                        .mul(r.smoothstep(0.25, 1))
                        .oneMinus(),
                );
            }

            return vec4(col, 1);
        })() as Vec4Node;
    }

    finish(input: Vec4Node, features: OutputFeatures): Vec4Node {
        return Fn(() => {
            const col = input.rgb.toVar();
            // three's hash() takes ONE float seed: a pixel coordinate (vec2) would hash its x only and
            // draw moving vertical stripes. Seeds are the integer pixel index (rows wrap after 2048,
            // within float's exact integer range) plus a per-frame offset.
            const px = screenCoordinate.xy.floor();
            const pixel = px.x.add(px.y.mod(2048).mul(4099));
            const frameSeed = (k: number) =>
                this.frame
                    .mod(509)
                    .mul(8191)
                    .add(k * 7919);

            if (features.grain) {
                // Monochrome, animated; strongest in the mid-tones like film.
                const gl = luma(col).clamp(0, 1);
                // Sum of two uniform samples: a triangular distribution, closer to film grain.
                const g = hash(pixel.add(frameSeed(1)))
                    .add(hash(pixel.add(frameSeed(2)).add(1048573)))
                    .sub(1);
                col.addAssign(
                    g
                        .mul(this.grain.mul(0.09))
                        .mul(gl.mul(gl.oneMinus()).mul(3).add(0.25)),
                );
            }

            // Dither to break up 8-bit banding in skies and fog.
            col.addAssign(
                hash(pixel.add(frameSeed(3)))
                    .sub(0.5)
                    .div(255),
            );

            if (features.letterbox) {
                const p = uv();
                const bars = this.letterbox;
                const outside = p.y
                    .lessThan(bars.y)
                    .or(p.y.greaterThan(bars.y.oneMinus()))
                    .or(p.x.lessThan(bars.x))
                    .or(p.x.greaterThan(bars.x.oneMinus()));
                col.assign(outside.select(vec3(0), col));
            }

            return vec4(col.clamp(0, 1), 1);
        })() as Vec4Node;
    }

    /** Letterbox bars for a target aspect ratio (0 = off) on a canvas of `canvasAspect`. */
    setLetterbox(target: number, canvasAspect: number): boolean {
        const bars = this.letterbox.value;

        if (target > 0.1) {
            bars.set(
                Math.max(0, (1 - target / canvasAspect) / 2),
                Math.max(0, (1 - canvasAspect / target) / 2),
            );
        } else {
            bars.set(0, 0);
        }

        return bars.x > 0.0005 || bars.y > 0.0005;
    }
}
