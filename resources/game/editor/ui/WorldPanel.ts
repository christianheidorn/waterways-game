import {
    Camera,
    CloudSun,
    History as HistoryIcon,
    Layers,
    Map as MapIcon,
    RotateCcw,
    Sparkles,
} from 'lucide';
import type {
    EnvironmentSettings,
    MapTemplateSummary,
    MaterialSummary,
    SettingFieldDef,
    SettingGroupDef,
    SnapshotSummary,
    TerrainLayer,
} from '../../shared/types';
import {
    button,
    h,
    icon,
    section,
    segmented,
    slider,
    toggle,
} from '../../ui/dom';
import type { Editor } from '../Editor';
import type { HistoryListing } from '../History';

export type WorldTab =
    | 'layers'
    | 'environment'
    | 'history'
    | 'snapshots'
    | 'maps';

/** What the World tab needs from the game (built by Game; saves go to the studio API). */
export type WorldHost = {
    /** Change a layer's look, material or auto-paint rules: applied live, saved to the map. */
    updateLayer: (id: number, patch: Partial<TerrainLayer>) => void;
    /** Ready materials of the library (loaded once). */
    materials: () => Promise<MaterialSummary[]>;
    /** Re-apply every layer's auto-paint rules to the whole map (undoable). */
    autoPaint: () => void;
    /** Lowest and highest terrain point (range of the height rule sliders). */
    heightRange: () => { min: number; max: number };
    environment: () => EnvironmentSettings;
    environmentGroup: () => Promise<SettingGroupDef | null>;
    /** Change environment fields: applied live, saved to the map. */
    updateEnvironment: (patch: Partial<EnvironmentSettings>) => void;
    history: () => HistoryListing;
    jumpHistory: (position: number) => void;
    /** null: snapshots are not available. */
    snapshots: () => Promise<{
        snapshots: SnapshotSummary[];
        settings: {
            auto_snapshot_minutes: number;
            auto_snapshot_keep: number;
        };
    } | null>;
    takeSnapshot: (label: string) => Promise<void>;
    /** Saves or drops unsaved edits (asks), restores and reloads. */
    restoreSnapshot: (snapshot: SnapshotSummary) => Promise<void>;
    templates: () => Promise<MapTemplateSummary[]>;
    /** Creates a map and opens its studio page (terrain generates there). */
    createMap: (data: {
        name: string;
        template: string | null;
        brief: string | null;
    }) => Promise<boolean>;
    /** The layer's ground cover and biome sections (shared with the Paint tab). */
    groundCover: () => HTMLElement;
};

const TABS: { value: WorldTab; label: string; icon: typeof Layers }[] = [
    { value: 'layers', label: 'Layers', icon: Layers },
    { value: 'environment', label: 'Weather', icon: CloudSun },
    { value: 'history', label: 'History', icon: HistoryIcon },
    { value: 'snapshots', label: 'Snapshots', icon: Camera },
    { value: 'maps', label: 'New map', icon: MapIcon },
];

/** Environment fields grouped like the studio's environment page, by key. */
const ENV_SECTIONS: { title: string; match: (key: string) => boolean }[] = [
    {
        title: 'Sun & sky',
        match: (k) =>
            [
                'time_of_day',
                'sun_azimuth',
                'turbidity',
                'cloud_coverage',
                'cloud_shadow_strength',
                'exposure',
            ].includes(k),
    },
    {
        title: 'Weather & wind',
        match: (k) =>
            [
                'weather',
                'precipitation',
                'falling_leaves',
                'lightning_frequency',
                'thunder_volume',
                'wetness',
            ].includes(k) ||
            k.startsWith('wind_') ||
            k.startsWith('gust_'),
    },
    { title: 'Fog', match: (k) => k.includes('fog') },
    {
        title: 'Water',
        match: (k) =>
            /^(water_|wave_|flow_|shore_|foam_|rapids_|ocean_|sea_)/.test(k),
    },
    { title: 'Camera & look', match: () => true },
];

const formatTime = (iso: string) =>
    new Date(iso).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });

