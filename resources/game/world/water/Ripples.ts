import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
    abs,
    clamp,
    exp,
    float,
    Fn,
    instancedArray,
    instanceIndex,
    int,
    max,
    min,
    positionWorld,
    select,
    smoothstep,
    texture,
    textureStore,
    uniform,
    uniformArray,
    uvec2,
    varying,
    vec2,
    vec3,
    vec4,
} from 'three/tsl';
import type { GameRenderer } from '../../core/renderer';
import {
    RIPPLE_DT,
    RIPPLE_EXTENT,
    RIPPLE_FOAM_DECAY,
    RIPPLE_FOAM_SPEED,
    RIPPLE_MAX_SOURCES,
    RIPPLE_MAX_STEPS,
    RIPPLE_RESOLUTION,
    rippleCoefficient,
    rippleOrigin,
    RippleSim,
} from './rippleSim';
import type { RippleQuality, RippleSource } from './rippleSim';
import type { WaterSurfaceLayer } from './waterMaterial';

type Float = Node<'float'>;
type Vec4 = Node<'vec4'>;
type Buffer = THREE.StorageBufferNode<'vec4'>;

/** The CPU field (WebGL 2) is capped at this resolution (its texture is uploaded every frame). */
const CPU_MAX = 128;

/** GPU kernels for one resolution (WebGPU): state ping-pong, shore mask and the output texture. */
type GpuField = {
    size: number;
    a: Buffer;
    b: Buffer;
    mask: THREE.StorageBufferNode<'float'>;
    maskArray: Float32Array;
    output: THREE.StorageTexture;
    /** inject[src]: shift + sources, src → other; step[src]: one wave step src → other; out[src]. */
    inject: [THREE.ComputeNode, THREE.ComputeNode];
    step: [THREE.ComputeNode, THREE.ComputeNode];
    out: [THREE.ComputeNode, THREE.ComputeNode];
    /** Which buffer holds the current state (0: a, 1: b). */
    current: 0 | 1;
};

/**
 * Interactive ripples on the water (docs/ROADMAP.md phase 12): a damped wave equation on a 40 m square
 * around the player (or camera) that reflects at shores. Footsteps, strokes, splashes and moving objects
 * disturb it (`disturb`); rings, bow waves and wakes emerge from the simulation. It feeds the water
 * material as a surface layer: height displacement, normals (its gradient) and foam where it moves fast.
 *
 * - WebGPU: compute kernels on storage buffers (rippleSim.ts documents the model), written each frame to
 *   one RGBA16F texture (height, ∂h/∂x, ∂h/∂z, foam): the water shaders bind a single extra texture.
 * - WebGL 2: the same model on the CPU (RippleSim, at most 128²), uploaded as a half-float texture.
 *
 * The field moves in jumps (RIPPLE_SNAP cells) so the shore mask is only rebuilt every couple of metres.
 * `sample` (gameplay) sees the CPU field only; on WebGPU the state stays on the GPU and ripples add nothing.
 */
export class Ripples {
    quality: RippleQuality = 'medium';
    private renderer: GameRenderer | null = null;
    private gpu: GpuField | null = null;
    private cpu: RippleSim | null = null;
    private cpuTexture: THREE.DataTexture | null = null;
    private cpuHalf: Uint16Array | null = null;
    /** Mask builder / CPU state (also the origin bookkeeping in GPU mode). */
    private field: RippleSim | null = null;
    private readonly placeholder = new THREE.DataTexture(
        new Uint16Array(4),
        1,
        1,
        THREE.RGBAFormat,
        THREE.HalfFloatType,
    );
    private readonly textureNode: THREE.TextureNode;
    private readonly origin = uniform(new THREE.Vector2());
    private readonly extent = uniform(RIPPLE_EXTENT);
    /** 0 while off (no texture), else the environment's ripple strength. */
    private readonly strength = uniform(0);
    private readonly sourceA = uniformArray(
        Array.from({ length: RIPPLE_MAX_SOURCES }, () => new THREE.Vector4()),
        'vec4',
    );
    private readonly sourceFoam = uniformArray(
        Array.from({ length: RIPPLE_MAX_SOURCES }, () => 0),
        'float',
    );
    private readonly shift = uniform(new THREE.Vector2());
    private readonly sources: RippleSource[] = [];
    private accumulator = 0;
    private pendingShift = { x: 0, z: 0 };
    private maskDirty = true;
    private envStrength = 1;
    private stepsRun = 0;

