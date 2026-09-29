import {
    ArrowUpDown,
    Blend,
    Droplets,
    Eraser,
    Flag,
    Grid3x3,
    Layers,
    Mountain,
    MousePointerClick,
    Paintbrush,
    Pipette,
    Rows3,
    Sparkles,
    Spline,
    TreePine,
    Waves,
    Wind,
} from 'lucide';
import type { IconNode } from 'lucide';
import type { EditorToolGroup } from '../../shared/protocol';
import type { FoliageType, GroundCoverEntry } from '../../shared/types';
import {
    button,
    h,
    icon,
    numberField,
    section,
    segmented,
    slider,
    toggle,
} from '../../ui/dom';
import type { FalloffType } from '../Brush';
import type { Editor, FoliageTool, SculptTool, WaterTool } from '../Editor';
import { FoliageThumbnails } from '../FoliageThumbnails';

type ToolDef<T extends string> = {
    value: T;
    label: string;
    icon: IconNode;
    hint: string;
};

const GROUPS: {
    value: EditorToolGroup;
    label: string;
    icon: IconNode;
    key: string;
}[] = [
    { value: 'sculpt', label: 'Sculpt', icon: Mountain, key: '1' },
    { value: 'paint', label: 'Paint', icon: Paintbrush, key: '2' },
    { value: 'foliage', label: 'Foliage', icon: TreePine, key: '3' },
    { value: 'water', label: 'Water', icon: Droplets, key: '4' },
    { value: 'place', label: 'Place', icon: Flag, key: '5' },
];

const SCULPT_TOOLS: ToolDef<SculptTool>[] = [
    {
        value: 'sculpt',
        label: 'Sculpt',
        icon: Mountain,
        hint: 'Raise terrain · Shift to lower',
    },
    {
        value: 'smooth',
        label: 'Smooth',
        icon: Blend,
        hint: 'Average out bumps and sharp edges',
    },
    {
        value: 'flatten',
        label: 'Flatten',
        icon: Rows3,
        hint: 'Level to the height where the stroke starts · Ctrl+click to pick a target',
    },
    {
        value: 'ramp',
        label: 'Ramp',
        icon: Spline,
        hint: 'Click a start point, then an end point to build a ramp',
    },
    {
        value: 'erosion',
        label: 'Slump',
        icon: Wind,
        hint: 'Thermal erosion: loose material slides off slopes steeper than the talus angle, softening cliffs',
    },
    {
        value: 'hydro',
        label: 'Rain',
        icon: Waves,
        hint: 'Rain erosion: simulated raindrops run downhill, carving gullies and depositing sediment in valleys. Shapes terrain only — it does not add water',
    },
    {
        value: 'noise',
        label: 'Noise',
        icon: Sparkles,
        hint: 'Add natural fractal detail · Shift to subtract',
    },
    {
        value: 'terrace',
        label: 'Terrace',
        icon: ArrowUpDown,
        hint: 'Cut slopes into steps',
    },
];

const FOLIAGE_TOOLS: ToolDef<FoliageTool>[] = [
    {
        value: 'paint',
        label: 'Paint',
        icon: Paintbrush,
        hint: 'Scatter the selected types up to their density · Shift to erase',
    },
    {
        value: 'erase',
        label: 'Erase',
        icon: Eraser,
        hint: 'Remove instances of the selected types',
    },
    {
        value: 'single',
        label: 'Single',
        icon: MousePointerClick,
        hint: 'Click to place one instance of the first selected type',
    },
];

const WATER_TOOLS: ToolDef<WaterTool>[] = [
    {
        value: 'lake',
        label: 'Lake',
        icon: Droplets,
        hint: 'Fill with water at the water level · Ctrl+click to pick the level',
    },
    {
        value: 'river',
        label: 'River',
        icon: Waves,
        hint: 'Paint a river that follows the terrain downhill',
    },
    {
        value: 'erase',
        label: 'Erase',
        icon: Eraser,
        hint: 'Remove water · also Shift with any water tool',
    },
];

const FALLOFFS: { value: FalloffType; label: string }[] = [
    { value: 'smooth', label: 'Smooth' },
    { value: 'linear', label: 'Linear' },
    { value: 'spherical', label: 'Sphere' },
    { value: 'tip', label: 'Tip' },
];

/**
 * The floating editor panel inside the game window: tool groups, tools, brush + tool options.
 */
