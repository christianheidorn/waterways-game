import { Check, Trash2, X } from 'lucide';
import type { RoadProfile, RoadSpline, RiverSpline } from '../../shared/types';
import { button, h, section, segmented, slider, toggle } from '../../ui/dom';
import type { Editor } from '../Editor';
import { ROAD_PROFILES } from '../splines/splineEdits';
import {
    defaultRoadLayer,
    updateRiver,
    updateRoad,
} from '../splines/splineOps';
import type { RiverInput, RoadInput } from '../splines/splineOps';
import { STAMP_SHAPES } from '../stamps';
import type { StampBlend, StampShape } from '../stamps';

/**
 * Editor panel sections for the building tools: roads, river splines, landscape stamps and prop
 * snapping. Each returns its element and a refresh for state changes that don't rebuild the panel.
 */
export type PanelSection = { el: HTMLElement; refresh: () => void };

const PROFILES: { value: RoadProfile; label: string }[] = [
    { value: 'path', label: 'Path' },
    { value: 'road', label: 'Road' },
    { value: 'track', label: 'Track' },
];

const STAMP_LABELS: Record<StampShape, string> = {
    mountain: 'Mountain',
    volcano: 'Volcano',
    crater: 'Crater',
    mesa: 'Mesa',
    dunes: 'Dunes',
    ridge: 'Ridge',
    canyon: 'Canyon',
    hills: 'Hills',
};

const BLENDS: { value: StampBlend; label: string; title: string }[] = [
    { value: 'add', label: 'Add', title: 'On top of the ground' },
    { value: 'max', label: 'Max', title: 'Only raises the ground' },
    { value: 'min', label: 'Min', title: 'Only lowers the ground' },
    {
        value: 'replace',
        label: 'Blend',
        title: 'Blends the ground into the landform',
    },
];

/** Calls fn once the value stopped changing for a moment (a re-carve per slider drag). */
function settle<T>(fn: (v: T) => void, ms = 450): (v: T) => void {
    let timer: number | null = null;

    return (v: T) => {
        if (timer !== null) {
            window.clearTimeout(timer);
        }

        timer = window.setTimeout(() => {
            timer = null;
            fn(v);
        }, ms);
    };
}

