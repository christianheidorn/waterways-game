import type {
    RiverSpline,
    RoadProfile,
    RoadSpline,
    SplinePoint,
} from '../../shared/types';
import type { GridRect } from '../../world/Heightfield';
import type { Editor } from '../Editor';
import {
    carveRiver,
    carveRoad,
    courseRect,
    footprintRect,
    revertFootprint,
    ROAD_PROFILES,
} from './splineEdits';
import type { SplineWorld } from './splineEdits';

/**
 * Creating, editing and removing roads and rivers in the editor, each as one undo step (terrain,
 * paint, water, foliage and the spline list together). Used by the Roads tool, the Water tool's
 * rivers and the MCP tools edit_road / edit_water.
 */

export class SplineError extends Error {}

export type RoadInput = Partial<Omit<RoadSpline, 'id' | 'footprint'>>;
export type RiverInput = Partial<Omit<RiverSpline, 'id' | 'footprint'>>;

const MAX_POINTS = 200;

/** A complete road from partial input (profile defaults filled in). */
export function roadFromInput(
    editor: Editor,
    input: RoadInput,
    base?: RoadSpline,
): RoadSpline {
    const profile: RoadProfile = input.profile ?? base?.profile ?? 'road';
    const d = ROAD_PROFILES[profile];
    // A new profile brings its own defaults unless values are given.
    const keep = base && (!input.profile || input.profile === base.profile);
    const store = editor.worldData.splines;

    return {
        id: base?.id ?? store.newId('r'),
        name:
            input.name ??
            base?.name ??
            store.nextName(
                profile === 'path'
                    ? 'Path'
                    : profile === 'track'
                      ? 'Track'
                      : 'Road',
            ),
        points: validPoints(editor, input.points ?? base?.points ?? []),
        profile,
        width: clamp(input.width ?? (keep ? base.width : d.width), 0.5, 60),
        shoulder: clamp(
            input.shoulder ?? (keep ? base.shoulder : d.shoulder),
            0.5,
            80,
        ),
        bank: clamp(input.bank ?? (keep ? base.bank : d.bank), 0, 1),
        smoothing: clamp(
            input.smoothing ?? (keep ? base.smoothing : d.smoothing),
            0,
            500,
        ),
        layer:
            input.layer !== undefined
                ? input.layer
                : base
                  ? base.layer
                  : defaultRoadLayer(editor),
        clear_foliage: input.clear_foliage ?? base?.clear_foliage ?? true,
        footprint: base?.footprint ?? null,
    };
}

export function riverFromInput(
    editor: Editor,
    input: RiverInput,
    base?: RiverSpline,
): RiverSpline {
    const store = editor.worldData.splines;

    return {
        id: base?.id ?? store.newId('w'),
        name: input.name ?? base?.name ?? store.nextName('River'),
        points: validPoints(editor, input.points ?? base?.points ?? []),
        width: clamp(input.width ?? base?.width ?? 10, 1, 400),
        depth: clamp(input.depth ?? base?.depth ?? 2, 0.3, 50),
        bank: clamp(input.bank ?? base?.bank ?? 8, 0, 200),
        footprint: base?.footprint ?? null,
    };
}

/** Builds a new road (one undo step). */
export function createRoad(
    editor: Editor,
    input: RoadInput,
): { road: RoadSpline; result: Record<string, number> } {
    const road = roadFromInput(editor, input);
    checkLayer(editor, road.layer);
    const result = recarve(editor, `Build ${road.name}`, null, road);

    return { road: editor.worldData.splines.road(road.id)!, result };
}

/** Changes a road and re-carves it (one undo step). */
export function updateRoad(
    editor: Editor,
    id: string,
    input: RoadInput,
): { road: RoadSpline; result: Record<string, number> } {
    const old = editor.worldData.splines.road(id);

    if (!old) {
        throw new SplineError(`There is no road "${id}".`);
    }

    const road = roadFromInput(editor, input, old);
    checkLayer(editor, road.layer);
    const result = recarve(editor, `Edit ${road.name}`, old, road);

    return { road: editor.worldData.splines.road(id)!, result };
}

export function createRiver(
    editor: Editor,
    input: RiverInput,
): { river: RiverSpline; result: Record<string, number> } {
    const river = riverFromInput(editor, input);
    const result = recarve(editor, `Carve ${river.name}`, null, river);

    return { river: editor.worldData.splines.river(river.id)!, result };
}