export class EditorPanel {
    readonly el: HTMLElement;
    private body: HTMLElement;
    private hint: HTMLElement;
    private groupSeg: ReturnType<typeof segmented<EditorToolGroup>>;
    private renderedKey = '';
    private refreshers: Array<() => void> = [];
    /** Rendered previews for foliage types without a baked thumbnail. */
    private readonly foliageThumbs = new FoliageThumbnails();
    /** Foliage type whose settings are shown under the list (last clicked tile). */
    private editingTypeId: number | null = null;
    private rebuildFoliageSettings: (() => void) | null = null;

    constructor(
        private readonly editor: Editor,
        private readonly actions: {
            autoPaint: () => void;
            softenMap: () => void;
            scatter: (ids: number[]) => void;
            clearFoliage: (ids: number[]) => void;
            /** Change a foliage type's settings live (saved to the studio library). */
            updateFoliageType: (
                id: number,
                patch: Partial<FoliageType>,
            ) => void;
            /** Change a terrain layer's ground cover live (saved to the map). */
            updateGroundCover: (
                layerId: number,
                entries: GroundCoverEntry[],
            ) => void;
        },
    ) {
        this.groupSeg = segmented(
            GROUPS.map((g) => ({
                value: g.value,
                label: g.label,
                icon: g.icon,
                title: `${g.label} (${g.key})`,
            })),
            editor.state.group,
            (v) => editor.setGroup(v),
            'ww-groups',
        );
        this.body = h('div', { class: 'ww-panel-body' });
        this.hint = h('div', { class: 'ww-hint' });
        this.el = h(
            'aside',
            { class: 'ww-panel ww-editor-panel' },
            this.groupSeg.el,
            this.body,
        );
        editor.subscribe(() => this.refresh());
        this.foliageThumbs.onChange = () => this.refresh();
        this.refresh();
    }

    /** The status-bar hint element (placed by the HUD). */
    get hintElement(): HTMLElement {
        return this.hint;
    }

    refresh(): void {
        const s = this.editor.state;
        this.groupSeg.set(s.group);
        const key = `${s.group}:${s.sculptTool}:${s.foliageTool}:${s.waterTool}:${this.editor.layers.map((l) => `${l.id}${l.name}${l.color}${l.tint}${l.texture_scale}${l.material?.thumbnail_url ?? ''}`).join()}:${this.editor.foliageTypes.map((t) => `${t.id}${t.name}${t.kind}${t.color}${t.color_secondary}${t.tint ?? ''}${t.model_url ?? ''}${t.asset?.thumbnail_url ?? ''}${t.asset?.height ?? ''}`).join()}:${s.group === 'foliage' ? this.foliageThumbs.version : ''}`;

        if (key !== this.renderedKey) {
            this.renderedKey = key;
            this.render();
        } else {
            for (const fn of this.refreshers) {
                fn();
            }
        }

        this.hint.textContent = this.currentHint();
    }

    private render(): void {
        this.refreshers = [];
        this.body.replaceChildren();
        const s = this.editor.state;

        switch (s.group) {
            case 'sculpt':
                this.body.append(
                    this.toolGrid(SCULPT_TOOLS, s.sculptTool, (t) =>
                        this.editor.setSculptTool(t),
                    ),
                );
                this.body.append(this.brushSection(s.sculptTool !== 'ramp'));
                this.body.append(...this.sculptOptions());
                this.body.append(
                    section(
                        'Whole map',
                        h(
                            'p',
                            { class: 'ww-muted' },
                            'Remove stair steps and hard edges across the entire terrain (undoable).',
                        ),
                        button(
                            'Soften whole map',
                            () => this.actions.softenMap(),
                            { icon: Blend },
                        ),
                    ),
                );
                break;
            case 'paint':
                this.body.append(this.layerList());
                this.body.append(this.groundCover());
                this.body.append(this.brushSection(true));
                this.body.append(
                    section(
                        'Automatic',
                        h(
                            'p',
                            { class: 'ww-muted' },
                            'Re-apply each layer’s height and slope rules (configured in the studio) to the whole map.',
                        ),
                        button(
                            'Auto paint map',
                            () => this.actions.autoPaint(),
                            { icon: Sparkles },
                        ),
                    ),
                );
                break;
            case 'foliage':
                this.body.append(
                    this.toolGrid(FOLIAGE_TOOLS, s.foliageTool, (t) => {
                        s.foliageTool = t;
                        this.editor.notify();
                    }),
                );
                this.body.append(this.foliageList());
                this.body.append(this.foliageSettings());
                this.body.append(this.brushSection(s.foliageTool !== 'single'));
                this.body.append(
                    section(
                        'Procedural',
                        h(
                            'p',
                            { class: 'ww-muted' },
                            'Scatter the selected types over the whole map using their slope/height rules and natural clustering. Replaces existing instances of those types.',
                        ),
                        h(
                            'div',
                            { class: 'ww-row' },
                            button(
                                'Scatter',
                                () =>
                                    this.actions.scatter([
                                        ...s.foliageSelection,
                                    ]),
                                { icon: Sparkles },
                            ),
                            button(
                                'Clear',
                                () =>
                                    this.actions.clearFoliage([
                                        ...s.foliageSelection,
                                    ]),
                                { icon: Eraser },
                            ),
                        ),
                    ),
                );
                break;
            case 'water':
                this.body.append(
                    this.toolGrid(WATER_TOOLS, s.waterTool, (t) => {
                        s.waterTool = t;
                        this.editor.notify();
                    }),
                );
                this.body.append(this.brushSection(true, false));
                this.body.append(this.waterOptions());
                break;
            case 'place':
                this.body.append(
                    section(
                        'Player start',
                        h(
                            'p',
                            { class: 'ww-muted' },
                            'Click the terrain to move the player start. The player faces the direction the camera is looking.',
                        ),
                    ),
                    section(
                        'Viewport',
                        h(
                            'p',
                            { class: 'ww-muted' },
                            'Press P to play from the camera position, Alt+P to play from the player start.',
                        ),
                    ),
                );
                break;
        }

        const grid = toggle('Show 100 m grid (G)', s.showGrid, (v) => {
            s.showGrid = v;
            this.editor.notify();
        });
        this.refreshers.push(() => grid.set(s.showGrid));
        this.body.append(
            h(
                'div',
                { class: 'ww-panel-footer' },
                grid.el,
                h(
                    'span',
                    { class: 'ww-muted', title: 'Grid' },
                    icon(Grid3x3, 14),
                ),
            ),
        );
    }

