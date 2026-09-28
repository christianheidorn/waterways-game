import { Aperture, Camera, Crosshair, EyeOff, RotateCcw, X } from 'lucide';
import type { ColorGrade, EnvironmentSettings } from '../shared/types';
import { button, h, icon, segmented, slider, toggle } from './dom';
import type { SliderHandle } from './dom';

export type PhotoModeHost = {
    /** Current (possibly previewed) environment. */
    environment: () => EnvironmentSettings;
    /** Apply look / time changes without saving them. */
    previewEnvironment: (patch: Partial<EnvironmentSettings>) => void;
    /** Restore the environment the map had when photo mode opened. */
    restoreEnvironment: (snapshot: EnvironmentSettings) => void;
    /** Cinematic render quality while photo mode is open (restored on exit). */
    setCinematic: (on: boolean) => void;
    /** Focus depth of field on a screen point (NDC -1…1). */
    focusAt: (ndcX: number, ndcY: number) => void;
    /** Render one frame at `scale` × the current resolution and return it as PNG. */
    capture: (scale: number) => Promise<Blob>;
    /** Hide / show every other overlay (editor panel, HUD, stats, menus). */
    setUiHidden: (hidden: boolean) => void;
    fov: () => number;
    setFov: (fov: number) => void;
    canvas: HTMLCanvasElement;
    mapName: () => string;
    onOpen?: () => void;
};

const GRADES: { value: ColorGrade; label: string }[] = [
    { value: 'neutral', label: 'Neutral' },
    { value: 'filmic', label: 'Filmic' },
    { value: 'golden_hour', label: 'Golden hour' },
    { value: 'teal_orange', label: 'Teal & orange' },
    { value: 'cold_storm', label: 'Cold storm' },
    { value: 'bleach_bypass', label: 'Bleach bypass' },
    { value: 'vintage', label: 'Vintage' },
    { value: 'noir', label: 'Noir' },
    { value: 'lush', label: 'Lush' },
    { value: 'desert', label: 'Desert' },
];

/**
 * Photo / cinematic mode (F9): hides the UI, switches to cinematic render quality and offers the
 * camera & look controls (grade, exposure, depth of field with click-to-focus, lens, letterbox,
 * time of day, field of view) plus high-resolution capture. Changes are previews; the map's saved
 * look is restored on exit (keep a look by setting it in Environment → Camera & look).
 */
export class PhotoMode {
    readonly el: HTMLElement;
    private open = false;
    private panelHidden = false;
    private focusPicking = false;
    private snapshot: EnvironmentSettings | null = null;
    private fovBefore = 60;
    private readonly sliders = new Map<
        keyof EnvironmentSettings,
        SliderHandle
    >();
    private readonly gradeSelect: HTMLSelectElement;
    private readonly autofocus: ReturnType<typeof toggle>;
    private readonly cinematic: ReturnType<typeof toggle>;
    private readonly fovSlider: SliderHandle;
    private readonly status: HTMLElement;
    private readonly letterbox: ReturnType<typeof segmented<string>>;

