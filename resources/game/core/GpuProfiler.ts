import { InspectorBase, TimestampQuery } from 'three/webgpu';
import type { Object3D, RenderTarget } from 'three/webgpu';
import type { GameRenderer } from './renderer';

export type ProfileSection = {
    name: string;
    /** GPU time in ms (smoothed); null when timestamp queries are unsupported or no result arrived yet. */
    gpuMs: number | null;
    /** CPU (JavaScript + command submission) time in ms (smoothed); null for passes rendered by nodes. */
    cpuMs: number | null;
};

const SMOOTHING = 0.15;

type QueryPools = Record<
    string,
    { timestamps?: Map<string, number> } | undefined
>;

/**
 * Section names for draws issued inside the render pipeline, by the name of the drawn object (three's
 * post nodes name their full-screen quads, e.g. "Bloom [ High Pass ]"; the scene pass renders the scene
 * under its pass name) or, failing that, the render target's texture name (our passes name both).
 */
const PASS_NAMES: [prefix: string, section: string][] = [
    ['Shadow Map', 'Shadows'],
    ['Scene', 'Scene'],
    ['AO', 'GTAO'],
    ['GTAONode', 'GTAO'],
    ['Denoise', 'GTAO'],
    ['SSR', 'SSR'],
    ['TAAU', 'TAAU'],
    ['TRAA', 'TAA'],
    ['Bloom', 'Bloom'],
    ['UnrealBloomPass', 'Bloom'],
    ['SMAANode', 'SMAA'],
    ['FSR1', 'FSR 1'],
    ['Render Pipeline', 'Output'],
    // Our own passes (core/postfx) are named after their section.
    ['Contact shadows', 'Contact shadows'],
    ['Light shafts', 'Light shafts'],
    ['Composite', 'Composite'],
    ['DoF', 'DoF'],
    ['Motion blur', 'Motion blur'],
    ['Eye adaptation', 'Eye adaptation'],
    ['Lens flare', 'Lens flare'],
    ['Output', 'Output'],
];

/** Draws that are not named after a pass (the water reflection, custom passes) keep the open section. */
function passSection(
    object: Object3D | null,
    target: RenderTarget | null,
): string | null {
    const names = [object?.name, target?.texture?.name];

    for (const raw of names) {
        if (!raw) {
            continue;
        }

        // "Contact shadows [ RTT ]" → "Contact shadows".
        const name = raw.replace(/\s*\[.*\]$/, '');

        for (const [prefix, section] of PASS_NAMES) {
            if (name.startsWith(prefix)) {
                return section;
            }
        }

        if (object && 'isQuadMesh' in object) {
            return name;
        }
    }

    return null;
}

/**
 * Hooks into the renderer's inspector: every render / compute call of a frame gets a timestamp query
 * id (uid); the profiler remembers which section each one belongs to. It stays a plain InspectorBase
 * (methods assigned per instance): three only warns about TSL `.toInspector()` on WebGL for other
 * inspector classes.
 */
function createInspector(profiler: {
    section: string;
    detailed: boolean;
    owners: Map<string, string>;
    seen(section: string): void;
}): InspectorBase {
    const inspector = new InspectorBase();
    inspector.beginRender = (
        uid: string,
        scene: Object3D,
        _camera: unknown,
        target: RenderTarget | null,
    ) => {
        const named = profiler.detailed ? passSection(scene, target) : null;
        profiler.owners.set(uid, named ?? profiler.section);
    };
    // Listed when they finish: nested draws (a pass rendered on demand by a later one) come first.
    inspector.finishRender = (uid: string) => {
        const section = profiler.owners.get(uid);

        if (section) {
            profiler.seen(section);
        }
    };
    inspector.beginCompute = (
        uid: string,
        computeNodes: { name?: string } | { name?: string }[],
    ) => {
        const node = Array.isArray(computeNodes)
            ? computeNodes[0]
            : computeNodes;
        const named = profiler.detailed && node?.name ? node.name : null;
        profiler.owners.set(uid, named ?? profiler.section);

        if (named) {
            profiler.seen(named);
        }
    };

    return inspector;
}

/**
 * Per-pass frame profiler, like UE's `stat gpu`.
 *
 * - GPU: the renderer's timestamp queries (`trackTimestamp`), one per render / compute call, on WebGPU
 *   (`timestamp-query`) and on WebGL 2 (EXT_disjoint_timer_query_webgl2). Results arrive a few frames
 *   late. Calls are attributed to the pass they belong to by name (the passes of the render pipeline,
 *   which all run inside one `render()`), otherwise to the section opened with `mark()`.
 * - CPU: performance.now() between `mark`s (not available per pipeline pass).
 *
 * With `detailed` off, the frame is a single section; its GPU total still drives dynamic resolution.
 */
export class GpuProfiler {
    private readonly state = {
        section: 'Frame',
        detailed: false,
        owners: new Map<string, string>(),
        seen: (section: string) => {
            if (!this.frameOrder.includes(section)) {
                this.frameOrder.push(section);
            }
        },
    };
    private open: { name: string; start: number } | null = null;
    private cpu = new Map<string, number>();
    private gpu = new Map<string, number>();
    private order: string[] = [];
    private frameOrder: string[] = [];
    private resolving = false;
    /** Total GPU time of the most recent measured frame in ms (null until the first result / unsupported). */
    lastMs: number | null = null;

    constructor(private readonly renderer: GameRenderer) {
        renderer.inspector = createInspector(this.state);
    }

    /** Per-pass sections (true) or a single whole-frame measurement (false). */
    get detailed(): boolean {
        return this.state.detailed;
    }

    set detailed(value: boolean) {
        this.state.detailed = value;
    }

    get supported(): boolean {
        const backend = this.renderer.backend as { trackTimestamp?: boolean };

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
        this.state.section = 'Frame';
        void this.resolve();
    }

    /** Sections of the last frame, in order. */
    sections(): ProfileSection[] {
        return this.order.map((name) => ({
            name,
            gpuMs: this.gpu.get(name) ?? null,
            cpuMs: this.cpu.get(name) ?? null,
        }));
    }

    private start(name: string): void {
        this.open = { name, start: performance.now() };
        this.state.seen(name);
        this.state.section = name;
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
        const owners = this.state.owners;

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
                    const section = owners.get(uid) ?? 'Other';
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
            for (const uid of owners.keys()) {
                const frame = Number(uid.slice(uid.lastIndexOf(':f') + 2));

                if (frame <= latest) {
                    owners.delete(uid);
                }
            }

            if (owners.size > 4096) {
                owners.clear();
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