    private toolGrid<T extends string>(
        tools: ToolDef<T>[],
        active: T,
        onPick: (t: T) => void,
    ): HTMLElement {
        const grid = h('div', { class: 'ww-tool-grid' });

        for (const tool of tools) {
            grid.append(
                h(
                    'button',
                    {
                        type: 'button',
                        class: `ww-tool ${tool.value === active ? 'is-active' : ''}`,
                        title: tool.hint,
                        onClick: () => onPick(tool.value),
                    },
                    icon(tool.icon, 18),
                    h('span', {}, tool.label),
                ),
            );
        }

        return grid;
    }

    private brushSection(
        showStrength: boolean,
        showFalloffType = true,
    ): HTMLElement {
        const b = this.editor.state.brush;
        const size = slider({
            label: 'Size',
            min: 0.5,
            max: 1000,
            step: 0.5,
            log: true,
            value: b.radius,
            unit: ' m',
            onInput: (v) => (b.radius = v),
            format: (v) => `${v < 10 ? v.toFixed(1) : Math.round(v)} m`,
        });
        const strength = slider({
            label: 'Strength',
            min: 0.01,
            max: 1,
            step: 0.01,
            value: b.strength,
            onInput: (v) => (b.strength = v),
            format: (v) => `${Math.round(v * 100)}%`,
        });
        const falloff = slider({
            label: 'Falloff',
            min: 0,
            max: 1,
            step: 0.01,
            value: b.falloff,
            onInput: (v) => (b.falloff = v),
            format: (v) => `${Math.round(v * 100)}%`,
        });
        const type = segmented(
            FALLOFFS,
            b.falloffType,
            (v) => (b.falloffType = v),
            'ww-compact',
        );
        this.refreshers.push(() => {
            const cur = this.editor.state.brush;
            size.set(cur.radius);
            strength.set(cur.strength);
            falloff.set(cur.falloff);
            type.set(cur.falloffType);
        });

        return section(
            'Brush',
            size.el,
            showStrength ? strength.el : null,
            falloff.el,
            showFalloffType ? type.el : null,
            h('p', { class: 'ww-kbd-hint' }, '[ ] size · - = strength'),
        );
    }

