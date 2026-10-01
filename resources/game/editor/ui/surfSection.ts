import { h, section, segmented, slider } from '../../ui/dom';
import type { Editor, SurfPaintMode } from '../Editor';

/**
 * Water › Surf: brush options. Surf breaks where a body has surf on and the shore is gentle; the brush
 * paints it on (at a strength) or off along a stretch of shore, or back to automatic. Stored per map
 * (surf.u8; MCP paint_surf). The waves themselves are set per body (Water › Bodies).
 */
export function surfSection(editor: Editor): HTMLElement {
    const s = editor.state;
    const mode = segmented<SurfPaintMode>(
        [
            { value: 'on', label: 'On', title: 'Paint surf on' },
            { value: 'off', label: 'Off', title: 'Paint surf off' },
            {
                value: 'auto',
                label: 'Auto',
                title: 'Back to automatic: the body’s surf setting on gentle shores',
            },
        ],
        s.surfMode,
        (v) => {
            s.surfMode = v;
            strength.el.style.display = v === 'on' ? '' : 'none';
            editor.notify();
        },
    );
    const strength = slider({
        label: 'Surf strength',
        min: 0.05,
        max: 1,
        step: 0.05,
        value: s.surfStrength,
        onInput: (v) => (s.surfStrength = v),
    });
    strength.el.style.display = s.surfMode === 'on' ? '' : 'none';
    const info = editor.worldData.water.surf.describe();

    return section(
        'Surf',
        mode.el,
        strength.el,
        h(
            'p',
            { class: 'ww-muted' },
            'Paint over the shoreline. Waves, period and direction are set per body in Bodies.',
        ),
        h(
            'p',
            { class: 'ww-muted' },
            `Surf on ~${info.surf_shore_m} m of shoreline${info.painted_samples ? ' · painted areas' : ''}.`,
        ),
    );
}
