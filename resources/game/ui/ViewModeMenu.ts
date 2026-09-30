import { Check, ChevronDown, Eye, Footprints } from 'lucide';
import { VIEW_MODES } from '../editor/ViewModes';
import type { ViewModes } from '../editor/ViewModes';
import { h, icon } from './dom';

/**
 * Build-mode view-mode picker (top right, next to the graphics button): a dropdown of the editor's
 * view modes and the current mode's legend. V / Shift+V cycle the modes (see Editor).
 */
export class ViewModeMenu {
    readonly el: HTMLElement;
    private readonly label: HTMLElement;
    private readonly toggleButton: HTMLButtonElement;
    private readonly list: HTMLElement;
    private readonly legend: HTMLElement;
    private readonly items = new Map<string, HTMLButtonElement>();
    private readonly walkButton: HTMLButtonElement | null = null;
    private open = false;

    constructor(
        parent: HTMLElement,
        private readonly modes: ViewModes,
        embedded: boolean,
        actions: { walk?: () => void } = {},
    ) {
        this.label = h('span', { class: 'ww-viewmode-label' });
        this.toggleButton = h(
            'button',
            {
                type: 'button',
                class: 'ww-button ww-viewmode-toggle',
                title: 'View mode (V / Shift+V to cycle)',
                onClick: () => this.setOpen(!this.open),
            },
            icon(Eye, 15),
            this.label,
            icon(ChevronDown, 14),
        );

        this.list = h('div', {
            class: 'ww-panel ww-viewmode-list',
            role: 'menu',
        });

        for (const mode of VIEW_MODES) {
            const item = h(
                'button',
                {
                    type: 'button',
                    class: 'ww-viewmode-item',
                    role: 'menuitemradio',
                    onClick: () => {
                        this.modes.set(mode.id);
                        this.setOpen(false);
                    },
                },
                h('span', { class: 'ww-viewmode-check' }, icon(Check, 14)),
                h(
                    'span',
                    { class: 'ww-viewmode-text' },
                    h('strong', {}, mode.label),
                    h('small', {}, mode.description),
                ),
            );
            this.items.set(mode.id, item);
            this.list.append(item);
        }

        this.list.hidden = true;

        if (actions.walk) {
            const walk = actions.walk;
            this.walkButton = h(
                'button',
                {
                    type: 'button',
                    class: 'ww-button ww-viewmode-toggle',
                    title: 'Walk here with collision (J; Esc to fly again)',
                    onClick: (e: MouseEvent) => {
                        (e.currentTarget as HTMLElement).blur();
                        walk();
                    },
                },
                icon(Footprints, 15),
                h('span', { class: 'ww-viewmode-label' }, 'Walk'),
            );
        }

        this.legend = h('div', { class: 'ww-panel ww-viewmode-legend' });
        this.el = h(
            'div',
            {
                class: 'ww-viewmode',
                'data-embedded': embedded ? '1' : '0',
            },
            h(
                'div',
                { class: 'ww-panel ww-viewmode-bar' },
                this.toggleButton,
                this.walkButton,
            ),
            this.list,
            this.legend,
        );
        parent.append(this.el);

        window.addEventListener('pointerdown', this.onPointerDown, true);
        window.addEventListener('keydown', this.onKey, true);
        this.sync();
    }

    /** Highlights the Walk button while walking. */
    setWalking(walking: boolean): void {
        this.walkButton?.classList.toggle('is-debug', walking);
    }

    /** Updates the button, the checked item and the legend from the current mode. */
    sync(): void {
        const current = this.modes.current;
        const info = VIEW_MODES.find((m) => m.id === current)!;
        this.label.textContent = info.label;
        this.toggleButton.classList.toggle('is-debug', current !== 'lit');

        for (const [id, item] of this.items) {
            item.classList.toggle('is-active', id === current);
            item.setAttribute('aria-checked', String(id === current));
        }

        this.renderLegend();
    }

    dispose(): void {
        window.removeEventListener('pointerdown', this.onPointerDown, true);
        window.removeEventListener('keydown', this.onKey, true);
        this.el.remove();
    }

    private setOpen(open: boolean): void {
        this.open = open;
        this.list.hidden = !open;
        this.legend.hidden = open || !this.legend.childElementCount;
    }

    private renderLegend(): void {
        const legend = this.modes.legend();
        this.legend.replaceChildren();

        if (legend) {
            if (legend.kind === 'ramp') {
                const stops = legend.entries
                    .map(
                        (e, i) =>
                            `${e.color} ${(i / (legend.entries.length - 1)) * 100}%`,
                    )
                    .join(', ');
                this.legend.append(
                    h('div', {
                        class: 'ww-viewmode-ramp',
                        style: {
                            background: `linear-gradient(to right, ${stops})`,
                        },
                    }),
                    h(
                        'div',
                        { class: 'ww-viewmode-ticks' },
                        legend.entries.map((e) => h('span', {}, e.label)),
                    ),
                );
            } else {
                for (const e of legend.entries) {
                    this.legend.append(
                        h(
                            'div',
                            { class: 'ww-viewmode-swatch' },
                            h('i', { style: { background: e.color } }),
                            e.label,
                        ),
                    );
                }
            }

            if (legend.note) {
                this.legend.append(
                    h('div', { class: 'ww-viewmode-note' }, legend.note),
                );
            }
        }

        this.legend.hidden = this.open || !legend;
    }

    private onPointerDown = (e: PointerEvent): void => {
        if (this.open && !this.el.contains(e.target as Node)) {
            this.setOpen(false);
        }
    };

    private onKey = (e: KeyboardEvent): void => {
        if (this.open && e.code === 'Escape') {
            e.preventDefault();
            e.stopImmediatePropagation();
            this.setOpen(false);
        }
    };
}
