import type { Editor } from '../Editor';
import type {
    PropModelRef,
    RiverSpline,
    RoadSpline,
    SplinePoint,
} from '../../shared/types';
import { polylineLength, sampleSpline } from '../../world/Splines';
import { placementsAlong, snapToEdges, snapToGrid } from '../propSnap';
import {
    createRiver,
    createRoad,
    deleteSpline,
    updateRiver,
    updateRoad,
} from '../splines/splineOps';
import type { RiverInput, RoadInput } from '../splines/splineOps';
import { STAMP_SHAPES } from '../stamps';
import type { StampParams } from '../stamps';
import type { GridRect } from '../../world/Heightfield';
import type { Props } from '../../world/Props';
import { encodePainted } from '../../world/water/shoreField';
import { ShapeMask } from './shapes';
import type { ShapeSpec } from './shapes';
import {
    clearFoliage,
    EditError,
    eraseWater,
    fillLake,
    paintLayer,
    placeProps,
    removeProps,
    scatterFoliage,
    scatterProps,
    updateProps,
    sculptTerrain,
} from './worldEdits';
import type {
    PaintParams,
    PropChange,
    PropPlacement,
    PropScatterParams,
    PropUpdate,
    SculptParams,
} from './worldEdits';

/**
 * Runs one scripted world edit sent by an agent (MCP tools sculpt_terrain, paint_terrain, edit_water,
 * edit_foliage) in the editor, as one undo step. Returns a summary for the agent; throws EditError
 * with a message for it when the edit cannot be done.
 */