/**
 * The editor's World tab: terrain layer settings (look, material, auto-paint rules, ground cover /
 * biome), environment and weather, the undo history, snapshots and new maps from templates.
 * Everything saves to the studio at once and applies live.
 */
export class WorldPanel {
    readonly el = h('div', { class: 'ww-world' });
    private tab: WorldTab = 'layers';
    private renderedKey = '';
    private materials: MaterialSummary[] | null = null;
    private envGroup: SettingGroupDef | null = null;
    private openEnvSection = 'Sun & sky';
    private snapshotList: Awaited<ReturnType<WorldHost['snapshots']>> = null;
    private templates: MapTemplateSummary[] | null = null;
    private template: string | null = null;

    constructor(
        private readonly editor: Editor,
        private readonly host: WorldHost,
    ) {}

    /** Re-renders when what the tab shows changed (not on every slider tick). */
    refresh(): void {
        const s = this.editor.state;
        const layers = this.editor.layers
            .map((l) => `${l.id}${l.name}${l.material_id ?? ''}`)
            .join();
        const key = `${this.tab}:${s.paintLayer}:${layers}:${
            this.tab === 'history' ? this.editor.history.version : ''
        }:${this.materials?.length ?? -1}:${this.envGroup ? 1 : 0}:${
            this.snapshotList?.snapshots.map((x) => x.id).join() ?? ''
        }:${this.templates?.length ?? -1}`;

        if (key !== this.renderedKey) {
            this.renderedKey = key;
            this.render();
        }
    }

    /** Opens a sub tab (e.g. from the toolbar's history button). */
    show(tab: WorldTab): void {
        this.tab = tab;
        this.renderedKey = '';
        this.refresh();
    }

    private render(): void {
        const tabs = segmented(
            TABS.map((t) => ({ value: t.value, label: t.label, icon: t.icon })),
            this.tab,
            (v) => this.show(v),
            'ww-compact ww-world-tabs',
        );
        let content: (HTMLElement | null)[] = [];

        switch (this.tab) {
            case 'layers':
                content = this.layersTab();
                break;
            case 'environment':
                content = this.environmentTab();
                break;
            case 'history':
                content = [this.historyTab()];
                break;
            case 'snapshots':
                content = this.snapshotsTab();
                break;
            case 'maps':
                content = this.mapsTab();
                break;
        }

        this.el.replaceChildren(tabs.el, ...content.filter((c) => c !== null));
    }

    // ------------------------------------------------------------------ layers

    private layersTab(): HTMLElement[] {
        const s = this.editor.state;
        const layers = this.editor.layers;
        const layer = layers.find((l) => l.slot === s.paintLayer) ?? layers[0];

        if (!layer) {
            return [
                section(
                    'Layers',
                    h('p', { class: 'ww-muted' }, 'This map has no layers.'),
                ),
            ];
        }

        const slots = h(
            'div',
            { class: 'ww-world-slots' },
            ...layers.map((l) =>
                h(
                    'button',
                    {
                        type: 'button',
                        class: `ww-world-slot ${l.id === layer.id ? 'is-active' : ''}`,
                        title: l.name,
                        onClick: () => {
                            s.paintLayer = l.slot;
                            this.editor.notify();
                        },
                    },
                    h('span', {
                        class: 'ww-swatch',
                        style: this.layerSwatch(l),
                    }),
                    h('span', {}, `${l.slot + 1}`),
                ),
            ),
        );
        const patch = (p: Partial<TerrainLayer>) =>
            this.host.updateLayer(layer.id, p);

        const name = h('input', {
            class: 'ww-input ww-world-text',
            type: 'text',
            maxlength: '60',
            'aria-label': 'Layer name',
        });
        name.value = layer.name;
        name.addEventListener('change', () => {
            const v = name.value.trim();

            if (v) {
                patch({ name: v });
            }
        });

        return [
            section(
                'Layer',
                slots,
                h('label', { class: 'ww-field' }, h('span', {}, 'Name'), name),
            ),
            this.materialSection(layer, patch),
            this.lookSection(layer, patch),
            this.rulesSection(layer, patch),
            this.host.groundCover(),
        ];
    }

