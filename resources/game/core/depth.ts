import * as THREE from 'three/webgpu';
import { float, Fn, max, min } from 'three/tsl';
import type { Node, NodeBuilder } from 'three/webgpu';

/**
 * Depth buffer conventions shared by everything that reads depth.
 *
 * On WebGPU the renderer uses a reversed float depth buffer (near plane = 1, far plane = 0): float
 * precision is densest near 0, which cancels the hyperbolic distribution of perspective depth, so a
 * surface 10 km away still resolves to millimetres (a 24-bit buffer quantises it into steps of tens of
 * metres there). The WebGL 2 backend keeps the standard buffer (near = 0, far = 1), see `renderer.ts`.
 *
 * The helpers read `renderer.reversedDepthBuffer` while the shader is built, so every node works with
 * either convention.
 */

/** Cleared depth (nothing drawn): exactly 0 when reversed, 1 otherwise; small margins for resolves. */
const REVERSED_SKY = 1e-9;
const STANDARD_SKY = 0.9999999;

function reversed(builder: NodeBuilder): boolean {
    return builder.renderer.reversedDepthBuffer === true;
}

/** True where the depth buffer holds no surface (sky / background). */
export const isSkyDepth = Fn(
    ([depth]: [Node<'float'>], builder: NodeBuilder) =>
        reversed(builder)
            ? depth.lessThanEqual(REVERSED_SKY)
            : depth.greaterThanEqual(STANDARD_SKY),
) as unknown as (depth: Node<'float'>) => Node<'bool'>;

/** The depth of the nearer of two surfaces. */
export const nearerDepth = Fn(
    ([a, b]: [Node<'float'>, Node<'float'>], builder: NodeBuilder) =>
        reversed(builder) ? max(a, b) : min(a, b),
) as unknown as (a: Node<'float'>, b: Node<'float'>) => Node<'float'>;

/** Depth (and NDC z) of the far plane. */
export const farDepth = Fn((builder: NodeBuilder) =>
    float(reversed(builder) ? 0 : 1),
) as unknown as () => Node<'float'>;

/**
 * Normalised device z of a depth buffer value: depth itself where clip space z is 0..1 (WebGPU, or any
 * reversed buffer: EXT_clip_control's zero-to-one range on WebGL), 2·depth − 1 for OpenGL's -1..1.
 */
export const depthToNdcZ = Fn(
    ([depth]: [Node<'float'>], builder: NodeBuilder) =>
        reversed(builder) ||
        builder.renderer.coordinateSystem === THREE.WebGPUCoordinateSystem
            ? depth
            : depth.mul(2).sub(1),
) as unknown as (depth: Node<'float'>) => Node<'float'>;

/**
 * Smallest resolvable change of view distance (m) at `distance` for the depth buffer in use: about one
 * float ULP of relative precision with reversed depth, the 24-bit step (∝ distance² / near) otherwise.
 * Effects driven by depth differences fade out where their differences drop below a few of these.
 */
export const depthPrecision = Fn(
    ([distance, near]: [Node<'float'>, Node<'float'>], builder: NodeBuilder) =>
        reversed(builder)
            ? distance.mul(2 ** -22)
            : distance
                  .mul(distance)
                  .div(near)
                  .mul(2 ** -23),
) as unknown as (distance: Node<'float'>, near: Node<'float'>) => Node<'float'>;

/** The depth of the farther of two surfaces. */
export const fartherDepth = Fn(
    ([a, b]: [Node<'float'>, Node<'float'>], builder: NodeBuilder) =>
        reversed(builder) ? min(a, b) : max(a, b),
) as unknown as (a: Node<'float'>, b: Node<'float'>) => Node<'float'>;