    constructor(
        /** Water depth (m) at a world position, null where dry. */
        private readonly depthAt: (x: number, z: number) => number | null,
    ) {
        this.placeholder.needsUpdate = true;
        this.textureNode = texture(this.placeholder);
    }

    /** WebGPU runs the compute field; WebGL 2 the CPU one. */
    setRenderer(renderer: GameRenderer): void {
        this.renderer = renderer;
        this.rebuild();
    }

    /** Graphics water_ripples (off on Low). */
    setQuality(quality: RippleQuality): void {
        if (quality === this.quality) {
            return;
        }

        this.quality = quality;
        this.rebuild();
    }

    /** Environment ripple strength (0 hides them; the simulation keeps running). */
    setStrength(strength: number): void {
        this.envStrength = Math.max(0, strength);
        this.strength.value = this.active ? this.envStrength : 0;
    }

    get active(): boolean {
        return !!(this.gpu || this.cpu);
    }

    get mode(): 'gpu' | 'cpu' | 'off' {
        return this.gpu ? 'gpu' : this.cpu ? 'cpu' : 'off';
    }

    /** A disturbance this frame (merged with the strongest others beyond RIPPLE_MAX_SOURCES). */
    disturb(source: RippleSource): void {
        if (!this.active) {
            return;
        }

        if (this.sources.length < RIPPLE_MAX_SOURCES) {
            this.sources.push({ ...source });

            return;
        }

        // Replace the weakest.
        let weakest = 0;

        for (let i = 1; i < this.sources.length; i++) {
            if (
                Math.abs(this.sources[i].amount) <
                Math.abs(this.sources[weakest].amount)
            ) {
                weakest = i;
            }
        }

        if (Math.abs(source.amount) > Math.abs(this.sources[weakest].amount)) {
            this.sources[weakest] = { ...source };
        }
    }

    /** Water edits: the shore mask is rebuilt. */
    invalidate(): void {
        this.maskDirty = true;
    }

    /** Advances the field around `focus` (fixed steps). */
    update(dt: number, focus: THREE.Vector3): void {
        const field = this.field;

        if (!field) {
            this.sources.length = 0;

            return;
        }

        // Follow the focus in jumps.
        const ox = rippleOrigin(focus.x, field.cell, field.size);
        const oz = rippleOrigin(focus.z, field.cell, field.size);

        if (ox !== field.originX || oz !== field.originZ) {
            const sx = Math.round((ox - field.originX) / field.cell);
            const sz = Math.round((oz - field.originZ) / field.cell);

            if (this.cpu) {
                this.cpu.moveTo(ox, oz);
            } else {
                field.originX = ox;
                field.originZ = oz;
                this.pendingShift.x += sx;
                this.pendingShift.z += sz;
            }

            this.maskDirty = true;
        }

        if (this.maskDirty) {
            this.maskDirty = false;
            field.buildMask(this.depthAt);

            if (this.gpu) {
                this.gpu.maskArray.set(field.mask);
                this.gpu.mask.value.needsUpdate = true;
            }
        }

        this.origin.value.set(field.originX, field.originZ);
        this.accumulator = Math.min(
            this.accumulator + dt,
            RIPPLE_DT * RIPPLE_MAX_STEPS,
        );
        const steps = Math.floor(this.accumulator / RIPPLE_DT);
        this.accumulator -= steps * RIPPLE_DT;
        this.stepsRun += steps;

        if (this.cpu) {
            this.updateCpu(this.cpu, steps);
        } else if (this.gpu && this.renderer) {
            this.updateGpu(this.gpu, this.renderer, steps);
        }

        this.sources.length = 0;
    }

