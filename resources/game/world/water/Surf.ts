import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
    abs,
    clamp,
    cos,
    exp,
    float,
    floor,
    fract,
    int,
    ivec2,
    length,
    max,
    min,
    mix,
    normalize,
    pow,
    select,
    sin,
    smoothstep,
    sqrt,
    texture,
    textureLoad,
    uniform,
    vec2,
    vec3,
} from 'three/tsl';
import type { GridRect, Heightfield } from '../Heightfield';
import { causticPattern } from '../waterPatterns';
import type { WaterBody } from './bodySegmentation';
import { SHORE_REACH, ShoreField, shoreStrength } from './shoreField';
import {
    alongshore,
    BORE_FRONT,
    BREAKER,
    GRAVITY,
    MAX_SLOPE,
    MIN_SLOPE,
    surfPhase,
    surfWave,
    swash,
    UPRUSH,
} from './surfModel';
import type { SurfWaveParams } from './surfModel';
import type { WaterLayerContext, WaterSurfaceLayer } from './waterMaterial';
import { BODY_ROWS } from './WaterBodies';
import type { WaterSurfaceData } from './WaterSurfaceData';

type Float = Node<'float'>;
type Vec2 = Node<'vec2'>;
type Vec3 = Node<'vec3'>;

/** Surf effects on the beach (terrain material): wet / glossy sand, the swash sheet and its foam. */
export type ShoreEffects = {
    wet: Float;
    gloss: Float;
    sheet: Float;
    foam: Float;
};

/** Hook the terrain material calls with the shaded world position. */
export type ShoreEffectsHook = (position: Vec3) => ShoreEffects;

/** Effective surf of a body for the current wind: height (m), period (s), direction (or none). */
export function bodySurf(
    body: WaterBody,
    wind: { strength: number; x: number; z: number },
): { height: number; period: number; dirX: number; dirZ: number } {
    const s = body.settings;
    const sea = body.kind === 'sea';
    const w = Math.max(0, wind.strength) * s.wind_exposure;
    // The sea's swell comes from afar (a little more in a storm); lakes only surf in the wind.
    const factor = sea
        ? 0.75 + 0.25 * Math.min(2, w)
        : Math.min(1.5, 0.15 + 0.85 * w);
    let dirX = 0;
    let dirZ = 0;

    if (s.surf_direction !== null) {
        const a = (s.surf_direction * Math.PI) / 180;
        dirX = Math.sin(a);
        dirZ = -Math.cos(a);
    } else if (wind.strength > 0.1) {
        const len = Math.hypot(wind.x, wind.z) || 1;
        dirX = wind.x / len;
        dirZ = wind.z / len;
    }

    return {
        height: s.surf_height * factor,
        period: s.surf_period,
        dirX,
        dirZ,
    };
}

/** How much of a body's surf reaches a shore facing `dir` (travel direction there). */
export function directionWeight(
    dirX: number,
    dirZ: number,
    shoreX: number,
    shoreZ: number,
): number {
    if (dirX === 0 && dirZ === 0) {
        return 1;
    }

    const t = Math.min(1, Math.max(0, (dirX * shoreX + dirZ * shoreZ + 0.2) / 0.8));

    return 0.2 + 0.8 * t * t * (3 - 2 * t);
}

/**
 * Beach surf (docs/ROADMAP.md phase 11): the shore distance field (ShoreField) as GPU textures, the
 * per-body surf settings as a table, and from them
 *
 * - a water surface layer: shoaling wave trains along the field that grow, sharpen and break
 *   (displacement, slopes, breaking crest foam and the foam they leave behind);
 * - shore effects for the terrain: the swash sheet running up the sand and draining back, its foam
 *   edge and bubbles, sand that stays glossy and darker where it was wet (ShoreEffectsHook);
 * - CPU sampling for gameplay and the surf ambience (activity near a point).
 *
 * Surf is on where a body has surf and the shore is gentle (auto beach detection by slope), or where
 * it is painted (surf.u8: the Water tool's Surf brush, MCP paint_surf).
 */
