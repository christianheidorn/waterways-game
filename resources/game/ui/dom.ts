import { createElement } from 'lucide';
import type { IconNode } from 'lucide';

type Props = Record<string, unknown> & {
    class?: string;
    style?: Partial<CSSStyleDeclaration>;
};

type Child = Node | string | null | undefined | false;

/** Tiny hyperscript helper for the in-game UI. */
export function h<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props: Props = {},
    ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);

    for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null || value === false) {
            continue;
        }

        if (key === 'class') {
            el.className = String(value as string);
        } else if (key === 'style') {
            Object.assign(el.style, value);
        } else if (key.startsWith('on') && typeof value === 'function') {
            el.addEventListener(
                key.slice(2).toLowerCase(),
                value as EventListener,
            );
        } else if (key in el && typeof value !== 'string') {
            (el as unknown as Record<string, unknown>)[key] = value;
        } else {
            el.setAttribute(
                key,
                value === true ? '' : String(value as string | number),
            );
        }
    }

    for (const child of children.flat()) {
        if (child === null || child === undefined || child === false) {
            continue;
        }

        el.append(
            typeof child === 'string' ? document.createTextNode(child) : child,
        );
    }

    return el;
}

export function icon(node: IconNode, size = 16): SVGElement {
    const svg = createElement(node);
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('stroke-width', '1.75');
    svg.classList.add('ww-icon');

    return svg;
}

export type SliderOptions = {
    label: string;
    min: number;
    max: number;
    step: number;
    value: number;
    unit?: string;
    /** Logarithmic mapping (useful for brush sizes). */
    log?: boolean;
    format?: (v: number) => string;
    onInput: (v: number) => void;
};

export type SliderHandle = { el: HTMLElement; set: (v: number) => void };

export function slider(opts: SliderOptions): SliderHandle {
    const toPos = (v: number) =>
        opts.log
            ? Math.log(v / opts.min) / Math.log(opts.max / opts.min)
            : (v - opts.min) / (opts.max - opts.min);
    const fromPos = (p: number) => {
        const raw = opts.log
            ? opts.min * Math.pow(opts.max / opts.min, p)
            : opts.min + p * (opts.max - opts.min);

        return Math.round(raw / opts.step) * opts.step;
    };
    const fmt =
        opts.format ??
        ((v: number) =>
            `${Number(v.toFixed(opts.step < 0.01 ? 3 : opts.step < 1 ? 2 : 0))}${opts.unit ?? ''}`);
    const range = h('input', {
        type: 'range',
        min: '0',
        max: '1000',
        step: '1',
        class: 'ww-range',
    });
    const value = h('span', { class: 'ww-slider-value' });
    const set = (v: number) => {
        range.value = String(Math.round(toPos(v) * 1000));
        value.textContent = fmt(v);
        range.style.setProperty('--fill', `${toPos(v) * 100}%`);
    };
    range.addEventListener('input', () => {
        const v = fromPos(Number(range.value) / 1000);
        value.textContent = fmt(v);
        range.style.setProperty(
            '--fill',
            `${(Number(range.value) / 1000) * 100}%`,
        );
        opts.onInput(v);
    });
    set(opts.value);

    const el = h(
        'label',
        { class: 'ww-slider' },
        h(
            'span',
            { class: 'ww-slider-head' },
            h('span', {}, opts.label),
            value,
        ),
        range,
    );

    return { el, set };
}

export type SegmentOption<T extends string> = {
    value: T;
    label: string;
    icon?: IconNode;
    title?: string;
};

export type SegmentHandle<T extends string> = {
    el: HTMLElement;
    set: (v: T) => void;
};

export function segmented<T extends string>(
    options: SegmentOption<T>[],
    value: T,
    onChange: (v: T) => void,
    cls = '',
): SegmentHandle<T> {
    const buttons = new Map<T, HTMLButtonElement>();
    const el = h('div', { class: `ww-segmented ${cls}` });

    for (const option of options) {
        const button = h(
            'button',
            {
                type: 'button',
                class: 'ww-segment',
                title: option.title ?? option.label,
                onClick: () => {
                    set(option.value);
                    onChange(option.value);
                },
            },
            option.icon ? icon(option.icon, 15) : null,
            h('span', {}, option.label),
        );
        buttons.set(option.value, button);
        el.append(button);
    }

    const set = (v: T) => {
        for (const [key, button] of buttons) {
            button.classList.toggle('is-active', key === v);
        }
    };
    set(value);

    return { el, set };
}

export function section(
    title: string,
    ...children: (Child | Child[])[]
): HTMLElement {
    return h(
        'section',
        { class: 'ww-section' },
        h('h3', { class: 'ww-section-title' }, title),
        ...children,
    );
}

export function button(
    label: string,
    onClick: () => void,
    opts: {
        icon?: IconNode;
        variant?: 'primary' | 'ghost' | 'default';
        title?: string;
    } = {},
): HTMLButtonElement {
    return h(
        'button',
        {
            type: 'button',
            class: `ww-button ww-button-${opts.variant ?? 'default'}`,
            title: opts.title ?? label,
            onClick,
        },
        opts.icon ? icon(opts.icon, 15) : null,
        label ? h('span', {}, label) : null,
    );
}

export function numberField(
    label: string,
    value: number,
    step: number,
    onChange: (v: number) => void,
): { el: HTMLElement; set: (v: number) => void } {
    const input = h('input', {
        type: 'number',
        step: String(step),
        class: 'ww-input',
        value: String(value),
    });
    input.addEventListener('change', () => onChange(Number(input.value)));

    return {
        el: h('label', { class: 'ww-field' }, h('span', {}, label), input),
        set: (v: number) => {
            input.value = String(Number(v.toFixed(2)));
        },
    };
}

export function toggle(
    label: string,
    value: boolean,
    onChange: (v: boolean) => void,
): { el: HTMLElement; set: (v: boolean) => void } {
    const input = h('input', { type: 'checkbox', class: 'ww-switch-input' });
    input.checked = value;
    input.addEventListener('change', () => onChange(input.checked));

    return {
        el: h(
            'label',
            { class: 'ww-toggle' },
            h('span', {}, label),
            input,
            h('span', { class: 'ww-switch' }),
        ),
        set: (v: boolean) => {
            input.checked = v;
        },
    };
}
