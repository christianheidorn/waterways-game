/**
 * Matte extraction for foliage "card" images (one plant per image, AI generated or uploaded): keying
 * the background out (flat key colours as well as gradients / vignettes), choking the matte, bleeding
 * edge colour, trimming and the alpha coverage checks that reject a card whose background survived.
 * Pure pixel code (no DOM, no three.js) so it runs in the browser baker and in unit tests.
 */

import { describeCoverage, measureCoverage } from '../util/alphaCoverage';
import type { CoverageReport } from '../util/alphaCoverage';

export type RawImage = {
    data: Uint8ClampedArray;
    width: number;
    height: number;
};

/** Alpha coverage of a card image trimmed to its plant. */
export function cardCoverage(image: RawImage): CoverageReport {
    return measureCoverage(image.data, image.width, image.height, 'card');
}

/**
 * The card baker's matte: keys the background out (when asked, or when the image has no
 * meaningful alpha), chokes the rim and trims to the plant. Throws when nothing is left, or when
 * the result is still an opaque box (a background that survived would draw as one in game).
 */
export function extractCardMatte(
    source: RawImage,
    options: { keyBackground?: boolean; keyColor?: string },
): {
    image: RawImage;
    keyed: boolean;
    coverage: CoverageReport;
    /** Where the result starts in the source image. */
    offset: { x: number; y: number };
} {
    let image = source;
    const offset = { x: 0, y: 0 };
    let keyed = !!options.keyBackground || !hasMeaningfulAlpha(image);

    if (!keyed) {
        // Real alpha around an opaque card (a model that "supports transparency" but painted a
        // background inside a transparent margin): key the card itself.
        const inner = trimToAlpha(image);

        if (inner && !cardCoverage(inner).ok) {
            image = inner;
            offset.x = inner.x;
            offset.y = inner.y;
            keyed = true;
        }
    }

    if (keyed) {
        keyBackground(image, parseHexColor(options.keyColor));
    }

    // Cut the rim off the matte so no background-tinted halo survives (thin blades are kept).
    chokeMatte(image, keyed);
    const trimmed = trimToAlpha(image);

    if (!trimmed) {
        throw new Error('The image is empty after removing the background');
    }

    // Never ship a card whose background survived: it draws as a box in game.
    const coverage = cardCoverage(trimmed);

    if (!coverage.ok) {
        throw new Error(
            `The background could not be removed (${describeCoverage(coverage)}). ` +
                'Regenerate the image on a flat magenta background or upload a PNG with transparency.',
        );
    }

    return {
        image: trimmed,
        keyed,
        coverage,
        offset: { x: offset.x + trimmed.x, y: offset.y + trimmed.y },
    };
}

export function hasMeaningfulAlpha(image: RawImage): boolean {
    const { width: w, height: h, data } = image;
    let transparent = 0;
    let border = 0;

    for (let x = 0; x < w; x++) {
        for (const y of [0, h - 1]) {
            border++;

            if (data[(y * w + x) * 4 + 3] < 128) {
                transparent++;
            }
        }
    }

    for (let y = 0; y < h; y++) {
        for (const x of [0, w - 1]) {
            border++;

            if (data[(y * w + x) * 4 + 3] < 128) {
                transparent++;
            }
        }
    }

    return transparent / border > 0.5;
}

export function parseHexColor(
    hex: string | undefined,
): [number, number, number] | null {
    const m = hex?.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);

    if (!m) {
        return null;
    }

    const v =
        m[1].length === 3
            ? m[1]
                  .split('')
                  .map((c) => c + c)
                  .join('')
            : m[1];

    return [
        parseInt(v.slice(0, 2), 16),
        parseInt(v.slice(2, 4), 16),
        parseInt(v.slice(4, 6), 16),
    ];
}

export function smooth01(e0: number, e1: number, x: number): number {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));

    return t * t * (3 - 2 * t);
}

/**
 * Breadth-first colour propagation: every pixel reached from the `known` set (in `mask`, when
 * given) takes the average `rgb` of its already-known 8-neighbours, layer by layer.
 * Returns the layer each pixel was reached in (0 = known, -1 = not reached).
 */