export class Surf {
    readonly field: ShoreField;
    /** Surf strength (0-1) per data sample: body / paint / beach slope at its nearest shore. */
    readonly strength: Float32Array;
    readonly textureA: THREE.DataTexture;
    readonly textureB: THREE.DataTexture;
    readonly table: THREE.DataTexture;
    readonly u = {
        time: uniform(0),
        mapHalf: uniform(1),
        size: uniform(1),
        spacing: uniform(1),
    };
    private readonly pixelsA: Uint16Array;
    private readonly pixelsB: Float32Array;
    private readonly tableData = new Float32Array(BODY_ROWS * 4);
    /** Per table row: (height, period, dirX, dirZ) and surf flag (CPU copies). */
    private rows: { height: number; period: number; dirX: number; dirZ: number; surf: boolean }[] = [];
    private time = 0;
    private activityAt = { x: NaN, z: NaN, t: -1 };
    private activityValue = { level: 0, distance: Infinity, crash: 0 };

    constructor(
        private readonly data: WaterSurfaceData,
        surface: Heightfield,
        terrain: Heightfield,
        /** Body row → body (row 0: none). */
        private readonly bodyOfRow: (row: number) => WaterBody | null,
    ) {
        const mask = new Uint8Array(surface.resolution * surface.resolution);
        this.field = new ShoreField(data, surface, terrain, mask);
        const n = data.size;
        this.strength = new Float32Array(n * n);
        this.pixelsA = new Uint16Array(n * n * 4);
        this.pixelsB = new Float32Array(n * n * 4);
        this.textureA = new THREE.DataTexture(
            this.pixelsA,
            n,
            n,
            THREE.RGBAFormat,
            THREE.HalfFloatType,
        );
        this.textureA.minFilter = this.textureA.magFilter = THREE.LinearFilter;
        this.textureA.generateMipmaps = false;
        this.textureA.name = 'Shore distance';
        this.textureB = new THREE.DataTexture(
            this.pixelsB,
            n,
            n,
            THREE.RGBAFormat,
            THREE.FloatType,
        );
        this.textureB.minFilter = this.textureB.magFilter = THREE.NearestFilter;
        this.textureB.generateMipmaps = false;
        this.textureB.name = 'Shore level';
        this.table = new THREE.DataTexture(
            this.tableData,
            BODY_ROWS,
            1,
            THREE.RGBAFormat,
            THREE.FloatType,
        );
        this.table.minFilter = this.table.magFilter = THREE.NearestFilter;
        this.table.generateMipmaps = false;
        this.table.name = 'Surf bodies';
        this.u.mapHalf.value = surface.half;
        this.u.size.value = n;
        this.u.spacing.value = data.spacing;
    }

    /** Painted surf per full-resolution sample (surf.u8: 0 automatic, 1-255 = 0-1). */
    get mask(): Uint8Array {
        return this.field.mask;
    }

    /** Stored paint (surf.u8); ignored unless it has one byte per sample. */
    loadMask(bytes: Uint8Array | null): void {
        this.mask.fill(0);

        if (bytes && bytes.length === this.mask.length) {
            this.mask.set(bytes);
        }

        this.rebuild();
    }

    /** Water time (s, wave speed applied): call every frame. */
    setTime(time: number): void {
        this.time = time;
        this.u.time.value = time;
    }

    /** Recomputes the field around an edit (full-res grid rect; everything when absent). */
    rebuild(rect?: GridRect): void {
        const region = this.field.update(rect);
        this.refresh(region);
    }

    /** Re-derives strengths and body rows (after re-segmentation or surf settings changed). */
    refresh(region = this.field.affected()): void {
        const f = this.field;
        const n = f.size;
        const half = (v: number) => THREE.DataUtils.toHalfFloat(v);

        for (let j = region.j0; j <= region.j1; j++) {
            for (let i = region.i0; i <= region.i1; i++) {
                const k = j * n + i;
                const wet = f.wetIndex[k];
                const row = wet >= 0 ? this.data.body[wet] : 0;
                const body = row > 0 ? this.bodyOfRow(row) : null;
                const strength =
                    wet < 0
                        ? 0
                        : shoreStrength(
                              !!body?.settings.surf,
                              f.paint[k] < 0 ? null : f.paint[k],
                              f.slope[k],
                          );
                this.strength[k] = strength;
                this.pixelsA[k * 4] = half(f.dist[k]);
                this.pixelsA[k * 4 + 1] = half(f.dirX[k]);
                this.pixelsA[k * 4 + 2] = half(f.dirZ[k]);
                this.pixelsA[k * 4 + 3] = half(strength);
                this.pixelsB[k * 4] = f.level[k];
                this.pixelsB[k * 4 + 1] = f.slope[k];
                this.pixelsB[k * 4 + 2] = row;
                this.pixelsB[k * 4 + 3] = 0;
            }
        }

        this.textureA.needsUpdate = true;
        this.textureB.needsUpdate = true;
    }

