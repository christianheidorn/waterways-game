import { Gamepad2, Hammer, Redo2, Save, Undo2 } from 'lucide';
import type { GameMode, GameStats, SaveState } from '../shared/protocol';
import { button, h } from './dom';

export type HudActions = {
    setMode: (mode: GameMode) => void;
    save: () => void;
    undo: () => void;
    redo: () => void;
};

/**
 * Overlay chrome: standalone toolbar, stats, play-mode hints, status bar and save state.
 */
export class Hud {
    readonly el: HTMLElement;
    readonly panelSlot: HTMLElement;
    private stats: HTMLElement;
    private status: HTMLElement;
    private saveBadge: HTMLElement;
    private playHint: HTMLElement;
    private toolbar: HTMLElement;
    private modeButtons: { edit: HTMLButtonElement; play: HTMLButtonElement };
    private undoBtn: HTMLButtonElement;
    private redoBtn: HTMLButtonElement;
    private crosshair: HTMLElement;
    private notice: HTMLElement;
    private noticeTimer = 0;

    constructor(
        private readonly root: HTMLElement,
        private readonly embedded: boolean,
        actions: HudActions,
    ) {
        this.modeButtons = {
            edit: button('Build', () => actions.setMode('edit'), {
                icon: Hammer,
                title: 'Build mode',
            }),
            play: button('Play', () => actions.setMode('play'), {
                icon: Gamepad2,
                title: 'Play test (P)',
            }),
        };
        this.undoBtn = button('', actions.undo, {
            icon: Undo2,
            variant: 'ghost',
            title: 'Undo (Ctrl+Z)',
        });
        this.redoBtn = button('', actions.redo, {
            icon: Redo2,
            variant: 'ghost',
            title: 'Redo (Ctrl+Y)',
        });
        this.toolbar = h(
            'div',
            { class: 'ww-toolbar ww-panel' },
            h(
                'div',
                { class: 'ww-segmented' },
                this.modeButtons.edit,
                this.modeButtons.play,
            ),
            this.undoBtn,
            this.redoBtn,
            button('Save', actions.save, {
                icon: Save,
                variant: 'primary',
                title: 'Save (Ctrl+S)',
            }),
        );
        this.toolbar.hidden = embedded;

        this.stats = h('div', { class: 'ww-stats' });
        this.saveBadge = h('span', { class: 'ww-save-badge' });
        this.status = h('div', { class: 'ww-statusbar' });
        this.playHint = h(
            'div',
            { class: 'ww-play-hint ww-panel' },
            h('strong', {}, 'Click to look around'),
            h(
                'span',
                {},
                'WASD move · Shift run · Space jump · C dive · Esc release mouse, Esc again to return to building',
            ),
        );
        this.crosshair = h('div', { class: 'ww-crosshair' });
        this.notice = h('div', { class: 'ww-notice' });
        this.panelSlot = h('div', { class: 'ww-panel-slot' });

        this.el = h(
            'div',
            { class: 'ww-hud' },
            this.panelSlot,
            this.toolbar,
            this.stats,
            this.playHint,
            this.crosshair,
            this.notice,
            this.status,
        );
        root.append(this.el);
    }

    setMode(mode: GameMode, pointerLocked: boolean): void {
        this.el.dataset.mode = mode;
        this.modeButtons.edit.classList.toggle('is-active', mode === 'edit');
        this.modeButtons.play.classList.toggle('is-active', mode === 'play');
        this.panelSlot.hidden = mode !== 'edit';
        this.playHint.hidden = mode !== 'play' || pointerLocked;
        this.crosshair.hidden = mode !== 'play' || !pointerLocked;
        this.undoBtn.hidden = this.redoBtn.hidden = mode !== 'edit';
    }

    setHistory(canUndo: boolean, canRedo: boolean): void {
        this.undoBtn.disabled = !canUndo;
        this.redoBtn.disabled = !canRedo;
    }

    setStatus(content: HTMLElement | string): void {
        this.status.replaceChildren(
            typeof content === 'string' ? content : content,
            this.saveBadge,
        );
    }

    setSaveState(state: SaveState | 'dirty', message?: string): void {
        const labels: Record<string, string> = {
            idle: 'All changes saved',
            saving: 'Saving…',
            saved: 'Saved',
            error: 'Save failed',
            dirty: 'Unsaved changes',
        };
        this.saveBadge.textContent = message
            ? `${labels[state]}: ${message}`
            : labels[state];
        this.saveBadge.dataset.state = state;
    }

    setStats(stats: GameStats | null): void {
        this.stats.hidden = !stats;

        if (!stats) {
            return;
        }

        const p = stats.position;
        this.stats.textContent = `${stats.fps.toFixed(0)} fps · ${stats.frameMs.toFixed(1)} ms · ${stats.drawCalls} draws · ${(stats.triangles / 1e6).toFixed(2)}M tris · ${stats.foliageInstances.toLocaleString()} foliage · ${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)}`;
    }

    flash(message: string): void {
        this.notice.textContent = message;
        this.notice.classList.add('is-visible');
        window.clearTimeout(this.noticeTimer);
        this.noticeTimer = window.setTimeout(
            () => this.notice.classList.remove('is-visible'),
            2200,
        );
    }

    dispose(): void {
        this.root.removeChild(this.el);
    }
}

export class LoadingScreen {
    readonly el: HTMLElement;
    private bar: HTMLElement;
    private label: HTMLElement;
    private detail: HTMLElement;

    constructor(root: HTMLElement, title: string) {
        this.bar = h('div', { class: 'ww-progress-bar' });
        this.label = h('div', { class: 'ww-loading-label' }, 'Loading…');
        this.detail = h('div', { class: 'ww-loading-detail' });
        this.el = h(
            'div',
            { class: 'ww-loading' },
            h(
                'div',
                { class: 'ww-loading-card' },
                h('div', { class: 'ww-loading-mark' }, waveMark()),
                h('div', { class: 'ww-loading-title' }, title),
                this.label,
                h('div', { class: 'ww-progress' }, this.bar),
                this.detail,
            ),
        );
        root.append(this.el);
    }

    set(progress: number, label: string, detail = ''): void {
        this.bar.style.width = `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`;
        this.label.textContent = label;
        this.detail.textContent = detail;
    }

    error(message: string): void {
        this.el.classList.add('is-error');
        this.label.textContent = 'Something went wrong';
        this.detail.textContent = message;
    }

    hide(): void {
        this.el.classList.add('is-hidden');
        window.setTimeout(() => this.el.remove(), 600);
    }
}

function waveMark(): SVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 48 48');
    svg.setAttribute('width', '44');
    svg.setAttribute('height', '44');
    svg.innerHTML =
        '<path d="M4 30c6 0 6-5 12-5s6 5 12 5 6-5 12-5 4 3 4 3" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>' +
        '<path d="M4 38c6 0 6-5 12-5s6 5 12 5 6-5 12-5 4 3 4 3" fill="none" stroke="currentColor" stroke-opacity=".55" stroke-width="3" stroke-linecap="round"/>' +
        '<path d="M10 22 20 8l6 8 4-5 8 11" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>';

    return svg;
}
