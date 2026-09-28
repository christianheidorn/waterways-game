export type ProfileSection = {
    name: string;
    /** GPU time in ms (smoothed); null when timer queries are unsupported or no result arrived yet. */
    gpuMs: number | null;
    /** CPU (JavaScript + WebGL submission) time in ms (smoothed). */
    cpuMs: number;
};

type Pending = { name: string; query: WebGLQuery | null }[];

const MAX_IN_FLIGHT = 4;
const SMOOTHING = 0.15;

/**
 * Per-pass frame profiler, like UE's `stat gpu`: GPU time per section with EXT_disjoint_timer_query_webgl2
 * (results arrive a few frames late) and CPU time per section with performance.now().
 *
 * Sections are sequential (`mark` closes the previous one), because WebGL allows only one time-elapsed
 * query at a time. With `detailed` off, the whole frame is a single section — that total still drives
 * dynamic resolution — so the per-pass queries only run while someone looks at them (the F10 menu).
 */
export class GpuProfiler {
    private readonly gl: WebGL2RenderingContext;
    private readonly ext: {
        TIME_ELAPSED_EXT: number;
        GPU_DISJOINT_EXT: number;
    } | null;
    private readonly inFlight: Pending[] = [];
    private frame: Pending | null = null;
    private open: { name: string; start: number } | null = null;
    private cpu = new Map<string, number>();
    private gpu = new Map<string, number>();
    private order: string[] = [];
    private frameOrder: string[] = [];
    /** Per-pass sections (true) or a single whole-frame measurement (false). */
    detailed = false;
    /** Total GPU time of the most recent measured frame in ms (null until the first result / unsupported). */
    lastMs: number | null = null;

    constructor(gl: WebGLRenderingContext | WebGL2RenderingContext) {
        this.gl = gl as WebGL2RenderingContext;
        this.ext =
            typeof WebGL2RenderingContext !== 'undefined' &&
            gl instanceof WebGL2RenderingContext
                ? gl.getExtension('EXT_disjoint_timer_query_webgl2')
                : null;
    }

    get supported(): boolean {
        return this.ext !== null;
    }

    /** Starts a frame with its first section. */
    begin(name: string): void {
        this.poll();
        this.frameOrder = [];
        this.frame = this.inFlight.length < MAX_IN_FLIGHT ? [] : null;
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

    /** Ends the frame. */
    end(): void {
        if (!this.open) {
            return;
        }

        this.stop();
        this.order = this.frameOrder;

        if (this.frame) {
            this.inFlight.push(this.frame);
            this.frame = null;
        }
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

        if (this.ext && this.frame) {
            const query = this.gl.createQuery();

            if (query) {
                this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
            }

            this.frame.push({ name, query });
        }
    }

    private stop(): void {
        const open = this.open!;
        this.open = null;
        smooth(this.cpu, open.name, performance.now() - open.start);

        if (this.ext && this.frame) {
            const last = this.frame[this.frame.length - 1];

            if (last?.query) {
                this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
            }
        }
    }

    /** Collects finished frames (all queries of a frame are read together). */
    private poll(): void {
        const gl = this.gl;

        while (this.ext && this.inFlight.length) {
            const frame = this.inFlight[0];
            const last = frame[frame.length - 1]?.query;

            if (
                last &&
                !gl.getQueryParameter(last, gl.QUERY_RESULT_AVAILABLE)
            ) {
                return;
            }

            this.inFlight.shift();
            const disjoint = gl.getParameter(
                this.ext.GPU_DISJOINT_EXT,
            ) as boolean;
            let total = 0;

            for (const { name, query } of frame) {
                if (!query) {
                    continue;
                }

                if (!disjoint) {
                    const ms =
                        (gl.getQueryParameter(
                            query,
                            gl.QUERY_RESULT,
                        ) as number) / 1e6;
                    total += ms;
                    smooth(this.gpu, name, ms);
                }

                gl.deleteQuery(query);
            }

            if (!disjoint) {
                this.lastMs = total;
            }
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