    /** The water surface layer (displacement, slope, foam; CPU sample from the WebGL 2 field). */
    layer(): WaterSurfaceLayer {
        const sampleAt = (xz: Node<'vec2'>) => {
            const uv = xz.sub(this.origin).div(this.extent);
            const edge = min(
                min(uv.x, uv.y),
                min(uv.x.oneMinus(), uv.y.oneMinus()),
            );
            const fade = smoothstep(0, 0.12, edge).mul(this.strength);

            return {
                v: this.textureNode.sample(uv) as unknown as Vec4,
                fade,
            };
        };
        // The water's fragment stage is at WebGPU's 16 sampled-texture limit: the field is only read in
        // the vertex stage and its slope / foam reach the pixels as a varying (the fine mesh's 0.25 m
        // quads resolve the ~0.2 m cells well enough).
        let shaded: Vec4 | null = null;
        const pixel = (): Vec4 => {
            if (!shaded) {
                const { v, fade } = sampleAt(positionWorld.xz);
                shaded = varying(vec4(v.y, v.z, v.w, 1).mul(fade));
            }

            return shaded;
        };

        return {
            name: 'ripples',
            displacement: (ctx) => {
                const { v, fade } = sampleAt(ctx.xz);

                return vec3(0, v.x.mul(fade), 0);
            },
            slope: () => pixel().xy,
            foam: () => clamp(pixel().z, 0, 1),
            sample: (x, z, _time, out) => {
                const cpu = this.cpu;

                if (!cpu || this.envStrength <= 0) {
                    return;
                }

                const s = this.sampleScratch;
                cpu.sample(x, z, s);
                out.height += s.height * this.envStrength;
                out.slopeX += s.slopeX * this.envStrength;
                out.slopeZ += s.slopeZ * this.envStrength;
            },
        };
    }

    private readonly sampleScratch = { height: 0, slopeX: 0, slopeZ: 0 };

    /** For get_editor_state / tests. */
    describe(): {
        mode: 'gpu' | 'cpu' | 'off';
        resolution: number;
        cell_m: number;
        extent_m: number;
        origin: { x: number; z: number } | null;
        steps: number;
    } {
        const f = this.field;

        return {
            mode: this.mode,
            resolution: f?.size ?? 0,
            cell_m: f ? Math.round(f.cell * 1000) / 1000 : 0,
            extent_m: RIPPLE_EXTENT,
            origin: f
                ? {
                      x: Math.round(f.originX * 100) / 100,
                      z: Math.round(f.originZ * 100) / 100,
                  }
                : null,
            steps: this.stepsRun,
        };
    }

    dispose(): void {
        this.disposeField();
        this.placeholder.dispose();
    }

    // ------------------------------------------------------------------ internals

    private rebuild(): void {
        this.disposeField();
        const size = RIPPLE_RESOLUTION[this.quality] ?? 0;

        if (size <= 0 || !this.renderer) {
            this.textureNode.value = this.placeholder;
            this.strength.value = 0;

            return;
        }

        const webgpu = !!(
            this.renderer.backend as { isWebGPUBackend?: boolean }
        ).isWebGPUBackend;

        if (webgpu) {
            this.field = new RippleSim(size);
            this.gpu = this.createGpu(size);
            this.textureNode.value = this.gpu.output;
        } else {
            const n = Math.min(CPU_MAX, size);
            this.cpu = new RippleSim(n);
            this.field = this.cpu;
            this.cpuHalf = new Uint16Array(n * n * 4);
            const t = new THREE.DataTexture(
                this.cpuHalf,
                n,
                n,
                THREE.RGBAFormat,
                THREE.HalfFloatType,
            );
            t.minFilter = THREE.LinearFilter;
            t.magFilter = THREE.LinearFilter;
            t.generateMipmaps = false;
            t.name = 'Ripples';
            t.needsUpdate = true;
            this.cpuTexture = t;
            this.textureNode.value = t;
        }

        // Far away at first: the first update places it and builds the mask.
        this.field.originX = 1e9;
        this.field.originZ = 1e9;
        this.maskDirty = true;
        this.pendingShift = { x: 1e6, z: 1e6 };
        this.strength.value = this.envStrength;
    }