    /** Per-body surf for the current wind (body rows as in the water body table). */
    writeTable(
        bodies: readonly WaterBody[],
        wind: { strength: number; x: number; z: number },
    ): void {
        this.tableData.fill(0);
        this.rows = [];
        bodies.slice(0, BODY_ROWS - 1).forEach((b, i) => {
            const s = bodySurf(b, wind);
            this.rows[i + 1] = { ...s, surf: b.settings.surf };
            this.tableData.set(
                [s.height, s.period, s.dirX, s.dirZ],
                (i + 1) * 4,
            );
        });
        this.table.needsUpdate = true;
    }

    /** Fraction of the shoreline samples (|dist| < one sample) with surf, e.g. for agents. */
    describe(): { surf_shore_m: number; painted_samples: number } {
        const f = this.field;
        let shore = 0;

        for (let k = 0; k < f.dist.length; k++) {
            if (f.dist[k] > 0 && f.dist[k] <= f.spacing && this.strength[k] > 0.05) {
                shore++;
            }
        }

        let painted = 0;

        for (const v of this.mask) {
            if (v) {
                painted++;
            }
        }

        return {
            surf_shore_m: Math.round(shore * f.spacing),
            painted_samples: painted,
        };
    }

    // ------------------------------------------------------------------ CPU sampling

    /** Field values at a world position (bilinear distance / direction / strength; nearest rest). */
    shoreAt(x: number, z: number) {
        const f = this.field;
        const n = f.size;
        const half = this.u.mapHalf.value;

        if (Math.abs(x) >= half || Math.abs(z) >= half) {
            return null;
        }

        const gx = Math.min(n - 1.0001, Math.max(0, (x + half) / f.spacing));
        const gz = Math.min(n - 1.0001, Math.max(0, (z + half) / f.spacing));
        const i = Math.floor(gx);
        const j = Math.floor(gz);
        const fx = gx - i;
        const fz = gz - j;
        const bil = (a: Float32Array) =>
            (a[j * n + i] * (1 - fx) + a[j * n + i + 1] * fx) * (1 - fz) +
            (a[(j + 1) * n + i] * (1 - fx) + a[(j + 1) * n + i + 1] * fx) * fz;
        const k = Math.round(gz) * n + Math.round(gx);
        const dx = bil(f.dirX);
        const dz = bil(f.dirZ);
        const len = Math.hypot(dx, dz) || 1;
        const row = Math.round(this.pixelsB[k * 4 + 2]);
        const params = this.rows[row];

        if (!params) {
            return null;
        }

        const dirX = dx / len;
        const dirZ = dz / len;

        return {
            dist: bil(f.dist),
            dirX,
            dirZ,
            strength:
                bil(this.strength) *
                directionWeight(params.dirX, params.dirZ, dirX, dirZ),
            level: f.level[k],
            slope: f.slope[k],
            params,
        };
    }

    /** Surface layer, CPU side (gameplay): adds the surf's height, slope and orbital velocity. */
    sample(
        x: number,
        z: number,
        out: {
            height: number;
            slopeX: number;
            slopeZ: number;
            velocity: THREE.Vector3;
        },
        depth: number,
    ): void {
        const s = this.shoreAt(x, z);

        if (!s || s.strength <= 0.001 || s.dist <= 0) {
            return;
        }

        const p: SurfWaveParams = {
            height: s.params.height * s.strength,
            period: Math.max(1, s.params.period),
            slope: s.slope,
        };
        const w = surfWave(s.dist, depth, this.time, alongshore(x, z), p, SHORE_REACH);
        out.height += w.eta;
        // The distance shrinks along the travel direction.
        out.slopeX -= w.detaDd * s.dirX;
        out.slopeZ -= w.detaDd * s.dirZ;
        const h = Math.max(0.1, Math.min(depth, s.dist * s.slope));
        const speed = (Math.sqrt(GRAVITY * h) * w.eta) / h;
        out.velocity.x += s.dirX * speed * 0.9;
        out.velocity.z += s.dirZ * speed * 0.9;
    }

