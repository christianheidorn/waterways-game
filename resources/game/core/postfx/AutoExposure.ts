import * as THREE from 'three/webgpu';
import {
    array,
    atomicAdd,
    atomicLoad,
    atomicStore,
    exp2,
    float,
    Fn,
    If,
    instanceIndex,
    int,
    ivec2,
    Loop,
    mix,
    storage,
    uint,
    uniform,
    uv,
    vec2,
    vec4,
} from 'three/tsl';
import { isWebGpu } from '../renderer';
import type { FloatNode, TextureNode, Vec2Node, Vec4Node } from './common';
import { luma, ScreenPass } from './common';

/** Metering grid (samples per axis) and histogram. */
const GRID = 64;
const BINS = 64;
const LOG_MIN = -16;
const LOG_MAX = 8;
/** Side of the reduced log-luminance image the WebGL 2 histogram is built from. */
const REDUCED = 16;

/**
 * Metering key: log2 of (scene luminance × base exposure) the image is calibrated for. The Atmosphere's
 * base exposure already looks right on an average clear day, so a scene at this key gets a multiplier of 1.
 */
const METER_KEY = -2.95;

/** Mean log2 luminance of four bilinear taps spread over one metering cell. */
function cellLogLuminance(
    input: TextureNode,
    cell: Vec2Node,
    level: boolean,
): FloatNode {
    const o = 0.25 / GRID;
    const tap = (x: number, y: number) => {
        const s = input.sample(cell.add(vec2(x * o, y * o)));
        // NaN / Inf / negative guard (one bad pixel must not poison the exposure).
        const l = luma((level ? s.level(float(0)) : s).rgb.clamp(0, 65000));

        return l.add(1e-5).log2();
    };

    return tap(-1, -1).add(tap(1, -1)).add(tap(-1, 1)).add(tap(1, 1)).mul(0.25);
}

/** Centre-weighted metering; the top of the frame (usually sky) counts a little less. */
function meterWeight(cell: Vec2Node): FloatNode {
    const p = cell.sub(0.5);
    const centre = mix(1, 3, p.dot(p).mul(3).clamp(0, 1).oneMinus());

    return centre.mul(p.y.lessThan(-0.25).select(0.75, 1));
}

function histogramBin(logLuminance: FloatNode) {
    return int(
        logLuminance
            .sub(LOG_MIN)
            .div(LOG_MAX - LOG_MIN)
            .clamp(0, 0.9999)
            .mul(BINS),
    );
}

type Params = {
    dt: THREE.UniformNode<'float', number>;
    speed: THREE.UniformNode<'float', number>;
    minEv: THREE.UniformNode<'float', number>;
    maxEv: THREE.UniformNode<'float', number>;
    baseEv: THREE.UniformNode<'float', number>;
    reset: THREE.UniformNode<'float', number>;
};

/**
 * Averages the 50th-95th percentile of the histogram (so small dark corners and the sun disc don't drive
 * exposure) and eases the previous exposure towards the target. Returns the new log2 exposure.
 */
function adapt(
    p: Params,
    bin: (i: THREE.Node<'int'>) => FloatNode,
    previous: FloatNode,
): { ev: FloatNode; metered: FloatNode } {
    const total = float(0).toVar();

    Loop(BINS, ({ i }) => {
        total.addAssign(bin(i));
    });

    const lowCut = total.mul(0.5).toVar();
    const highCut = total.mul(0.95).toVar();
    const acc = float(0).toVar();
    const sum = float(0).toVar();
    const weight = float(0).toVar();

    Loop(BINS, ({ i }) => {
        const h = bin(i).toVar();
        // Portion of this bin inside the [lowCut, highCut] percentile window.
        const inside = acc.add(h).min(highCut).sub(acc.max(lowCut)).clamp(0, h);
        const centre = float(i)
            .add(0.5)
            .div(BINS)
            .mul(LOG_MAX - LOG_MIN)
            .add(LOG_MIN);
        sum.addAssign(centre.mul(inside));
        weight.addAssign(inside);
        acc.addAssign(h);
    });

    const metered = sum.div(weight.max(1e-4)).toVar();
    // Partial adaptation (0.75): dark places should still feel darker than bright ones.
    const target = float(METER_KEY)
        .sub(metered.add(p.baseEv))
        .mul(0.75)
        .clamp(p.minEv, p.maxEv)
        .toVar();
    const ev = target.toVar();

    If(p.reset.lessThan(0.5).and(previous.equal(previous)), () => {
        // Adapting to brightness (exposure going down) is faster than adapting to the dark.
        const speed = p.speed.mul(target.lessThan(previous).select(1.6, 1));
        ev.assign(
            previous.add(
                target
                    .sub(previous)
                    .mul(p.dt.negate().mul(speed).exp().oneMinus()),
            ),
        );
    });

    return { ev, metered };
}

/** Runs the metering compute passes once per frame, before the first draw that reads the exposure. */
class ComputeMeter extends THREE.TempNode {
    constructor(
        private readonly kernels: THREE.ComputeNode[],
        private readonly result: FloatNode,
    ) {
        super('float');
        this.updateBeforeType = THREE.NodeUpdateType.FRAME;
    }

    override updateBefore(frame: THREE.NodeFrame): boolean | undefined {
        void (frame.renderer as THREE.Renderer).compute(this.kernels);

        return undefined;
    }

    override setup(): THREE.Node {
        return this.result;
    }
}