export function propagateColor(
    w: number,
    h: number,
    rgb: Float32Array,
    known: Uint8Array,
    maxLayers: number,
    mask?: Uint8Array,
): Int32Array {
    const n = w * h;
    const layerOf = new Int32Array(n).fill(-1);
    let layer: number[] = [];
    const visit = (i: number, into: number[]) => {
        const x = i % w;
        const y = (i / w) | 0;

        for (let dy = -1; dy <= 1; dy++) {
            const ny = y + dy;

            if (ny < 0 || ny >= h) {
                continue;
            }

            for (let dx = -1; dx <= 1; dx++) {
                const nx = x + dx;

                if (nx < 0 || nx >= w) {
                    continue;
                }

                const j = ny * w + nx;

                if (layerOf[j] === -1 && (!mask || mask[j])) {
                    layerOf[j] = -2;
                    into.push(j);
                }
            }
        }
    };

    for (let i = 0; i < n; i++) {
        if (known[i]) {
            layerOf[i] = 0;
        }
    }

    for (let i = 0; i < n; i++) {
        if (known[i]) {
            visit(i, layer);
        }
    }

    for (let pass = 1; layer.length && pass <= maxLayers; pass++) {
        const fill = new Float32Array(layer.length * 3);

        for (let k = 0; k < layer.length; k++) {
            const i = layer[k];
            const x = i % w;
            const y = (i / w) | 0;
            let r = 0;
            let g = 0;
            let b = 0;
            let c = 0;

            for (let dy = -1; dy <= 1; dy++) {
                const ny = y + dy;

                if (ny < 0 || ny >= h) {
                    continue;
                }

                for (let dx = -1; dx <= 1; dx++) {
                    const nx = x + dx;
                    const j = ny * w + nx;

                    if (nx >= 0 && nx < w && layerOf[j] >= 0) {
                        r += rgb[j * 3];
                        g += rgb[j * 3 + 1];
                        b += rgb[j * 3 + 2];
                        c++;
                    }
                }
            }

            fill[k * 3] = r / c;
            fill[k * 3 + 1] = g / c;
            fill[k * 3 + 2] = b / c;
        }

        for (let k = 0; k < layer.length; k++) {
            const i = layer[k];
            rgb[i * 3] = fill[k * 3];
            rgb[i * 3 + 1] = fill[k * 3 + 1];
            rgb[i * 3 + 2] = fill[k * 3 + 2];
            layerOf[i] = pass;
        }

        const next: number[] = [];

        for (const i of layer) {
            visit(i, next);
        }

        layer = next;
    }

    for (const i of layer) {
        layerOf[i] = -1;
    }

    return layerOf;
}

/** Cells across the longer side of the background field. */
const FIELD_CELLS = 40;
/** Rounds of growing the background region and refitting the field to it. */
const FIELD_ROUNDS = 10;

/** One light blur pass over a cell grid (rgb): keeps gradients, evens out single cells. */
function smoothCells(
    cells: Float32Array,
    gw: number,
    gh: number,
): Float32Array {
    const out = new Float32Array(cells.length);

    for (let y = 0; y < gh; y++) {
        for (let x = 0; x < gw; x++) {
            const i = y * gw + x;
            let weight = 4;

            for (let k = 0; k < 3; k++) {
                out[i * 3 + k] = cells[i * 3 + k] * 4;
            }

            for (const [dx, dy] of [
                [-1, 0],
                [1, 0],
                [0, -1],
                [0, 1],
            ]) {
                const nx = x + dx;
                const ny = y + dy;

                if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) {
                    continue;
                }

                const j = ny * gw + nx;
                weight++;

                for (let k = 0; k < 3; k++) {
                    out[i * 3 + k] += cells[j * 3 + k];
                }
            }

            for (let k = 0; k < 3; k++) {
                out[i * 3 + k] /= weight;
            }
        }
    }

    return out;
}

/**
 * Background colour behind every pixel, for backgrounds that aren't one flat colour (vignettes,
 * gradients, uneven lighting): starting from the flat colour `bg`, the region of pixels close to
 * the current field is flood-filled from the image border, the field is refitted to it on a coarse
 * grid (cell averages, cells without background pixels filled in from their neighbours, bilinear
 * in between), and the two steps repeat until the region stops growing. Each round follows the
 * background a little further into a vignette, while the plant — a jump in colour, not a gradual
 * drift — stays out. Returns the field (rgb per pixel) and the RMS residual of the background
 * pixels against it (noise, grain, JPEG artefacts).
 */