    constructor(
        parent: HTMLElement,
        private readonly host: PhotoModeHost,
    ) {
        const env = () => this.host.environment();
        const set = (patch: Partial<EnvironmentSettings>) =>
            this.host.previewEnvironment(patch);
        const num = (
            key: keyof EnvironmentSettings,
            label: string,
            min: number,
            max: number,
            step: number,
            unit = '',
        ) => {
            const s = slider({
                label,
                min,
                max,
                step,
                unit,
                value: Number(env()[key] ?? min),
                onInput: (v) => set({ [key]: v }),
            });
            this.sliders.set(key, s);

            return s.el;
        };

        this.gradeSelect = h('select', {
            class: 'ww-input ww-select',
            'aria-label': 'Colour grade',
        });

        for (const g of GRADES) {
            this.gradeSelect.append(h('option', { value: g.value }, g.label));
        }

        this.gradeSelect.addEventListener('change', () =>
            set({ color_grade: this.gradeSelect.value as ColorGrade }),
        );

        this.autofocus = toggle('Autofocus (screen centre)', true, (on) => {
            if (on) {
                set({ dof_focus_distance: 0 });
                this.focusPicking = false;
                this.syncStatus();
            }
        });
        this.cinematic = toggle('Cinematic quality', true, (on) =>
            this.host.setCinematic(on),
        );
        this.fovSlider = slider({
            label: 'Field of view',
            min: 10,
            max: 110,
            step: 1,
            unit: '°',
            value: 60,
            onInput: (v) => this.host.setFov(v),
        });
        this.letterbox = segmented<string>(
            [
                { value: '0', label: 'Off' },
                { value: '1.85', label: '1.85' },
                { value: '2.39', label: '2.39' },
                { value: '2.76', label: '2.76' },
            ],
            '0',
            (v) => set({ letterbox: Number(v) }),
            'ww-compact',
        );
        this.status = h('p', { class: 'ww-muted ww-photo-status' });

        const section = (title: string, ...children: HTMLElement[]) =>
            h(
                'section',
                { class: 'ww-section' },
                h('h3', { class: 'ww-section-title' }, title),
                ...children,
            );

        this.el = h(
            'aside',
            {
                class: 'ww-panel ww-photo',
                'aria-label': 'Photo mode',
                hidden: true,
            },
            h(
                'div',
                { class: 'ww-gfx-header' },
                icon(Camera, 16),
                h('strong', {}, 'Photo mode'),
                h('span', { class: 'ww-muted' }, 'F9'),
                button('', () => this.setPanelHidden(true), {
                    icon: EyeOff,
                    variant: 'ghost',
                    title: 'Hide this panel (H)',
                }),
                button('', () => this.close(), {
                    icon: X,
                    variant: 'ghost',
                    title: 'Exit photo mode (F9 / Esc)',
                }),
            ),
            h(
                'div',
                { class: 'ww-photo-body' },
                section(
                    'Capture',
                    h(
                        'div',
                        { class: 'ww-row' },
                        button('Capture', () => void this.capture(1), {
                            icon: Camera,
                            variant: 'primary',
                            title: 'Save a PNG (Enter)',
                        }),
                        button('2× capture', () => void this.capture(2), {
                            title: 'Render at twice the resolution and save a PNG',
                        }),
                    ),
                    this.cinematic.el,
                    this.status,
                ),
                section(
                    'Look',
                    h(
                        'label',
                        { class: 'ww-field' },
                        h('span', {}, 'Colour grade'),
                        this.gradeSelect,
                    ),
                    num('color_grade_intensity', 'Grade strength', 0, 1, 0.01),
                    num('white_balance', 'White balance', -1, 1, 0.01),
                    num(
                        'exposure_compensation',
                        'Exposure',
                        -3,
                        3,
                        0.05,
                        ' EV',
                    ),
                    num('god_ray_intensity', 'Light shafts', 0, 2, 0.01),
                    num('time_of_day', 'Time of day', 0, 24, 0.05, ' h'),
                ),
                section(
                    'Depth of field',
                    this.autofocus.el,
                    button(
                        'Click to focus',
                        () => {
                            this.focusPicking = !this.focusPicking;
                            this.syncStatus();
                        },
                        {
                            icon: Crosshair,
                            title: 'Then click the subject in the scene',
                        },
                    ),
                    num('dof_aperture', 'Aperture', 1, 22, 0.1, ' f/'),
                    num('dof_max_blur', 'Max blur', 1, 40, 0.5, ' px'),
                    this.fovSlider.el,
                ),
                section(
                    'Lens',
                    num('lens_flare_intensity', 'Lens flare', 0, 1, 0.01),
                    num(
                        'chromatic_aberration',
                        'Chromatic aberration',
                        0,
                        1,
                        0.01,
                    ),
                    num('film_grain', 'Film grain', 0, 1, 0.01),
                    num('motion_blur_strength', 'Motion blur', 0, 1, 0.01),
                    h(
                        'div',
                        { class: 'ww-field' },
                        h('span', {}, 'Letterbox'),
                        this.letterbox.el,
                    ),
                ),
                section(
                    'Reset',
                    button('Reset look to the map’s', () => this.resetLook(), {
                        icon: RotateCcw,
                    }),
                    h(
                        'p',
                        { class: 'ww-muted' },
                        icon(Aperture, 12),
                        ' Photo mode changes are previews. To keep a look, set it in Environment → Camera & look.',
                    ),
                ),
            ),
        );
        parent.append(this.el);

        host.canvas.addEventListener(
            'pointerdown',
            (e) => {
                if (!this.open || !this.focusPicking || e.button !== 0) {
                    return;
                }

                const rect = host.canvas.getBoundingClientRect();
                this.host.focusAt(
                    ((e.clientX - rect.left) / rect.width) * 2 - 1,
                    -(((e.clientY - rect.top) / rect.height) * 2 - 1),
                );
                this.focusPicking = false;
                this.autofocus.set(false);
                this.syncStatus('Focus set');
                e.preventDefault();
                e.stopPropagation();
            },
            true,
        );

        window.addEventListener('keydown', (e) => {
            const target = e.target as HTMLElement | null;

            if (target?.closest('input, select, textarea')) {
                return;
            }

            if (e.key === 'F9') {
                e.preventDefault();
                this.toggle();
            } else if (this.open && e.key === 'Escape') {
                this.close();
            } else if (this.open && (e.key === 'h' || e.key === 'H')) {
                this.setPanelHidden(!this.panelHidden);
            } else if (this.open && e.key === 'Enter') {
                void this.capture(1);
            }
        });
    }