export function runWorldEdit(
    editor: Editor,
    payload: Record<string, unknown>,
): Record<string, unknown> {
    const world = editor.worldData;
    const hf = world.heights;
    const shape = payload.shape as ShapeSpec | undefined;
    const mask = shape ? new ShapeMask(hf, shape) : null;
    const requireMask = (): ShapeMask => {
        if (!mask) {
            throw new EditError('This edit needs a shape.');
        }

        if (!mask.weight.some((w) => w > 0)) {
            throw new EditError(
                'The shape does not cover any part of the map.',
            );
        }

        return mask;
    };
    const whole: GridRect = {
        x0: 0,
        z0: 0,
        x1: hf.resolution - 1,
        z1: hf.resolution - 1,
    };

    switch (payload.kind) {
        case 'sculpt': {
            const m = requireMask();
            const params = payload.params as SculptParams;
            // Erosion stamps reach up to ~80 m beyond the shape.
            const rect =
                params.op === 'erode'
                    ? grow(m.rect, Math.ceil(90 / hf.cell), hf.resolution)
                    : m.rect;

            return editor.scriptedEdit(
                `Agent: ${params.op}`,
                rect,
                ['height'],
                () => sculptTerrain(hf, m, params),
            );
        }
        case 'paint': {
            const m = requireMask();
            const params = payload.params as PaintParams;

            if (!world.layers.some((l) => l.slot === params.slot)) {
                throw new EditError(
                    `The map has no layer in slot ${params.slot}.`,
                );
            }

            return editor.scriptedEdit('Agent: paint', m.rect, ['splat'], () =>
                paintLayer(world.splat, hf, m, params),
            );
        }
        case 'water': {
            const action = payload.action;

            if (action === 'lake') {
                return editor.scriptedEdit(
                    'Agent: lake',
                    mask?.rect ?? whole,
                    ['water'],
                    () =>
                        fillLake(
                            hf,
                            world.waterGrid,
                            mask,
                            payload.params as never,
                        ),
                );
            }

            if (action === 'update_river' || action === 'delete_river') {
                const id = typeof payload.id === 'string' ? payload.id : '';

                if (!world.splines.river(id)) {
                    throw new EditError(
                        `There is no river "${id}". edit_water action list_rivers lists them.`,
                    );
                }

                if (action === 'delete_river') {
                    return deleteSpline(editor, id);
                }

                const done = updateRiver(
                    editor,
                    id,
                    riverInput(payload.params, shape),
                );

                return { ...done.result, river: describeRiver(done.river) };
            }

            if (action === 'river') {
                if (!shape || shape.type !== 'path') {
                    throw new EditError('A river needs a path shape.');
                }

                // A stored, editable river spline (re-carved when edited).
                const done = createRiver(
                    editor,
                    riverInput(payload.params, shape),
                );

                return { ...done.result, river: describeRiver(done.river) };
            }

            const m = requireMask();

            return editor.scriptedEdit(
                'Agent: erase water',
                m.rect,
                ['water'],
                () => eraseWater(world.waterGrid, m),
            );
        }
        case 'foliage': {
            const m = requireMask();
            const params = payload.params as {
                type_ids?: number[] | null;
                density?: number;
                clustering?: number;
                strength?: number;
                seed?: number;
            };
            const ids = params.type_ids ?? null;

            if (payload.action === 'clear') {
                return editor.scriptedEdit(
                    'Agent: clear foliage',
                    m.rect,
                    ['foliage'],
                    () =>
                        clearFoliage(
                            world.foliage,
                            m,
                            ids,
                            params.strength ?? 1,
                        ),
                );
            }

            const types = world.foliageTypes.filter((t) => ids?.includes(t.id));

            if (!types.length) {
                throw new EditError(
                    'Name at least one foliage type to scatter.',
                );
            }

            return editor.scriptedEdit(
                'Agent: scatter foliage',
                m.rect,
                ['foliage'],
                () => ({
                    placed: scatterFoliage(
                        world.foliage,
                        editor.placementContext(),
                        m,
                        {
                            types,
                            density: params.density,
                            clustering: params.clustering,
                            seed: params.seed,
                        },
                    ),
                }),
            );
        }
        case 'road': {
            const action = payload.action;

            const input = (payload.road ?? {}) as RoadInput;

            if (action === 'create') {
                const done = createRoad(editor, input);

                return { ...done.result, road: describeRoad(done.road) };
            }

            const id = typeof payload.id === 'string' ? payload.id : '';

            if (!world.splines.road(id)) {
                throw new EditError(
                    `There is no road "${id}". edit_road action list lists them.`,
                );
            }

            if (action === 'delete') {
                return deleteSpline(editor, id);
            }

            const done = updateRoad(editor, id, input);

            return { ...done.result, road: describeRoad(done.road) };
        }
        case 'stamp': {
            const params = payload.params as StampParams;

            if (!STAMP_SHAPES.includes(params.shape)) {
                throw new EditError(
                    `Unknown stamp shape ${String(params.shape)}.`,
                );
            }

            if (!hf.contains(params.x, params.z)) {
                throw new EditError(
                    `(${params.x}, ${params.z}) is outside the map.`,
                );
            }

            return editor.applyStamp(params);
        }
        case 'props': {
            const action = payload.action;

            // The models may be newer than the editor (imported or generated after it loaded).
            if (Array.isArray(payload.prop_models)) {
                world.props.addModels(payload.prop_models as PropModelRef[]);
            }

            if (action === 'place') {
                const snap = (payload.snap ?? {}) as PropSnap;
                const placements = (payload.placements as PropPlacement[]).map(
                    (p) => snapPlacement(world.props, p, snap),
                );

                return editor.scriptedEdit(
                    'Agent: place props',
                    whole,
                    ['props'],
                    () => placeProps(world.props, hf, placements),
                );
            }

            if (action === 'along') {
                const along = payload.along as {
                    model: number;
                    points: SplinePoint[];
                    spacing?: number | null;
                    scale?: number;
                    align?: boolean;
                    smooth?: boolean;
                    offset?: number;
                };
                const scale = along.scale ?? 1;

                if (!world.props.hasModel(along.model)) {
                    throw new EditError(
                        `There is no ready prop model with id ${along.model}. Use list_prop_models.`,
                    );
                }

                const points = along.smooth
                    ? sampleSpline(along.points, 1)
                    : along.points;
                const spots = placementsAlong(
                    world.props,
                    along.model,
                    scale,
                    points,
                    along.spacing ?? null,
                );

                return editor.scriptedEdit(
                    'Agent: place props along a path',
                    whole,
                    ['props'],
                    () => ({
                        ...placeProps(
                            world.props,
                            hf,
                            spots.map((spot) => ({
                                model: along.model,
                                x: spot.x,
                                z: spot.z,
                                rotation: (spot.yaw * 180) / Math.PI,
                                scale,
                                offset: along.offset ?? 0,
                                align: along.align,
                            })),
                        ),
                        path_length_m: Math.round(polylineLength(points)),
                    }),
                );
            }

            if (action === 'scatter') {
                const m = requireMask();

                return editor.scriptedEdit(
                    'Agent: scatter props',
                    m.rect,
                    ['props'],
                    () =>
                        scatterProps(
                            world.props,
                            hf,
                            world.waterGrid,
                            m,
                            payload.params as PropScatterParams,
                        ),
                );
            }

            const ids = (payload.ids as string[] | null | undefined) ?? null;

            if (action === 'update') {
                return editor.scriptedEdit(
                    'Agent: edit props',
                    whole,
                    ['props'],
                    () =>
                        updateProps(world.props, hf, mask, {
                            updates: payload.updates as PropUpdate[] | null,
                            ids,
                            models: (payload.models as number[] | null) ?? null,
                            change: payload.change as PropChange | null,
                        }),
                );
            }

            if (!mask && !ids) {
                throw new EditError('Give a shape or prop ids to remove.');
            }

            return editor.scriptedEdit(
                'Agent: remove props',
                mask?.rect ?? whole,
                ['props'],
                () =>
                    removeProps(
                        world.props,
                        mask,
                        (payload.models as number[] | null | undefined) ?? null,
                        ids,
                    ),
            );
        }
        case 'water_body':
            return waterBodyEdit(editor, payload);
        case 'surf':
            return surfEdit(editor, requireMask(), payload);
        default:
            throw new EditError(`Unknown edit kind ${String(payload.kind)}.`);
    }
}