    /**
     * Surf heard from (x, z): loudness (0-1) by the strength and height of the surf on the shores
     * within ~120 m and their distance, the nearest such shore, and a crash pulse (0-1) while its
     * waves break. Rescanned at most every 0.25 s or 4 m.
     */
    activity(x: number, z: number): { level: number; distance: number; crash: number } {
        const a = this.activityAt;

        if (
            Math.abs(this.time - a.t) < 0.25 &&
            Math.hypot(x - a.x, z - a.z) < 4
        ) {
            return this.activityValue;
        }

        a.x = x;
        a.z = z;
        a.t = this.time;
        const f = this.field;
        const n = f.size;
        const half = this.u.mapHalf.value;
        const radius = 120;
        const stride = Math.max(1, Math.round(4 / f.spacing));
        const ci = Math.round((x + half) / f.spacing);
        const cj = Math.round((z + half) / f.spacing);
        const r = Math.ceil(radius / f.spacing);
        let level = 0;
        let nearest = Infinity;
        let nearestK = -1;

        for (let j = Math.max(0, cj - r); j <= Math.min(n - 1, cj + r); j += stride) {
            for (let i = Math.max(0, ci - r); i <= Math.min(n - 1, ci + r); i += stride) {
                const k = j * n + i;
                const d = f.dist[k];

                if (d <= 0 || d > 6 || this.strength[k] < 0.05) {
                    continue;
                }

                const row = Math.round(this.pixelsB[k * 4 + 2]);
                const params = this.rows[row];

                if (!params) {
                    continue;
                }

                const dist = Math.hypot(i * f.spacing - half - x, j * f.spacing - half - z);

                if (dist > radius) {
                    continue;
                }

                const loud =
                    this.strength[k] *
                    Math.min(1.5, params.height) *
                    stride *
                    f.spacing *
                    0.02;
                level += loud / (1 + (dist / 18) ** 2);

                if (dist < nearest) {
                    nearest = dist;
                    nearestK = k;
                }
            }
        }

        let crash = 0;

        if (nearestK >= 0) {
            const i = nearestK % n;
            const j = (nearestK - i) / n;
            const sx = i * f.spacing - half;
            const sz = j * f.spacing - half;
            const params = this.rows[Math.round(this.pixelsB[nearestK * 4 + 2])];
            const u = surfPhase(0, this.time, alongshore(sx, sz), {
                height: params.height,
                period: Math.max(1, params.period),
                slope: f.slope[nearestK],
            });
            // The bore reaches the shore at phase 0: the crash builds just before and fades after.
            const t = u > 0.8 ? (u - 0.8) / 0.2 : Math.max(0, 1 - u / 0.35);
            crash = t * t;
        }

        this.activityValue = {
            level: Math.min(1, level),
            distance: nearest,
            crash,
        };

        return this.activityValue;
    }

    // ------------------------------------------------------------------ GPU

    /** Shore field and body surf at a world position (nodes). */
    private shoreNodes(xz: Vec2) {
        const u = this.u;
        const g = xz.add(u.mapHalf).div(u.spacing);
        const inside = max(abs(xz.x), abs(xz.y)).lessThan(u.mapHalf);
        const a = texture(this.textureA, g.add(0.5).div(u.size)).level(float(0));
        const gi = clamp(floor(g.add(0.5)), 0, u.size.sub(1));
        const b = textureLoad(this.textureB, ivec2(int(gi.x), int(gi.y)));
        const t = textureLoad(this.table, ivec2(int(b.z), int(0)));
        const dir = normalize(vec2(a.y, a.z).add(vec2(1e-5, 0))) as Vec2;
        const facing = smoothstep(-0.2, 0.6, t.z.mul(dir.x).add(t.w.mul(dir.y)));
        const dirWeight = select(
            length(vec2(t.z, t.w)).greaterThan(0.5),
            facing.mul(0.8).add(0.2),
            float(1),
        );
        const strength = select(inside, a.w.mul(dirWeight), float(0));

        return {
            dist: a.x as Float,
            dir,
            strength,
            level: b.x as Float,
            slope: clamp(b.y, MIN_SLOPE, MAX_SLOPE) as Float,
            height: (t.x as Float).mul(strength),
            period: max(t.y, 1) as Float,
        };
    }