    private sculptOptions(): HTMLElement[] {
        const s = this.editor.state;
        const out: HTMLElement[] = [];

        switch (s.sculptTool) {
            case 'flatten': {
                const mode = segmented(
                    [
                        { value: 'both', label: 'Both' },
                        { value: 'raise', label: 'Raise' },
                        { value: 'lower', label: 'Lower' },
                    ],
                    s.flattenMode,
                    (v) => (s.flattenMode = v),
                    'ww-compact',
                );
                const target = numberField(
                    'Target height (m)',
                    s.flattenTarget,
                    0.1,
                    (v) => (s.flattenTarget = v),
                );
                const pick = toggle(
                    'Use height under cursor at stroke start',
                    s.flattenPickOnStroke,
                    (v) => (s.flattenPickOnStroke = v),
                );
                this.refreshers.push(() => {
                    target.set(s.flattenTarget);
                    pick.set(s.flattenPickOnStroke);
                });
                out.push(
                    section(
                        'Flatten',
                        mode.el,
                        target.el,
                        pick.el,
                        h(
                            'p',
                            { class: 'ww-muted' },
                            icon(Pipette, 12),
                            ' Ctrl+click samples a target height.',
                        ),
                    ),
                );
                break;
            }
            case 'ramp': {
                const width = slider({
                    label: 'Ramp width',
                    min: 1,
                    max: 200,
                    step: 0.5,
                    log: true,
                    value: s.rampWidth,
                    unit: ' m',
                    onInput: (v) => (s.rampWidth = v),
                });
                out.push(
                    section(
                        'Ramp',
                        width.el,
                        h(
                            'p',
                            { class: 'ww-muted' },
                            'Click the start, then the end. Esc cancels.',
                        ),
                    ),
                );
                break;
            }
            case 'erosion': {
                const talus = slider({
                    label: 'Talus angle',
                    min: 5,
                    max: 70,
                    step: 1,
                    value: s.talusAngle,
                    unit: '°',
                    onInput: (v) => (s.talusAngle = v),
                });
                out.push(
                    section(
                        'Slump (thermal erosion)',
                        h(
                            'p',
                            { class: 'ww-muted' },
                            'Material slides down wherever the slope exceeds the talus angle, turning sharp cliffs into natural scree slopes.',
                        ),
                        talus.el,
                    ),
                );
                break;
            }
            case 'hydro': {
                const drops = slider({
                    label: 'Droplets / frame',
                    min: 5,
                    max: 300,
                    step: 1,
                    value: s.hydroDroplets,
                    onInput: (v) => (s.hydroDroplets = v),
                });
                out.push(
                    section(
                        'Rain erosion',
                        h(
                            'p',
                            { class: 'ww-muted' },
                            'Simulates rainfall wearing the terrain down over thousands of years: water runs downhill, cuts channels into slopes and drops sediment where it slows. It only changes the terrain shape — use the Water tools to add lakes and rivers. Works best on slopes; use gentle strength and several short strokes.',
                        ),
                        drops.el,
                    ),
                );
                break;
            }
            case 'noise': {
                const scale = slider({
                    label: 'Noise scale',
                    min: 2,
                    max: 500,
                    step: 1,
                    log: true,
                    value: s.noiseScale,
                    unit: ' m',
                    onInput: (v) => (s.noiseScale = v),
                });
                out.push(section('Noise', scale.el));
                break;
            }
            case 'terrace': {
                const step = slider({
                    label: 'Step height',
                    min: 0.5,
                    max: 50,
                    step: 0.5,
                    value: s.terraceStep,
                    unit: ' m',
                    onInput: (v) => (s.terraceStep = v),
                });
                const sharp = slider({
                    label: 'Sharpness',
                    min: 0,
                    max: 1,
                    step: 0.01,
                    value: s.terraceSharpness,
                    onInput: (v) => (s.terraceSharpness = v),
                });
                out.push(section('Terrace', step.el, sharp.el));
                break;
            }
            default:
                break;
        }

        return out;
    }

