import type { GridRect } from '../../world/Heightfield';

/** Row-by-row copies of grid rects (editor worker messages). */

export type Grid = Float32Array | Uint8Array;

/** Writes the rows of `values` (a rect of `channels` per sample) into a grid. */
export function writeRect(
    grid: Grid,
    resolution: number,
    rect: GridRect,
    channels: number,
    values: Grid,
): void {
    const w = (rect.x1 - rect.x0 + 1) * channels;

    for (let row = rect.z0; row <= rect.z1; row++) {
        const local = (row - rect.z0) * w;
        grid.set(
            values.subarray(local, local + w),
            (row * resolution + rect.x0) * channels,
        );
    }
}

/** Copies a rect of a grid out, row by row. */
export function readRect<T extends Grid>(
    grid: T,
    resolution: number,
    rect: GridRect,
    channels: number,
    out: T,
): T {
    const w = (rect.x1 - rect.x0 + 1) * channels;

    for (let row = rect.z0; row <= rect.z1; row++) {
        const start = (row * resolution + rect.x0) * channels;
        out.set(grid.subarray(start, start + w), (row - rect.z0) * w);
    }

    return out;
}
