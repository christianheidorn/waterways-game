import type { GridRect } from '../../world/Heightfield';
import type { Heightfield } from '../../world/Heightfield';
import type { SplatMap } from '../../world/SplatMap';
import type { WorkerRequest, WorkerResponse } from './editorWorker';
import { readRect } from './gridRect';

type Pending = {
    resolve: (response: WorkerResponse) => void;
    reject: (error: Error) => void;
};

/**
 * Main-thread side of the editor worker (editorWorker.ts): one module worker, requests matched to
 * responses by id. Used on the WebGL 2 fallback (Game enables it there) for erosion brush steps, the
 * foliage scatter and ground cover tiles; on WebGPU the same work stays on the main thread or runs as
 * GPU compute. A worker that fails to start leaves `available` false and callers do the work inline.
 */
export class EditorWorkerClient {
    private worker: Worker | null = null;
    private nextId = 1;
    private readonly pending = new Map<number, Pending>();
    /** Jobs in flight (callers limit how many they queue). */
    get busy(): number {
        return this.pending.size;
    }

    available = false;
    /** Jobs finished (tests / profiling). */
    completed = 0;

    constructor() {
        try {
            this.worker = new Worker(
                new URL('./editorWorker.ts', import.meta.url),
                { type: 'module', name: 'waterways-editor' },
            );
            this.worker.onmessage = (event: MessageEvent) =>
                this.receive(event.data);
            this.worker.onerror = (event) => {
                console.warn('Editor worker failed; working inline', event);
                this.fail(new Error('Editor worker failed'));
            };
            this.available = true;
        } catch (error) {
            console.warn('Editor worker unavailable; working inline', error);
        }
    }

    request(
        request: WorkerRequest,
        transfer: Transferable[] = [],
    ): Promise<WorkerResponse> {
        const worker = this.worker;

        if (!worker || !this.available) {
            return Promise.reject(new Error('Editor worker unavailable'));
        }

        const id = this.nextId++;

        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            worker.postMessage({ id, request }, transfer);
        });
    }

    /** Erosion brush step on a copy of the region it touches; resolves with the changed heights. */
    async erode(
        heights: Heightfield,
        kind: 'hydraulic' | 'thermal',
        x: number,
        z: number,
        request: Pick<
            Extract<WorkerRequest, { op: 'erode' }>,
            'brush' | 'dt' | 'options'
        >,
    ): Promise<{ rect: GridRect; heights: Float32Array } | null> {
        // Droplets live within 1.25 × the radius, plus the erosion kernel (≤ 8 cells) and a margin.
        const region = heights.rectForCircle(
            x,
            z,
            request.brush.radius * 1.25,
            12,
        );
        const values = readRect(
            heights.data,
            heights.resolution,
            region,
            1,
            new Float32Array(
                (region.x1 - region.x0 + 1) * (region.z1 - region.z0 + 1),
            ),
        );
        const response = (await this.request(
            {
                op: 'erode',
                kind,
                resolution: heights.resolution,
                size: heights.size,
                region,
                heights: values,
                x,
                z,
                ...request,
            },
            [values.buffer],
        )) as { rect: GridRect | null; heights: Float32Array | null };

        return response.rect && response.heights
            ? { rect: response.rect, heights: response.heights }
            : null;
    }

    /** Full copies of the grids ground cover tiles read (heights, water surface, splat map). */
    setWorld(heights: Heightfield, water: Heightfield, splat: SplatMap): void {
        void this.request({
            op: 'world',
            resolution: heights.resolution,
            size: heights.size,
            heights: new Float32Array(heights.data),
            water: new Float32Array(water.data),
            splatResolution: splat.resolution,
            splat: new Uint8Array(splat.data),
        }).catch(() => undefined);
    }

    /** Sends a changed grid rect (height / water grid resolution) of all three grids. */
    patchWorld(
        heights: Heightfield,
        water: Heightfield,
        splat: SplatMap,
        rect: GridRect,
    ): void {
        const res = heights.resolution;
        const clamp = (r: GridRect, max: number): GridRect => ({
            x0: Math.max(0, Math.min(max, r.x0)),
            z0: Math.max(0, Math.min(max, r.z0)),
            x1: Math.max(0, Math.min(max, r.x1)),
            z1: Math.max(0, Math.min(max, r.z1)),
        });
        const grid = clamp(rect, res - 1);
        const cells = (grid.x1 - grid.x0 + 1) * (grid.z1 - grid.z0 + 1);
        const k = (splat.resolution - 1) / (res - 1);
        const splatRect = clamp(
            {
                x0: Math.floor(grid.x0 * k),
                z0: Math.floor(grid.z0 * k),
                x1: Math.ceil(grid.x1 * k),
                z1: Math.ceil(grid.z1 * k),
            },
            splat.resolution - 1,
        );
        const splatCells =
            (splatRect.x1 - splatRect.x0 + 1) *
            (splatRect.z1 - splatRect.z0 + 1);
        const h = readRect(heights.data, res, grid, 1, new Float32Array(cells));
        const w = readRect(water.data, res, grid, 1, new Float32Array(cells));
        const s = readRect(
            splat.data,
            splat.resolution,
            splatRect,
            8,
            new Uint8Array(splatCells * 8),
        );
        void this.request(
            {
                op: 'patch',
                rect: grid,
                heights: h,
                water: w,
                splatRect,
                splat: s,
            },
            [h.buffer, w.buffer, s.buffer],
        ).catch(() => undefined);
    }

    dispose(): void {
        this.fail(new Error('Editor worker closed'));
        this.worker?.terminate();
        this.worker = null;
    }

    private receive(message: {
        id: number;
        response?: WorkerResponse;
        error?: string;
    }): void {
        const pending = this.pending.get(message.id);

        if (!pending) {
            return;
        }

        this.pending.delete(message.id);
        this.completed++;

        if (message.error !== undefined || !message.response) {
            pending.reject(new Error(message.error ?? 'Editor worker error'));
        } else {
            pending.resolve(message.response);
        }
    }

    private fail(error: Error): void {
        this.available = false;

        for (const pending of this.pending.values()) {
            pending.reject(error);
        }

        this.pending.clear();
    }
}