/**
 * Eye adaptation, entirely on the GPU (no read-back stalls): a centre-weighted 64-bin histogram of the
 * log luminance of the final HDR image, the 50th-95th percentile mean as the metered value, and a
 * smoothed exposure multiplier applied on top of the base exposure (renderer.toneMappingExposure, set by
 * the Atmosphere from time of day and weather).
 *
 * - WebGPU: two compute passes: 64×64 metering samples binned with atomics, then one invocation that
 *   evaluates the histogram, clears it and updates the exposure in a storage buffer.
 * - WebGL 2: a 64×64 log-luminance image, reduced to 16×16, and a 1×1 feedback pass that builds the
 *   histogram of those 256 values.
 */
export class AutoExposure {
    /** Exposure multiplier node (reads the adapted value of this frame). */
    readonly multiplier: FloatNode;
    /** WebGL 2 fragment passes (empty on WebGPU). */
    readonly passes: ScreenPass[] = [];
    private readonly params: Params = {
        dt: uniform(0),
        speed: uniform(1),
        minEv: uniform(-2),
        maxEv: uniform(2),
        baseEv: uniform(0),
        reset: uniform(1),
    };
    private needsReset = true;

    constructor(renderer: THREE.Renderer, input: TextureNode) {
        this.multiplier = isWebGpu(renderer as THREE.WebGPURenderer)
            ? this.buildCompute(input)
            : this.buildFragment(input);
    }

    private buildCompute(input: TextureNode): FloatNode {
        const p = this.params;
        const histogram = new THREE.StorageBufferAttribute(
            new Uint32Array(BINS),
            1,
        );
        // [exposure multiplier, log2 exposure, metered log2 luminance, unused]
        const state = new THREE.StorageBufferAttribute(
            new Float32Array([1, 0, 0, 0]),
            4,
        );
        const bins = storage(histogram, 'uint', BINS).toAtomic();
        const stateRw = storage(state, 'vec4', 1);

        const binKernel = Fn(() => {
            const x = instanceIndex.mod(GRID);
            const y = instanceIndex.div(GRID);
            const cell = vec2(float(x), float(y)).add(0.5).div(GRID).toVar();
            const l = cellLogLuminance(input, cell, true);
            // Weights in 1/16 steps: atomics are integer.
            const w = uint(meterWeight(cell).mul(16).round());
            atomicAdd(bins.element(histogramBin(l)), w);
        })().compute(GRID * GRID, [64]);
        binKernel.name = 'Eye adaptation';

        const adaptKernel = Fn(() => {
            const previous = stateRw.element(0).y;
            const { ev, metered } = adapt(
                p,
                (i) => float(atomicLoad(bins.element(i))),
                previous,
            );

            Loop(BINS, ({ i }) => {
                atomicStore(bins.element(i), 0);
            });

            stateRw.element(0).assign(vec4(exp2(ev), ev, metered, 0));
        })().compute(1, [1]);
        adaptKernel.name = 'Eye adaptation';

        const read = storage(state, 'vec4', 1).toReadOnly().element(0).x;

        return new ComputeMeter(
            [binKernel, adaptKernel],
            read,
        ) as unknown as FloatNode;
    }

    private buildFragment(input: TextureNode): FloatNode {
        const p = this.params;
        const lum = new ScreenPass('Eye adaptation', { size: [GRID, GRID] });
        lum.fragment = Fn(() => {
            const l = cellLogLuminance(input, uv(), false);

            return vec4(l, meterWeight(uv()), 0, 1);
        })() as Vec4Node;

        const lumTexture = lum.getTextureNode();
        const reduce = new ScreenPass('Eye adaptation', {
            size: [REDUCED, REDUCED],
            filter: THREE.NearestFilter,
        });
        const block = GRID / REDUCED;
        reduce.fragment = Fn(() => {
            const origin = ivec2(uv().mul(REDUCED).floor()).mul(block);
            const sum = vec4(0).toVar();

            for (let y = 0; y < block; y++) {
                for (let x = 0; x < block; x++) {
                    sum.addAssign(lumTexture.load(origin.add(ivec2(x, y))));
                }
            }

            return sum.div(block * block);
        })() as Vec4Node;

        const reduced = reduce.getTextureNode();
        const exposure = new ScreenPass('Eye adaptation', {
            size: [1, 1],
            filter: THREE.NearestFilter,
            type: THREE.FloatType,
            feedback: true,
        });
        exposure.fragment = Fn(() => {
            const hist = array('float', BINS).toVar() as unknown as {
                element(i: THREE.Node): FloatNode;
            };

            Loop(BINS, ({ i }) => {
                hist.element(i).assign(0);
            });

            Loop(REDUCED * REDUCED, ({ i }) => {
                const texel = reduced.load(
                    ivec2(i.mod(REDUCED), i.div(REDUCED)),
                );
                hist.element(histogramBin(texel.x)).addAssign(texel.y);
            });

            const previous = exposure.previous.sample(vec2(0.5)).y;
            const { ev, metered } = adapt(p, (i) => hist.element(i), previous);

            return vec4(exp2(ev), ev, metered, 1);
        })() as Vec4Node;

        this.passes.push(lum, reduce, exposure);

        return exposure.getTextureNode().sample(vec2(0.5)).x as FloatNode;
    }

    reset(): void {
        this.needsReset = true;
    }

    update(
        dt: number,
        baseExposure: number,
        minEv: number,
        maxEv: number,
        speed: number,
    ): void {
        const p = this.params;
        p.dt.value = dt;
        p.speed.value = Math.max(0.01, speed);
        p.minEv.value = Math.min(minEv, maxEv);
        p.maxEv.value = Math.max(minEv, maxEv);
        p.baseEv.value = Math.log2(Math.max(1e-4, baseExposure));
        p.reset.value = this.needsReset ? 1 : 0;
        this.needsReset = false;
    }

    dispose(): void {
        for (const pass of this.passes) {
            pass.dispose();
        }
    }
}