    private layerList(): HTMLElement {
        const s = this.editor.state;
        const grid = h('div', { class: 'ww-material-grid' });
        const active = this.editor.layers.find((l) => l.slot === s.paintLayer);

        for (const layer of this.editor.layers) {
            const selected = layer.slot === s.paintLayer;
            const thumb =
                layer.material?.thumbnail_url ??
                layer.material?.maps.albedo ??
                layer.texture_url;
            const tile = h('span', {
                class: 'ww-material-thumb',
                style: thumb
                    ? {
                          backgroundImage: `url("${thumb}")`,
                          backgroundColor: layer.tint ?? '#ffffff',
                      }
                    : {
                          background: `linear-gradient(135deg, ${layer.color}, ${layer.color_secondary})`,
                      },
            });
            const subtitle = layer.material
                ? `${layer.material.name} · ${formatMetres(layer.texture_scale || layer.material.tile_size)}`
                : 'Procedural colours';

            grid.append(
                h(
                    'button',
                    {
                        type: 'button',
                        class: `ww-material-tile ${selected ? 'is-active' : ''}`,
                        title: `${layer.name} — ${subtitle}`,
                        onClick: () => {
                            s.paintLayer = layer.slot;
                            this.renderedKey = '';
                            this.editor.notify();
                        },
                    },
                    tile,
                    h(
                        'span',
                        { class: 'ww-material-slot' },
                        String(layer.slot + 1),
                    ),
                    h(
                        'span',
                        { class: 'ww-material-text' },
                        h('span', { class: 'ww-material-name' }, layer.name),
                        h('span', { class: 'ww-material-sub' }, subtitle),
                    ),
                ),
            );
        }

        if (!this.editor.layers.length) {
            grid.append(
                h(
                    'p',
                    { class: 'ww-muted' },
                    'No layers. Add terrain layers for this map in the studio.',
                ),
            );
        }

        // Larger preview of the selected material, tiled at its real-world scale relative to a 4 m swatch.
        let preview: HTMLElement | null = null;
        const thumb =
            active?.material?.thumbnail_url ??
            active?.material?.maps.albedo ??
            active?.texture_url;

        if (active) {
            const metres =
                active.texture_scale || active.material?.tile_size || 4;
            const tilesAcross = Math.max(1, Math.min(8, 4 / metres));
            preview = h(
                'div',
                { class: 'ww-material-preview' },
                h('div', {
                    class: 'ww-material-preview-image',
                    style: thumb
                        ? {
                              backgroundImage: `url("${thumb}")`,
                              backgroundSize: `${100 / tilesAcross}% auto`,
                              backgroundColor: active.tint ?? '#ffffff',
                          }
                        : {
                              background: `linear-gradient(135deg, ${active.color}, ${active.color_secondary})`,
                          },
                }),
                h(
                    'div',
                    { class: 'ww-material-preview-caption' },
                    h('strong', {}, active.name),
                    h(
                        'span',
                        {},
                        active.material
                            ? `${active.material.name} · 1 tile = ${formatMetres(metres)} · swatch shows 4 m`
                            : 'Procedural colours — assign a material in the studio',
                    ),
                ),
            );
        }

        return section(
            'Layers',
            preview,
            grid,
            h(
                'p',
                { class: 'ww-muted' },
                icon(Layers, 12),
                ' Paint the selected layer · Shift to erase',
            ),
        );
    }

    /**
     * Ground cover of the selected layer: foliage types that grow by themselves wherever the layer
     * is painted. Everything regrows live; the type settings below are the same as in the Foliage tab.
     */
    private groundCover(): HTMLElement {
        const wrap = h('div', {});
        const build = () => {
            const s = this.editor.state;
            const layer = this.editor.layers.find(
                (l) => l.slot === s.paintLayer,
            );
            const types = this.editor.foliageTypes;

            if (!layer) {
                wrap.replaceChildren();

                return;
            }

            const entries = layer.ground_cover ?? [];
            const current = () =>
                this.editor.layers.find((l) => l.id === layer.id)
                    ?.ground_cover ?? entries;
            const save = (next: GroundCoverEntry[]) => {
                this.actions.updateGroundCover(layer.id, next);
            };
            const rows = entries.map((entry, index) => {
                const type = types.find((t) => t.id === entry.foliage_type_id);
                const density = slider({
                    label: type?.name ?? `Type ${entry.foliage_type_id}`,
                    min: 0,
                    max: 4,
                    step: 0.05,
                    value: entry.density,
                    format: (v) => `${v.toFixed(2)}×`,
                    onInput: (v) =>
                        save(
                            current().map((e, i) =>
                                i === index ? { ...e, density: v } : e,
                            ),
                        ),
                });
                const edit = button(
                    'Settings',
                    () => {
                        this.editingTypeId = entry.foliage_type_id;
                        build();
                    },
                    { title: 'Edit this type’s size, colour, rules below' },
                );
                const remove = button(
                    'Remove',
                    () => {
                        save(current().filter((_e, i) => i !== index));
                        build();
                    },
                    { icon: Eraser },
                );

                return h(
                    'div',
                    { class: 'ww-ground-cover-row' },
                    density.el,
                    h('div', { class: 'ww-row' }, edit, remove),
                );
            });

            const available = types.filter(
                (t) => !entries.some((e) => e.foliage_type_id === t.id),
            );
            const small = new Set(['grass', 'flower', 'reed', 'bush', 'rock']);
            available.sort(
                (a, b) =>
                    Number(small.has(b.kind)) - Number(small.has(a.kind)) ||
                    a.name.localeCompare(b.name),
            );
            const add = h('select', {
                class: 'ww-input ww-select',
                style: { width: '100%', textAlign: 'left' },
                'aria-label': 'Add ground cover',
            });
            add.append(h('option', { value: '' }, 'Add foliage type…'));

            for (const t of available) {
                add.append(h('option', { value: String(t.id) }, t.name));
            }

            add.addEventListener('change', () => {
                const id = Number(add.value);

                if (!id || entries.length >= 8) {
                    return;
                }

                save([...current(), { foliage_type_id: id, density: 1 }]);
                this.editingTypeId = id;
                build();
            });

            const settings = entries.some(
                (e) => e.foliage_type_id === this.editingTypeId,
            )
                ? this.foliageSettings(true)
                : null;

            wrap.replaceChildren(
                section(
                    `Ground cover · ${layer.name}`,
                    h(
                        'p',
                        { class: 'ww-muted' },
                        'Grows by itself wherever this layer is painted, following the paint and each type’s slope, altitude and water rules. Nothing to place or erase: repaint the layer or tweak the settings and it regrows instantly.',
                    ),
                    ...rows,
                    available.length && entries.length < 8 ? add : null,
                ),
                ...(settings ? [settings] : []),
            );
        };

        build();

        return wrap;
    }

