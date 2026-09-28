import * as THREE from 'three/webgpu';
import {
    ceil,
    clamp,
    exp2,
    float,
    floor,
    Fn,
    If,
    instancedArray,
    instanceIndex,
    int,
    ivec2,
    log2,
    max,
    min,
    Return,
    textureLoad,
    uint,
    uniform,
    vec3,
    vec4,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { GameRenderer } from '../../core/renderer';

/** Pyramid levels kept (level 1 = half the depth resolution; 12 levels cover 8k). */
const MAX_LEVELS = 12;

/** Pyramid storage: depth texels and per-level layout (offset, width, height). */
export type HiZNodes = {
    buffer: THREE.StorageBufferNode<'float'>;
    info: THREE.StorageBufferNode<'vec4'>;
};

/**
 * Hierarchical-Z pyramid for GPU occlusion culling (WebGPU only).
 *
 * Built each frame by compute from the scene pass depth of the PREVIOUS frame: level 1 is the depth at
 * half resolution, every further level halves again; each texel keeps the FARTHEST depth of the texels
 * it covers (non-power-of-two sizes round up, so a texel always covers all of its children). The
 * levels live in one float storage buffer; `occluded()` tests a bounding sphere, reprojected with the
 * previous frame's camera, against 2×2 texels of the level where its screen rectangle spans ≤ 2 texels.
 *
 * Storage is allocated for the largest depth size seen; smaller sizes only change uniforms.
 */
export class HiZ {
    private capacity = new THREE.Vector2(0, 0);
    private buffer: HiZNodes['buffer'] | null = null;
    /** Per level: element offset, width, height (floats, last unused). */
    private levelInfo: HiZNodes['info'] | null = null;
    private levelArray = new Float32Array(MAX_LEVELS * 4);
    private builds: THREE.ComputeNode[] = [];
    private levelSizes: THREE.UniformNode<'vec2', THREE.Vector2>[] = [];
    private levelCount = 0;
    private texture: THREE.Texture | null = null;
    /** Depth size (pixels) of the source texture. */
    readonly size = uniform(new THREE.Vector2(1, 1));
    readonly levels = uniform(1);
    /** Proxy test nodes are created against these (rebuilt with the buffers). */
    version = 0;

    /**
     * Rebuilds the pyramid from `depth` (call before this frame's scene render). Returns false when
     * the pyramid can't be used this frame (no depth yet, or the depth size just changed).
     */
    update(renderer: GameRenderer, depth: THREE.Texture): boolean {
        const image = depth.image as { width?: number; height?: number };
        const w = image?.width ?? 0;
        const h = image?.height ?? 0;

        if (w < 4 || h < 4) {
            return false;
        }

        const resized =
            this.texture !== depth ||
            w !== this.size.value.x ||
            h !== this.size.value.y;

        if (
            this.texture !== depth ||
            w > this.capacity.x ||
            h > this.capacity.y
        ) {
            this.allocate(depth, w, h);
        }

        if (resized) {
            this.configure(w, h);
        }

        void renderer.compute(this.builds.slice(0, this.levelCount));

        // The depth of a resized pass is cleared, not last frame's: skip testing for one frame.
        return !resized;
    }

    /** Storage buffers read by the culling shaders (null until the first update). */
    get nodes(): HiZNodes | null {
        return this.buffer && this.levelInfo
            ? { buffer: this.buffer, info: this.levelInfo }
            : null;
    }

    private allocate(depth: THREE.Texture, w: number, h: number): void {
        this.dispose();
        this.texture = depth;
        // Headroom so dynamic resolution steps don't reallocate.
        const cw = Math.ceil(w * 1.25);
        const ch = Math.ceil(h * 1.25);
        this.capacity.set(cw, ch);
        let total = 0;
        let lw = cw;
        let lh = ch;
        const offsets: number[] = [];
        const capacities: number[] = [];

        for (let level = 1; level <= MAX_LEVELS; level++) {
            lw = Math.ceil(lw / 2);
            lh = Math.ceil(lh / 2);
            offsets.push(total);
            capacities.push(lw * lh);
            total += lw * lh;

            if (lw === 1 && lh === 1) {
                break;
            }
        }

        const buffer = instancedArray(total, 'float');
        const info = instancedArray(this.levelArray, 'vec4');
        this.buffer = buffer;
        this.levelInfo = info;
        this.levelSizes = [];
        this.builds = offsets.map((offset, i) => {
            const size = uniform(new THREE.Vector2(1, 1));
            this.levelSizes.push(size);
            const src = i === 0 ? null : offsets[i - 1];

            // Index math in float (exact far beyond any depth size): texel t → (x, y).
            return Fn(() => {
                const t = float(instanceIndex);

                If(t.greaterThanEqual(size.x.mul(size.y)), () => {
                    Return();
                });

                const y = floor(t.div(size.x));
                const x = t.sub(y.mul(size.x));
                const sx = x.mul(2);
                const sy = y.mul(2);
                // Children of the texel: 2×2, clamped at odd edges.
                const source = i === 0 ? this.size : this.levelSizes[i - 1];
                const x1 = min(sx.add(1), source.x.sub(1));
                const y1 = min(sy.add(1), source.y.sub(1));
                const at =
                    src === null
                        ? (px: Node<'float'>, py: Node<'float'>) =>
                              textureLoad(depth, ivec2(int(px), int(py))).x
                        : (px: Node<'float'>, py: Node<'float'>) =>
                              buffer.element(
                                  uint(py.mul(source.x).add(px).add(src)),
                              );
                const d = max(
                    max(at(sx, sy), at(x1, sy)),
                    max(at(sx, y1), at(x1, y1)),
                );
                buffer.element(uint(offset).add(instanceIndex)).assign(d);
            })().compute(capacities[i]);
        });
        this.version++;
    }

    private configure(w: number, h: number): void {
        this.size.value.set(w, h);
        let lw = w;
        let lh = h;
        let offset = 0;
        let cw = this.capacity.x;
        let ch = this.capacity.y;
        this.levelCount = 0;

        for (let i = 0; i < this.builds.length; i++) {
            lw = Math.ceil(lw / 2);
            lh = Math.ceil(lh / 2);
            cw = Math.ceil(cw / 2);
            ch = Math.ceil(ch / 2);
            this.levelSizes[i].value.set(lw, lh);
            this.levelArray.set([offset, lw, lh, 0], i * 4);
            offset += cw * ch;
            this.levelCount++;

            if (lw === 1 && lh === 1) {
                break;
            }
        }

        this.levels.value = this.levelCount;
        const attribute = this.levelInfo!.value as THREE.BufferAttribute;
        attribute.needsUpdate = true;
    }

    dispose(): void {
        for (const node of this.builds) {
            node.dispose();
        }

        this.builds = [];
        this.buffer = null;
        this.levelInfo = null;
        this.texture = null;
        this.capacity.set(0, 0);
    }
}

/**
 * Occlusion test of a world-space bounding sphere against the pyramid (inside a compute Fn). The
 * sphere is reprojected with the previous frame's view / projection; anything that was not entirely
 * on screen, touches the near plane or isn't behind the stored depth counts as visible.
 */
export function occludedNode(
    hiz: HiZ,
    nodes: HiZNodes,
    center: Node<'vec3'>,
    radius: Node<'float'>,
    prevView: THREE.UniformNode<'mat4', THREE.Matrix4>,
    prevProj: THREE.UniformNode<'mat4', THREE.Matrix4>,
    near: THREE.UniformNode<'float', number>,
): Node<'float'> {
    const occluded = float(0).toVar();
    const viewCenter = prevView.mul(vec4(center, 1)).toVar();

    // Entirely in front of the near plane (view space looks down -z).
    If(viewCenter.z.negate().sub(radius).greaterThan(near), () => {
        const lo = vec4(1e9, 1e9, 0, 0).toVar();
        const hi = vec4(-1e9, -1e9, 0, 0).toVar();

        for (const cx of [-1, 1]) {
            for (const cy of [-1, 1]) {
                for (const cz of [-1, 1]) {
                    const corner = viewCenter.xyz.add(
                        vec3(cx, cy, cz).mul(radius),
                    );
                    const clip = prevProj.mul(vec4(corner, 1));
                    const ndc = clip.xy.div(clip.w);
                    lo.assign(vec4(min(lo.xy, ndc), 0, 0));
                    hi.assign(vec4(max(hi.xy, ndc), 0, 0));
                }
            }
        }

        const size = hiz.size;
        // NDC → pixels of the depth texture (y down).
        const x0 = lo.x.mul(0.5).add(0.5).mul(size.x);
        const x1 = hi.x.mul(0.5).add(0.5).mul(size.x);
        const y0 = float(0.5).sub(hi.y.mul(0.5)).mul(size.y);
        const y1 = float(0.5).sub(lo.y.mul(0.5)).mul(size.y);

        If(
            x0
                .greaterThanEqual(0)
                .and(y0.greaterThanEqual(0))
                .and(x1.lessThan(size.x))
                .and(y1.lessThan(size.y)),
            () => {
                const extent = max(max(x1.sub(x0), y1.sub(y0)), 1);
                const level = clamp(ceil(log2(extent)), 1, hiz.levels);
                const info = nodes.info.element(uint(level.sub(1)));
                const scale = exp2(level);
                const tx0 = floor(x0.div(scale));
                const ty0 = floor(y0.div(scale));
                const tx1 = min(floor(x1.div(scale)), info.y.sub(1));
                const ty1 = min(floor(y1.div(scale)), info.z.sub(1));
                const at = (tx: Node<'float'>, ty: Node<'float'>) =>
                    nodes.buffer.element(
                        uint(info.x.add(ty.mul(info.y)).add(tx)),
                    );
                const farthest = max(
                    max(at(tx0, ty0), at(tx1, ty0)),
                    max(at(tx0, ty1), at(tx1, ty1)),
                );
                // Depth of the sphere's nearest point.
                const nearClip = prevProj.mul(
                    vec4(0, 0, viewCenter.z.add(radius), 1),
                );
                const nearest = nearClip.z.div(nearClip.w);

                If(nearest.greaterThan(farthest), () => {
                    occluded.assign(1);
                });
            },
        );
    });

    return occluded;
}
