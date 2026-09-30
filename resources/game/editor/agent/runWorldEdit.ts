import type { Editor } from '../Editor';
import type { PropModelRef } from '../../shared/types';
import type { GridRect } from '../../world/Heightfield';
import { ShapeMask } from './shapes';
import type { ShapeSpec } from './shapes';
import {
    carveRiver,
    clearFoliage,
    EditError,
    eraseWater,
    fillLake,
    paintLayer,
    placeProps,
    removeProps,
    scatterFoliage,
    scatterProps,
    sculptTerrain,
} from './worldEdits';
import type {
    PaintParams,
    PropPlacement,
    PropScatterParams,
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

            const m = requireMask();

            if (action === 'river') {
                const depth = Math.max(
                    0.3,
                    Number((payload.params as { depth?: number }).depth ?? 2),
                );

                return editor.scriptedEdit(
                    'Agent: river',
                    m.rect,
                    ['height', 'water'],
                    () => carveRiver(hf, world.waterGrid, m, depth),
                );
            }

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
        case 'props': {
            const action = payload.action;

            // The models may be newer than the editor (imported or generated after it loaded).
            if (Array.isArray(payload.prop_models)) {
                world.props.addModels(payload.prop_models as PropModelRef[]);
            }

            if (action === 'place') {
                return editor.scriptedEdit(
                    'Agent: place props',
                    whole,
                    ['props'],
                    () =>
                        placeProps(
                            world.props,
                            hf,
                            payload.placements as PropPlacement[],
                        ),
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
        default:
            throw new EditError(`Unknown edit kind ${String(payload.kind)}.`);
    }
}

function grow(rect: GridRect, by: number, res: number): GridRect {
    return {
        x0: Math.max(0, rect.x0 - by),
        z0: Math.max(0, rect.z0 - by),
        x1: Math.min(res - 1, rect.x1 + by),
        z1: Math.min(res - 1, rect.z1 + by),
    };
}