export function backgroundField(
    image: RawImage,
    bg: ArrayLike<number>,
): { field: Float32Array; noise: number; coverage: number } {
    const { width: w, height: h, data } = image;
    const n = w * h;
    const cell = Math.max(4, Math.ceil(Math.max(w, h) / FIELD_CELLS));
    const gw = Math.ceil(w / cell);
    const gh = Math.ceil(h / cell);
    let cells: Float32Array = new Float32Array(gw * gh * 3);

    for (let c = 0; c < gw * gh; c++) {
        cells[c * 3] = bg[0];
        cells[c * 3 + 1] = bg[1];
        cells[c * 3 + 2] = bg[2];
    }

    const field = new Float32Array(n * 3);
    // Bilinear between cell centres (lookup tables per column and row).
    const axis = (size: number, along: number) => {
        const i0 = new Int32Array(size);
        const i1 = new Int32Array(size);
        const t = new Float32Array(size);

        for (let p = 0; p < size; p++) {
            const f = Math.min(along - 1, Math.max(0, (p + 0.5) / cell - 0.5));
            i0[p] = Math.max(0, Math.min(along - 2, Math.floor(f)));
            i1[p] = Math.min(along - 1, i0[p] + 1);
            t[p] = Math.min(1, f - i0[p]);
        }

        return { i0, i1, t };
    };
    const ax = axis(w, gw);
    const ay = axis(h, gh);
    const fill = () => {
        for (let y = 0; y < h; y++) {
            const r0 = ay.i0[y] * gw;
            const r1 = ay.i1[y] * gw;
            const ty = ay.t[y];

            for (let x = 0; x < w; x++) {
                const x0 = ax.i0[x];
                const x1 = ax.i1[x];
                const tx = ax.t[x];
                const o = (y * w + x) * 3;

                for (let k = 0; k < 3; k++) {
                    const top =
                        cells[(r0 + x0) * 3 + k] * (1 - tx) +
                        cells[(r0 + x1) * 3 + k] * tx;
                    const bottom =
                        cells[(r1 + x0) * 3 + k] * (1 - tx) +
                        cells[(r1 + x1) * 3 + k] * tx;
                    field[o + k] = top * (1 - ty) + bottom * ty;
                }
            }
        }
    };
    const residual = (i: number) =>
        Math.sqrt(
            (data[i * 4] - field[i * 3]) ** 2 +
                (data[i * 4 + 1] - field[i * 3 + 1]) ** 2 +
                (data[i * 4 + 2] - field[i * 3 + 2]) ** 2,
        );
    const mask = new Uint8Array(n);
    const stack = new Int32Array(n);
    let count = 0;
    let previous = -1;
    // Starting noise: the border against the flat colour (a vignette's corners overstate it, so
    // it is capped; later rounds measure it against the fitted field).
    let noise = 0;
    {
        let sum = 0;
        let k = 0;

        for (let x = 0; x < w; x++) {
            for (const y of [0, h - 1]) {
                const o = (y * w + x) * 4;
                const d2 =
                    (data[o] - bg[0]) ** 2 +
                    (data[o + 1] - bg[1]) ** 2 +
                    (data[o + 2] - bg[2]) ** 2;

                if (data[o + 3] >= 8 && d2 < 40 * 40) {
                    sum += d2;
                    k++;
                }
            }
        }

        noise = k ? Math.sqrt(sum / k) : 0;
    }

    // Seeds: the outermost visible pixels (the image border, or the edge of a transparent margin).
    const edge: number[] = [];
    const clear = (i: number) => data[i * 4 + 3] < 8;

    for (let i = 0; i < n; i++) {
        const x = i % w;

        if (
            !clear(i) &&
            (x === 0 ||
                x === w - 1 ||
                i < w ||
                i >= n - w ||
                clear(i - 1) ||
                clear(i + 1) ||
                clear(i - w) ||
                clear(i + w))
        ) {
            edge.push(i);
        }
    }

    for (let round = 0; round < FIELD_ROUNDS; round++) {
        fill();
        const limit = Math.min(56, Math.max(30, noise * 3));
        mask.fill(0);
        count = 0;
        let sp = 0;
        const seed = (i: number) => {
            if (!mask[i] && data[i * 4 + 3] >= 8 && residual(i) < limit) {
                mask[i] = 1;
                stack[sp++] = i;
            }
        };

        for (const i of edge) {
            seed(i);
        }

        while (sp > 0) {
            const i = stack[--sp];
            count++;
            const x = i % w;

            if (x > 0) {
                seed(i - 1);
            }

            if (x < w - 1) {
                seed(i + 1);
            }

            if (i >= w) {
                seed(i - w);
            }

            if (i < n - w) {
                seed(i + w);
            }
        }

        // Converged: the field that found this region is the result.
        if (count === 0 || (previous >= 0 && count <= previous + n * 0.001)) {
            break;
        }

        previous = count;
        // Refit: per-cell averages of the region, holes filled from neighbouring cells.
        const sums = new Float32Array(gw * gh * 3);
        const counts = new Uint32Array(gw * gh);
        let sq = 0;

        for (let i = 0; i < n; i++) {
            if (!mask[i]) {
                continue;
            }

            sq += residual(i) ** 2;
            const x = i % w;

            // Only the region's interior: its rim holds anti-aliased mixes with the plant.
            if (
                (x > 0 && !mask[i - 1]) ||
                (x < w - 1 && !mask[i + 1]) ||
                (i >= w && !mask[i - w]) ||
                (i < n - w && !mask[i + w])
            ) {
                continue;
            }

            const ci = ((((i / w) | 0) / cell) | 0) * gw + ((x / cell) | 0);
            sums[ci * 3] += data[i * 4];
            sums[ci * 3 + 1] += data[i * 4 + 1];
            sums[ci * 3 + 2] += data[i * 4 + 2];
            counts[ci]++;
        }

        noise = Math.sqrt(sq / count);
        const known = new Uint8Array(gw * gh);
        const minCount = Math.max(4, cell * cell * 0.2);
        const next = new Float32Array(gw * gh * 3);

        for (let c = 0; c < gw * gh; c++) {
            if (counts[c] >= minCount) {
                known[c] = 1;
                next[c * 3] = sums[c * 3] / counts[c];
                next[c * 3 + 1] = sums[c * 3 + 1] / counts[c];
                next[c * 3 + 2] = sums[c * 3 + 2] / counts[c];
            }
        }

        if (!known.some((k) => k)) {
            break;
        }

        propagateColor(gw, gh, next, known, gw + gh);
        cells = smoothCells(next, gw, gh);
    }

    fill();
    let sq = 0;
    let k = 0;

    for (let i = 0; i < n; i++) {
        if (mask[i]) {
            sq += residual(i) ** 2;
            k++;
        }
    }

    return {
        field,
        noise: k ? Math.sqrt(sq / k) : noise,
        coverage: k / n,
    };
}