    private foliageList(): HTMLElement {
        const s = this.editor.state;
        const types = this.editor.foliageTypes;
        const grid = h('div', {
            class: 'ww-material-grid ww-foliage-grid',
            role: 'group',
            'aria-label': 'Foliage types to paint (multi-select)',
        });
        const count = h('span', {});
        const syncCount = () => {
            const n = types.filter((t) => s.foliageSelection.has(t.id)).length;
            count.textContent = n
                ? `${n} of ${types.length} selected`
                : 'Nothing selected';
        };

        for (const type of types) {
            const thumb =
                type.asset?.thumbnail_url ?? this.foliageThumbs.get(type);
            const size = foliageSize(type);
            const subtitle = [type.kind, size].filter(Boolean).join(' · ');
            const subtitleEl = h(
                'span',
                { class: 'ww-material-sub ww-foliage-sub' },
                subtitle,
            );
            this.refreshers.push(() => {
                const current = this.editor.foliageTypes.find(
                    (t) => t.id === type.id,
                );

                if (current) {
                    subtitleEl.textContent = [
                        current.kind,
                        foliageSize(current),
                    ]
                        .filter(Boolean)
                        .join(' · ');
                }
            });
            const tile = h(
                'button',
                {
                    type: 'button',
                    class: 'ww-material-tile ww-foliage-tile',
                    title: `${type.name} — ${type.asset ? `model: ${type.asset.name}` : type.model_url ? 'custom model' : 'procedural mesh'} · ${subtitle}`,
                    onClick: () => {
                        if (s.foliageSelection.has(type.id)) {
                            s.foliageSelection.delete(type.id);
                        } else {
                            s.foliageSelection.add(type.id);
                        }

                        this.editingTypeId = type.id;
                        sync();
                        syncCount();
                        this.rebuildFoliageSettings?.();
                    },
                },
                h('span', {
                    class: `ww-foliage-thumb ${thumb ? '' : 'is-pending'}`,
                    style: {
                        // Colour gradient shows while the preview renders / loads, or if it is missing.
                        background: `${thumb ? `center / contain no-repeat url("${thumb}"), ` : ''}radial-gradient(circle at 50% 85%, ${type.color}66, transparent 70%), linear-gradient(160deg, oklch(1 0 0 / 0.06), oklch(0 0 0 / 0.2))`,
                    },
                }),
                h('span', { class: 'ww-foliage-check', 'aria-hidden': 'true' }),
                h(
                    'span',
                    { class: 'ww-material-text' },
                    h('span', { class: 'ww-material-name' }, type.name),
                    subtitleEl,
                ),
            );
            const sync = () => {
                const on = s.foliageSelection.has(type.id);
                tile.classList.toggle('is-active', on);
                tile.setAttribute('aria-pressed', String(on));
            };
            sync();
            this.refreshers.push(sync);
            grid.append(tile);
        }

        if (!types.length) {
            return section(
                'Foliage types',
                h(
                    'p',
                    { class: 'ww-muted' },
                    'No foliage types yet. Create them in the studio’s Foliage library.',
                ),
            );
        }

        syncCount();
        this.refreshers.push(syncCount);

        return section(
            'Foliage types',
            grid,
            h(
                'p',
                { class: 'ww-muted' },
                icon(TreePine, 12),
                ' Click to toggle · ',
                count,
            ),
        );
    }

