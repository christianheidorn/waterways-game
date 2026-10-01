import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
    bitAnd,
    bitOr,
    cos,
    float,
    Fn,
    If,
    instancedArray,
    instanceIndex,
    invocationLocalIndex,
    length,
    max,
    min,
    select,
    shiftLeft,
    shiftRight,
    sin,
    sqrt,
    textureStore,
    uint,
    uniform,
    uvec2,
    vec2,
    vec4,
    workgroupArray,
    workgroupBarrier,
    workgroupId,
} from 'three/tsl';
import type { GameRenderer } from '../../core/renderer';
import { CASCADES, FFT_SIZE, GRAVITY } from './spectrum';
import type { CascadeSpectrum } from './spectrum';

const N = FFT_SIZE;

type Shared = { element(i: Node<'uint'>): Node<'vec2'> };
const LOG_N = Math.log2(N);
/** Complex fields per cascade (each packs two real outputs, see the spectrum kernel). */
const FIELDS = 4;

/**
 * GPU FFT ocean (WebGPU compute, Tessendorf): every frame the three cascades' spectra are evolved in time
 * and transformed to the spatial domain with a radix-2 inverse FFT (one workgroup per row / column, all
 * eight butterfly stages in workgroup memory: two dispatches for all cascades and fields), then unpacked
 * into textures the water material samples:
 *
 * - displacement[c]: RGBA16F (dx, dy, dz, foam): horizontal (choppiness 1) and vertical displacement (m) and
 *   the persistent whitecap Jacobian (minimum of the Jacobian over the last seconds, recovering to 1);
 * - derivatives[c]: RGBA16F (∂y/∂x, ∂y/∂z, mean of ∂Dx/∂x and ∂Dz/∂z, whitecap Jacobian), mipmapped: all the
 *   fragment stage needs (normals, crest compression, foam).
 *
 * Cascade c tiles every CASCADES[c].length metres. Cost: 8 dispatches, ~4.7 MB of storage buffers.
 */
export class WaveFFT {
    readonly displacement: THREE.StorageTexture[] = [];
    readonly derivatives: THREE.StorageTexture[] = [];
    private readonly h0 = instancedArray(CASCADES.length * N * N, 'vec4');
    private readonly h0Array: Float32Array;
    private readonly bufferA = instancedArray(
        CASCADES.length * FIELDS * N * N,
        'vec2',
    );
    private readonly bufferB = instancedArray(
        CASCADES.length * FIELDS * N * N,
        'vec2',
    );
    private readonly foamState = instancedArray(
        CASCADES.length * N * N,
        'float',
    );
    private readonly time = uniform(0);
    private readonly dt = uniform(0);
    /** Whitecaps fade over about this many seconds. */
    readonly foamDecay = uniform(2.5);
    private readonly kernels: THREE.ComputeNode[];
    private hasSpectrum = false;

    constructor() {
        this.h0Array = this.h0.value.array as Float32Array;

        for (let c = 0; c < CASCADES.length; c++) {
            const disp = new THREE.StorageTexture(N, N);
            disp.type = THREE.HalfFloatType;
            disp.format = THREE.RGBAFormat;
            disp.wrapS = disp.wrapT = THREE.RepeatWrapping;
            disp.generateMipmaps = false;
            disp.minFilter = THREE.LinearFilter;
            disp.name = `Wave displacement ${c}`;
            this.displacement.push(disp);

            const deriv = new THREE.StorageTexture(N, N);
            deriv.type = THREE.HalfFloatType;
            deriv.format = THREE.RGBAFormat;
            deriv.wrapS = deriv.wrapT = THREE.RepeatWrapping;
            deriv.generateMipmaps = true;
            deriv.minFilter = THREE.LinearMipmapLinearFilter;
            deriv.anisotropy = 4;
            deriv.name = `Wave derivatives ${c}`;
            this.derivatives.push(deriv);
        }

        this.kernels = [
            ...CASCADES.map((_, c) => this.spectrumKernel(c)),
            this.fftKernel(this.bufferA, this.bufferB, false),
            this.fftKernel(this.bufferB, this.bufferA, true),
            ...CASCADES.map((_, c) => this.unpackKernel(c)),
        ];
    }

