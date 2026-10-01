import * as THREE from 'three/webgpu';
import { h, section, slider, toggle } from '../../ui/dom';
import type { Editor } from '../Editor';
import { bodyName, WATER_BODY_KINDS } from '../../world/water/bodySegmentation';
import type {
    WaterBody,
    WaterBodySettings,
} from '../../world/water/bodySegmentation';

/** Re-render key of the Bodies tool: the body list and the selection. */
export function waterBodiesKey(editor: Editor): string {
    const bodies = editor.worldData.water.bodies;

    return `${bodies.selected ?? ''}|${bodies.bodies.map((b) => `${b.id}${b.kind}`).join(',')}`;
}

const AREA = (m2: number) =>
    m2 >= 1e6
        ? `${(m2 / 1e6).toFixed(2)} km²`
        : m2 >= 1e4
          ? `${(m2 / 1e4).toFixed(1)} ha`
          : `${Math.round(m2)} m²`;

/**
 * Water › Bodies: the map's water bodies (lakes, ponds, rivers, the sea) and the settings of the selected
 * one (wind exposure, fetch, wave height, choppiness, colours, clarity, surf). Click water in the view to
 * select it. Changes apply live and are saved with the map (MCP: edit_water_body).
 */
export function waterBodiesSection(
    editor: Editor,
    refreshers: (() => void)[],
): HTMLElement {
    const water = editor.worldData.water;
    water.flushBodies();
    const bodies = water.bodies;
    const selected = bodies.selected ? bodies.get(bodies.selected) : undefined;
    const select = (id: string | null) => {
        bodies.select(id);
        const b = id ? bodies.get(id) : undefined;

        if (b) {
            editor.fly.focus(
                new THREE.Vector3(b.seed.x, b.level, b.seed.z),
                Math.min(600, Math.max(40, Math.sqrt(b.area) * 0.8)),
            );
        }

        editor.notify();
    };

    const list = h(
        'div',
        { class: 'ww-body-list' },
        ...bodies.bodies.slice(0, 60).map((b) =>
            h(
                'button',
                {
                    type: 'button',
                    class: `ww-list-row${b.id === bodies.selected ? ' is-active' : ''}`,
                    title: `${b.id} · ${b.kind} · ${AREA(b.area)}`,
                    onClick: () =>
                        select(b.id === bodies.selected ? null : b.id),
                },
                h('span', {}, bodyName(b)),
                h('span', { class: 'ww-muted' }, `${b.kind} · ${AREA(b.area)}`),
            ),
        ),
    );
    const listSection = section(
        `Water bodies (${bodies.bodies.length})`,
        bodies.bodies.length
            ? list
            : h(
                  'p',
                  { class: 'ww-muted' },
                  'No water yet. Fill a lake or draw a river first.',
              ),
        bodies.bodies.length > 60
            ? h(
                  'p',
                  { class: 'ww-muted' },
                  `The 60 largest of ${bodies.bodies.length}.`,
              )
            : null,
    );

    if (!selected) {
        return h(
            'div',
            {},
            listSection,
            h(
                'p',
                { class: 'ww-muted' },
                'Click a lake, pond, river or the sea to edit it.',
            ),
        );
    }

    return h(
        'div',
        {},
        listSection,
        bodySettings(editor, selected, refreshers),
    );
}