/**
 * Removes the background — a flat key colour (magenta, cyan, white, …: `key` when given, else
 * sampled from the image border) or a smooth gradient / vignette (e.g. dark green fading to black),
 * modelled as a colour field grown in from the border (see backgroundField). Background-like regions
 * connected to the border — or large enclosed ones (gaps between branches) — become transparent. In a band along the cut-out edge, alpha is
 * re-estimated by un-mixing each pixel between the key and the nearby solid plant colour, the
 * foreground colour is recovered (F = (C − (1 − a)·B) / a) and remaining key spill is removed.
 */
export function keyBackground(
    image: RawImage,
    key: [number, number, number] | null,
): void {
    const { width: w, height: h, data } = image;
    const n = w * h;
    const rs: number[] = [];
    const gs: number[] = [];
    const bs: number[] = [];
    const sample = (x: number, y: number) => {
        const o = (y * w + x) * 4;

        if (data[o + 3] >= 128) {
            rs.push(data[o]);
            gs.push(data[o + 1]);
            bs.push(data[o + 2]);
        }
    };
    const ring = Math.max(1, Math.round(Math.min(w, h) * 0.01));

    for (let k = 0; k < ring; k++) {
        for (let x = 0; x < w; x++) {
            sample(x, k);
            sample(x, h - 1 - k);
        }

        for (let y = 0; y < h; y++) {
            sample(k, y);
            sample(w - 1 - k, y);
        }
    }

    if (!rs.length) {
        return;
    }

    const median = (list: number[]) => {
        const sorted = list.slice().sort((a, b) => a - b);

        return sorted[sorted.length >> 1];
    };
    const detected = [median(rs), median(gs), median(bs)];
    const far = (c: number[]) =>
        Math.hypot(c[0] - detected[0], c[1] - detected[1], c[2] - detected[2]);
    // Trust the requested key unless the image plainly came back with another background.
    const bg = key && far(key) < 90 ? key : detected;
    // The background as a smoothly varying colour field (flat keys, gradients, vignettes), grown in
    // from the border; its residual noise (JPEG artefacts, grain) widens the tolerance.
    const { field, noise } = backgroundField(image, bg);
    const tolerance = Math.min(70, Math.max(26, noise * 2.5));
    const feather = 42;
    const dist = new Float32Array(n);

    for (let i = 0; i < n; i++) {
        const o = i * 4;
        dist[i] = Math.sqrt(
            (data[o] - field[i * 3]) ** 2 +
                (data[o + 1] - field[i * 3 + 1]) ** 2 +
                (data[o + 2] - field[i * 3 + 2]) ** 2,
        );
    }

    // Connected regions of background-like pixels.
    const limit = tolerance + feather;
    const region = new Int32Array(n).fill(-1);
    const keyRegion: boolean[] = [];
    const lum = (r: number, g: number, b: number) =>
        0.2126 * r + 0.7152 * g + 0.0722 * b;
    const magentaKey = bg[0] > 150 && bg[2] > 150 && bg[1] < 110;
    const cyanKey = bg[1] > 150 && bg[2] > 150 && bg[0] < 110;
    const whiteKey =
        lum(bg[0], bg[1], bg[2]) > 190 &&
        Math.max(...bg) - Math.min(...bg) < 40;
    // Saturated keys (magenta, cyan) don't occur in plants: every enclosed pocket of key colour
    // (gaps between leaflets) is background. Otherwise only large pockets or near-exact key
    // colour are, so white blossoms on a white background survive.
    const saturatedKey = magentaKey || cyanKey;
    const minArea = Math.max(48, n * 0.0008);
    const stack: number[] = [];

    for (let start = 0; start < n; start++) {
        if (
            region[start] >= 0 ||
            dist[start] >= limit ||
            data[start * 4 + 3] < 8
        ) {
            continue;
        }

        const id = keyRegion.length;
        let area = 0;
        let touchesBorder = false;
        let core = 0;
        region[start] = id;
        stack.push(start);

        while (stack.length) {
            const i = stack.pop()!;
            area++;
            core += dist[i] < tolerance ? 1 : 0;
            const x = i % w;
            const y = (i / w) | 0;

            // The image border, or a transparent margin around the picture.
            if (
                x === 0 ||
                y === 0 ||
                x === w - 1 ||
                y === h - 1 ||
                data[(i - 1) * 4 + 3] < 8 ||
                data[(i + 1) * 4 + 3] < 8 ||
                data[(i - w) * 4 + 3] < 8 ||
                data[(i + w) * 4 + 3] < 8
            ) {
                touchesBorder = true;
            }

            const neighbours = [
                x > 0 ? i - 1 : -1,
                x < w - 1 ? i + 1 : -1,
                y > 0 ? i - w : -1,
                y < h - 1 ? i + w : -1,
            ];

            for (const j of neighbours) {
                if (
                    j >= 0 &&
                    region[j] < 0 &&
                    dist[j] < limit &&
                    data[j * 4 + 3] >= 8
                ) {
                    region[j] = id;
                    stack.push(j);
                }
            }
        }

        keyRegion.push(
            touchesBorder ||
                area >= minArea ||
                saturatedKey ||
                core >= area * 0.3,
        );
    }

    const isKey = new Uint8Array(n);

    for (let i = 0; i < n; i++) {
        const id = region[i];
        isKey[i] = id >= 0 && keyRegion[id] ? 1 : 0;
    }

    // Edge band: everything within `radius` px of a keyed pixel; beyond it the plant is "solid".
    const radius = Math.max(3, Math.round(Math.max(w, h) / 400));
    const band = new Uint8Array(n);
    const solid = new Uint8Array(n);
    {
        const reach = new Int32Array(n).fill(-1);
        let front: number[] = [];

        for (let i = 0; i < n; i++) {
            if (isKey[i]) {
                reach[i] = 0;
                front.push(i);
            }
        }

        for (let step = 1; step <= radius && front.length; step++) {
            const next: number[] = [];

            for (const i of front) {
                const x = i % w;
                const y = (i / w) | 0;

                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const nx = x + dx;
                        const ny = y + dy;
                        const j = ny * w + nx;

                        if (
                            nx >= 0 &&
                            ny >= 0 &&
                            nx < w &&
                            ny < h &&
                            reach[j] < 0
                        ) {
                            reach[j] = step;
                            next.push(j);
                        }
                    }
                }
            }

            front = next;
        }

        for (let i = 0; i < n; i++) {
            band[i] = reach[i] >= 0 ? 1 : 0;

            if (data[i * 4 + 3] < 128) {
                continue;
            }

            if (reach[i] < 0) {
                solid[i] = 1;
                continue;
            }

            // Inside the band (thin fronds are all band): a pixel not touching the background
            // that is the most plant-like of its neighbourhood counts as pure plant colour.
            if (isKey[i] || dist[i] < limit) {
                continue;
            }

            const x = i % w;
            const y = (i / w) | 0;
            let pure = true;

            for (let dy = -1; dy <= 1 && pure; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = x + dx;
                    const ny = y + dy;

                    if (nx < 0 || ny < 0 || nx >= w || ny >= h) {
                        continue;
                    }

                    const j = ny * w + nx;

                    if (isKey[j] || dist[i] < dist[j] * 0.85) {
                        pure = false;
                        break;
                    }
                }
            }

            solid[i] = pure ? 1 : 0;
        }
    }

    // Local plant colour for every band pixel, grown in from the solid interior.
    const local = new Float32Array(n * 3);

    for (let i = 0; i < n; i++) {
        local[i * 3] = data[i * 4];
        local[i * 3 + 1] = data[i * 4 + 1];
        local[i * 3 + 2] = data[i * 4 + 2];
    }

    const localLayer = propagateColor(w, h, local, solid, radius * 4 + 4, band);
    for (let i = 0; i < n; i++) {
        if (!band[i]) {
            continue;
        }

        const o = i * 4;

        if (isKey[i] && dist[i] < tolerance) {
            data[o + 3] = 0;
            continue;
        }

        const cr = data[o];
        const cg = data[o + 1];
        const cb = data[o + 2];
        // Distance-based fallback (plant colour close to the key, or no solid plant nearby).
        let alpha = isKey[i]
            ? smooth01(tolerance, tolerance + feather, dist[i])
            : 1;
        let fr = localLayer[i] >= 0 ? local[i * 3] : cr;
        let fg = localLayer[i] >= 0 ? local[i * 3 + 1] : cg;
        let fb = localLayer[i] >= 0 ? local[i * 3 + 2] : cb;
        // The background behind this pixel.
        const br = field[i * 3];
        const bgg = field[i * 3 + 1];
        const bb = field[i * 3 + 2];
        const vr = fr - br;
        const vg = fg - bgg;
        const vb = fb - bb;
        const len2 = vr * vr + vg * vg + vb * vb;

        if (localLayer[i] >= 0 && len2 > 60 * 60) {
            // Project the pixel onto the key → plant line; colour off that line is real detail
            // (a highlight, a blossom), not a mix with the background.
            const pr = cr - br;
            const pg = cg - bgg;
            const pb = cb - bb;
            const t = Math.min(
                1,
                Math.max(0, (pr * vr + pg * vg + pb * vb) / len2),
            );
            const off = Math.hypot(pr - t * vr, pg - t * vg, pb - t * vb);
            alpha = t + (1 - t) * smooth01(24, 70, off);
        }

        if (alpha <= 0.03) {
            data[o + 3] = 0;
            continue;
        }

        // Decontaminate: recover the foreground colour from the mix with the key.
        const a = Math.max(alpha, 0.08);
        fr = Math.min(255, Math.max(0, (cr - (1 - a) * br) / a));
        fg = Math.min(255, Math.max(0, (cg - (1 - a) * bgg) / a));
        fb = Math.min(255, Math.max(0, (cb - (1 - a) * bb) / a));

        // Despill whatever key tint is left.
        if (magentaKey) {
            const spill = Math.min(fr, fb) - fg;

            if (spill > 0) {
                fr -= spill;
                fb -= spill;
            }
        } else if (cyanKey) {
            const spill = Math.min(fg, fb) - fr;

            if (spill > 0) {
                fg -= spill;
                fb -= spill;
            }
        } else if (whiteKey && localLayer[i] >= 0) {
            // Brightness lift: an edge pixel shouldn't be lighter than the plant next to it.
            const cap =
                lum(local[i * 3], local[i * 3 + 1], local[i * 3 + 2]) * 1.12 +
                6;
            const l = lum(fr, fg, fb);

            if (l > cap) {
                const k = cap / l;
                fr *= k;
                fg *= k;
                fb *= k;
            }
        }

        data[o] = fr;
        data[o + 1] = fg;
        data[o + 2] = fb;
        data[o + 3] = Math.min(data[o + 3], Math.round(alpha * 255));
    }

    // Keyed pixels outside the band (can only be deep background) are fully transparent.
    for (let i = 0; i < n; i++) {
        if (isKey[i] && !band[i]) {
            data[i * 4 + 3] = 0;
        }
    }
}