    /**
     * Settings of one foliage type, editable without leaving the editor. Every change applies
     * live and is saved to the studio library after a short pause.
     */
    private foliageSettings(groundCover = false): HTMLElement {
        const wrap = h('div', {});
        const build = () => {
            const s = this.editor.state;
            const types = this.editor.foliageTypes;

            if (!types.length) {
                wrap.replaceChildren();

                return;
            }

            if (!types.some((t) => t.id === this.editingTypeId)) {
                this.editingTypeId =
                    types.find((t) => s.foliageSelection.has(t.id))?.id ??
                    types[0].id;
            }

            const id = this.editingTypeId!;
            const current = (): FoliageType =>
                this.editor.foliageTypes.find((t) => t.id === id)!;
            const type = current();
            const update = (patch: Partial<FoliageType>) =>
                this.actions.updateFoliageType(id, patch);
            const baseHeight = type.asset?.height ?? null;
            const metres = (scale: number) =>
                baseHeight ? ` (≈ ${formatMetres(scale * baseHeight)})` : '';

            const picker = h('select', {
                class: 'ww-input ww-select',
                'aria-label': 'Foliage type to edit',
            });

            for (const t of types) {
                const option = h('option', { value: String(t.id) }, t.name);
                option.selected = t.id === id;
                picker.append(option);
            }

            picker.addEventListener('change', () => {
                this.editingTypeId = Number(picker.value);
                build();
            });

            const density = slider({
                label: 'Density',
                min: 0.01,
                max: 500,
                step: 0.01,
                log: true,
                value: type.density,
                format: (v) =>
                    `${v < 1 ? v.toFixed(2) : v < 10 ? v.toFixed(1) : Math.round(v)} /100 m²`,
                onInput: (v) => update({ density: v }),
            });
            let minScale: ReturnType<typeof slider>;
            let maxScale: ReturnType<typeof slider>;
            minScale = slider({
                label: 'Min size',
                min: 0.05,
                max: 20,
                step: 0.01,
                log: true,
                value: type.min_scale,
                format: (v) => `${v.toFixed(2)}×${metres(v)}`,
                onInput: (v) => {
                    const patch: Partial<FoliageType> = { min_scale: v };

                    if (v > current().max_scale) {
                        patch.max_scale = v;
                        maxScale.set(v);
                    }

                    update(patch);
                },
            });
            maxScale = slider({
                label: 'Max size',
                min: 0.05,
                max: 20,
                step: 0.01,
                log: true,
                value: type.max_scale,
                format: (v) => `${v.toFixed(2)}×${metres(v)}`,
                onInput: (v) => {
                    const patch: Partial<FoliageType> = { max_scale: v };

                    if (v < current().min_scale) {
                        patch.min_scale = v;
                        minScale.set(v);
                    }

                    update(patch);
                },
            });
            let minSlope: ReturnType<typeof slider>;
            let maxSlope: ReturnType<typeof slider>;
            minSlope = slider({
                label: 'Min slope',
                min: 0,
                max: 90,
                step: 1,
                unit: '°',
                value: type.min_slope,
                onInput: (v) => {
                    const patch: Partial<FoliageType> = { min_slope: v };

                    if (v > current().max_slope) {
                        patch.max_slope = v;
                        maxSlope.set(v);
                    }

                    update(patch);
                },
            });
            maxSlope = slider({
                label: 'Max slope',
                min: 0,
                max: 90,
                step: 1,
                unit: '°',
                value: type.max_slope,
                onInput: (v) => {
                    const patch: Partial<FoliageType> = { max_slope: v };

                    if (v < current().min_slope) {
                        patch.min_slope = v;
                        minSlope.set(v);
                    }

                    update(patch);
                },
            });
            const cull = slider({
                label: 'Visible up to',
                min: 20,
                max: 5000,
                step: 10,
                log: true,
                unit: ' m',
                value: type.cull_distance,
                onInput: (v) => update({ cull_distance: v }),
            });
            const altitude = (
                label: string,
                key: 'min_height' | 'max_height',
            ): HTMLElement => {
                const input = h('input', {
                    type: 'number',
                    step: '1',
                    class: 'ww-input',
                    placeholder: 'any',
                    value:
                        type[key] === null
                            ? ''
                            : String(Math.round(type[key]!)),
                });
                input.addEventListener('change', () => {
                    const value =
                        input.value.trim() === '' ? null : Number(input.value);
                    update({
                        [key]:
                            value !== null && Number.isFinite(value)
                                ? value
                                : null,
                    });
                });

                return h(
                    'label',
                    { class: 'ww-field' },
                    h('span', {}, label),
                    input,
                );
            };
            const shadows = toggle('Cast shadows', type.cast_shadows, (v) =>
                update({ cast_shadows: v }),
            );
            const align = toggle(
                'Align to terrain slope',
                type.align_to_normal,
                (v) => update({ align_to_normal: v }),
            );
            const yaw = toggle('Random rotation', type.random_yaw, (v) =>
                update({ random_yaw: v }),
            );
            const underwater = toggle(
                'Allow under water',
                type.allow_underwater,
                (v) => update({ allow_underwater: v }),
            );

            wrap.replaceChildren(
                section(
                    'Type settings',
                    h('div', { class: 'ww-row ww-foliage-edit-head' }, picker),
                    density.el,
                    minScale.el,
                    maxScale.el,
                    minSlope.el,
                    maxSlope.el,
                    altitude('Min altitude (m)', 'min_height'),
                    altitude('Max altitude (m)', 'max_height'),
                    cull.el,
                    shadows.el,
                    align.el,
                    yaw.el,
                    underwater.el,
                    h(
                        'p',
                        { class: 'ww-muted' },
                        groundCover
                            ? 'Saved to the studio library automatically. Ground cover regrows at once; painted instances of this type keep their placement.'
                            : 'Saved to the studio library automatically. Visibility and shadows update at once; density, size and placement rules apply to new painting (ground cover regrows at once) — use Scatter to regenerate a type.',
                    ),
                    groundCover
                        ? null
                        : button(
                              `Re-scatter ${type.name}`,
                              () => this.actions.scatter([id]),
                              {
                                  icon: Sparkles,
                                  title: 'Replace all placed instances of this type using the new settings (undoable)',
                              },
                          ),
                ),
            );
        };

        this.rebuildFoliageSettings = build;
        build();

        return wrap;
    }

