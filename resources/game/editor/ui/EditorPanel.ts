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

    constructor(
        private readonly editor: Editor,
        private readonly actions: {
            autoPaint: () => void;
            softenMap: () => void;
            scatter: (ids: number[]) => void;
            clearFoliage: (ids: number[]) => void;
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
        this.refresh();
    }

    /** The status-bar hint element (placed by the HUD). */
    get hintElement(): HTMLElement {
        return this.hint;
    }

    refresh(): void {
        const s = this.editor.state;
        this.groupSeg.set(s.group);
        const key = `${s.group}:${s.sculptTool}:${s.foliageTool}:${s.waterTool}:${this.editor.layers.map((l) => l.id + l.name + l.color).join()}:${this.editor.foliageTypes.map((t) => t.id + t.name).join()}`;

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
        const list = h('div', { class: 'ww-list' });

        for (const layer of this.editor.layers) {
            const row = h(
                'button',
                {
                    type: 'button',
                    class: `ww-list-item ${layer.slot === s.paintLayer ? 'is-active' : ''}`,
                    onClick: () => {
                        s.paintLayer = layer.slot;
                        this.renderedKey = '';
                        this.editor.notify();
                    },
                },
                h('span', {
                    class: 'ww-swatch',
                    style: {
                        background: `linear-gradient(135deg, ${layer.color}, ${layer.color_secondary})`,
                    },
                }),
                h('span', { class: 'ww-list-label' }, layer.name),
                h('span', { class: 'ww-badge' }, `#${layer.slot + 1}`),
            );
            list.append(row);
        }

        if (!this.editor.layers.length) {
            list.append(
                h(
                    'p',
                    { class: 'ww-muted' },
                    'No layers. Add terrain layers for this map in the studio.',
                ),
            );
        }

        return section(
            'Layers',
            h(
                'p',
                { class: 'ww-muted' },
                icon(Layers, 12),
                ' Paint the selected layer · Shift to erase',
            ),
            list,
        );
    }

    private foliageList(): HTMLElement {
        const s = this.editor.state;
        const list = h('div', { class: 'ww-list' });

        for (const type of this.editor.foliageTypes) {
            const checked = s.foliageSelection.has(type.id);
            const input = h('input', { type: 'checkbox', class: 'ww-check' });
            input.checked = checked;
            input.addEventListener('change', () => {
                if (input.checked) {
                    s.foliageSelection.add(type.id);
                } else {
                    s.foliageSelection.delete(type.id);
                }
            });
            list.append(
                h(
                    'label',
                    { class: 'ww-list-item' },
                    input,
                    h('span', {
                        class: 'ww-swatch',
                        style: {
                            background: `linear-gradient(135deg, ${type.color}, ${type.color_secondary})`,
                        },
                    }),
                    h('span', { class: 'ww-list-label' }, type.name),
                    h('span', { class: 'ww-badge' }, type.kind),
                ),
            );
        }

        if (!this.editor.foliageTypes.length) {
            list.append(
                h(
                    'p',
                    { class: 'ww-muted' },
                    'No foliage types yet. Create them in the studio’s Foliage library.',
                ),
            );
        }

        return section('Foliage types', list);
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
