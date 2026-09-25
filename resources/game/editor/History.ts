/**
 * Tile-based copy-on-write undo/redo for editor grid layers (heights, splat, water) plus
 * generic custom snapshots (e.g. foliage cells). Only tiles touched during a stroke are stored.
 */

import type { GridRect } from '../world/Heightfield';

export interface UndoableGrid {
    readonly resolution: number;
    readonly data: Float32Array | Uint8Array;
    /** Samples per cell, e.g. 1 for heights, 8 for splat. */
    readonly channels: number;
}

export type CustomHandlers = {
    capture(id: string): unknown;
    restore(id: string, state: unknown): void;
};

type TileData = Float32Array | Uint8Array;

type TileSnapshot = { before: TileData; after: TileData | null };

type Entry = {
    label: string;
    grids: Map<string, Map<number, TileSnapshot>>;
    custom: Map<
        string,
        Map<string, { before: unknown; after: unknown; hasAfter: boolean }>
    >;
};

type GridRegistration = {
    grid: UndoableGrid;
    onRestore: (rect: GridRect) => void;
};

/** Tile edge length in grid samples. */
export const HISTORY_TILE = 64;

export class History {
    private readonly maxSteps: number;
    private readonly onChange?: (canUndo: boolean, canRedo: boolean) => void;
    private readonly grids = new Map<string, GridRegistration>();
    private readonly customs = new Map<string, CustomHandlers>();
    private undoStack: Entry[] = [];
    private redoStack: Entry[] = [];
    private current: Entry | null = null;

    constructor(opts: {
        maxSteps: number;
        onChange?: (canUndo: boolean, canRedo: boolean) => void;
    }) {
        this.maxSteps = Math.max(1, Math.floor(opts.maxSteps) || 1);
        this.onChange = opts.onChange;
    }

    registerGrid(
        key: string,
        grid: UndoableGrid,
        onRestore: (rect: GridRect) => void,
    ): void {
        this.grids.set(key, { grid, onRestore });
    }

    registerCustom(key: string, handlers: CustomHandlers): void {
        this.customs.set(key, handlers);
    }

    /** True between beginStroke and endStroke. */
    get recording(): boolean {
        return this.current !== null;
    }

    /** Label of the entry that would be undone next. */
    get undoLabel(): string | null {
        return this.undoStack.length
            ? this.undoStack[this.undoStack.length - 1].label
            : null;
    }

    get redoLabel(): string | null {
        return this.redoStack.length
            ? this.redoStack[this.redoStack.length - 1].label
            : null;
    }

    beginStroke(label: string): void {
        if (this.current) {
            this.endStroke();
        }

        this.current = { label, grids: new Map(), custom: new Map() };
    }

    /**
     * Call BEFORE modifying `rect` of grid `key`. Saves each covered tile the first time it is
     * touched in the current stroke. Starts an implicit stroke if none is open.
     */
    touch(key: string, rect: GridRect): void {
        const reg = this.grids.get(key);

        if (!reg) {
            return;
        }

        const entry = this.ensureStroke();
        let tiles = entry.grids.get(key);

        if (!tiles) {
            tiles = new Map();
            entry.grids.set(key, tiles);
        }

        const res = reg.grid.resolution;
        const max = res - 1;
        const x0 = Math.max(0, Math.floor(rect.x0));
        const z0 = Math.max(0, Math.floor(rect.z0));
        const x1 = Math.min(max, Math.ceil(rect.x1));
        const z1 = Math.min(max, Math.ceil(rect.z1));

        if (x1 < x0 || z1 < z0) {
            return;
        }

        const tilesX = Math.ceil(res / HISTORY_TILE);

        for (
            let ty = Math.floor(z0 / HISTORY_TILE);
            ty <= Math.floor(z1 / HISTORY_TILE);
            ty++
        ) {
            for (
                let tx = Math.floor(x0 / HISTORY_TILE);
                tx <= Math.floor(x1 / HISTORY_TILE);
                tx++
            ) {
                const id = ty * tilesX + tx;

                if (!tiles.has(id)) {
                    tiles.set(id, {
                        before: this.readTile(reg.grid, tx, ty),
                        after: null,
                    });
                }
            }
        }
    }

    /** Capture custom state before modification (first time per stroke). */
    touchCustom(key: string, id: string): void {
        const handlers = this.customs.get(key);

        if (!handlers) {
            return;
        }

        const entry = this.ensureStroke();
        let states = entry.custom.get(key);

        if (!states) {
            states = new Map();
            entry.custom.set(key, states);
        }

        if (!states.has(id)) {
            states.set(id, {
                before: handlers.capture(id),
                after: undefined,
                hasAfter: false,
            });
        }
    }

    /** Pushes the stroke if anything was touched and clears the redo stack. */
    endStroke(): void {
        const entry = this.current;
        this.current = null;

        if (!entry) {
            return;
        }

        let touched = false;

        for (const tiles of entry.grids.values()) {
            if (tiles.size) {
                touched = true;
            }
        }

        for (const states of entry.custom.values()) {
            if (states.size) {
                touched = true;
            }
        }

        if (!touched) {
            return;
        }

        this.undoStack.push(entry);
        this.redoStack = [];

        while (this.undoStack.length > this.maxSteps) {
            this.undoStack.shift();
        }

        this.emit();
    }