    private waterOptions(): HTMLElement {
        const s = this.editor.state;
        const level = numberField(
            'Water level (m)',
            s.waterLevel,
            0.1,
            (v) => (s.waterLevel = v),
        );
        const depth = slider({
            label: 'Carve depth',
            min: 0.2,
            max: 30,
            step: 0.1,
            value: s.waterDepth,
            unit: ' m',
            onInput: (v) => (s.waterDepth = v),
        });
        const carve = toggle(
            'Carve terrain below water',
            s.waterCarve,
            (v) => (s.waterCarve = v),
        );
        const pick = toggle(
            'Level from terrain at stroke start',
            s.waterPickOnStroke,
            (v) => (s.waterPickOnStroke = v),
        );
        this.refreshers.push(() => {
            level.set(s.waterLevel);
            pick.set(s.waterPickOnStroke);
        });

        return section(
            'Water',
            s.waterTool === 'lake' ? pick.el : null,
            s.waterTool === 'lake' ? level.el : null,
            carve.el,
            depth.el,
            h(
                'p',
                { class: 'ww-muted' },
                icon(Pipette, 12),
                ' Ctrl+click samples the level from terrain or existing water.',
            ),
        );
    }

    private currentHint(): string {
        const s = this.editor.state;
        const base =
            'RMB+WASD fly · MMB pan · Alt+LMB orbit · Wheel zoom · F focus · Ctrl+Z/Y undo/redo · Ctrl+S save · P play';
        let tool = '';

        switch (s.group) {
            case 'sculpt':
                tool =
                    SCULPT_TOOLS.find((t) => t.value === s.sculptTool)?.hint ??
                    '';
                break;
            case 'paint':
                tool = 'Paint the selected layer · Shift to erase';
                break;
            case 'foliage':
                tool =
                    FOLIAGE_TOOLS.find((t) => t.value === s.foliageTool)
                        ?.hint ?? '';
                break;
            case 'water':
                tool =
                    WATER_TOOLS.find((t) => t.value === s.waterTool)?.hint ??
                    '';
                break;
            case 'place':
                tool = 'Click to set the player start';
                break;
        }

        return `${tool}  —  ${base}`;
    }
}

/** "≈ 9 m" / "7–11 m" from the baked model height and the type's scale range. */
function foliageSize(type: {
    asset?: { height: number | null } | null;
    min_scale: number;
    max_scale: number;
}): string {
    const height = type.asset?.height;

    if (!height) {
        return '';
    }

    const lo = height * type.min_scale;
    const hi = height * type.max_scale;

    return Math.abs(hi - lo) < 0.05 * hi ||
        formatMetres(lo) === formatMetres(hi)
        ? `≈ ${formatMetres(hi)}`
        : `${formatMetres(lo).replace(' m', '')}–${formatMetres(hi)}`;
}

function formatMetres(m: number): string {
    return `${Number(m.toFixed(m < 10 ? 1 : 0))} m`;
}
