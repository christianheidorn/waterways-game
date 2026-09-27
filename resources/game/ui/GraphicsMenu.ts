import { MonitorCog, RotateCcw, X } from 'lucide';
import {
    applyGroupLevel,
    applyPreset,
    detectGroupLevel,
    detectPreset,
    PRESET_INFO,
    PRESET_NAMES,
    QUALITY_LEVELS,
    SCALABILITY_GROUPS,
    withDetectedPreset,
} from '../shared/graphicsPresets';
import type { PresetName } from '../shared/graphicsPresets';
import type { GameStats } from '../shared/protocol';
import type { GraphicsSettings, QualityLevel } from '../shared/types';
import { button, h, icon, segmented, slider, toggle } from './dom';
import type { SegmentHandle, SliderHandle } from './dom';

const STORAGE_KEY = 'waterways.graphics.overrides.v1';

/** Per-device graphics overrides layered over the project's settings.graphics. */
export function loadGraphicsOverrides(): Partial<GraphicsSettings> {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : null;

        return parsed && typeof parsed === 'object'
            ? (parsed as Partial<GraphicsSettings>)
            : {};
    } catch {
        return {};
    }
}

export function saveGraphicsOverrides(
    overrides: Partial<GraphicsSettings>,
): void {
    try {
        if (Object.keys(overrides).length) {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
        } else {
            window.localStorage.removeItem(STORAGE_KEY);
        }
    } catch {
        // Storage blocked (private mode, sandboxed iframe): overrides last for this session only.
    }
}

/** The keys of `settings` that differ from `defaults`. */
export function diffGraphics(
    settings: GraphicsSettings,
    defaults: GraphicsSettings,
): Partial<GraphicsSettings> {
    const out: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(settings)) {
        const base = (defaults as Record<string, unknown>)[key];

        if (String(value) !== String(base)) {
            out[key] = value;
        }
    }

    return out as Partial<GraphicsSettings>;
}

export type GraphicsMenuHost = {
    /** Currently applied (project defaults + device overrides). */
    current: () => GraphicsSettings;
    /** Project defaults from the studio. */
    defaults: () => GraphicsSettings;
    apply: (settings: GraphicsSettings) => void;
    /** Called when the menu opens (e.g. to release pointer lock). */
    onOpen?: () => void;
};

const LEVEL_LABELS: Record<QualityLevel, string> = {
    low: 'Low',
    medium: 'Med',
    high: 'High',
    epic: 'Epic',
};

/**
 * In-game graphics menu (F10 or the gear button): Unreal-style presets and scalability groups,
 * resolution / frame-rate controls and a live performance readout. Changes apply instantly and are
 * stored per device in localStorage; "Reset to project defaults" drops them.
 */
export class GraphicsMenu {
    readonly el: HTMLElement;
    readonly toggleButton: HTMLButtonElement;
    private open = false;
    private presetButtons = new Map<PresetName, HTMLButtonElement>();
    private customBadge: HTMLElement;
    private overrideNote: HTMLElement;
    private groupControls: Array<{
        key: string;
        handle: SegmentHandle<QualityLevel | 'custom'>;
    }> = [];
    private renderScale: SliderHandle;
    private targetFps: SliderHandle;
    private maxFps: SliderHandle;
    private dynRes: { el: HTMLElement; set: (v: boolean) => void };
    private readout: HTMLElement;