/**
 * MCP paint_surf: surf painted on (at a strength), off, or back to automatic inside the shape (Water ›
 * Surf brush): where the weight is at least half. Reports the shoreline with surf inside the shape.
 */
function surfEdit(
    editor: Editor,
    mask: ShapeMask,
    payload: Record<string, unknown>,
): Record<string, unknown> {
    const water = editor.worldData.water;
    const hf = editor.worldData.heights;
    const mode = payload.action;

    if (mode !== 'on' && mode !== 'off' && mode !== 'auto') {
        throw new EditError(`Unknown surf mode ${String(mode)}.`);
    }

    const params = (payload.params ?? {}) as { strength?: number };
    const value = encodePainted(
        mode === 'auto' ? null : mode === 'off' ? 0 : (params.strength ?? 1),
    );
    const surfMask = water.surf.mask;
    const r = mask.rect;
    let painted = 0;

    editor.scriptedEdit(`Agent: surf ${mode}`, r, ['surf'], () => {
        for (let row = r.z0; row <= r.z1; row++) {
            for (let col = r.x0; col <= r.x1; col++) {
                const w = mask.weight[(row - r.z0) * mask.width + (col - r.x0)];

                if (w >= 0.5) {
                    surfMask[row * hf.resolution + col] = value;
                    painted++;
                }
            }
        }
    });

    // Shoreline with surf now inside the shape (water samples next to the shore).
    const f = water.surf.field;
    let shore = 0;
    let surfing = 0;

    for (let j = 0; j < f.size; j++) {
        for (let i = 0; i < f.size; i++) {
            const k = j * f.size + i;
            const d = f.dist[k];

            if (d <= 0 || d > f.spacing) {
                continue;
            }

            const x = i * f.spacing - hf.half;
            const z = j * f.spacing - hf.half;

            if (mask.weightAt(x, z) < 0.5) {
                continue;
            }

            shore++;

            if (water.surf.strength[k] > 0.05) {
                surfing++;
            }
        }
    }

    return {
        mode,
        ...(mode === 'on' ? { strength: params.strength ?? 1 } : {}),
        painted_samples: painted,
        shoreline_in_shape_m: Math.round(shore * f.spacing),
        shoreline_with_surf_m: Math.round(surfing * f.spacing),
        ...(shore === 0
            ? {
                  note: 'The shape covers no shoreline: paint over where water meets land.',
              }
            : {}),
    };
}