/**
 * Matte choke: erodes the rim of the alpha matte by ~1 px (scaled with the image) where the
 * plant is thick enough, then tightens the soft edge, so no background-tinted halo survives.
 * Features up to ~4 px across (thin fronds, grass blades) are not eroded, only tightened.
 * Without `erodeOpaque`, fully opaque rim pixels are kept (images that came with real alpha).
 */
export function chokeMatte(image: RawImage, erodeOpaque: boolean): void {
    const { width: w, height: h, data } = image;
    const n = w * h;
    const r = Math.max(1, Math.round(Math.max(w, h) / 1024));
    const cap = r + 3;
    // Chebyshev distance (in px) to the nearest background pixel, capped.
    const d = new Uint8Array(n).fill(cap);
    let front: number[] = [];

    for (let i = 0; i < n; i++) {
        if (data[i * 4 + 3] < 20) {
            d[i] = 0;
            front.push(i);
        }
    }

    for (let step = 1; step < cap && front.length; step++) {
        const next: number[] = [];

        for (const i of front) {
            const x = i % w;
            const y = (i / w) | 0;

            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = x + dx;
                    const ny = y + dy;
                    const j = ny * w + nx;

                    if (nx >= 0 && ny >= 0 && nx < w && ny < h && d[j] > step) {
                        d[j] = step;
                        next.push(j);
                    }
                }
            }
        }

        front = next;
    }

    const out = new Uint8ClampedArray(n);
    const win = r + 1;

    for (let i = 0; i < n; i++) {
        let a = data[i * 4 + 3] / 255;
        out[i] = data[i * 4 + 3];

        if (d[i] === 0 || d[i] > r + 1) {
            continue;
        }

        if (d[i] <= r && (erodeOpaque || a < 0.98)) {
            // Thickness: deepest pixel within reach. Thin features stay whole.
            const x = i % w;
            const y = (i / w) | 0;
            let depth = 0;

            for (let dy = -win; dy <= win; dy++) {
                const ny = y + dy;

                if (ny < 0 || ny >= h) {
                    continue;
                }

                for (let dx = -win; dx <= win; dx++) {
                    const nx = x + dx;

                    if (nx >= 0 && nx < w) {
                        depth = Math.max(depth, d[ny * w + nx]);
                    }
                }
            }

            if (depth >= r + 2) {
                a *= d[i] / (r + 1);
            }
        }

        if (a < 1) {
            a = smooth01(0.15, 0.85, a);
        }

        out[i] = Math.round(a * 255);
    }

    for (let i = 0; i < n; i++) {
        data[i * 4 + 3] = out[i];
    }
}