export function updateRiver(
    editor: Editor,
    id: string,
    input: RiverInput,
): { river: RiverSpline; result: Record<string, number> } {
    const old = editor.worldData.splines.river(id);

    if (!old) {
        throw new SplineError(`There is no river "${id}".`);
    }

    const river = riverFromInput(editor, input, old);
    const result = recarve(editor, `Edit ${river.name}`, old, river);

    return { river: editor.worldData.splines.river(id)!, result };
}

/** Removes a road or river and takes its terrain changes out again (one undo step). */
export function deleteSpline(editor: Editor, id: string): { removed: string } {
    const store = editor.worldData.splines;
    const old = store.get(id);

    if (!old) {
        throw new SplineError(`There is no road or river "${id}".`);
    }

    recarve(editor, `Remove ${old.name}`, old, null);

    return { removed: id };
}

/** Moves one control point (dragging a handle) and re-carves. */
export function moveSplinePoint(
    editor: Editor,
    id: string,
    points: SplinePoint[],
): void {
    const kind = editor.worldData.splines.kindOf(id);

    if (kind === 'road') {
        updateRoad(editor, id, { points });
    } else if (kind === 'river') {
        updateRiver(editor, id, { points });
    }
}

/** Reverts `old` (if any) and carves `next` (if any) as one undo step. */
function recarve(
    editor: Editor,
    label: string,
    old: RoadSpline | RiverSpline | null,
    next: RoadSpline | RiverSpline | null,
): Record<string, number> {
    const world = editor.worldData;
    const w: SplineWorld = {
        heights: world.heights,
        splat: world.splat,
        water: world.waterGrid,
        foliage: world.foliage,
    };
    const isRoad = (s: RoadSpline | RiverSpline): s is RoadSpline =>
        'profile' in s;
    let rect: GridRect | null = footprintRect(world.heights, old?.footprint);

    if (next) {
        const reach = isRoad(next)
            ? next.width / 2 + next.shoulder
            : next.width / 2 + next.bank;
        rect = union(rect, courseRect(world.heights, next.points, reach));
    }

    const channels: ('height' | 'splat' | 'water' | 'foliage' | 'splines')[] = [
        'height',
        'splines',
    ];
    const either = next ?? old!;

    if (isRoad(either)) {
        channels.push('splat', 'foliage');
    } else {
        channels.push('water');
    }

    return editor.scriptedEdit(label, rect!, channels, () => {
        revertFootprint(w, old?.footprint);

        if (!next) {
            world.splines.remove(old!.id);

            return { removed: 1 };
        }

        const carved = isRoad(next) ? carveRoad(w, next) : carveRiver(w, next);
        const stored = { ...next, footprint: carved.footprint };

        if (isRoad(stored)) {
            world.splines.putRoad(stored);
        } else {
            world.splines.putRiver(stored as RiverSpline);
        }

        return carved.summary;
    });
}

/** The layer a new road paints: one named like a road surface, else none. */
export function defaultRoadLayer(editor: Editor): number | null {
    const layers = editor.layers;

    for (const pattern of [
        /road|asphalt|path|track|paving/i,
        /gravel|cobble|stone/i,
        /dirt|mud|earth/i,
        /sand/i,
    ]) {
        const named = layers.find((l) => pattern.test(l.name));

        if (named) {
            return named.slot;
        }
    }

    return null;
}

function checkLayer(editor: Editor, slot: number | null): void {
    if (slot !== null && !editor.layers.some((l) => l.slot === slot)) {
        throw new SplineError(`The map has no terrain layer in slot ${slot}.`);
    }
}

function validPoints(editor: Editor, points: SplinePoint[]): SplinePoint[] {
    const hf = editor.worldData.heights;

    if (points.length < 2) {
        throw new SplineError('A course needs at least 2 points.');
    }

    if (points.length > MAX_POINTS) {
        throw new SplineError(`A course has at most ${MAX_POINTS} points.`);
    }

    return points.map((p) => {
        const x = Number(p.x);
        const z = Number(p.z);

        if (!Number.isFinite(x) || !Number.isFinite(z) || !hf.contains(x, z)) {
            throw new SplineError(`(${p.x}, ${p.z}) is outside the map.`);
        }

        return { x: Math.round(x * 100) / 100, z: Math.round(z * 100) / 100 };
    });
}

function union(a: GridRect | null, b: GridRect): GridRect {
    return a
        ? {
              x0: Math.min(a.x0, b.x0),
              z0: Math.min(a.z0, b.z0),
              x1: Math.max(a.x1, b.x1),
              z1: Math.max(a.z1, b.z1),
          }
        : b;
}

function clamp(v: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, Number(v)));
}