/** MCP edit_water_body: list / get / update the water bodies (Water › Bodies). */
function waterBodyEdit(
    editor: Editor,
    payload: Record<string, unknown>,
): Record<string, unknown> {
    const water = editor.worldData.water;
    water.flushBodies();
    const all = water.describeBodies();
    const wind = {
        strength: Math.round(water.waves.windStrength * 100) / 100,
        towards: {
            x: Math.round(water.waves.windDir.x * 100) / 100,
            z: Math.round(water.waves.windDir.y * 100) / 100,
        },
        wave_mode: water.waveMode,
    };

    if (payload.action === 'list') {
        return { count: all.length, wind, bodies: all };
    }

    const point = payload.point as { x: number; z: number } | undefined;
    const body =
        typeof payload.id === 'string'
            ? water.bodies.get(payload.id)
            : point
              ? water.bodies.at(point.x, point.z)
              : null;

    if (!body) {
        throw new EditError(
            typeof payload.id === 'string'
                ? `There is no water body "${payload.id}". Action "list" lists them.`
                : 'There is no water at that point.',
        );
    }

    if (payload.action === 'update') {
        water.bodies.update(
            body.id,
            (payload.params ?? {}) as Record<string, unknown>,
        );
    } else if (payload.action !== 'get') {
        throw new EditError(
            `Unknown water body action ${String(payload.action)}.`,
        );
    }

    return { wind, body: water.describeBodies().find((b) => b.id === body.id) };
}

function grow(rect: GridRect, by: number, res: number): GridRect {
    return {
        x0: Math.max(0, rect.x0 - by),
        z0: Math.max(0, rect.z0 - by),
        x1: Math.min(res - 1, rect.x1 + by),
        z1: Math.min(res - 1, rect.z1 + by),
    };
}

/** Snapping options for placed props (place_props). */
type PropSnap = { grid?: number; edges?: boolean; align?: boolean };

/** A placement moved onto the grid / end-to-end onto a neighbour, and tilted when asked. */
function snapPlacement(
    props: Props,
    p: PropPlacement,
    snap: PropSnap,
): PropPlacement {
    let x = snapToGrid(p.x, snap.grid ?? 0);
    let z = snapToGrid(p.z, snap.grid ?? 0);
    let rotation = p.rotation;

    if (snap.edges) {
        const edge = snapToEdges(props, p.model, p.scale ?? 1, x, z);

        if (edge) {
            x = edge.x;
            z = edge.z;
            rotation = (edge.yaw * 180) / Math.PI;
        }
    }

    return {
        ...p,
        x,
        z,
        rotation,
        align: p.align ?? snap.align,
    };
}

function riverInput(params: unknown, shape: ShapeSpec | undefined): RiverInput {
    const p = (params ?? {}) as {
        depth?: number;
        width?: number;
        bank?: number;
        name?: string;
    };
    const input: RiverInput = {};

    if (shape?.type === 'path') {
        input.points = shape.points;
        input.width = shape.width;

        if (shape.falloff !== undefined) {
            input.bank = shape.falloff;
        }
    }

    if (p.width !== undefined) input.width = p.width;
    if (p.depth !== undefined) input.depth = p.depth;
    if (p.bank !== undefined) input.bank = p.bank;
    if (p.name !== undefined) input.name = p.name;

    return input;
}

/** A road as agents see it (without its footprint). */
export function describeRoad(r: RoadSpline): Record<string, unknown> {
    return {
        id: r.id,
        name: r.name,
        profile: r.profile,
        width: r.width,
        shoulder: r.shoulder,
        bank: r.bank,
        smoothing: r.smoothing,
        layer: r.layer,
        clear_foliage: r.clear_foliage,
        length_m: Math.round(polylineLength(sampleSpline(r.points, 2))),
        points: r.points,
    };
}

export function describeRiver(r: RiverSpline): Record<string, unknown> {
    return {
        id: r.id,
        name: r.name,
        width: r.width,
        depth: r.depth,
        bank: r.bank,
        length_m: Math.round(polylineLength(sampleSpline(r.points, 2))),
        points: r.points,
    };
}