/**
 * Edge colour bleed: every pixel below ~95 % alpha takes the average colour of the solidly
 * opaque plant pixels a few px away, so light (or key-tinted) edge colour can't show through
 * bilinear filtering and mip-maps. Visible pixels further from any solid pixel (thin blades)
 * keep their own colour; fully transparent texels are then padded from everything visible.
 */
export function bleedEdgeColor(image: RawImage, reach = 3): void {
    const { width: w, height: h, data } = image;
    const n = w * h;
    let maxAlpha = 0;

    for (let i = 0; i < n; i++) {
        maxAlpha = Math.max(maxAlpha, data[i * 4 + 3]);
    }

    if (maxAlpha === 0) {
        return;
    }

    const solidAlpha = Math.min(242, maxAlpha * 0.95);
    const rgb = new Float32Array(n * 3);
    const known = new Uint8Array(n);

    for (let i = 0; i < n; i++) {
        rgb[i * 3] = data[i * 4];
        rgb[i * 3 + 1] = data[i * 4 + 1];
        rgb[i * 3 + 2] = data[i * 4 + 2];
        known[i] = data[i * 4 + 3] >= solidAlpha ? 1 : 0;
    }

    // 1. Near solid pixels: replace edge colour by the solid neighbourhood's.
    const first = propagateColor(w, h, rgb, known, reach);

    // 2. Everything else: pad from all pixels that now have a trusted colour.
    for (let i = 0; i < n; i++) {
        if (first[i] >= 0) {
            known[i] = 1;
        } else if (data[i * 4 + 3] >= 128) {
            known[i] = 1;
            rgb[i * 3] = data[i * 4];
            rgb[i * 3 + 1] = data[i * 4 + 1];
            rgb[i * 3 + 2] = data[i * 4 + 2];
        } else {
            known[i] = 0;
        }
    }

    propagateColor(w, h, rgb, known, 1 << 16);

    for (let i = 0; i < n; i++) {
        if (data[i * 4 + 3] < solidAlpha) {
            data[i * 4] = rgb[i * 3];
            data[i * 4 + 1] = rgb[i * 3 + 1];
            data[i * 4 + 2] = rgb[i * 3 + 2];
        }
    }
}