/** Roads tool: new-road settings, or the selected road's settings (re-carved on change). */
export function roadsSection(editor: Editor): PanelSection {
    const s = editor.state;
    const tool = editor.splineTool;
    const road = tool.current() as RoadSpline | null;
    const change = (input: RoadInput) =>
        editor.editSelectedSpline((id) => updateRoad(editor, id, input));
    const later = settle(change);
    const value = <K extends keyof RoadSpline>(
        key: K,
        fallback: RoadSpline[K],
    ) => (road ? road[key] : fallback);
    const profile = segmented(
        PROFILES,
        value('profile', s.roadProfile),
        (v) => {
            if (road) {
                change({ profile: v });
            } else {
                const d = ROAD_PROFILES[v];
                s.roadProfile = v;
                s.roadWidth = d.width;
                s.roadShoulder = d.shoulder;
                s.roadBank = d.bank;
                s.roadSmoothing = d.smoothing;
                width.set(d.width);
                shoulder.set(d.shoulder);
                bank.set(d.bank);
                smoothing.set(d.smoothing);
            }
        },
    );
    const width = slider({
        label: 'Width',
        min: 1,
        max: 40,
        step: 0.5,
        unit: ' m',
        value: value('width', s.roadWidth),
        onInput: (v) => (road ? later({ width: v }) : (s.roadWidth = v)),
    });
    const shoulder = slider({
        label: 'Banks (blend)',
        min: 0.5,
        max: 40,
        step: 0.5,
        unit: ' m',
        value: value('shoulder', s.roadShoulder),
        onInput: (v) => (road ? later({ shoulder: v }) : (s.roadShoulder = v)),
    });
    const bank = slider({
        label: 'Lean into curves',
        min: 0,
        max: 1,
        step: 0.05,
        value: value('bank', s.roadBank),
        format: (v) => `${Math.round(v * 100)}%`,
        onInput: (v) => (road ? later({ bank: v }) : (s.roadBank = v)),
    });
    const smoothing = slider({
        label: 'Even out the grade over',
        min: 0,
        max: 300,
        step: 5,
        unit: ' m',
        value: value('smoothing', s.roadSmoothing),
        onInput: (v) =>
            road ? later({ smoothing: v }) : (s.roadSmoothing = v),
    });
    const auto =
        s.roadLayer === undefined ? defaultRoadLayer(editor) : s.roadLayer;
    const layerValue = road ? road.layer : auto;
    const layer = h(
        'select',
        {
            class: 'ww-input ww-select',
            'aria-label': 'Painted layer',
        },
        h('option', { value: '' }, 'No paint'),
        ...editor.layers.map((l) =>
            h('option', { value: String(l.slot) }, `${l.slot + 1}. ${l.name}`),
        ),
    );
    layer.value = layerValue === null ? '' : String(layerValue);
    layer.addEventListener('change', () => {
        const slot = layer.value === '' ? null : Number(layer.value);

        if (road) {
            change({ layer: slot });
        } else {
            s.roadLayer = slot;
        }
    });
    const clear = toggle(
        'Clear foliage along it',
        value('clear_foliage', s.roadClearFoliage),
        (v) => (road ? change({ clear_foliage: v }) : (s.roadClearFoliage = v)),
    );
    const status = h('p', { class: 'ww-muted' });
    const build = button('Build', () => tool.finish(), {
        icon: Check,
        variant: 'primary',
    });
    const cancel = button('Cancel', () => tool.cancel(), { icon: X });
    const remove = button('Delete road', () => editor.deleteSelectedSpline(), {
        icon: Trash2,
    });
    const refresh = () => {
        const n = tool.draft.length;
        build.disabled = n < 2;
        cancel.disabled = n === 0;
        status.textContent = road
            ? `${road.name}: drag its points to move them, Shift+click the road to add a point, Ctrl+click a point to remove it.`
            : n === 0
              ? 'Click the terrain to start a new road, or click a road to select it.'
              : `${n} point${n === 1 ? '' : 's'} · Enter builds · Backspace removes the last point · Esc cancels`;
    };
    refresh();

    const list = editor.worldData.splines.roads;

    return {
        el: h(
            'div',
            {},
            section(
                road ? road.name : 'New road',
                status,
                road
                    ? h(
                          'div',
                          { class: 'ww-row' },
                          remove,
                          button('Deselect', () => tool.select(null), {
                              icon: X,
                          }),
                      )
                    : h('div', { class: 'ww-row' }, build, cancel),
            ),
            section(
                'Profile',
                profile.el,
                width.el,
                shoulder.el,
                bank.el,
                smoothing.el,
                h(
                    'label',
                    { class: 'ww-field' },
                    h('span', {}, 'Paint layer'),
                    layer,
                ),
                clear.el,
                h(
                    'p',
                    { class: 'ww-muted' },
                    road
                        ? 'Changes re-grade the road (one undo step each).'
                        : 'The road bed follows an even grade with soft banks into the terrain; the layer is painted along it and trees are cleared.',
                ),
            ),
            list.length
                ? section(
                      `Roads (${list.length})`,
                      h(
                          'div',
                          { class: 'ww-list' },
                          ...list.map((r) =>
                              h(
                                  'button',
                                  {
                                      type: 'button',
                                      class: `ww-list-item ${r.id === road?.id ? 'is-active' : ''}`,
                                      onClick: () => tool.select(r.id),
                                  },
                                  `${r.name} · ${r.profile} · ${r.width} m`,
                              ),
                          ),
                      ),
                  )
                : null,
        ),
        refresh,
    };
}

