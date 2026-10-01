/**
 * Water bodies: the connected pieces of the water grid (lakes, ponds, rivers, the sea), each with its own
 * settings (wind exposure, fetch, wave height, choppiness, colour / clarity, surf). Stored per map in
 * maps/{id}/water_bodies.json:
 *
 *   {"version": 1, "bodies": [{"id": "wb3", "seed": [x, z], "kind": "lake", "area": 51200, ...settings}]}
 *
 * The bodies themselves are always derived from the water grid (recomputed after every water edit); the
 * file keeps their ids and settings. Ids stay stable across edits: a body keeps its id while its seed point
 * (its deepest sample) is still wet in it, or while its centroid stays within it.
 *
 * Pure code (no three.js): unit tested.
 */
import { NO_WATER } from '../../shared/types';

export type WaterBodyKind = 'lake' | 'pond' | 'river' | 'sea';

export const WATER_BODY_KINDS: readonly WaterBodyKind[] = ['lake', 'pond', 'river', 'sea'];

/** Per-body settings (what the editor's Bodies tool and MCP `edit_water_body` change). */
export type WaterBodySettings = {
    /** Display name ('' = automatic, e.g. "Lake wb3"). */
    name: string;
    /** Kind override (null = classified automatically). */
    kind: WaterBodyKind | null;
    /** How much of the wind reaches the water (0 = sheltered, 1 = open, up to 2). */
    wind_exposure: number;
    /** Fetch in m (distance the wind blows over the water); null = from the body's size along the wind. */
    fetch: number | null;
    /** Wave height multiplier (0 = glassy). */
    wave_height: number;
    /** Horizontal choppiness of the waves (0 = rolling sines, 1 = natural, 2 = sharp crests). */
    choppiness: number;
    /** Colour / clarity overrides (null = the map's environment water colours). */
    shallow_color: string | null;
    deep_color: string | null;
    clarity: number | null;
    /** Surf on the shores of this body (beaches, phase 11). */
    surf: boolean;
};

export const DEFAULT_BODY_SETTINGS: Readonly<WaterBodySettings> = {
    name: '',
    kind: null,
    wind_exposure: 1,
    fetch: null,
    wave_height: 1,
    choppiness: 1,
    shallow_color: null,
    deep_color: null,
    clarity: null,
    surf: false,
};

/** Default settings per kind for bodies seen for the first time. */
export function defaultSettingsFor(kind: WaterBodyKind): WaterBodySettings {
    return {
        ...DEFAULT_BODY_SETTINGS,
        // Rivers: the flow carries the look, wind waves stay small; ponds are sheltered.
        wind_exposure: kind === 'river' ? 0.5 : kind === 'pond' ? 0.7 : 1,
        surf: kind === 'sea',
    };
}

/** A body derived from the grid, with its settings. */
export type WaterBody = {
    id: string;
    /** Effective kind (the override, else `auto_kind`). */
    kind: WaterBodyKind;
    auto_kind: WaterBodyKind;
    /** Its deepest sample (world x / z): the anchor that keeps the id stable. */
    seed: { x: number; z: number };
    centroid: { x: number; z: number };
    /** Surface area (m²) and sample count. */
    area: number;
    samples: number;
    /** Mean / lowest / highest surface level (m) and the deepest water (m). */
    level: number;
    level_min: number;
    level_max: number;
    max_depth: number;
    /** World-space bounds. */
    bounds: { x0: number; z0: number; x1: number; z1: number };
    /** Touches the map edge. */
    edge: boolean;
    /** Spatial covariance of the samples (m²): sizes the body along any direction (fetch). */
    cov: { xx: number; xz: number; zz: number };
    settings: WaterBodySettings;
};

export type WaterBodyRecord = WaterBodySettings & {
    id: string;
    seed: [number, number];
    centroid?: [number, number];
    kind_auto?: WaterBodyKind;
    area?: number;
    level?: number;
};

export type WaterBodiesFile = { version: 1; bodies: WaterBodyRecord[] };

export type GridLike = {
    resolution: number;
    cell: number;
    half: number;
    data: Float32Array;
};