/** Crops to the visible pixels (+1 px); `x` / `y` = where the crop starts in the source. */
export function trimToAlpha(
    image: RawImage,
): (RawImage & { x: number; y: number }) | null {
    const { width: w, height: h, data } = image;
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (data[(y * w + x) * 4 + 3] > 24) {
                x0 = Math.min(x0, x);
                x1 = Math.max(x1, x);
                y0 = Math.min(y0, y);
                y1 = Math.max(y1, y);
            }
        }
    }

    if (x1 < 0) {
        return null;
    }

    // One pixel of padding so edge filtering doesn't clamp into the plant.
    x0 = Math.max(0, x0 - 1);
    y0 = Math.max(0, y0 - 1);
    x1 = Math.min(w - 1, x1 + 1);
    y1 = Math.min(h - 1, y1 + 1);
    const tw = x1 - x0 + 1;
    const th = y1 - y0 + 1;
    const out = new Uint8ClampedArray(tw * th * 4);

    for (let y = 0; y < th; y++) {
        out.set(
            data.subarray(
                ((y + y0) * w + x0) * 4,
                ((y + y0) * w + x0 + tw) * 4,
            ),
            y * tw * 4,
        );
    }

    return { data: out, width: tw, height: th, x: x0, y: y0 };
}

/** Horizontal position (0..1) of the plant's base: opaque-pixel centroid of the bottom rows. */
export function basePivot(image: RawImage): number {
    const { width: w, height: h, data } = image;
    const rows = Math.max(2, Math.round(h * 0.04));
    let sum = 0;
    let count = 0;

    for (let y = h - 1; y >= 0 && y >= h - rows * 4; y--) {
        for (let x = 0; x < w; x++) {
            if (data[(y * w + x) * 4 + 3] > 128) {
                sum += x;
                count++;
            }
        }

        if (count > 0 && y <= h - rows) {
            break;
        }
    }

    return count ? (sum / count + 0.5) / w : 0.5;
}