    /** New initial spectra (wind / fetch changed); the waves keep their phases. */
    setSpectra(spectra: readonly CascadeSpectrum[]): void {
        spectra.forEach((s, c) => this.h0Array.set(s.h0, c * N * N * 4));
        this.h0.value.needsUpdate = true;
        this.hasSpectrum = true;
    }

    update(renderer: GameRenderer, time: number, dt: number): void {
        if (!this.hasSpectrum) {
            return;
        }

        this.time.value = time;
        this.dt.value = Math.min(0.1, Math.max(0, dt));
        void renderer.compute(this.kernels);
    }

    dispose(): void {
        for (const t of [...this.displacement, ...this.derivatives]) {
            t.dispose();
        }

        this.h0.value.dispose?.();
    }

    /** h(k, t) and the seven derived spectra, packed in pairs into four complex fields. */
    private spectrumKernel(c: number): THREE.ComputeNode {
        const dk = (Math.PI * 2) / CASCADES[c].length;

        return Fn(() => {
            const t = instanceIndex;
            const x = float(bitAnd(t, uint(N - 1)));
            const y = float(shiftRight(t, uint(LOG_N)));
            const kx = x.sub(N / 2).mul(dk);
            const kz = y.sub(N / 2).mul(dk);
            const kl = max(length(vec2(kx, kz)), 1e-6);
            const omega = sqrt(kl.mul(GRAVITY));
            const phase = omega.mul(this.time);
            const cw = cos(phase);
            const sw = sin(phase);
            const h0 = this.h0.element(uint(c * N * N).add(t));
            // h = h0(k) e^{-iωt} + conj(h0(-k)) e^{iωt} (travels along +k).
            const h = vec2(
                h0.x
                    .mul(cw)
                    .add(h0.y.mul(sw))
                    .add(h0.z.mul(cw))
                    .sub(h0.w.mul(sw)),
                h0.y
                    .mul(cw)
                    .sub(h0.x.mul(sw))
                    .add(h0.z.mul(sw))
                    .add(h0.w.mul(cw)),
            ).mul(select(kl.greaterThan(1e-5), float(1), float(0)));
            // i·h
            const ih = vec2(h.y.negate(), h.x);
            const ux = kx.div(kl);
            const uz = kz.div(kl);
            const dx = ih.mul(ux);
            const dz = ih.mul(uz);
            const dyx = ih.mul(kx);
            const dyz = ih.mul(kz);
            const dxx = h.mul(kx.mul(ux).negate());
            const dzz = h.mul(kz.mul(uz).negate());
            const dxz = h.mul(kx.mul(uz).negate());
            // A + i·B: the inverse transform returns A in the real part, B in the imaginary part.
            const pack = (a: Node<'vec2'>, b: Node<'vec2'>) =>
                vec2(a.x.sub(b.y), a.y.add(b.x));
            const base = uint(c * FIELDS * N * N).add(t);
            this.bufferA.element(base).assign(pack(dx, h));
            this.bufferA.element(base.add(N * N)).assign(pack(dz, dyx));
            this.bufferA.element(base.add(2 * N * N)).assign(pack(dyz, dxx));
            this.bufferA.element(base.add(3 * N * N)).assign(pack(dzz, dxz));
        })().compute(N * N, [64]);
    }