    private static alongNode(xz: Vec2): Float {
        return sin(xz.x.mul(0.037).add(sin(xz.y.mul(0.021)).mul(1.7)))
            .mul(0.5)
            .add(
                sin(
                    xz.y
                        .mul(0.031)
                        .sub(xz.x.mul(0.019))
                        .add(sin(xz.x.mul(0.013)).mul(2.3)),
                ).mul(0.5),
            );
    }

    /** The shoaling wave at distance `dd` (see surfWave). */
    private waveNodes(
        sh: ReturnType<Surf['shoreNodes']>,
        dd: Float,
        depth: Float,
        along: Float,
    ) {
        const time = this.u.time;
        const m = sh.slope;
        const c0 = sh.period.mul(GRAVITY / (2 * Math.PI));
        const sStar = c0.mul(c0).div(m.mul(GRAVITY));
        const d = max(dd, 0);
        const tau = select(
            d.lessThan(sStar),
            sqrt(d.div(m.mul(GRAVITY))).mul(2),
            c0.mul(2).div(m.mul(GRAVITY)).add(d.sub(sStar).div(c0)),
        );
        const u = fract(
            time.add(tau).div(sh.period).add(along.mul(0.12)),
        );
        const h = clamp(min(depth, d.mul(m)), 0.02, 1e4);
        const ks = clamp(pow(c0.mul(c0).div(GRAVITY).div(h), 0.25), 1, 2.2);
        const group = sin(
            time
                .add(tau)
                .mul((2 * Math.PI) / 6.3)
                .div(sh.period)
                .add(along.mul(4)),
        )
            .mul(0.28)
            .add(0.72);
        const h0 = sh.height
            .mul(group)
            .mul(smoothstep(SHORE_REACH, SHORE_REACH * 0.6, d));
        const hu = h0.mul(ks);
        const ratio = hu.div(h.mul(BREAKER));
        const breaking = smoothstep(0.8, 1.05, ratio);
        const height = min(hu, h.mul(BREAKER));
        const pw = smoothstep(0.3, 1, ratio).mul(2).add(1);
        const peak = pow(
            max(cos(u.mul(Math.PI * 2)).mul(0.5).add(0.5), 1e-4),
            pw,
        ).sub(float(0.5).div(pow(pw, 0.6)));
        const bore = select(
            u.lessThan(1 - BORE_FRONT),
            float(1).sub(u.div(1 - BORE_FRONT)),
            u.sub(1 - BORE_FRONT).div(BORE_FRONT),
        ).sub(0.5);

        return {
            eta: height.mul(mix(peak, bore, breaking)),
            u,
            height,
            breaking,
            ratio,
        };
    }

    /** Bubbly foam lace (0-1). */
    private laceNode(xz: Vec2, dir: Vec2): Float {
        const t = this.u.time;
        const a = causticPattern(
            xz.mul(0.31).add(dir.mul(t.mul(0.05))),
            t.mul(0.3),
        );
        const b = causticPattern(xz.mul(0.83).sub(dir.mul(t.mul(0.08))), t.mul(0.45).add(3.1));

        return clamp(max(a, b.mul(0.8)).mul(1.8), 0, 1);
    }

    /** The water surface layer (shoaling, breaking surf). */
    layer(): WaterSurfaceLayer {
        const wave = (ctx: WaterLayerContext, offset: number) => {
            const sh = this.shoreNodes(ctx.xz);
            const along = Surf.alongNode(ctx.xz);

            return {
                sh,
                w: this.waveNodes(sh, sh.dist.add(offset), ctx.depth, along),
            };
        };

        return {
            name: 'surf',
            displacement: (ctx) => {
                const { sh, w } = wave(ctx, 0);

                return vec3(0, select(sh.dist.greaterThan(0), w.eta, float(0)), 0);
            },
            slope: (ctx) => {
                const delta = 0.3;
                const a = wave(ctx, delta);
                const b = wave(ctx, -delta);
                const deta = a.w.eta.sub(b.w.eta).div(delta * 2);

                return a.sh.dir.mul(deta.negate()).mul(
                    select(a.sh.dist.greaterThan(0), float(1), float(0)),
                );
            },
            foam: (ctx) => {
                const { sh, w } = wave(ctx, 0);
                const lace = this.laceNode(ctx.xz, sh.dir);
                const crest = max(
                    smoothstep(1 - BORE_FRONT * 2, 1 - BORE_FRONT * 0.5, w.u),
                    smoothstep(0.1, 0.02, w.u),
                );
                const trail = exp(w.u.mul(-3.2));
                const zone = smoothstep(0.5, 1, w.ratio);

                return clamp(
                    w.breaking
                        .mul(crest.mul(0.95).add(trail.mul(lace).mul(0.75)))
                        .add(zone.mul(lace).mul(0.18)),
                    0,
                    1,
                )
                    .mul(smoothstep(0.03, 0.15, w.height))
                    .mul(select(sh.dist.greaterThan(0), float(1), float(0)));
            },
        };
    }