    constructor(
        parent: HTMLElement,
        private readonly host: GraphicsMenuHost,
        embedded: boolean,
    ) {
        this.toggleButton = button('', () => this.toggle(), {
            icon: MonitorCog,
            title: 'Graphics settings (F10)',
        });
        this.toggleButton.classList.add('ww-gfx-toggle', 'ww-panel');
        this.toggleButton.dataset.embedded = embedded ? '1' : '0';

        const presetRow = h('div', { class: 'ww-gfx-presets' });

        for (const name of PRESET_NAMES) {
            const b = h(
                'button',
                {
                    type: 'button',
                    class: 'ww-gfx-preset',
                    title: `${PRESET_INFO[name].description}\n${PRESET_INFO[name].performance}`,
                    onClick: () =>
                        this.commit(applyPreset(name, this.host.current())),
                },
                PRESET_INFO[name].label,
            );
            this.presetButtons.set(name, b);
            presetRow.append(b);
        }

        this.customBadge = h('span', { class: 'ww-badge' }, 'Custom');

        const groupRows = SCALABILITY_GROUPS.map((group) => {
            const handle = segmented<QualityLevel | 'custom'>(
                QUALITY_LEVELS.map((level) => ({
                    value: level,
                    label: LEVEL_LABELS[level],
                    title: `${group.label}: ${level}`,
                })),
                'high',
                (level) => {
                    if (level !== 'custom') {
                        this.commit(
                            applyGroupLevel(this.host.current(), group, level),
                        );
                    }
                },
                'ww-compact',
            );
            this.groupControls.push({ key: group.key, handle });

            return h(
                'div',
                { class: 'ww-gfx-row', title: `${group.description} (${group.ue})` },
                h('span', { class: 'ww-gfx-row-label' }, group.label),
                handle.el,
            );
        });

        const patch = (values: Partial<GraphicsSettings>) =>
            this.commit(withDetectedPreset({ ...this.host.current(), ...values }));

        this.renderScale = slider({
            label: 'Render scale',
            min: 0.5,
            max: 2,
            step: 0.05,
            value: 1,
            format: (v) => `${Math.round(v * 100)}%`,
            onInput: (v) => patch({ render_scale: v }),
        });
        this.dynRes = toggle('Dynamic resolution', false, (v) =>
            patch({ dynamic_resolution: v }),
        );
        this.targetFps = slider({
            label: 'Target frame rate',
            min: 30,
            max: 144,
            step: 1,
            value: 60,
            unit: ' fps',
            onInput: (v) => patch({ target_fps: v }),
        });
        this.maxFps = slider({
            label: 'Frame rate limit',
            min: 0,
            max: 240,
            step: 5,
            value: 0,
            format: (v) => (v <= 0 ? 'Unlimited' : `${v} fps`),
            onInput: (v) => patch({ max_fps: v }),
        });
        this.readout = h('div', { class: 'ww-gfx-readout' }, '…');
        this.overrideNote = h('span', { class: 'ww-muted' });

        this.el = h(
            'div',
            { class: 'ww-gfx-menu ww-panel', role: 'dialog' },
            h(
                'header',
                { class: 'ww-gfx-header' },
                icon(MonitorCog, 16),
                h('strong', {}, 'Graphics'),
                this.customBadge,
                h('span', { class: 'ww-kbd-hint' }, 'F10'),
                button('', () => this.setOpen(false), {
                    icon: X,
                    variant: 'ghost',
                    title: 'Close (Esc)',
                }),
            ),
            h(
                'div',
                { class: 'ww-gfx-body' },
                h(
                    'section',
                    { class: 'ww-section' },
                    h('h3', { class: 'ww-section-title' }, 'Quality preset'),
                    presetRow,
                ),
                h(
                    'section',
                    { class: 'ww-section' },
                    h('h3', { class: 'ww-section-title' }, 'Scalability'),
                    ...groupRows,
                ),
                h(
                    'section',
                    { class: 'ww-section' },
                    h(
                        'h3',
                        { class: 'ww-section-title' },
                        'Resolution & frame rate',
                    ),
                    this.renderScale.el,
                    this.dynRes.el,
                    this.targetFps.el,
                    this.maxFps.el,
                ),
                h(
                    'section',
                    { class: 'ww-section' },
                    h('h3', { class: 'ww-section-title' }, 'Performance'),
                    this.readout,
                ),
            ),
            h(
                'footer',
                { class: 'ww-panel-footer ww-gfx-footer' },
                this.overrideNote,
                button(
                    'Reset to project defaults',
                    () => this.commit(this.host.defaults()),
                    {
                        icon: RotateCcw,
                        title: 'Drop the overrides stored on this device',
                    },
                ),
            ),
        );
        this.el.hidden = true;
        parent.append(this.toggleButton, this.el);

        window.addEventListener('keydown', this.onKey, true);
    }

    get isOpen(): boolean {
        return this.open;
    }

    toggle(): void {
        this.setOpen(!this.open);
    }

    setOpen(open: boolean): void {
        this.open = open;
        this.el.hidden = !open;
        this.toggleButton.classList.toggle('is-active', open);

        if (open) {
            this.sync();
            this.host.onOpen?.();
        }
    }

    /** Refresh every control from the applied settings. */
    sync(): void {
        const g = this.host.current();
        const preset = detectPreset(g);

        for (const [name, b] of this.presetButtons) {
            b.classList.toggle('is-active', name === preset);
        }

        this.customBadge.hidden = preset !== 'custom';

        for (const { key, handle } of this.groupControls) {
            const group = SCALABILITY_GROUPS.find((x) => x.key === key)!;
            handle.set(detectGroupLevel(g, group));
        }

        this.renderScale.set(g.render_scale);
        this.dynRes.set(g.dynamic_resolution);
        this.targetFps.set(g.target_fps);
        this.maxFps.set(g.max_fps);
        const overrides = Object.keys(
            diffGraphics(g, this.host.defaults()),
        ).filter((k) => k !== 'quality_preset').length;
        this.overrideNote.textContent = overrides
            ? `${overrides} override${overrides === 1 ? '' : 's'} on this device`
            : 'Using project defaults';
    }

    /** Live readout; call with fresh stats (e.g. every 0.5 s). */
    setStats(
        stats: GameStats,
        extra: { renderScale: number; passes: string[] },
    ): void {
        if (!this.open) {
            return;
        }

        this.readout.textContent =
            `${stats.fps.toFixed(0)} fps · ${(1000 / Math.max(1, stats.fps)).toFixed(1)} ms frame · ${stats.frameMs.toFixed(1)} ms CPU\n` +
            `${stats.drawCalls.toLocaleString()} draw calls · ${(stats.triangles / 1e6).toFixed(2)}M triangles\n` +
            `Resolution ${Math.round(extra.renderScale * 100)}% · ${extra.passes.join(' → ')}`;
    }

    dispose(): void {
        window.removeEventListener('keydown', this.onKey, true);
        this.el.remove();
        this.toggleButton.remove();
    }

    private commit(settings: GraphicsSettings): void {
        this.host.apply(settings);
        this.sync();
    }

    private onKey = (e: KeyboardEvent): void => {
        if (e.code === 'F10') {
            e.preventDefault();
            e.stopImmediatePropagation();
            this.toggle();
        } else if (e.code === 'Escape' && this.open) {
            e.preventDefault();
            e.stopImmediatePropagation();
            this.setOpen(false);
        }
    };
}