    get isOpen(): boolean {
        return this.open;
    }

    toggle(): void {
        if (this.open) {
            this.close();
        } else {
            this.show();
        }
    }

    show(): void {
        if (this.open) {
            return;
        }

        this.open = true;
        this.snapshot = { ...this.host.environment() };
        this.fovBefore = this.host.fov();
        this.host.onOpen?.();
        this.host.setUiHidden(true);
        this.host.setCinematic(
            this.cinematic.el.querySelector('input')!.checked,
        );
        this.el.hidden = false;
        this.setPanelHidden(false);
        this.sync();
    }

    close(): void {
        if (!this.open) {
            return;
        }

        this.open = false;
        this.focusPicking = false;
        this.el.hidden = true;
        this.host.setCinematic(false);
        this.host.setUiHidden(false);
        this.host.setFov(this.fovBefore);

        if (this.snapshot) {
            this.host.restoreEnvironment(this.snapshot);
            this.snapshot = null;
        }
    }

    private resetLook(): void {
        if (this.snapshot) {
            this.host.restoreEnvironment(this.snapshot);
            this.host.setFov(this.fovBefore);
            this.sync();
        }
    }

    private setPanelHidden(hidden: boolean): void {
        this.panelHidden = hidden;
        this.el.classList.toggle('is-collapsed', hidden);
    }

    private sync(): void {
        const env = this.host.environment();

        for (const [key, s] of this.sliders) {
            s.set(Number(env[key] ?? 0));
        }

        this.gradeSelect.value = env.color_grade ?? 'filmic';
        this.autofocus.set(!env.dof_focus_distance);
        this.letterbox.set(String(env.letterbox ?? 0));
        this.fovSlider.set(this.host.fov());
        this.syncStatus();
    }

    private syncStatus(message?: string): void {
        this.status.textContent =
            message ??
            (this.focusPicking
                ? 'Click the subject to focus on it…'
                : 'H hides this panel · Enter captures · F9 exits');
    }

    private async capture(scale: number): Promise<void> {
        const wasHidden = this.panelHidden;
        this.syncStatus(scale > 1 ? 'Rendering 2× capture…' : 'Capturing…');

        try {
            const blob = await this.host.capture(scale);
            const url = URL.createObjectURL(blob);
            const a = h('a', {
                href: url,
                download: `${this.host.mapName().replace(/[^\w-]+/g, '-')}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`,
            });
            document.body.append(a);
            a.click();
            a.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 5000);
            this.syncStatus('Saved');
        } catch (error) {
            this.syncStatus(
                `Capture failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        } finally {
            this.setPanelHidden(wasHidden);
        }
    }
}