    private disposeField(): void {
        if (this.gpu) {
            this.gpu.output.dispose();
            this.gpu.a.value.dispose?.();
            this.gpu.b.value.dispose?.();
            this.gpu.mask.value.dispose?.();
        }

        this.cpuTexture?.dispose();
        this.gpu = null;
        this.cpu = null;
        this.cpuTexture = null;
        this.cpuHalf = null;
        this.field = null;
    }

    private updateCpu(sim: RippleSim, steps: number): void {
        for (const s of this.sources) {
            sim.disturb(s);
        }

        for (let i = 0; i < steps; i++) {
            sim.step();
        }

        if (steps > 0 || this.sources.length) {
            const out = sim.writeOutput();
            const half = this.cpuHalf!;

            for (let i = 0; i < out.length; i++) {
                half[i] = THREE.DataUtils.toHalfFloat(out[i]);
            }

            this.cpuTexture!.needsUpdate = true;
        }
    }

    private updateGpu(
        g: GpuField,
        renderer: GameRenderer,
        steps: number,
    ): void {
        const field = this.field!;
        const shifted = this.pendingShift.x !== 0 || this.pendingShift.z !== 0;

        if (!shifted && !this.sources.length && steps === 0) {
            return;
        }

        const kernels: THREE.ComputeNode[] = [];

        // Shift and sources: one pass into the other buffer.
        if (shifted || this.sources.length) {
            const a = this.sourceA.array as THREE.Vector4[];
            const f = this.sourceFoam.array as number[];

            for (let i = 0; i < RIPPLE_MAX_SOURCES; i++) {
                const s = this.sources[i];

                if (s) {
                    // Cell space of the (new) origin.
                    a[i].set(
                        (s.x - field.originX) / field.cell,
                        (s.z - field.originZ) / field.cell,
                        Math.max(0.75, s.radius / field.cell),
                        s.amount,
                    );
                    f[i] = s.foam;
                } else {
                    a[i].set(-1e4, -1e4, 1, 0);
                    f[i] = 0;
                }
            }

            const big = Math.abs(this.pendingShift.x) >= g.size;
            this.shift.value.set(
                big ? 1e6 : this.pendingShift.x,
                big ? 1e6 : this.pendingShift.z,
            );
            this.pendingShift = { x: 0, z: 0 };
            kernels.push(g.inject[g.current]);
            g.current = g.current === 0 ? 1 : 0;
        }

        // The uniforms above are read when the kernels are dispatched: one compute call for all.
        for (let i = 0; i < steps; i++) {
            kernels.push(g.step[g.current]);
            g.current = g.current === 0 ? 1 : 0;
        }

        kernels.push(g.out[g.current]);
        void renderer.compute(kernels);
    }