    private layerSwatch(l: TerrainLayer): Partial<CSSStyleDeclaration> {
        const thumb = l.material?.thumbnail_url ?? l.material?.maps.albedo;

        return thumb
            ? {
                  backgroundImage: `url("${thumb}")`,
                  backgroundSize: 'cover',
                  backgroundColor: l.tint,
              }
            : {
                  background: `linear-gradient(135deg, ${l.color}, ${l.color_secondary})`,
              };
    }

    private materialSection(
        layer: TerrainLayer,
        patch: (p: Partial<TerrainLayer>) => void,
    ): HTMLElement {
        if (this.materials === null) {
            void this.host.materials().then((list) => {
                this.materials = list;
                this.refresh();
            });

            return section(
                'Material',
                h('p', { class: 'ww-muted' }, 'Loading the material library…'),
            );
        }

        const tile = (
            id: number | null,
            label: string,
            style: Partial<CSSStyleDeclaration>,
            sub: string,
        ) =>
            h(
                'button',
                {
                    type: 'button',
                    class: `ww-material-tile ${layer.material_id === id ? 'is-active' : ''}`,
                    title: label,
                    onClick: () => patch({ material_id: id }),
                },
                h('span', { class: 'ww-material-thumb', style }),
                h(
                    'span',
                    { class: 'ww-material-text' },
                    h('span', { class: 'ww-material-name' }, label),
                    h('span', { class: 'ww-material-sub' }, sub),
                ),
            );

        return section(
            'Material',
            h(
                'div',
                { class: 'ww-material-grid ww-world-materials' },
                tile(
                    null,
                    'Procedural colours',
                    {
                        background: `linear-gradient(135deg, ${layer.color}, ${layer.color_secondary})`,
                    },
                    'No texture',
                ),
                ...this.materials.map((m) =>
                    tile(
                        m.id,
                        m.name,
                        {
                            backgroundImage: `url("${m.thumbnail_url ?? m.maps.albedo ?? ''}")`,
                        },
                        `${m.category ?? 'material'} · ${m.tile_size} m`,
                    ),
                ),
            ),
            this.materials.length
                ? null
                : h(
                      'p',
                      { class: 'ww-muted' },
                      'No materials yet: generate or import them on the studio’s Materials page.',
                  ),
        );
    }

    private lookSection(
        layer: TerrainLayer,
        patch: (p: Partial<TerrainLayer>) => void,
    ): HTMLElement {
        const color = (
            label: string,
            key: 'color' | 'color_secondary' | 'tint',
        ) => {
            const input = h('input', {
                type: 'color',
                class: 'ww-color',
                'aria-label': label,
            });
            input.value = layer[key];
            input.addEventListener('input', () =>
                patch({ [key]: input.value }),
            );

            return h(
                'label',
                { class: 'ww-field' },
                h('span', {}, label),
                input,
            );
        };
        const num = (
            label: string,
            key: keyof TerrainLayer,
            min: number,
            max: number,
            step: number,
            unit = '',
        ) =>
            slider({
                label,
                min,
                max,
                step,
                unit,
                value: Number(layer[key] ?? min),
                onInput: (v) => patch({ [key]: v }),
            }).el;

        return section(
            'Look',
            layer.material
                ? [
                      color('Tint', 'tint'),
                      num('Tile size', 'texture_scale', 0.5, 50, 0.1, ' m'),
                      num('Roughness', 'roughness_scale', 0, 3, 0.05),
                      num('Normal strength', 'normal_strength', 0, 3, 0.05),
                  ]
                : [
                      color('Colour', 'color'),
                      color('Second colour', 'color_secondary'),
                      num('Roughness', 'roughness', 0, 1, 0.01),
                      num('Pattern size', 'noise_scale', 0.5, 100, 0.5, ' m'),
                      num('Variation', 'variation', 0, 1, 0.01),
                      num('Bump', 'bump', 0, 2, 0.05),
                  ],
        );
    }