export type SegmentOptions = {
    /** Terrain heights (same grid) for depths. */
    terrain?: GridLike | null;
    /** River flow per sample (x, z pairs; non-zero on a river spline). */
    riverFlow?: Float32Array | null;
    /** Sea level when the ocean is on (bodies at that level touching the map edge are the sea). */
    seaLevel?: number | null;
    /** Neighbours whose levels differ by more are not connected (a waterfall splits two bodies). */
    wallLimit?: number;
};

export type Segmentation = {
    /** Body index + 1 per sample (0 = dry). */
    labels: Int32Array;
    bodies: Omit<WaterBody, 'id' | 'settings' | 'kind'>[];
};

const isWet = (v: number) => v > NO_WATER + 1;

/** Area below which a still body is a pond (m²). */
export const POND_AREA = 4000;

/**
 * Connected components of the water grid (4-neighbourhood, split where levels jump by more than
 * `wallLimit`), with their statistics and an automatic kind.
 */
export function segmentWaterBodies(grid: GridLike, options: SegmentOptions = {}): Segmentation {
    const res = grid.resolution;
    const data = grid.data;
    const labels = new Int32Array(res * res);
    const stack = new Int32Array(res * res);
    const wallLimit = options.wallLimit ?? Math.max(1.5, grid.cell);
    const terrain = options.terrain ?? null;
    const flow = options.riverFlow ?? null;
    const cellArea = grid.cell * grid.cell;
    const bodies: Segmentation['bodies'] = [];

    for (let start = 0; start < res * res; start++) {
        if (labels[start] !== 0 || !isWet(data[start])) {
            continue;
        }

        const label = bodies.length + 1;
        let top = 0;
        stack[top++] = start;
        labels[start] = label;
        let n = 0;
        let sx = 0;
        let sz = 0;
        let sxx = 0;
        let sxz = 0;
        let szz = 0;
        let sl = 0;
        let lmin = Infinity;
        let lmax = -Infinity;
        let deepest = -Infinity;
        let seed = start;
        let c0 = res;
        let c1 = 0;
        let r0 = res;
        let r1 = 0;
        let riverSamples = 0;

        while (top > 0) {
            const i = stack[--top];
            const r = Math.floor(i / res);
            const c = i - r * res;
            const v = data[i];
            const x = c * grid.cell - grid.half;
            const z = r * grid.cell - grid.half;
            n++;
            sx += x;
            sz += z;
            sxx += x * x;
            sxz += x * z;
            szz += z * z;
            sl += v;
            lmin = Math.min(lmin, v);
            lmax = Math.max(lmax, v);
            c0 = Math.min(c0, c);
            c1 = Math.max(c1, c);
            r0 = Math.min(r0, r);
            r1 = Math.max(r1, r);
            const depth = terrain ? v - terrain.data[i] : 0;

            // Deepest sample (ties: the first found, so the seed is deterministic).
            if (depth > deepest + 1e-6) {
                deepest = depth;
                seed = i;
            }

            if (flow && (flow[i * 2] !== 0 || flow[i * 2 + 1] !== 0)) {
                riverSamples++;
            }

            for (let k = 0; k < 4; k++) {
                if ((k === 0 && c === 0) || (k === 1 && c === res - 1) || (k === 2 && r === 0) || (k === 3 && r === res - 1)) {
                    continue;
                }

                const j = k === 0 ? i - 1 : k === 1 ? i + 1 : k === 2 ? i - res : i + res;

                if (labels[j] === 0 && isWet(data[j]) && Math.abs(data[j] - v) <= wallLimit) {
                    labels[j] = label;
                    stack[top++] = j;
                }
            }
        }

        const cx = sx / n;
        const cz = sz / n;
        const cov = {
            xx: Math.max(0, sxx / n - cx * cx) + cellArea / 12,
            xz: sxz / n - cx * cz,
            zz: Math.max(0, szz / n - cz * cz) + cellArea / 12,
        };
        const edge = c0 === 0 || r0 === 0 || c1 === res - 1 || r1 === res - 1;
        const area = n * cellArea;
        const level = sl / n;
        const seedR = Math.floor(seed / res);
        const seedC = seed - seedR * res;
        const stats = {
            seed: { x: seedC * grid.cell - grid.half, z: seedR * grid.cell - grid.half },
            centroid: { x: cx, z: cz },
            area,
            samples: n,
            level,
            level_min: lmin,
            level_max: lmax,
            max_depth: terrain ? Math.max(0, deepest) : 0,
            bounds: {
                x0: c0 * grid.cell - grid.half,
                z0: r0 * grid.cell - grid.half,
                x1: c1 * grid.cell - grid.half,
                z1: r1 * grid.cell - grid.half,
            },
            edge,
            cov,
        };
        bodies.push({
            ...stats,
            auto_kind: classify(stats, riverSamples / n, options.seaLevel ?? null, (res - 1) * (res - 1) * cellArea),
        });
    }

    return { labels, bodies };
}