    private createGpu(size: number): GpuField {
        const n = size * size;
        const a = instancedArray(n, 'vec4') as unknown as Buffer;
        const b = instancedArray(n, 'vec4') as unknown as Buffer;
        const mask = instancedArray(n, 'float');
        const output = new THREE.StorageTexture(size, size);
        output.type = THREE.HalfFloatType;
        output.format = THREE.RGBAFormat;
        output.minFilter = THREE.LinearFilter;
        output.magFilter = THREE.LinearFilter;
        output.generateMipmaps = false;
        output.name = 'Ripples';
        const k = rippleCoefficient(RIPPLE_EXTENT / size);
        const cell = RIPPLE_EXTENT / size;
        const foamDecay = Math.exp(-RIPPLE_DT / RIPPLE_FOAM_DECAY);

        const coords = () => {
            const i = int(instanceIndex.mod(size));
            const j = int(instanceIndex.div(size));

            return { i, j };
        };
        const read = (buf: Buffer, i: Node<'int'>, j: Node<'int'>): Vec4 => {
            const inside = i
                .greaterThanEqual(0)
                .and(i.lessThan(size))
                .and(j.greaterThanEqual(0))
                .and(j.lessThan(size));
            const clampIndex = (v: Node<'int'>) =>
                select(
                    v.lessThan(0),
                    int(0),
                    select(v.greaterThan(size - 1), int(size - 1), v),
                ) as unknown as Node<'int'>;
            const ci = clampIndex(i);
            const cj = clampIndex(j);

            return select(
                inside,
                buf.element(cj.mul(size).add(ci)),
                vec4(0),
            ) as unknown as Vec4;
        };

        const inject = (src: Buffer, dst: Buffer) =>
            Fn(() => {
                const { i, j } = coords();
                const s = read(
                    src,
                    i.add(int(this.shift.x)),
                    j.add(int(this.shift.y)),
                );
                const p = vec2(float(i).add(0.5), float(j).add(0.5));
                let add: Float = float(0);
                let foam: Float = s.z;

                for (let q = 0; q < RIPPLE_MAX_SOURCES; q++) {
                    const src4 = this.sourceA.element(q) as unknown as Vec4;
                    const d = p.sub(src4.xy);
                    const g = exp(d.dot(d).div(src4.z.mul(src4.z)).negate());
                    add = add.add(src4.w.mul(g)) as Float;
                    foam = max(
                        foam,
                        (this.sourceFoam.element(q) as unknown as Float).mul(g),
                    ) as Float;
                }

                const m = mask.element(instanceIndex);
                const wet = select(m.greaterThan(0), float(1), float(0));
                dst.element(instanceIndex).assign(
                    vec4(s.x.add(add), s.y.add(add), foam, 0).mul(wet),
                );
            })().compute(n, [64]);

        const step = (src: Buffer, dst: Buffer) =>
            Fn(() => {
                const { i, j } = coords();
                const c = src.element(instanceIndex);
                const h = c.x;
                const sum = read(src, i.add(1), j)
                    .x.add(read(src, i.sub(1), j).x)
                    .add(read(src, i, j.add(1)).x)
                    .add(read(src, i, j.sub(1)).x);
                const m = mask.element(instanceIndex);
                const v = m.mul(
                    h
                        .mul(2)
                        .sub(c.y)
                        .add(sum.sub(h.mul(4)).mul(k)),
                );
                const speed = abs(v.sub(h)).div(RIPPLE_DT);
                const foam = max(
                    c.z.mul(foamDecay),
                    min(1, speed.sub(RIPPLE_FOAM_SPEED).mul(1.5)),
                ).mul(select(m.greaterThan(0), float(1), float(0)));
                dst.element(instanceIndex).assign(vec4(v, h, foam, 0));
            })().compute(n, [64]);

        const out = (src: Buffer) =>
            Fn(() => {
                const { i, j } = coords();
                const c = src.element(instanceIndex);
                const gx = read(src, i.add(1), j)
                    .x.sub(read(src, i.sub(1), j).x)
                    .div(2 * cell);
                const gz = read(src, i, j.add(1))
                    .x.sub(read(src, i, j.sub(1)).x)
                    .div(2 * cell);
                textureStore(
                    output,
                    uvec2(instanceIndex.mod(size), instanceIndex.div(size)),
                    vec4(c.x, gx, gz, c.z),
                );
            })().compute(n, [64]);

        return {
            size,
            a,
            b,
            mask,
            maskArray: mask.value.array as Float32Array,
            output,
            inject: [inject(a, b), inject(b, a)],
            step: [step(a, b), step(b, a)],
            out: [out(a), out(b)],
            current: 0,
        };
    }
}