    /** Auto-paint rules: height and slope ranges (off = any) and priority. */
    private rulesSection(
        layer: TerrainLayer,
        patch: (p: Partial<TerrainLayer>) => void,
    ): HTMLElement {
        const heights = this.host.heightRange();
        const lo = Math.floor(heights.min - 50);
        const hi = Math.ceil(heights.max + 50);
        const range = (
            label: string,
            minKey: 'auto_min_height' | 'auto_min_slope',
            maxKey: 'auto_max_height' | 'auto_max_slope',
            min: number,
            max: number,
            unit: string,
        ) => {
            const on = layer[minKey] !== null || layer[maxKey] !== null;
            const wrap = h('div', { class: 'ww-world-rule' });
            const sliders = on
                ? [
                      slider({
                          label: 'From',
                          min,
                          max,
                          step: 1,
                          unit,
                          value: Math.max(
                              min,
                              Math.min(max, layer[minKey] ?? min),
                          ),
                          onInput: (v) => patch({ [minKey]: v }),
                      }).el,
                      slider({
                          label: 'To',
                          min,
                          max,
                          step: 1,
                          unit,
                          value: Math.max(
                              min,
                              Math.min(max, layer[maxKey] ?? max),
                          ),
                          onInput: (v) => patch({ [maxKey]: v }),
                      }).el,
                  ]
                : [];
            wrap.append(
                toggle(label, on, (v) => {
                    patch(
                        v
                            ? { [minKey]: min, [maxKey]: max }
                            : { [minKey]: null, [maxKey]: null },
                    );
                    this.renderedKey = '';
                    this.refresh();
                }).el,
                ...sliders,
            );

            return wrap;
        };

        return section(
            'Auto paint rules',
            h(
                'p',
                { class: 'ww-muted' },
                'Where Auto paint puts this layer. Higher priority wins where rules overlap; a layer without limits fills the rest.',
            ),
            range(
                'Height limits',
                'auto_min_height',
                'auto_max_height',
                lo,
                hi,
                ' m',
            ),
            range(
                'Slope limits',
                'auto_min_slope',
                'auto_max_slope',
                0,
                90,
                '°',
            ),
            slider({
                label: 'Priority',
                min: 0,
                max: 10,
                step: 1,
                value: layer.auto_priority,
                onInput: (v) => patch({ auto_priority: v }),
            }).el,
            button('Auto paint map', () => this.host.autoPaint(), {
                icon: Sparkles,
                title: 'Re-apply every layer’s rules to the whole map (undoable)',
            }),
        );
    }

    // ------------------------------------------------------------- environment

    private environmentTab(): HTMLElement[] {
        if (!this.envGroup) {
            void this.host.environmentGroup().then((group) => {
                this.envGroup = group;
                this.refresh();
            });

            return [
                section(
                    'Weather',
                    h(
                        'p',
                        { class: 'ww-muted' },
                        'Loading environment settings…',
                    ),
                ),
            ];
        }

        const env = this.host.environment() as unknown as Record<
            string,
            unknown
        >;
        const buckets = new Map<string, SettingFieldDef[]>();

        for (const field of this.envGroup.fields) {
            const bucket = ENV_SECTIONS.find((b) => b.match(field.key))!.title;
            buckets.set(bucket, [...(buckets.get(bucket) ?? []), field]);
        }

        return [
            h(
                'p',
                { class: 'ww-muted ww-world-note' },
                'Changes apply live and are saved to this map.',
            ),
            ...[...buckets].map(([title, fields]) => {
                const details = h(
                    'details',
                    { class: 'ww-section ww-details' },
                    h('summary', { class: 'ww-section-title' }, title),
                    ...fields.map((f) => this.envField(f, env[f.key])),
                );
                details.open = title === this.openEnvSection;
                details.addEventListener('toggle', () => {
                    if (details.open) {
                        this.openEnvSection = title;
                    }
                });

                return details;
            }),
        ];
    }