    /** Inverse FFT of every row (or column) of every field: one workgroup of N invocations per line. */
    private fftKernel(
        src: THREE.StorageBufferNode<'vec2'>,
        dst: THREE.StorageBufferNode<'vec2'>,
        vertical: boolean,
    ): THREE.ComputeNode {
        const lines = CASCADES.length * FIELDS * N;

        return Fn(() => {
            // (The typings lack WorkgroupInfoNode.element.)
            const ping = workgroupArray('vec2', N) as unknown as Shared;
            const pong = workgroupArray('vec2', N) as unknown as Shared;
            const line = workgroupId.x.add(workgroupId.y.mul(65535));
            const lane = invocationLocalIndex;
            const plane = shiftRight(line, uint(LOG_N));
            const inPlane = bitAnd(line, uint(N - 1));
            const address = vertical
                ? plane
                      .mul(N * N)
                      .add(lane.mul(N))
                      .add(inPlane)
                : line.mul(N).add(lane);
            // Bit-reversed load.
            let rev: Node<'uint'> = uint(0);

            for (let b = 0; b < LOG_N; b++) {
                rev = bitOr(
                    rev,
                    shiftLeft(
                        bitAnd(shiftRight(lane, uint(b)), uint(1)),
                        uint(LOG_N - 1 - b),
                    ),
                );
            }

            ping.element(rev).assign(src.element(address));
            workgroupBarrier();

            let from = ping;
            let to = pong;

            for (let s = 0; s < LOG_N; s++) {
                const half = 1 << s;
                const j = bitAnd(lane, uint(half - 1));
                const a = lane.sub(bitAnd(lane, uint(half)));
                const angle = float(j).mul((Math.PI * 2) / (half * 2));
                // Inverse transform: twiddle e^{+iθ}.
                const wr = cos(angle);
                const wi = sin(angle);
                const pa = from.element(a);
                const pb = from.element(a.add(half));
                const tw = vec2(
                    pb.x.mul(wr).sub(pb.y.mul(wi)),
                    pb.x.mul(wi).add(pb.y.mul(wr)),
                );
                const upper = bitAnd(lane, uint(half)).equal(uint(0));
                to.element(lane).assign(select(upper, pa.add(tw), pa.sub(tw)));
                workgroupBarrier();
                [from, to] = [to, from];
            }

            dst.element(address).assign(from.element(lane));
        })().compute(
            (lines > 65535
                ? [65535, Math.ceil(lines / 65535), 1]
                : [lines, 1, 1]) as unknown as number,
            [N],
        );
    }

    /** Fields → textures (sign of the centred spectrum, persistent whitecap Jacobian). */
    private unpackKernel(c: number): THREE.ComputeNode {
        const disp = this.displacement[c];
        const deriv = this.derivatives[c];

        return Fn(() => {
            const t = instanceIndex;
            const xi = bitAnd(t, uint(N - 1));
            const yi = shiftRight(t, uint(LOG_N));
            // The spectrum is centred (k = 0 at N/2): the transform carries a (-1)^(x+y) checkerboard.
            const sign = select(
                bitAnd(xi.add(yi), uint(1)).equal(uint(0)),
                float(1),
                float(-1),
            );
            const base = uint(c * FIELDS * N * N).add(t);
            const f0 = this.bufferA.element(base).mul(sign);
            const f1 = this.bufferA.element(base.add(N * N)).mul(sign);
            const f2 = this.bufferA.element(base.add(2 * N * N)).mul(sign);
            const f3 = this.bufferA.element(base.add(3 * N * N)).mul(sign);
            const dxx = f2.y;
            const dzz = f3.x;
            const dxz = f3.y;
            const jacobian = float(1)
                .add(dxx)
                .mul(float(1).add(dzz))
                .sub(dxz.mul(dxz));
            // Whitecaps linger: the lowest Jacobian seen lately, relaxing back towards 1.
            const state = this.foamState.element(uint(c * N * N).add(t));
            const relaxed = min(
                state.add(float(1).sub(state).mul(this.dt.div(this.foamDecay))),
                1,
            );
            const foam = min(jacobian, relaxed).toVar();
            If(state.equal(0), () => {
                // Fresh buffer.
                foam.assign(jacobian);
            });
            state.assign(foam);
            textureStore(disp, uvec2(xi, yi), vec4(f0.x, f0.y, f1.x, foam));
            // The fragment stage reads only this texture (texture binding limits): the mean horizontal
            // compression for the normals and the whitecap Jacobian ride along.
            textureStore(
                deriv,
                uvec2(xi, yi),
                vec4(f1.y, f2.x, dxx.add(dzz).mul(0.5), foam),
            );
        })().compute(N * N, [64]);
    }
}