    /** Swash, wet sand and its foam on the terrain (the terrain material's shore effects). */
    readonly terrainHook: ShoreEffectsHook = (position) => {
        const xz = position.xz;
        const sh = this.shoreNodes(xz);
        const along = Surf.alongNode(xz);
        const time = this.u.time;
        const hz = position.y.sub(sh.level);
        const m = sh.slope;
        const c0 = sh.period.mul(GRAVITY / (2 * Math.PI));
        const l0 = c0.mul(sh.period);
        const group = sin(
            time.mul((2 * Math.PI) / 6.3).div(sh.period).add(along.mul(4)),
        )
            .mul(0.28)
            .add(0.72);
        const h0 = sh.height.mul(group);
        const xi = m.div(sqrt(max(h0, 0.01).div(l0)));
        const factor = clamp(xi.mul(0.75).add(0.25), 0.3, 1.4);
        const runup = h0.mul(factor);
        const typical = sh.height.mul(factor);
        const u = fract(time.div(sh.period).add(along.mul(0.12)));
        const r = select(
            u.lessThan(UPRUSH),
            float(1).sub(pow(float(1).sub(u.div(UPRUSH)), 2)),
            float(1).sub(u.sub(UPRUSH).div(1 - UPRUSH)),
        );
        const reach = runup.mul(r).sub(runup.mul(0.05));
        const film = reach.sub(hz);
        // Only near the shoreline (and nothing where there is no surf).
        const near = smoothstep(-45, -25, sh.dist)
            .mul(smoothstep(0.001, 0.02, sh.strength))
            .mul(smoothstep(4, 1, sh.dist));
        const sheet = smoothstep(0, 0.012, film).mul(near);
        const uprush = select(u.lessThan(UPRUSH), float(1), float(0.45));
        const edge = smoothstep(-0.004, 0.006, film)
            .mul(smoothstep(0.035, 0.006, film))
            .mul(uprush);
        const lace = this.laceNode(xz, sh.dir);
        const bubbles = sheet.mul(lace).mul(smoothstep(0.65, 0, u)).mul(0.75);
        const foam = max(edge.mul(0.85).mul(near), bubbles).mul(
            smoothstep(0.02, 0.08, runup),
        );
        // Time since the backwash uncovered this height: glossy, then just damp.
        const below = hz.add(runup.mul(0.05)).div(max(runup, 1e-3));
        const uncovered = float(UPRUSH).add(
            float(1 - UPRUSH).mul(float(1).sub(below)),
        );
        const since = fract(u.sub(uncovered)).mul(sh.period);
        const reached = smoothstep(1.02, 0.95, below);
        const gloss = max(
            select(film.greaterThan(0), float(1), exp(since.negate().div(sh.period.mul(0.4)))).mul(reached),
            sheet,
        ).mul(near);
        const damp = smoothstep(typical.mul(1.5), typical.mul(0.2), hz)
            .mul(0.7)
            .mul(near);
        const wet = max(damp, gloss);

        return { wet, gloss, sheet, foam };
    };

    /** Surf params at a position for the CPU (for tests / agents). */
    surfParamsAt(x: number, z: number): SurfWaveParams | null {
        const s = this.shoreAt(x, z);

        return s
            ? {
                  height: s.params.height * s.strength,
                  period: s.params.period,
                  slope: s.slope,
              }
            : null;
    }

    /** CPU swash at a shore position (agents / tests). */
    swashAt(x: number, z: number) {
        const p = this.surfParamsAt(x, z);

        return p && p.height > 0 ? swash(this.time, alongshore(x, z), p) : null;
    }

    dispose(): void {
        this.textureA.dispose();
        this.textureB.dispose();
        this.table.dispose();
    }
}