    private envField(
        field: SettingFieldDef,
        value: unknown,
    ): HTMLElement | null {
        const set = (v: unknown) =>
            this.host.updateEnvironment({
                [field.key]: v,
            } as Partial<EnvironmentSettings>);
        const titled = (el: HTMLElement) => {
            if (field.description) {
                el.title = field.description;
            }

            return el;
        };

        switch (field.type) {
            case 'number': {
                const step = field.step ?? 0.01;

                return titled(
                    slider({
                        label: field.label,
                        min: field.min ?? 0,
                        max: field.max ?? 1,
                        step,
                        unit: field.unit ? ` ${field.unit}` : '',
                        value: Number(value ?? field.default),
                        format:
                            field.key === 'time_of_day'
                                ? (v) =>
                                      `${String(Math.floor(v) % 24).padStart(2, '0')}:${String(Math.round((v % 1) * 60) % 60).padStart(2, '0')}`
                                : undefined,
                        onInput: set,
                    }).el,
                );
            }
            case 'boolean':
                return titled(toggle(field.label, Boolean(value), set).el);
            case 'select': {
                const select = h('select', {
                    class: 'ww-input ww-select',
                    'aria-label': field.label,
                });

                for (const [k, label] of Object.entries(field.options ?? {})) {
                    select.append(h('option', { value: k }, label));
                }

                select.value = String(value ?? field.default);
                select.addEventListener('change', () => set(select.value));

                return titled(
                    h(
                        'label',
                        { class: 'ww-field' },
                        h('span', {}, field.label),
                        select,
                    ),
                );
            }
            case 'color': {
                const input = h('input', { type: 'color', class: 'ww-color' });
                input.value = String(value ?? field.default);
                input.addEventListener('input', () => set(input.value));

                return titled(
                    h(
                        'label',
                        { class: 'ww-field' },
                        h('span', {}, field.label),
                        input,
                    ),
                );
            }
            default:
                return null;
        }
    }

    // ----------------------------------------------------------------- history

    private historyTab(): HTMLElement {
        const { steps, position } = this.host.history();
        const row = (index: number, label: string) => {
            const applied = index <= position;

            return h(
                'button',
                {
                    type: 'button',
                    class: `ww-list-item ww-history-item ${index === position ? 'is-active' : ''} ${applied ? '' : 'is-undone'}`,
                    title:
                        index === position
                            ? 'Current state'
                            : applied
                              ? 'Go back to this step'
                              : 'Redo up to this step',
                    onClick: () => this.host.jumpHistory(index),
                },
                h('span', { class: 'ww-history-index' }, String(index)),
                h('span', { class: 'ww-list-label' }, label),
            );
        };

        return section(
            'Undo history',
            h(
                'p',
                { class: 'ww-muted' },
                'Click a step to go back to it, or forward again to redo. Undone steps are dimmed until the next edit replaces them.',
            ),
            h(
                'div',
                { class: 'ww-list ww-history' },
                // Newest first; 0 is the state before the oldest kept step.
                ...steps.map((step, i) => row(i + 1, step.label)).reverse(),
                row(0, steps.length ? 'Before these steps' : 'No edits yet'),
            ),
        );
    }

    // --------------------------------------------------------------- snapshots