/** Water tool, rivers: new-river settings or the selected river (re-carved on change). */
export function riverSection(editor: Editor): PanelSection {
    const s = editor.state;
    const tool = editor.splineTool;
    const river = tool.current() as RiverSpline | null;
    const later = settle((input: RiverInput) =>
        editor.editSelectedSpline((id) => updateRiver(editor, id, input)),
    );
    const width = slider({
        label: 'Width',
        min: 1,
        max: 150,
        step: 0.5,
        log: true,
        unit: ' m',
        value: river?.width ?? s.riverWidth,
        onInput: (v) => (river ? later({ width: v }) : (s.riverWidth = v)),
    });
    const depth = slider({
        label: 'Depth',
        min: 0.3,
        max: 20,
        step: 0.1,
        unit: ' m',
        value: river?.depth ?? s.riverDepth,
        onInput: (v) => (river ? later({ depth: v }) : (s.riverDepth = v)),
    });
    const bank = slider({
        label: 'Banks',
        min: 0,
        max: 60,
        step: 0.5,
        unit: ' m',
        value: river?.bank ?? s.riverBank,
        onInput: (v) => (river ? later({ bank: v }) : (s.riverBank = v)),
    });
    const status = h('p', { class: 'ww-muted' });
    const build = button('Carve river', () => tool.finish(), {
        icon: Check,
        variant: 'primary',
    });
    const cancel = button('Cancel', () => tool.cancel(), { icon: X });
    const refresh = () => {
        const n = tool.draft.length;
        build.disabled = n < 2;
        cancel.disabled = n === 0;
        status.textContent = river
            ? `${river.name}: drag its points to re-carve it, Shift+click to add a point, Ctrl+click a point to remove it, Delete removes the river.`
            : n === 0
              ? 'Click from the source downstream to draw a river, or click a river to select it.'
              : `${n} point${n === 1 ? '' : 's'} · Enter carves · Backspace removes the last point · Esc cancels`;
    };
    refresh();

    return {
        el: h(
            'div',
            {},
            section(
                river ? river.name : 'New river',
                status,
                river
                    ? h(
                          'div',
                          { class: 'ww-row' },
                          button(
                              'Delete river',
                              () => editor.deleteSelectedSpline(),
                              {
                                  icon: Trash2,
                              },
                          ),
                          button('Deselect', () => tool.select(null), {
                              icon: X,
                          }),
                      )
                    : h('div', { class: 'ww-row' }, build, cancel),
                width.el,
                depth.el,
                bank.el,
                h(
                    'p',
                    { class: 'ww-muted' },
                    'The water follows the ground downhill from the first point; the bed is carved below it. Rivers stay editable.',
                ),
            ),
        ),
        refresh,
    };
}

