import { InspectorBase, TimestampQuery } from 'three/webgpu';
import type { GameRenderer } from './renderer';

export type ProfileSection = {
    name: string;
    /** GPU time in ms (smoothed); null when timestamp queries are unsupported or no result arrived yet. */
    gpuMs: number | null;
    /** CPU (JavaScript + command submission) time in ms (smoothed). */
    cpuMs: number;
};

const SMOOTHING = 0.15;

type QueryPools = Record<
    string,
    { timestamps?: Map<string, number> } | undefined
>;

/**
 * Hooks into the renderer's inspector: every render / compute call of a frame gets a timestamp query
 * id (uid); the profiler remembers which section was open when each one started.
 */
class SectionInspector extends InspectorBase {
    section = 'Frame';
    readonly owners = new Map<string, string>();

    override beginRender(uid: string): void {
        this.owners.set(uid, this.section);
    }

    override beginCompute(uid: string): void {
        this.owners.set(uid, this.section);
    }
}

/**
 * Per-pass frame profiler, like UE's `stat gpu`.
 *
 * - GPU: the renderer's timestamp queries (`trackTimestamp`), one per render / compute call, on WebGPU
 *   (`timestamp-query`) and on WebGL 2 (EXT_disjoint_timer_query_webgl2). Results arrive a few frames
 *   late and are attributed to the section that issued each call.
 * - CPU: performance.now() between `mark`s.
 *
 * With `detailed` off, the frame is a single section; its GPU total still drives dynamic resolution.
 */
export class GpuProfiler {
    private readonly inspector = new SectionInspector();
    private open: { name: string; start: number } | null = null;
    private cpu = new Map<string, number>();
    private gpu = new Map<string, number>();
    private order: string[] = [];
    private frameOrder: string[] = [];
    private resolving = false;
    /** Per-pass sections (true) or a single whole-frame measurement (false). */
    detailed = false;
    /** Total GPU time of the most recent measured frame in ms (null until the first result / unsupported). */
    lastMs: number | null = null;

    constructor(private readonly renderer: GameRenderer) {
        renderer.inspector = this.inspector;
    }

    get supported(): boolean {
        const backend = this.renderer.backend as {
            trackTimestamp?: boolean;
            hasFeature?: (name: string) => boolean;
        };

        return !!backend.trackTimestamp;
    }

    /** Starts a frame with its first section. */
    begin(name: string): void {
        this.frameOrder = [];
        this.start(this.detailed ? name : 'Frame');
    }

    /** Closes the current section and opens the next one (ignored unless detailed). */
    mark(name: string): void {
        if (!this.detailed || !this.open) {
            return;
        }

        this.stop();
        this.start(name);
    }

    /** Ends the frame and collects GPU timings of earlier frames. */
    end(): void {
        if (!this.open) {
            return;
        }

        this.stop();
        this.order = this.frameOrder;
        this.inspector.section = 'Frame';
        void this.resolve();
    }

    /** Sections of the last frame, in order. */
    sections(): ProfileSection[] {
        return this.order.map((name) => ({
            name,
            gpuMs: this.gpu.get(name) ?? null,
            cpuMs: this.cpu.get(name) ?? 0,
        }));
    }

    private start(name: string): void {
        this.open = { name, start: performance.now() };
        this.frameOrder.push(name);
        this.inspector.section = name;
    }

    private stop(): void {
        const open = this.open!;
        this.open = null;
        smooth(this.cpu, open.name, performance.now() - open.start);
    }

    private async resolve(): Promise<void> {
        if (this.resolving || !this.supported) {
            return;
        }

        this.resolving = true;

        try {
            const renderer = this.renderer;
            await Promise.all([
                renderer.resolveTimestampsAsync(TimestampQuery.RENDER),
                renderer.resolveTimestampsAsync(TimestampQuery.COMPUTE),
            ]);
            const pools = (
                renderer.backend as unknown as {
                    timestampQueryPool: QueryPools;
                }
            ).timestampQueryPool;
            // uid = "<r|c>:<call>:<id>:f<frame>" → per frame, per section.
            const frames = new Map<number, Map<string, number>>();

            for (const pool of Object.values(pools)) {
                for (const [uid, ms] of pool?.timestamps ?? []) {
                    const frame = Number(uid.slice(uid.lastIndexOf(':f') + 2));
                    const section = this.inspector.owners.get(uid) ?? 'Other';
                    const sums = frames.get(frame) ?? new Map<string, number>();
                    sums.set(section, (sums.get(section) ?? 0) + ms);
                    frames.set(frame, sums);
                }
            }

            const latest = Math.max(...frames.keys());

            if (Number.isFinite(latest)) {
                const sums = frames.get(latest)!;
                let total = 0;

                for (const [section, ms] of sums) {
                    total += ms;
                    smooth(this.gpu, section, ms);
                }

                this.lastMs = total;
            }

            // Forget uids of resolved frames (they are unique per frame).
            for (const uid of this.inspector.owners.keys()) {
                const frame = Number(uid.slice(uid.lastIndexOf(':f') + 2));

                if (frame <= latest) {
                    this.inspector.owners.delete(uid);
                }
            }

            if (this.inspector.owners.size > 4096) {
                this.inspector.owners.clear();
            }
        } catch {
            // Device lost / unsupported: keep the CPU timings.
        } finally {
            this.resolving = false;
        }
    }
}

function smooth(map: Map<string, number>, name: string, value: number): void {
    const previous = map.get(name);
    map.set(
        name,
        previous === undefined
            ? value
            : previous + (value - previous) * SMOOTHING,
    );
}