    private snapshotsTab(): HTMLElement[] {
        if (!this.snapshotList) {
            void this.loadSnapshots();
        }

        const list = this.snapshotList;
        const label = h('input', {
            class: 'ww-input ww-world-text',
            type: 'text',
            maxlength: '200',
            placeholder: 'Label, e.g. Before the harbour',
            'aria-label': 'Snapshot label',
        });
        const take = button(
            'Take snapshot',
            () => {
                take.disabled = true;
                void this.host
                    .takeSnapshot(label.value.trim() || 'Snapshot')
                    .then(() => this.loadSnapshots());
            },
            { icon: Camera, variant: 'primary' },
        );
        const settings = list?.settings;

        return [
            section(
                'Snapshots',
                h(
                    'p',
                    { class: 'ww-muted' },
                    settings && settings.auto_snapshot_minutes > 0
                        ? `Restore points of the saved map. While you edit, one is taken on your first save and then after saves at most every ${settings.auto_snapshot_minutes} min; the last ${settings.auto_snapshot_keep} automatic ones are kept (Settings → Game → Editor).`
                        : 'Restore points of the saved map. Automatic snapshots while you edit are off (Settings → Game → Editor).',
                ),
                h('div', { class: 'ww-row' }, label, take),
            ),
            section(
                'Restore',
                list === null
                    ? h('p', { class: 'ww-muted' }, 'Loading…')
                    : list.snapshots.length
                      ? h(
                            'div',
                            { class: 'ww-list' },
                            ...list.snapshots.map((snap) =>
                                h(
                                    'div',
                                    { class: 'ww-list-item ww-snapshot' },
                                    h(
                                        'span',
                                        {
                                            class: 'ww-list-label',
                                            title: snap.label,
                                        },
                                        snap.label,
                                        h(
                                            'span',
                                            { class: 'ww-material-sub' },
                                            `${formatTime(snap.created_at)}${snap.editing ? ' · automatic' : snap.auto ? ' · before an agent change' : ''}`,
                                        ),
                                    ),
                                    button(
                                        '',
                                        () =>
                                            void this.host.restoreSnapshot(
                                                snap,
                                            ),
                                        {
                                            icon: RotateCcw,
                                            variant: 'ghost',
                                            title: 'Restore this snapshot (the current state is kept as a snapshot too)',
                                        },
                                    ),
                                ),
                            ),
                        )
                      : h('p', { class: 'ww-muted' }, 'No snapshots yet.'),
            ),
        ];
    }

    private async loadSnapshots(): Promise<void> {
        this.snapshotList = await this.host.snapshots();
        this.renderedKey = '';
        this.refresh();
    }

    // -------------------------------------------------------------------- maps

    private mapsTab(): HTMLElement[] {
        if (!this.templates) {
            void this.host.templates().then((t) => {
                this.templates = t;
                this.refresh();
            });

            return [
                section(
                    'New map',
                    h('p', { class: 'ww-muted' }, 'Loading templates…'),
                ),
            ];
        }

        const name = h('input', {
            class: 'ww-input ww-world-text',
            type: 'text',
            maxlength: '120',
            placeholder: 'Name of the new map',
            'aria-label': 'Map name',
        });
        const brief = h('textarea', {
            class: 'ww-textarea',
            rows: '3',
            maxlength: '4000',
            placeholder:
                'Optional: describe the world, e.g. “A foggy fjord with a fishing village and pine forests”. Claude picks it up as a request and builds it.',
            'aria-label': 'Description for Claude',
        });
        const cards = this.templates.map((t) =>
            h(
                'button',
                {
                    type: 'button',
                    class: `ww-list-item ww-template ${this.template === t.key ? 'is-active' : ''}`,
                    onClick: () => {
                        this.template = this.template === t.key ? null : t.key;
                        this.renderedKey = '';
                        this.refresh();
                    },
                },
                h(
                    'span',
                    { class: 'ww-list-label' },
                    h('strong', {}, t.name),
                    h('span', { class: 'ww-template-summary' }, t.summary),
                ),
            ),
        );
        const create = button(
            'Create map',
            () => {
                const n = name.value.trim();

                if (!n) {
                    name.focus();

                    return;
                }

                create.disabled = true;
                void this.host
                    .createMap({
                        name: n,
                        template: this.template,
                        brief: brief.value.trim() || null,
                    })
                    .then((ok) => {
                        create.disabled = ok;
                    });
            },
            { icon: Sparkles, variant: 'primary' },
        );

        return [
            section(
                'Template',
                h(
                    'p',
                    { class: 'ww-muted' },
                    'Start from a curated map (terrain, biomes, weather and plants), or from plain procedural terrain.',
                ),
                h('div', { class: 'ww-list' }, ...cards),
            ),
            section(
                'New map',
                name,
                brief,
                h('div', { class: 'ww-row' }, create),
                h(
                    'p',
                    { class: 'ww-muted' },
                    icon(MapIcon, 12),
                    ' The terrain generates in the background; the new map opens in the studio. Save this one first.',
                ),
            ),
        ];
    }
}
