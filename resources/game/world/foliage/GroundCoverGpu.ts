import * as THREE from 'three/webgpu';
import {
    abs,
    acos,
    atan,
    atomicAdd,
    bool,
    clamp,
    cos,
    degrees,
    dot,
    float,
    floor,
    Fn,
    If,
    instancedArray,
    instanceIndex,
    int,
    ivec2,
    min,
    normalize,
    round,
    sin,
    storage,
    textureLoad,
    uint,
    uniform,
    uniformArray,
    vec2,
    vec3,
    vec4,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { GameRenderer } from '../../core/renderer';
import type { FoliageType } from '../../shared/types';
import { NO_WATER, SPLAT_CHANNELS } from '../../shared/types';
import type { Heightfield } from '../Heightfield';
import type { GpuCell, GpuFill, GpuFiller, GpuSlots } from './FoliageGpu';
import type { GroundCoverContext, GroundCoverSource } from './groundCover';
import {
    clusterScale,
    expectedTileCount,
    SALT,
    tileGrid,
    tilePainted,
    typeSeed,
} from './groundCover';

type Float = Node<'float'>;
type Int = Node<'int'>;
type Uint = Node<'uint'>;

/** Ranges one pass clears / tiles it grows at most; the rest waits for the next frame. */
const MAX_FILLS = 512;
/** Threads a frame's passes run at most (32k workgroups). */
const MAX_THREADS = 1 << 21;
/**
 * u32 per tile in the fill job list: end and first thread (one per candidate), first slot and slots
 * of its range, first grid cell (g0, h0), columns of the candidate grid, tile (cx, cz).
 */
const FILL_JOB = 9;
/** Slots a tile gets beyond its expected count and five standard deviations. */
const CAPACITY_SLACK = 16;
/** Binary search steps over the fills of a pass (2^10 > MAX_FILLS). */
const SEARCH_STEPS = 10;
/** Sources per type (one per terrain layer at most). */
const MAX_SOURCES = SPLAT_CHANNELS;
/** Stands in for "no limit" of the height rules. */
const UNBOUNDED = 1e30;

/**
 * The terrain as the GPU generator reads it: heights and water surface levels in storage buffers that
 * share the CPU arrays (only the rows an edit touched are uploaded again), the splat map through its
 * existing terrain textures.
 */
export class GroundCoverField {
    readonly heights: GridBuffer;
    readonly water: GridBuffer;
    readonly splat: [THREE.Texture, THREE.Texture];

    constructor(
        readonly ctx: GroundCoverContext,
        water: Heightfield,
    ) {
        this.heights = new GridBuffer(ctx.heights);
        this.water = new GridBuffer(water);
        this.splat = ctx.splat.textures;
    }

    /** Re-uploads the rows of a world rect on the next sync (sculpting, water edits). */
    invalidate(minX: number, minZ: number, maxX: number, maxZ: number): void {
        this.heights.invalidate(minZ, maxZ);
        this.water.invalidate(minZ, maxZ);
    }

    /** Uploads the invalidated rows (before the frame's compute passes). */
    sync(): void {
        this.heights.sync();
        this.water.sync();
    }
}

/** A Heightfield mirrored in a float storage buffer (same array, row-range uploads). */
class GridBuffer {
    readonly node: THREE.StorageBufferNode<'float'>;
    private readonly attribute: THREE.StorageBufferAttribute;
    private dirty: { from: number; to: number } | null = null;

    constructor(readonly grid: Heightfield) {
        this.attribute = new THREE.StorageBufferAttribute(grid.data, 1);
        this.node = storage(this.attribute, 'float', grid.data.length);
    }

    invalidate(minZ: number, maxZ: number): void {
        const g = this.grid;
        const last = g.resolution - 1;
        const from = Math.max(0, Math.floor((minZ + g.half) / g.cell) - 1);
        const to = Math.min(last, Math.ceil((maxZ + g.half) / g.cell) + 1);

        if (from > to) {
            return;
        }

        this.dirty = this.dirty
            ? {
                  from: Math.min(this.dirty.from, from),
                  to: Math.max(this.dirty.to, to),
              }
            : { from, to };
    }

    sync(): void {
        if (!this.dirty) {
            return;
        }

        const res = this.grid.resolution;
        this.attribute.addUpdateRange(
            this.dirty.from * res,
            (this.dirty.to - this.dirty.from + 1) * res,
        );
        this.attribute.needsUpdate = true;
        this.dirty = null;
    }

    /** Heightfield.get(): the sample at whole grid coordinates, clamped to the grid. */
    at(col: Float, row: Float): Float {
        const last = this.grid.resolution - 1;

        return this.node.element(
            int(clamp(row, 0, last))
                .mul(this.grid.resolution)
                .add(int(clamp(col, 0, last))),
        );
    }

    /** Heightfield.sample(): bilinear, clamped to the map edge. */
    sample(x: Float, z: Float): Float {
        const g = this.grid;
        const last = g.resolution - 1;
        const gx = clamp(x.add(g.half).div(g.cell), 0, last).toVar();
        const gz = clamp(z.add(g.half).div(g.cell), 0, last).toVar();
        const c0 = min(floor(gx), last - 1).toVar();
        const r0 = min(floor(gz), last - 1).toVar();
        const fx = gx.sub(c0);
        const fz = gz.sub(r0);
        const i = int(r0).mul(g.resolution).add(int(c0)).toVar();
        const d = this.node;
        const top = d
            .element(i)
            .mul(fx.oneMinus())
            .add(d.element(i.add(1)).mul(fx));
        const bottom = d
            .element(i.add(g.resolution))
            .mul(fx.oneMinus())
            .add(d.element(i.add(g.resolution + 1)).mul(fx));

        return top.mul(fz.oneMinus()).add(bottom.mul(fz));
    }
}

/**
 * Ground cover tiles grown on the GPU (WebGPU): the compute port of generateGroundCoverTile. One thread
 * per candidate grid cell of a tile evaluates its candidate with the same integer hashes (bit-exact),
 * clustering noise, splat weights and placement rules as the CPU and appends the instance to the
 * tile's slot range (atomic counter per tile). A range is sized from the tile's expected count plus
 * a margin (expectedTileCount), so rejected candidates cost the culling pass nothing; a tile that
 * grows more than its range holds (read back) is grown again into an exact one. The CPU does no
 * per-instance work: it decides which tiles to (re)grow and drop, and reads their counts back.
 *
 * Floating point runs in f32 instead of f64, so positions differ by well under a millimetre and a
 * candidate right at a threshold (keep probability, slope or height limit, tile edge) can rarely fall
 * the other way; the hashes, and so the plants, are the same.
 */
export class GroundCoverGenerator implements GpuFiller {
    readonly maxFills = MAX_FILLS;
    readonly maxThreads = MAX_THREADS;
    private type: FoliageType;
    private readonly seed: number;
    private sources: GroundCoverSource[] = [];
    private size = 0;
    /** Ranges to clear: end (exclusive thread index), first slot − first thread (wrapping). */
    private readonly clearJobs = instancedArray(MAX_FILLS * 2, 'uint');
    /** Tiles to grow: see FILL_JOB. */
    private readonly fillJobs = instancedArray(MAX_FILLS * FILL_JOB, 'uint');
    private readonly clearCount = uniform(0, 'uint');
    private readonly fillCount = uniform(0, 'uint');
    /** Instances each tile of the last pass grew (also the append cursor). */
    private readonly counts = instancedArray(MAX_FILLS, 'uint').toAtomic();
    private readonly u = {
        cell: uniform(1),
        margin: uniform(0),
        span: uniform(1),
        peak: uniform(1),
        size: uniform(1),
        minScale: uniform(1),
        scaleRange: uniform(0),
        groves: uniform(14),
        clustered: uniform(0),
        align: uniform(0),
        randomYaw: uniform(1),
        minSlope: uniform(0),
        maxSlope: uniform(90),
        minHeight: uniform(-UNBOUNDED),
        maxHeight: uniform(UNBOUNDED),
        underwater: uniform(0),
        /** Per source: density, clustering. */
        sources: uniformArray<'vec4'>(
            Array.from({ length: MAX_SOURCES }, () => new THREE.Vector4()),
            'vec4',
        ),
        /** Per source: its splat channel as a one-hot mask over the two splat textures. */
        masksA: uniformArray<'vec4'>(
            Array.from({ length: MAX_SOURCES }, () => new THREE.Vector4()),
            'vec4',
        ),
        masksB: uniformArray<'vec4'>(
            Array.from({ length: MAX_SOURCES }, () => new THREE.Vector4()),
            'vec4',
        ),
    };
    private passes: {
        clear: THREE.ComputeNode;
        fill: THREE.ComputeNode;
    } | null = null;
    private passInstances: THREE.StorageBufferNode<'vec4'> | null = null;

    constructor(
        readonly field: GroundCoverField,
        type: FoliageType,
    ) {
        this.type = type;
        // Compiled into the pass (a type's id never changes).
        this.seed = typeSeed(type.id);
    }

    /** Type, sources and tile size of the next passes (tiles already grown keep their plants). */
    configure(
        type: FoliageType,
        sources: GroundCoverSource[],
        size: number,
    ): void {
        this.type = type;
        this.sources = sources.slice(0, MAX_SOURCES);
        this.size = size;
        const u = this.u;
        u.size.value = size;
        u.minScale.value = type.min_scale;
        u.scaleRange.value = type.max_scale - type.min_scale;
        u.groves.value = clusterScale(type.kind);
        u.clustered.value = this.sources.some((s) => s.clustering > 0) ? 1 : 0;
        u.align.value = type.align_to_normal ? 1 : 0;
        u.randomYaw.value = type.random_yaw ? 1 : 0;
        u.minSlope.value = type.min_slope;
        u.maxSlope.value = type.max_slope;
        u.minHeight.value = type.min_height ?? -UNBOUNDED;
        u.maxHeight.value = type.max_height ?? UNBOUNDED;
        u.underwater.value = type.allow_underwater ? 1 : 0;
        // The candidate grid's spacing does not depend on the tile.
        const grid = tileGrid(type, this.sources, size, 0, 0);
        u.cell.value = grid?.cell ?? 1;
        u.margin.value = grid?.margin ?? 0;
        u.span.value = grid?.span ?? 1;
        u.peak.value = grid?.peak ?? 1;
        const params = u.sources.array as THREE.Vector4[];
        const masksA = u.masksA.array as THREE.Vector4[];
        const masksB = u.masksB.array as THREE.Vector4[];

        for (let i = 0; i < MAX_SOURCES; i++) {
            const s = this.sources[i];
            params[i].set(s?.density ?? 0, s?.clustering ?? 0, 0, 0);
            masksA[i].set(0, 0, 0, 0);
            masksB[i].set(0, 0, 0, 0);

            if (s) {
                (s.slot < 4 ? masksA[i] : masksB[i]).setComponent(
                    s.slot % 4,
                    1,
                );
            }
        }
    }

    /**
     * Slots for a tile: its expected count plus five standard deviations (and a few), at most one per
     * candidate; 0 when no source layer is painted there.
     */
    capacity(cx: number, cz: number): number {
        const { type, sources, size } = this;
        const grid = tileGrid(type, sources, size, cx, cz);

        if (!grid || !tilePainted(size, cx, cz, sources, this.field.ctx)) {
            return 0;
        }

        const expected = expectedTileCount(
            type,
            size,
            cx,
            cz,
            sources,
            this.field.ctx,
        );

        return Math.min(
            grid.columns * grid.rows,
            Math.ceil(expected + 5 * Math.sqrt(expected) + CAPACITY_SLACK),
        );
    }

    threads(cell: GpuCell): number {
        const grid = tileGrid(
            this.type,
            this.sources,
            this.size,
            cell.cx,
            cell.cz,
        );

        return grid ? grid.columns * grid.rows : 0;
    }

    pass(
        instances: THREE.StorageBufferNode<'vec4'>,
        clears: GpuSlots[],
        fills: GpuFill[],
    ): THREE.ComputeNode[] {
        if (!this.passes || this.passInstances !== instances) {
            this.disposePasses();
            this.passes = this.build(instances);
            this.passInstances = instances;
        }

        const { clear, fill } = this.passes;
        const nodes: THREE.ComputeNode[] = [];

        if (clears.length) {
            const jobs = (this.clearJobs.value as THREE.BufferAttribute)
                .array as Uint32Array;
            let end = 0;

            clears.forEach((range, i) => {
                jobs[i * 2 + 1] = (range.start - end) >>> 0;
                end += range.length;
                jobs[i * 2] = end;
            });

            this.upload(this.clearJobs, clears.length * 2);
            this.clearCount.value = clears.length;
            clear.count = end;
            nodes.push(clear);
        }

        if (fills.length) {
            const jobs = (this.fillJobs.value as THREE.BufferAttribute)
                .array as Uint32Array;
            let end = 0;

            fills.forEach((f, i) => {
                const o = i * FILL_JOB;
                const grid = tileGrid(
                    this.type,
                    this.sources,
                    this.size,
                    f.cell.cx,
                    f.cell.cz,
                )!;
                jobs[o + 1] = end;
                end += grid.columns * grid.rows;
                jobs[o] = end;
                jobs[o + 2] = f.start;
                jobs[o + 3] = f.length;
                jobs[o + 4] = grid.g0 >>> 0;
                jobs[o + 5] = grid.h0 >>> 0;
                jobs[o + 6] = grid.columns;
                jobs[o + 7] = f.cell.cx >>> 0;
                jobs[o + 8] = f.cell.cz >>> 0;
            });

            this.upload(this.fillJobs, fills.length * FILL_JOB);
            // The counters start at zero (their CPU copy never changes).
            (this.counts.value as THREE.BufferAttribute).needsUpdate = true;
            this.fillCount.value = fills.length;
            fill.count = end;
            nodes.push(fill);
        }

        return nodes;
    }

    async readCounts(renderer: GameRenderer): Promise<Uint32Array> {
        const buffer = await renderer.getArrayBufferAsync(
            this.counts.value as THREE.StorageBufferAttribute,
        );

        return new Uint32Array(buffer as ArrayBuffer);
    }

    dispose(): void {
        this.disposePasses();
    }

    private upload(jobs: THREE.StorageBufferNode<'uint'>, count: number): void {
        const attribute = jobs.value as THREE.BufferAttribute;
        attribute.addUpdateRange(0, count);
        attribute.needsUpdate = true;
    }

    private disposePasses(): void {
        this.passes?.clear.dispose();
        this.passes?.fill.dispose();
        this.passes = null;
        this.passInstances = null;
    }

    private build(instances: THREE.StorageBufferNode<'vec4'>): {
        clear: THREE.ComputeNode;
        fill: THREE.ComputeNode;
    } {
        const clearJobs = this.clearJobs;
        const fillJobs = this.fillJobs;

        // Every slot of the ranges dead (freed ranges, and the ranges about to be grown again).
        const clear = Fn(() => {
            const job = findJob(clearJobs, 2, this.clearCount);
            const slot = instanceIndex.add(
                clearJobs.element(job.mul(2).add(1)),
            );
            instances.element(slot.mul(4).add(3)).assign(vec4(0));
        })().compute(1);

        const fill = Fn(() => {
            const job = findJob(fillJobs, FILL_JOB, this.fillCount);
            const base = job.mul(FILL_JOB).toVar();
            const local = instanceIndex
                .sub(fillJobs.element(base.add(1)))
                .toVar();
            // Candidate of this thread (generateGroundCoverTile's loops, row by row).
            const columns = fillJobs.element(base.add(6));
            const gx = int(fillJobs.element(base.add(4)))
                .add(int(local.mod(columns)))
                .toVar();
            const gz = int(fillJobs.element(base.add(5)))
                .add(int(local.div(columns)))
                .toVar();
            const origin = vec2(
                float(int(fillJobs.element(base.add(7)))),
                float(int(fillJobs.element(base.add(8)))),
            ).mul(this.u.size);
            const instance = this.candidate(gx, gz, origin);

            If(instance.kept, () => {
                // Append to the tile's range; a tile growing more than it holds is grown again.
                const n = atomicAdd(this.counts.element(job), 1).toVar();

                If(n.lessThan(fillJobs.element(base.add(3))), () => {
                    const slot = fillJobs
                        .element(base.add(2))
                        .add(n)
                        .mul(4)
                        .toVar();

                    instance.rows.forEach((row, i) => {
                        instances.element(slot.add(i)).assign(row);
                    });
                });
            });
        })().compute(1);

        return { clear, fill };
    }

    /**
     * Evaluates the candidate of grid cell gx, gz for the tile at `origin` (m): whether it is kept and
     * its instance rows (writeInstance() of [x, y, z, yaw, scale, tiltX, tiltZ], then rank, scale, live).
     */
    private candidate(
        gx: Int,
        gz: Int,
        origin: Node<'vec2'>,
    ): { kept: Node<'bool'>; rows: Node<'vec4'>[] } {
        const u = this.u;
        const field = this.field;
        const seed = this.seed;
        // cellRandom(): hash of a grid cell and a salt → [0, 1) with 24 bits (exact in f32).
        const random = (cx: Int, cz: Int, salt: number): Float =>
            float(
                hash32(
                    uint(seed).bitXor(
                        hash32(
                            uint(cx).bitXor(
                                hash32(uint(cz).bitXor(uint(salt))),
                            ),
                        ),
                    ),
                ).shiftRight(uint(8)),
            ).div(16777216);
        const smooth = (t: Float) => t.mul(t).mul(float(3).sub(t.mul(2)));
        const kept = bool(false).toVar();
        const rows = [vec4(0), vec4(0), vec4(0), vec4(0)].map((r) => r.toVar());
        const x = float(gx)
            .mul(u.cell)
            .add(u.margin)
            .add(random(gx, gz, SALT.x).mul(u.span))
            .toVar();
        const z = float(gz)
            .mul(u.cell)
            .add(u.margin)
            .add(random(gx, gz, SALT.z).mul(u.span))
            .toVar();
        const half = field.heights.grid.half;
        // Each candidate belongs to exactly one tile (the one it lands in), inside the map.
        const inside = x
            .greaterThanEqual(origin.x)
            .and(x.lessThan(origin.x.add(u.size)))
            .and(z.greaterThanEqual(origin.y))
            .and(z.lessThan(origin.y.add(u.size)))
            .and(abs(x).lessThanEqual(half))
            .and(abs(z).lessThanEqual(half));

        If(inside, () => {
            // Paint weight × density × clustering of every source, against the keep probability.
            const noise = float(0.5).toVar();

            If(u.clustered.greaterThan(0.5), () => {
                const fx = x.div(u.groves);
                const fz = z.div(u.groves);
                const cx = int(floor(fx)).toVar();
                const cz = int(floor(fz)).toVar();
                const tx = smooth(fx.sub(float(cx))).toVar();
                const tz = smooth(fz.sub(float(cz))).toVar();
                const at = (dx: number, dz: number) =>
                    random(cx.add(dx), cz.add(dz), SALT.cluster);
                const top = at(0, 0).mul(tx.oneMinus()).add(at(1, 0).mul(tx));
                const bottom = at(0, 1)
                    .mul(tx.oneMinus())
                    .add(at(1, 1).mul(tx));
                noise.assign(top.mul(tz.oneMinus()).add(bottom.mul(tz)));
            });

            const [splatA, splatB] = splatWeights(field, x, z);
            const weight = float(0).toVar();
            // clusterFactor() = 1 + clustering × grove.
            const grove = smooth(clamp(noise.sub(0.3).div(0.4), 0, 1))
                .mul(2)
                .sub(1)
                .toVar();

            for (let s = 0; s < MAX_SOURCES; s++) {
                const params = u.sources.element(s);
                const w = dot(splatA, u.masksA.element(s)).add(
                    dot(splatB, u.masksB.element(s)),
                );
                weight.addAssign(
                    w.mul(params.x).mul(params.y.mul(grove).add(1)),
                );
            }

            If(random(gx, gz, SALT.keep).lessThan(weight.div(u.peak)), () => {
                // placementAllowed(): slope, altitude, water.
                const heights = field.heights;
                const y = heights.sample(x, z).toVar();
                const e = heights.grid.cell;
                const normal = normalize(
                    vec3(
                        heights
                            .sample(x.sub(e), z)
                            .sub(heights.sample(x.add(e), z)),
                        2 * e,
                        heights
                            .sample(x, z.sub(e))
                            .sub(heights.sample(x, z.add(e))),
                    ),
                ).toVar();
                const slope = degrees(acos(clamp(normal.y, -1, 1)));
                const dry = u.underwater
                    .greaterThan(0.5)
                    .or(
                        waterLevel(field.water, x, z).lessThanEqual(
                            y.sub(0.05),
                        ),
                    );

                kept.assign(
                    slope
                        .greaterThanEqual(u.minSlope)
                        .and(slope.lessThanEqual(u.maxSlope))
                        .and(y.greaterThanEqual(u.minHeight))
                        .and(y.lessThanEqual(u.maxHeight))
                        .and(dry),
                );

                const scale = u.minScale
                    .add(random(gx, gz, SALT.scale).mul(u.scaleRange))
                    .toVar();
                const yaw = random(gx, gz, SALT.yaw)
                    .mul(Math.PI * 2)
                    .mul(u.randomYaw);
                const tiltX = atan(normal.z, normal.y).mul(u.align);
                const tiltZ = atan(normal.x, normal.y).negate().mul(u.align);
                // Rotation of Euler(tiltX, yaw, tiltZ, 'XZY') × scale, row by row.
                const a = cos(tiltX).toVar();
                const b = sin(tiltX).toVar();
                const c = cos(yaw).toVar();
                const d = sin(yaw).toVar();
                const ce = cos(tiltZ).toVar();
                const f = sin(tiltZ).toVar();
                rows[0].assign(
                    vec4(vec3(c.mul(ce), f.negate(), d.mul(ce)).mul(scale), x),
                );
                rows[1].assign(
                    vec4(
                        vec3(
                            a.mul(c).mul(f).add(b.mul(d)),
                            a.mul(ce),
                            a.mul(d).mul(f).sub(b.mul(c)),
                        ).mul(scale),
                        y.sub(scale.mul(0.05)),
                    ),
                );
                rows[2].assign(
                    vec4(
                        vec3(
                            b.mul(c).mul(f).sub(a.mul(d)),
                            b.mul(ce),
                            b.mul(d).mul(f).add(a.mul(c)),
                        ).mul(scale),
                        z,
                    ),
                );
                // Rank (distance thinning, the order the CPU sorts by), scale, live.
                rows[3].assign(vec4(random(gx, gz, SALT.rank), scale, 1, 0));
            });
        });

        return { kept, rows };
    }
}

/** Index of the job a thread belongs to: the first whose end (first u32 of `stride`) lies past it. */
function findJob(
    jobs: THREE.StorageBufferNode<'uint'>,
    stride: number,
    count: Uint,
): Uint {
    const lo = uint(0).toVar();
    const hi = count.toVar();

    for (let k = 0; k < SEARCH_STEPS; k++) {
        If(lo.lessThan(hi), () => {
            const mid = lo.add(hi).div(2).toVar();

            If(jobs.element(mid.mul(stride)).greaterThan(instanceIndex), () => {
                hi.assign(mid);
            }).Else(() => {
                lo.assign(mid.add(1));
            });
        });
    }

    return lo;
}

/** lowbias32 (groundCover.ts hash32): u32 multiplies wrap and shifts are logical, as with Math.imul / >>>. */
const hash32 = Fn(([input]: [Uint]) => {
    const x = uint(input).toVar();
    x.assign(x.bitXor(x.shiftRight(uint(16))));
    x.assign(x.mul(uint(0x7feb352d)));
    x.assign(x.bitXor(x.shiftRight(uint(15))));
    x.assign(x.mul(uint(0x846ca68b)));
    x.assign(x.bitXor(x.shiftRight(uint(16))));

    return x;
}).setLayout({
    name: 'groundCoverHash32',
    type: 'uint',
    inputs: [{ name: 'x', type: 'uint' }],
});

/**
 * splatWeight() of all eight channels at once: bilinear over the byte values (read back exactly from
 * the RGBA8 terrain textures), / 255.
 */
function splatWeights(
    field: GroundCoverField,
    x: Float,
    z: Float,
): [Node<'vec4'>, Node<'vec4'>] {
    const g = field.heights.grid;
    const last = field.ctx.splat.resolution - 1;
    const gx = x.add(g.half).div(g.cell).toVar();
    const gz = z.add(g.half).div(g.cell).toVar();
    const x0 = clamp(floor(gx), 0, last).toVar();
    const z0 = clamp(floor(gz), 0, last).toVar();
    const x1 = min(x0.add(1), last);
    const z1 = min(z0.add(1), last);
    const fx = clamp(gx.sub(x0), 0, 1).toVar();
    const fz = clamp(gz.sub(z0), 0, 1).toVar();

    const weights = (texture: THREE.Texture) => {
        const at = (col: Float, row: Float) =>
            round(textureLoad(texture, ivec2(int(col), int(row))).mul(255));
        const top = at(x0, z0).mul(fx.oneMinus()).add(at(x1, z0).mul(fx));
        const bottom = at(x0, z1).mul(fx.oneMinus()).add(at(x1, z1).mul(fx));

        return top.mul(fz.oneMinus()).add(bottom.mul(fz)).div(255).toVar();
    };

    return [weights(field.splat[0]), weights(field.splat[1])];
}

/**
 * Water.levelAt(): the nearest sample decides whether it is wet; the level averages the wet samples
 * of the cell. Dry returns a level far below any terrain. (Outside the water grid levelAt reports the
 * ocean; the grid spans the map, so no candidate gets there.)
 */
function waterLevel(water: GridBuffer, x: Float, z: Float): Float {
    const g = water.grid;
    const gx = x.add(g.half).div(g.cell).toVar();
    const gz = z.add(g.half).div(g.cell).toVar();
    const level = float(NO_WATER).toVar();
    // Math.round: halves round up (WGSL round() would round them to even).
    const v = water.at(floor(gx.add(0.5)), floor(gz.add(0.5)));

    If(v.greaterThan(NO_WATER + 1), () => {
        const c0 = floor(gx).toVar();
        const r0 = floor(gz).toVar();
        const sum = float(0).toVar();
        const count = float(0).toVar();

        for (let dz = 0; dz <= 1; dz++) {
            for (let dx = 0; dx <= 1; dx++) {
                const s = water.at(c0.add(dx), r0.add(dz)).toVar();

                If(s.greaterThan(NO_WATER + 1), () => {
                    sum.addAssign(s);
                    count.addAssign(1);
                });
            }
        }

        level.assign(count.greaterThan(0).select(sum.div(count), v));
    });

    return level;
}