/** Sculpt tool, Stamp: shape library and placement settings (the preview follows the cursor). */
export function stampSection(editor: Editor): PanelSection {
    const s = editor.state;
    const shapes = h(
        'div',
        { class: 'ww-tool-grid' },
        ...STAMP_SHAPES.map((shape) =>
            h(
                'button',
                {
                    type: 'button',
                    class: `ww-tool ${shape === s.stampShape ? 'is-active' : ''}`,
                    onClick: () => {
                        s.stampShape = shape;

                        for (const el of shapes.children) {
                            el.classList.toggle(
                                'is-active',
                                (el as HTMLElement).dataset.shape === shape,
                            );
                        }

                        if (shape === 'crater' || shape === 'canyon') {
                            s.stampBlend = 'add';
                            blend.set('add');
                        }
                    },
                    'data-shape': shape,
                },
                h('span', {}, STAMP_LABELS[shape]),
            ),
        ),
    );
    const radius = slider({
        label: 'Size (radius)',
        min: 10,
        max: 2000,
        step: 5,
        log: true,
        unit: ' m',
        value: s.stampRadius,
        onInput: (v) => (s.stampRadius = v),
    });
    const height = slider({
        label: 'Height / depth',
        min: 1,
        max: 600,
        step: 1,
        log: true,
        unit: ' m',
        value: s.stampHeight,
        onInput: (v) => (s.stampHeight = v),
    });
    const rotation = slider({
        label: 'Rotation',
        min: 0,
        max: 355,
        step: 5,
        unit: '°',
        value: s.stampRotation,
        onInput: (v) => (s.stampRotation = v),
    });
    const strength = slider({
        label: 'Strength',
        min: 0.05,
        max: 1,
        step: 0.05,
        value: s.stampStrength,
        format: (v) => `${Math.round(v * 100)}%`,
        onInput: (v) => (s.stampStrength = v),
    });
    const falloff = slider({
        label: 'Edge blend',
        min: 0.05,
        max: 1,
        step: 0.05,
        value: s.stampFalloff,
        format: (v) => `${Math.round(v * 100)}%`,
        onInput: (v) => (s.stampFalloff = v),
    });
    const blend = segmented(
        BLENDS,
        s.stampBlend,
        (v) => (s.stampBlend = v),
        'ww-compact',
    );
    const reroll = button('New variation', () => {
        s.stampSeed = Math.floor(Math.random() * 1e6);
    });

    return {
        el: section(
            'Stamp',
            shapes,
            radius.el,
            height.el,
            rotation.el,
            strength.el,
            falloff.el,
            h('p', { class: 'ww-muted' }, 'Blend mode'),
            blend.el,
            reroll,
            h(
                'p',
                { class: 'ww-muted' },
                'The grid shows the result under the cursor · click to stamp · R / Shift+R turns by 15° · Ctrl+Z undoes',
            ),
        ),
        refresh: () => rotation.set(s.stampRotation),
    };
}

/** Props tool: snapping options (grid, slope, end-to-end). */
export function propSnapSection(editor: Editor): PanelSection {
    const s = editor.state;
    const grid = slider({
        label: 'Grid snap',
        min: 0,
        max: 20,
        step: 0.25,
        value: s.propGrid,
        format: (v) => (v > 0 ? `${v} m` : 'Off'),
        onInput: (v) => (s.propGrid = v),
    });
    const align = toggle('Tilt with the slope', s.propAlign, (v) => {
        s.propAlign = v;
    });
    const edges = toggle(
        'Snap end-to-end (fences, walls)',
        s.propEdgeSnap,
        (v) => (s.propEdgeSnap = v),
    );

    return {
        el: section('Snapping', grid.el, align.el, edges.el),
        refresh: () => {
            grid.set(s.propGrid);
            align.set(s.propAlign);
            edges.set(s.propEdgeSnap);
        },
    };
}

/** Props tool, Along a path: click points, then place copies every `spacing` metres. */
export function propAlongSection(editor: Editor): PanelSection {
    const s = editor.state;
    const spacing = slider({
        label: 'Spacing',
        min: 0,
        max: 50,
        step: 0.25,
        value: s.propSpacing ?? 0,
        format: (v) => (v > 0 ? `${v} m` : 'Model length'),
        onInput: (v) => (s.propSpacing = v > 0 ? v : null),
    });
    const status = h('p', { class: 'ww-muted' });
    const place = button('Place along path', () => editor.placePropsAlong(), {
        icon: Check,
        variant: 'primary',
    });
    const clear = button(
        'Clear points',
        () => {
            s.propPathPoints = [];
            editor.notify();
        },
        { icon: X },
    );
    const refresh = () => {
        const n = s.propPathPoints.length;
        place.disabled = n < 2 || s.propModel === null;
        clear.disabled = n === 0;
        status.textContent =
            n === 0
                ? 'Click points on the terrain for a row of props (fence posts, lamps, walls).'
                : `${n} point${n === 1 ? '' : 's'} · Enter places · Backspace removes the last point · Esc clears`;
    };
    refresh();

    return {
        el: section(
            'Along a path',
            status,
            spacing.el,
            h('div', { class: 'ww-row' }, place, clear),
        ),
        refresh,
    };
}