    /** Discards the open stroke's snapshots without pushing (does not revert data). */
    cancelStroke(): void {
        this.current = null;
    }

    undo(): boolean {
        if (this.current) {
            this.endStroke();
        }

        const entry = this.undoStack.pop();

        if (!entry) {
            return false;
        }

        this.apply(entry, 'undo');
        this.redoStack.push(entry);
        this.emit();

        return true;
    }

    redo(): boolean {
        if (this.current) {
            this.endStroke();
        }

        const entry = this.redoStack.pop();

        if (!entry) {
            return false;
        }

        this.apply(entry, 'redo');
        this.undoStack.push(entry);
        this.emit();

        return true;
    }

    canUndo(): boolean {
        return this.undoStack.length > 0;
    }

    canRedo(): boolean {
        return this.redoStack.length > 0;
    }

    clear(): void {
        this.undoStack = [];
        this.redoStack = [];
        this.current = null;
        this.emit();
    }

    // -----------------------------------------------------------------------------------------

    private ensureStroke(): Entry {
        if (!this.current) {
            this.current = { label: '', grids: new Map(), custom: new Map() };
        }

        return this.current;
    }

    private emit(): void {
        this.onChange?.(this.canUndo(), this.canRedo());
    }

    private apply(entry: Entry, dir: 'undo' | 'redo'): void {
        for (const [key, tiles] of entry.grids) {
            const reg = this.grids.get(key);

            if (!reg || !tiles.size) {
                continue;
            }

            const res = reg.grid.resolution;
            const tilesX = Math.ceil(res / HISTORY_TILE);
            let x0 = Infinity;
            let z0 = Infinity;
            let x1 = -1;
            let z1 = -1;

            for (const [id, snap] of tiles) {
                const tx = id % tilesX;
                const ty = Math.floor(id / tilesX);

                if (dir === 'undo') {
                    // Capture the current state so redo can restore it.
                    snap.after = this.readTile(
                        reg.grid,
                        tx,
                        ty,
                        snap.after ?? undefined,
                    );
                    this.writeTile(reg.grid, tx, ty, snap.before);
                } else if (snap.after) {
                    this.writeTile(reg.grid, tx, ty, snap.after);
                }

                const r = this.tileRect(res, tx, ty);
                x0 = Math.min(x0, r.x0);
                z0 = Math.min(z0, r.z0);
                x1 = Math.max(x1, r.x1);
                z1 = Math.max(z1, r.z1);
            }

            reg.onRestore({ x0, z0, x1, z1 });
        }

        for (const [key, states] of entry.custom) {
            const handlers = this.customs.get(key);

            if (!handlers) {
                continue;
            }

            for (const [id, s] of states) {
                if (dir === 'undo') {
                    s.after = handlers.capture(id);
                    s.hasAfter = true;
                    handlers.restore(id, s.before);
                } else if (s.hasAfter) {
                    handlers.restore(id, s.after);
                }
            }
        }
    }

    private tileRect(res: number, tx: number, ty: number): GridRect {
        const x0 = tx * HISTORY_TILE;
        const z0 = ty * HISTORY_TILE;

        return {
            x0,
            z0,
            x1: Math.min(res, x0 + HISTORY_TILE) - 1,
            z1: Math.min(res, z0 + HISTORY_TILE) - 1,
        };
    }

    private readTile(
        grid: UndoableGrid,
        tx: number,
        ty: number,
        reuse?: TileData,
    ): TileData {
        const res = grid.resolution;
        const ch = grid.channels;
        const r = this.tileRect(res, tx, ty);
        const w = (r.x1 - r.x0 + 1) * ch;
        const h = r.z1 - r.z0 + 1;
        const size = w * h;
        const src = grid.data;
        const out: TileData =
            reuse &&
            reuse.length === size &&
            reuse.constructor === src.constructor
                ? reuse
                : src instanceof Float32Array
                  ? new Float32Array(size)
                  : new Uint8Array(size);

        for (let row = 0; row < h; row++) {
            const off = ((r.z0 + row) * res + r.x0) * ch;
            // Same element type by construction.
            (out as Float32Array).set(
                (src as Float32Array).subarray(off, off + w),
                row * w,
            );
        }

        return out;
    }

    private writeTile(
        grid: UndoableGrid,
        tx: number,
        ty: number,
        tile: TileData,
    ): void {
        const res = grid.resolution;
        const ch = grid.channels;
        const r = this.tileRect(res, tx, ty);
        const w = (r.x1 - r.x0 + 1) * ch;
        const h = r.z1 - r.z0 + 1;
        const dst = grid.data;

        for (let row = 0; row < h; row++) {
            const off = ((r.z0 + row) * res + r.x0) * ch;
            (dst as Float32Array).set(
                (tile as Float32Array).subarray(row * w, row * w + w),
                off,
            );
        }
    }
}