type Stats = {
    area: number;
    level: number;
    level_min: number;
    level_max: number;
    edge: boolean;
    cov: { xx: number; xz: number; zz: number };
};

/** Elongation: smaller / larger principal spread (1 = round, → 0 = a long ribbon). */
export function elongation(cov: Stats['cov']): number {
    const tr = cov.xx + cov.zz;
    const det = cov.xx * cov.zz - cov.xz * cov.xz;
    const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
    const l1 = tr / 2 + disc;
    const l2 = Math.max(0, tr / 2 - disc);

    return l1 > 0 ? Math.sqrt(l2 / l1) : 1;
}

/** Automatic kind: sea (at sea level, open to the map edge), river (on a river spline or a sloping ribbon), pond (small) or lake. */
export function classify(
    s: Stats,
    riverShare: number,
    seaLevel: number | null,
    mapArea: number,
): WaterBodyKind {
    if (s.edge && ((seaLevel !== null && Math.abs(s.level - seaLevel) < 0.75) || s.area > mapArea * 0.2)) {
        return 'sea';
    }

    const slope = s.level_max - s.level_min;

    if (riverShare > 0.5 || (elongation(s.cov) < 0.18 && slope > 0.6)) {
        return 'river';
    }

    return s.area < POND_AREA ? 'pond' : 'lake';
}

/**
 * Fetch (m) of a body for a wind blowing along (dx, dz): its length along the wind, from the spread of
 * its samples (a uniform strip of length L has σ² = L²/12). The sea is open.
 */
export function bodyFetch(body: Pick<WaterBody, 'kind' | 'cov' | 'settings'>, dx: number, dz: number, open: number): number {
    if (body.settings.fetch !== null && body.settings.fetch > 0) {
        return body.settings.fetch;
    }

    if (body.kind === 'sea') {
        return open;
    }

    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len;
    const uz = dz / len;
    const variance = ux * ux * body.cov.xx + 2 * ux * uz * body.cov.xz + uz * uz * body.cov.zz;

    return Math.max(5, Math.sqrt(12 * Math.max(0, variance)));
}

/** Settings from a stored record (anything missing or invalid falls back to the defaults). */
export function sanitizeSettings(input: Partial<Record<keyof WaterBodySettings, unknown>>, base: WaterBodySettings): WaterBodySettings {
    const num = (v: unknown, min: number, max: number, fallback: number) =>
        typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
    const color = (v: unknown, fallback: string | null) =>
        v === null ? null : typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : fallback;
    const kind = input.kind;

    return {
        name: typeof input.name === 'string' ? input.name.slice(0, 80) : base.name,
        kind: kind === null ? null : WATER_BODY_KINDS.includes(kind as WaterBodyKind) ? (kind as WaterBodyKind) : base.kind,
        wind_exposure: num(input.wind_exposure, 0, 2, base.wind_exposure),
        fetch: input.fetch === null ? null : typeof input.fetch === 'number' ? num(input.fetch, 5, 200_000, 0) : base.fetch,
        wave_height: num(input.wave_height, 0, 4, base.wave_height),
        choppiness: num(input.choppiness, 0, 2, base.choppiness),
        shallow_color: 'shallow_color' in input ? color(input.shallow_color, base.shallow_color) : base.shallow_color,
        deep_color: 'deep_color' in input ? color(input.deep_color, base.deep_color) : base.deep_color,
        clarity: input.clarity === null ? null : typeof input.clarity === 'number' ? num(input.clarity, 0.3, 40, 5) : base.clarity,
        surf: typeof input.surf === 'boolean' ? input.surf : base.surf,
    };
}