function bodySettings(
    editor: Editor,
    body: WaterBody,
    refreshers: (() => void)[],
): HTMLElement {
    const water = editor.worldData.water;
    const update = (patch: Partial<WaterBodySettings>) => {
        water.bodies.update(body.id, patch);
        info.textContent = describe();
    };
    const describe = () => {
        const d = water.describeBodies().find((b) => b.id === body.id);

        return d
            ? `${d.id} · auto: ${d.auto_kind} · ${AREA(d.area_m2)} · deepest ${d.max_depth} m · fetch ${d.fetch_m} m · waves ~${d.waves.significant_height_m} m`
            : body.id;
    };
    const info = h('p', { class: 'ww-muted' }, describe());
    const s = body.settings;

    const name = h('input', {
        type: 'text',
        class: 'ww-input',
        value: s.name,
        placeholder: bodyName({ ...body, settings: { ...s, name: '' } }),
    });
    name.addEventListener('change', () => update({ name: name.value.trim() }));

    const kind = h(
        'select',
        { class: 'ww-input' },
        h('option', { value: '' }, `Automatic (${body.auto_kind})`),
        ...WATER_BODY_KINDS.map((k) =>
            h('option', { value: k }, k[0].toUpperCase() + k.slice(1)),
        ),
    );
    kind.value = s.kind ?? '';
    kind.addEventListener('change', () => {
        update({
            kind: kind.value ? (kind.value as WaterBodySettings['kind']) : null,
        });
        editor.notify();
    });

    const exposure = slider({
        label: 'Wind exposure',
        min: 0,
        max: 2,
        step: 0.05,
        value: s.wind_exposure,
        onInput: (v) => update({ wind_exposure: v }),
    });
    const height = slider({
        label: 'Wave height',
        min: 0,
        max: 4,
        step: 0.05,
        value: s.wave_height,
        unit: '×',
        onInput: (v) => update({ wave_height: v }),
    });
    const chop = slider({
        label: 'Choppiness',
        min: 0,
        max: 2,
        step: 0.05,
        value: s.choppiness,
        onInput: (v) => update({ choppiness: v }),
    });
    const autoFetch = toggle(
        'Fetch from the body’s size',
        s.fetch === null,
        (v) => {
            update({
                fetch: v
                    ? null
                    : Math.round(
                          water.describeBodies().find((b) => b.id === body.id)
                              ?.fetch_m ?? 500,
                      ),
            });
            fetch.el.style.display = v ? 'none' : '';
        },
    );
    const fetch = slider({
        label: 'Fetch',
        min: 10,
        max: 200000,
        step: 10,
        log: true,
        value: s.fetch ?? 500,
        unit: ' m',
        onInput: (v) => update({ fetch: v }),
    });
    fetch.el.style.display = s.fetch === null ? 'none' : '';

    const colorRow = (
        label: string,
        key: 'shallow_color' | 'deep_color',
        fallback: string,
    ) => {
        const input = h('input', {
            type: 'color',
            class: 'ww-color',
            value: s[key] ?? fallback,
        });
        input.disabled = s[key] === null;
        const on = toggle(label, s[key] !== null, (v) => {
            input.disabled = !v;
            update({ [key]: v ? input.value : null });
        });
        input.addEventListener('input', () => update({ [key]: input.value }));

        return h('div', { class: 'ww-row' }, on.el, input);
    };
    const env = water.environment;
    const clarityOn = toggle('Own clarity', s.clarity !== null, (v) => {
        update({ clarity: v ? (s.clarity ?? env?.water_clarity ?? 5) : null });
        clarity.el.style.display = v ? '' : 'none';
    });
    const clarity = slider({
        label: 'Clarity',
        min: 0.3,
        max: 40,
        step: 0.1,
        log: true,
        value: s.clarity ?? env?.water_clarity ?? 5,
        unit: ' m',
        onInput: (v) => update({ clarity: v }),
    });
    clarity.el.style.display = s.clarity === null ? 'none' : '';
    const surfHeight = slider({
        label: 'Surf height',
        min: 0,
        max: 4,
        step: 0.05,
        value: s.surf_height,
        unit: ' m',
        onInput: (v) => update({ surf_height: v }),
    });
    const surfPeriod = slider({
        label: 'Surf period',
        min: 1.5,
        max: 20,
        step: 0.1,
        value: s.surf_period,
        unit: ' s',
        onInput: (v) => update({ surf_period: v }),
    });
    let direction = s.surf_direction ?? 0;
    const surfDirection = slider({
        label: 'Surf towards',
        min: 0,
        max: 359,
        step: 1,
        value: direction,
        unit: '°',
        onInput: (v) => {
            direction = v;
            update({ surf_direction: v });
        },
    });
    const surfAuto = toggle(
        'Surf direction from the wind',
        s.surf_direction === null,
        (v) => {
            update({ surf_direction: v ? null : direction });
            surfDirection.el.style.display = v ? 'none' : '';
        },
    );
    surfDirection.el.style.display = s.surf_direction === null ? 'none' : '';
    const surfOptions = h(
        'div',
        {},
        surfHeight.el,
        surfPeriod.el,
        surfAuto.el,
        surfDirection.el,
    );
    surfOptions.style.display = s.surf ? '' : 'none';
    const surf = toggle('Surf on its gentle shores', s.surf, (v) => {
        update({ surf: v });
        surfOptions.style.display = v ? '' : 'none';
    });

    refreshers.push(() => {
        info.textContent = describe();
    });

    return h(
        'div',
        {},
        section(
            bodyName(body),
            info,
            h('label', { class: 'ww-field' }, h('span', {}, 'Name'), name),
            h('label', { class: 'ww-field' }, h('span', {}, 'Kind'), kind),
        ),
        section(
            'Waves',
            exposure.el,
            autoFetch.el,
            fetch.el,
            height.el,
            chop.el,
        ),
        section(
            'Look',
            colorRow(
                'Own shallow colour',
                'shallow_color',
                env?.water_shallow_color ?? '#3aa6a0',
            ),
            colorRow(
                'Own deep colour',
                'deep_color',
                env?.water_deep_color ?? '#0a2a3c',
            ),
            clarityOn.el,
            clarity.el,
            h(
                'p',
                { class: 'ww-muted' },
                'Wind waves grow with the wind (World › weather) and the fetch; a sheltered or small body stays calmer.',
            ),
        ),
        section(
            'Surf',
            surf.el,
            surfOptions,
            h(
                'p',
                { class: 'ww-muted' },
                'Waves shoal and break on gentle shores (beaches are found by slope); lake surf grows with the wind. Paint it on or off along a shore with Water › Surf.',
            ),
        ),
    );
}