/**
 * Gives the freshly segmented bodies the ids and settings of the previous ones:
 * 1. a previous body whose seed is still wet claims the body there;
 * 2. else one whose centroid lies within a body's bounds (nearest centroid wins);
 * when several previous bodies claim one body (they merged), the largest keeps its id and settings.
 * Unclaimed bodies get new ids (wb + a number above every id used so far) and default settings.
 */
export function matchBodies(
    seg: Segmentation,
    grid: GridLike,
    previous: readonly WaterBodyRecord[],
): WaterBody[] {
    const res = grid.resolution;
    const labelAt = (x: number, z: number) => {
        const c = Math.round((x + grid.half) / grid.cell);
        const r = Math.round((z + grid.half) / grid.cell);

        return c < 0 || r < 0 || c >= res || r >= res ? 0 : seg.labels[r * res + c];
    };
    const claims = new Map<number, WaterBodyRecord[]>();
    const unclaimed: WaterBodyRecord[] = [];

    for (const p of previous) {
        const label = labelAt(p.seed[0], p.seed[1]);

        if (label > 0) {
            claims.set(label, [...(claims.get(label) ?? []), p]);
        } else {
            unclaimed.push(p);
        }
    }

    for (const p of unclaimed) {
        const [cx, cz] = p.centroid ?? p.seed;
        let best = 0;
        let bestDist = Infinity;

        seg.bodies.forEach((b, i) => {
            const label = i + 1;

            if (claims.has(label) || cx < b.bounds.x0 || cx > b.bounds.x1 || cz < b.bounds.z0 || cz > b.bounds.z1) {
                return;
            }

            const d = Math.hypot(b.centroid.x - cx, b.centroid.z - cz);

            if (d < bestDist && d < Math.max(30, Math.sqrt(b.area))) {
                bestDist = d;
                best = label;
            }
        });

        if (best > 0) {
            claims.set(best, [p]);
        }
    }

    let next = 1 + previous.reduce((m, p) => Math.max(m, Number(/^wb(\d+)$/.exec(p.id)?.[1] ?? 0)), 0);

    return seg.bodies.map((b, i) => {
        const owners = claims.get(i + 1) ?? [];
        const owner = owners.reduce<WaterBodyRecord | null>((best, p) => (!best || (p.area ?? 0) > (best.area ?? 0) ? p : best), null);
        const settings = owner ? sanitizeSettings(owner, defaultSettingsFor(b.auto_kind)) : defaultSettingsFor(b.auto_kind);
        // Keep the old seed while it is still wet in this body (stable through small edits).
        const keepSeed = owner && labelAt(owner.seed[0], owner.seed[1]) === i + 1;

        return {
            ...b,
            id: owner ? owner.id : `wb${next++}`,
            kind: settings.kind ?? b.auto_kind,
            seed: keepSeed ? { x: owner.seed[0], z: owner.seed[1] } : b.seed,
            settings,
        };
    });
}

/** Stored form of the bodies. */
export function serializeBodies(bodies: readonly WaterBody[]): WaterBodiesFile {
    const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

    return {
        version: 1,
        bodies: bodies.map((b) => ({
            id: b.id,
            seed: [round(b.seed.x), round(b.seed.z)],
            centroid: [round(b.centroid.x, 1), round(b.centroid.z, 1)],
            kind_auto: b.auto_kind,
            area: Math.round(b.area),
            level: round(b.level),
            ...b.settings,
        })),
    };
}

/** Display name: the user's, else "<Kind> <id>". */
export function bodyName(b: Pick<WaterBody, 'id' | 'kind' | 'settings'>): string {
    return b.settings.name || `${b.kind[0].toUpperCase()}${b.kind.slice(1)} ${b.id}`;
}
