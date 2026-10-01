/// <reference lib="webworker" />
/**
 * Bounce light worker: computes the irradiance probes (see bounceShared.ts) off the main thread.
 *
 * 1. Lighting: every scene cell's surface and canopy radiance for a unit sun and a unit sky. The sun
 *    visibility is a ray marched towards the sun / moon through terrain, props and canopies (light
 *    passes canopies with Beer-Lambert extinction); the sky visibility is a dozen rays over the upper
 *    hemisphere (on a grid half as fine).
 * 2. Probes: from each probe, a fixed set of rays over the sphere marches through a mip pyramid of the
 *    scene (coarser cells as the steps grow, out to 600 m). A ray that hits the ground, water or a
 *    prop picks up that cell's radiance; inside a canopy it picks up the leaves' radiance (their light
 *    fades with depth into the canopy) and loses transmittance. Upward rays that escape count towards
 *    the sky visibility.
 *
 * Probes are processed in tiles, nearest to the camera first, and posted back in batches. A new scene
 * (after an edit) is diffed against the last one: only tiles near cells whose geometry or lighting
 * changed are recomputed. A new light direction recomputes everything.
 */
import {
    PROBE_HEIGHTS,
    PROBE_LAYERS,
    TILE,
    toHalf,
} from './bounceShared';
import type {
    BounceRequest,
    BounceResponse,
    BounceScene,
    BounceTile,
} from './bounceShared';

declare const self: DedicatedWorkerGlobalScope;

/** Rays end after this distance (m). */
const MAX_DISTANCE = 600;
/** Cells closer than this to a change get their probes recomputed (m). */
const INFLUENCE = 56;
/** Weight of the sky part when finding the dominant bounce direction. */
const SKY_WEIGHT = 0.35;
/** Rays used for the sky visibility of scene cells. */
const SKY_RAYS = 12;

type Level = {
    n: number;
    cell: number;
    surf: Float32Array;
    /** Radiance per unit sun / sky irradiance (rgb). */
    ls: Float32Array;
    lk: Float32Array;
    bottom: Float32Array;
    top: Float32Array;
    sigma: Float32Array;
    /** Leaf radiance at the canopy top per unit sun / sky (rgb). */
    cs: Float32Array;
    ck: Float32Array;
};

let scene: BounceScene | null = null;
let res = 0;
let rays: Float32Array = new Float32Array(0);
let rayCount = 0;
let light: [number, number, number] = [0, 1, 0];
let levels: Level[] = [];
let maxTop = 0;
let half = 0;
let probeBase: Float32Array = new Float32Array(0);
let dirty: Uint8Array = new Uint8Array(0);
let tilesPerSide = 0;
let focus = { x: 0, z: 0 };
let paused = false;
let running = false;
/** Bumped by every message that changes what is being computed (a running pass restarts). */
let generation = 0;
let passStart = 0;
let passWork = 0;

self.onmessage = (event: MessageEvent<BounceRequest>) => {
    const msg = event.data;

    switch (msg.op) {
        case 'scene':
            setScene(msg.scene, msg.res, msg.rays, msg.light);
            break;
        case 'light':
            light = msg.light;

            if (scene) {
                generation++;
                const t0 = performance.now();
                relight();
                passWork += performance.now() - t0;
                dirty.fill(1);
            }

            break;
        case 'focus':
            focus = { x: msg.x, z: msg.z };

            return;
        case 'pause':
            paused = msg.paused;
            break;
    }

    void run();
};

function post(msg: BounceResponse, transfer: Transferable[] = []): void {
    self.postMessage(msg, transfer);
}

function setScene(
    next: BounceScene,
    nextRes: number,
    nextRays: number,
    nextLight: [number, number, number],
): void {
    generation++;
    const t0 = performance.now();
    const prev = scene;
    const prevLevel = levels[0];
    const same =
        !!prev &&
        prev.n === next.n &&
        prev.size === next.size &&
        res === nextRes &&
        rayCount === nextRays &&
        light.every((v, i) => Math.abs(v - nextLight[i]) < 1e-4);

    scene = next;
    res = nextRes;
    light = nextLight;
    half = next.size / 2;

    if (rayCount !== nextRays) {
        rayCount = nextRays;
        rays = sphereDirections(nextRays);
    }

    tilesPerSide = Math.ceil(res / TILE);

    if (dirty.length !== tilesPerSide * tilesPerSide) {
        dirty = new Uint8Array(tilesPerSide * tilesPerSide);
    }

    buildLevels();
    relight();
    computeProbeBase();

    if (same && prev && prevLevel) {
        markChanges(prev, prevLevel);
    } else {
        dirty.fill(1);
    }

    passWork += performance.now() - t0;
}

// ------------------------------------------------------------------ scene pyramid

function buildLevels(): void {
    const s = scene!;
    const n = s.n;
    const cell = s.size / n;
    const base: Level = {
        n,
        cell,
        surf: s.surf,
        ls: new Float32Array(n * n * 3),
        lk: new Float32Array(n * n * 3),
        bottom: s.canopyBottom,
        top: s.canopyTop,
        sigma: s.canopySigma,
        cs: new Float32Array(n * n * 3),
        ck: new Float32Array(n * n * 3),
    };
    levels = [base];
    maxTop = -Infinity;

    for (let i = 0; i < n * n; i++) {
        maxTop = Math.max(
            maxTop,
            s.surf[i],
            s.canopySigma[i] > 0 ? s.canopyTop[i] : -Infinity,
        );
    }

    let prev = base;

    while (prev.n > 4) {
        const m = Math.ceil(prev.n / 2);
        const next: Level = {
            n: m,
            cell: prev.cell * 2,
            surf: new Float32Array(m * m),
            ls: new Float32Array(m * m * 3),
            lk: new Float32Array(m * m * 3),
            bottom: new Float32Array(m * m),
            top: new Float32Array(m * m),
            sigma: new Float32Array(m * m),
            cs: new Float32Array(m * m * 3),
            ck: new Float32Array(m * m * 3),
        };
        downsampleGeometry(prev, next);
        levels.push(next);
        prev = next;
    }
}

/** 2×2 averages: heights, canopy extent (weighted by density) and density. */
function downsampleGeometry(src: Level, dst: Level): void {
    const n = src.n;

    for (let z = 0; z < dst.n; z++) {
        for (let x = 0; x < dst.n; x++) {
            let surf = 0;
            let count = 0;
            let sigma = 0;
            let bottom = 0;
            let top = 0;

            for (let dz = 0; dz < 2; dz++) {
                for (let dx = 0; dx < 2; dx++) {
                    const sx = Math.min(n - 1, x * 2 + dx);
                    const sz = Math.min(n - 1, z * 2 + dz);
                    const k = sz * n + sx;
                    surf += src.surf[k];
                    count++;
                    const s = src.sigma[k];

                    if (s > 0) {
                        sigma += s;
                        bottom += src.bottom[k] * s;
                        top += src.top[k] * s;
                    }
                }
            }

            const k = z * dst.n + x;
            dst.surf[k] = surf / count;
            dst.sigma[k] = sigma / count;
            dst.bottom[k] = sigma > 0 ? bottom / sigma : Infinity;
            dst.top[k] = sigma > 0 ? top / sigma : -Infinity;
        }
    }
}

/** 2×2 averages of the radiance (canopy radiance weighted by density). */
function downsampleLight(src: Level, dst: Level): void {
    const n = src.n;

    for (let z = 0; z < dst.n; z++) {
        for (let x = 0; x < dst.n; x++) {
            const k = z * dst.n + x;
            let count = 0;
            let sigma = 0;

            for (let c = 0; c < 3; c++) {
                dst.ls[k * 3 + c] = 0;
                dst.lk[k * 3 + c] = 0;
                dst.cs[k * 3 + c] = 0;
                dst.ck[k * 3 + c] = 0;
            }

            for (let dz = 0; dz < 2; dz++) {
                for (let dx = 0; dx < 2; dx++) {
                    const sx = Math.min(n - 1, x * 2 + dx);
                    const sz = Math.min(n - 1, z * 2 + dz);
                    const j = sz * n + sx;
                    const s = src.sigma[j];
                    count++;
                    sigma += s;

                    for (let c = 0; c < 3; c++) {
                        dst.ls[k * 3 + c] += src.ls[j * 3 + c];
                        dst.lk[k * 3 + c] += src.lk[j * 3 + c];
                        dst.cs[k * 3 + c] += src.cs[j * 3 + c] * s;
                        dst.ck[k * 3 + c] += src.ck[j * 3 + c] * s;
                    }
                }
            }

            for (let c = 0; c < 3; c++) {
                dst.ls[k * 3 + c] /= count;
                dst.lk[k * 3 + c] /= count;
                dst.cs[k * 3 + c] = sigma > 0 ? dst.cs[k * 3 + c] / sigma : 0;
                dst.ck[k * 3 + c] = sigma > 0 ? dst.ck[k * 3 + c] / sigma : 0;
            }
        }
    }
}

// ------------------------------------------------------------------ ray marching

/** Results of the last march: transmittance left at the end and radiance picked up (sun, sky). */
let mT = 1;
let mHit = false;
const mS = new Float32Array(3);
const mK = new Float32Array(3);

/**
 * Marches from p along the unit direction d through the scene pyramid. `radiance` also gathers
 * what the ray hits; `minLevel` starts on a coarser level (cheap visibility rays).
 */
function march(
    px: number,
    py: number,
    pz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDist: number,
    radiance: boolean,
    minLevel = 0,
): void {
    mT = 1;
    mHit = false;
    mS[0] = mS[1] = mS[2] = 0;
    mK[0] = mK[1] = mK[2] = 0;
    const c0 = levels[0].cell;
    const lastLevel = levels.length - 1;
    let level = Math.min(minLevel, lastLevel);
    let t = c0 * 0.3;

    while (t < maxDist) {
        const step = Math.max(c0 * 0.5, t * 0.22);

        while (
            level < lastLevel &&
            step >= levels[level + 1].cell * 0.75
        ) {
            level++;
        }

        const tm = t + step * 0.5;
        const qy = py + dy * tm;

        if (dy > 0 && qy > maxTop) {
            break;
        }

        const L = levels[level];
        const n = L.n;
        let ix = Math.floor((px + dx * tm + half) / L.cell);
        let iz = Math.floor((pz + dz * tm + half) / L.cell);
        ix = ix < 0 ? 0 : ix >= n ? n - 1 : ix;
        iz = iz < 0 ? 0 : iz >= n ? n - 1 : iz;
        const k = iz * n + ix;

        if (qy < L.surf[k]) {
            if (radiance) {
                const k3 = k * 3;
                mS[0] += mT * L.ls[k3];
                mS[1] += mT * L.ls[k3 + 1];
                mS[2] += mT * L.ls[k3 + 2];
                mK[0] += mT * L.lk[k3];
                mK[1] += mT * L.lk[k3 + 1];
                mK[2] += mT * L.lk[k3 + 2];
            }

            mT = 0;
            mHit = true;

            return;
        }

        const sigma = L.sigma[k];

        if (sigma > 0 && qy > L.bottom[k] && qy < L.top[k]) {
            const a = 1 - Math.exp(-sigma * step);

            if (radiance) {
                // Leaves deeper in the canopy get less of the light from above.
                const w = mT * a * Math.exp(-sigma * 1.2 * (L.top[k] - qy));
                const k3 = k * 3;
                mS[0] += w * L.cs[k3];
                mS[1] += w * L.cs[k3 + 1];
                mS[2] += w * L.cs[k3 + 2];
                mK[0] += w * L.ck[k3];
                mK[1] += w * L.ck[k3 + 1];
                mK[2] += w * L.ck[k3 + 2];
            }

            mT *= 1 - a;

            if (mT < 0.01) {
                mT = 0;

                return;
            }
        }

        t += step;
    }
}

/** `count` roughly uniform directions over the sphere (Fibonacci), xyz interleaved. */
function sphereDirections(count: number): Float32Array {
    const out = new Float32Array(count * 3);
    const golden = Math.PI * (3 - Math.sqrt(5));

    for (let i = 0; i < count; i++) {
        const y = 1 - ((i + 0.5) / count) * 2;
        const r = Math.sqrt(1 - y * y);
        const a = i * golden;
        out[i * 3] = Math.cos(a) * r;
        out[i * 3 + 1] = y;
        out[i * 3 + 2] = Math.sin(a) * r;
    }

    return out;
}

/** Cosine-distributed directions over the upper hemisphere (sky visibility of scene cells). */
const skyDirs = (() => {
    const out = new Float32Array(SKY_RAYS * 3);
    const golden = Math.PI * (3 - Math.sqrt(5));

    for (let i = 0; i < SKY_RAYS; i++) {
        const u = (i + 0.5) / SKY_RAYS;
        const r = Math.sqrt(u);
        const a = i * golden;
        out[i * 3] = Math.cos(a) * r;
        out[i * 3 + 1] = Math.sqrt(1 - u);
        out[i * 3 + 2] = Math.sin(a) * r;
    }

    return out;
})();

function skyVisibility(x: number, y: number, z: number): number {
    let sum = 0;

    for (let r = 0; r < SKY_RAYS; r++) {
        march(
            x,
            y,
            z,
            skyDirs[r * 3],
            skyDirs[r * 3 + 1],
            skyDirs[r * 3 + 2],
            MAX_DISTANCE * 0.5,
            false,
            1,
        );
        sum += mT;
    }

    return sum / SKY_RAYS;
}

// ------------------------------------------------------------------ lighting

/** Surface and canopy radiance of every cell for the current light direction. */
function relight(): void {
    const s = scene!;
    const L0 = levels[0];
    const n = L0.n;
    const cell = L0.cell;
    const [lx, ly, lz] = light;
    const sunUp = ly > 0.01;
    // Sky visibility on the next coarser level (cosine rays are the expensive part).
    const L1 = levels[1] ?? L0;
    const m = L1.n;
    const skySurf = new Float32Array(m * m);
    const skyTop = new Float32Array(m * m);
    const ratio = n / m;

    for (let z = 0; z < m; z++) {
        for (let x = 0; x < m; x++) {
            const k = z * m + x;
            const wx = -half + (x + 0.5) * L1.cell;
            const wz = -half + (z + 0.5) * L1.cell;
            // Lowest surface of the children (the ground under the trees, not the props).
            let low = Infinity;
            let top = -Infinity;

            for (let dz = 0; dz < ratio; dz++) {
                for (let dx = 0; dx < ratio; dx++) {
                    const j =
                        Math.min(n - 1, z * ratio + dz) * n +
                        Math.min(n - 1, x * ratio + dx);
                    low = Math.min(low, L0.surf[j]);

                    if (L0.sigma[j] > 0) {
                        top = Math.max(top, L0.top[j]);
                    }
                }
            }

            skySurf[k] = skyVisibility(wx, low + 0.3, wz);
            skyTop[k] = top > -Infinity ? skyVisibility(wx, top + 0.5, wz) : 1;
        }
    }

    const inv = 1 / Math.PI;

    for (let z = 0; z < n; z++) {
        for (let x = 0; x < n; x++) {
            const k = z * n + x;
            const k3 = k * 3;
            const wx = -half + (x + 0.5) * cell;
            const wz = -half + (z + 0.5) * cell;
            const p = Math.min(m - 1, Math.floor(z / ratio)) * m +
                Math.min(m - 1, Math.floor(x / ratio));
            // Surface normal: terrain slope where the ground is the surface, up on water and props.
            let nx = 0;
            let ny = 1;
            let nz = 0;

            if (s.surf[k] <= s.ground[k] + 0.05) {
                const g = s.ground;
                const xl = g[z * n + Math.max(0, x - 1)];
                const xr = g[z * n + Math.min(n - 1, x + 1)];
                const zd = g[Math.max(0, z - 1) * n + x];
                const zu = g[Math.min(n - 1, z + 1) * n + x];
                nx = (xl - xr) / (2 * cell);
                nz = (zd - zu) / (2 * cell);
                const len = Math.hypot(nx, 1, nz);
                nx /= len;
                ny = 1 / len;
                nz /= len;
            }

            let sun = 0;
            const cos = nx * lx + ny * ly + nz * lz;

            if (sunUp && cos > 0) {
                march(wx, s.surf[k] + 0.3, wz, lx, ly, lz, MAX_DISTANCE, false);
                sun = mT * cos;
            }

            const sky = skySurf[p] * (0.5 + 0.5 * ny);

            for (let c = 0; c < 3; c++) {
                const albedo = s.albedo[k3 + c] * inv;
                L0.ls[k3 + c] = albedo * sun;
                L0.lk[k3 + c] = albedo * sky;
            }

            if (L0.sigma[k] > 0) {
                let sunTop = 0;

                if (sunUp) {
                    // Start above the own crown: other crowns and the terrain shade it.
                    march(
                        wx + lx * cell,
                        L0.top[k] + ly * cell,
                        wz + lz * cell,
                        lx,
                        ly,
                        lz,
                        MAX_DISTANCE,
                        false,
                    );
                    // Leaves face every way: about half the light, plus what shines through them.
                    sunTop = mT * 0.6 * Math.max(0, ly) ** 0.35;
                }

                for (let c = 0; c < 3; c++) {
                    const albedo = s.canopyAlbedo[k3 + c] * inv;
                    L0.cs[k3 + c] = albedo * sunTop;
                    L0.ck[k3 + c] = albedo * skyTop[p] * 0.6;
                }
            } else {
                for (let c = 0; c < 3; c++) {
                    L0.cs[k3 + c] = 0;
                    L0.ck[k3 + c] = 0;
                }
            }
        }
    }

    for (let i = 1; i < levels.length; i++) {
        downsampleLight(levels[i - 1], levels[i]);
    }
}

// ------------------------------------------------------------------ probes

function computeProbeBase(): void {
    const s = scene!;
    const n = s.n;
    const ratio = n / res;
    probeBase = new Float32Array(res * res);
    let min = Infinity;

    for (let z = 0; z < res; z++) {
        for (let x = 0; x < res; x++) {
            let sum = 0;
            let count = 0;

            for (let dz = 0; dz < ratio; dz++) {
                for (let dx = 0; dx < ratio; dx++) {
                    const sx = Math.min(n - 1, Math.floor(x * ratio + dx));
                    const sz = Math.min(n - 1, Math.floor(z * ratio + dz));
                    sum += s.base[sz * n + sx];
                    count++;
                }
            }

            const v = sum / count;
            probeBase[z * res + x] = v;
            min = Math.min(min, v);
        }
    }

    const heights = new Uint16Array(res * res);

    for (let i = 0; i < res * res; i++) {
        heights[i] = toHalf(probeBase[i] - min);
    }

    post({ op: 'base', heights, min, res }, [heights.buffer]);
}

/** Marks the tiles near cells whose geometry or radiance changed. */
function markChanges(prev: BounceScene, prevLevel: Level): void {
    const s = scene!;
    const n = s.n;
    const L0 = levels[0];
    const probeCell = s.size / res;
    const reach = Math.ceil(INFLUENCE / probeCell);
    const changed = new Uint8Array(res * res);
    const ratio = n / res;
    let any = false;

    // NaN (∞ - ∞: no canopy in either) compares false.
    const differs = (
        a: Float32Array,
        b: Float32Array,
        i: number,
        eps: number,
    ) => {
        const d = a[i] - b[i];

        return d > eps || d < -eps;
    };

    for (let i = 0; i < n * n; i++) {
        let diff =
            differs(s.surf, prev.surf, i, 0.05) ||
            differs(s.canopySigma, prev.canopySigma, i, 1e-3) ||
            differs(s.canopyTop, prev.canopyTop, i, 0.1);

        for (let c = 0; !diff && c < 3; c++) {
            diff =
                differs(L0.ls, prevLevel.ls, i * 3 + c, 1e-3) ||
                differs(L0.lk, prevLevel.lk, i * 3 + c, 1e-3) ||
                differs(L0.cs, prevLevel.cs, i * 3 + c, 1e-3);
        }

        if (diff) {
            const x = Math.floor((i % n) / ratio);
            const z = Math.floor(Math.floor(i / n) / ratio);
            changed[z * res + x] = 1;
            any = true;
        }
    }

    if (!any) {
        return;
    }

    for (let z = 0; z < res; z++) {
        for (let x = 0; x < res; x++) {
            if (!changed[z * res + x]) {
                continue;
            }

            const t0x = Math.max(0, Math.floor((x - reach) / TILE));
            const t1x = Math.min(tilesPerSide - 1, Math.floor((x + reach) / TILE));
            const t0z = Math.max(0, Math.floor((z - reach) / TILE));
            const t1z = Math.min(tilesPerSide - 1, Math.floor((z + reach) / TILE));

            for (let tz = t0z; tz <= t1z; tz++) {
                for (let tx = t0x; tx <= t1x; tx++) {
                    dirty[tz * tilesPerSide + tx] = 1;
                }
            }
        }
    }
}

function computeTile(tx: number, tz: number): BounceTile {
    const s = scene!;
    const n = s.n;
    const probeCell = s.size / res;
    const x0 = tx * TILE;
    const z0 = tz * TILE;
    const w = Math.min(TILE, res - x0);
    const h = Math.min(TILE, res - z0);
    const count = PROBE_LAYERS * w * h * 4;
    const a = new Uint16Array(count);
    const b = new Uint16Array(count);
    const c = new Uint16Array(count);
    const K = rayCount;
    const avg = Math.PI / K;
    const L0 = levels[0];

    for (let layer = 0; layer < PROBE_LAYERS; layer++) {
        const lift = PROBE_HEIGHTS[layer];

        for (let z = 0; z < h; z++) {
            for (let x = 0; x < w; x++) {
                const px = x0 + x;
                const pz = z0 + z;
                const wx = -half + (px + 0.5) * probeCell;
                const wz = -half + (pz + 0.5) * probeCell;
                let wy = probeBase[pz * res + px] + lift;
                // Inside a prop: from its top instead.
                const sx = Math.min(n - 1, Math.floor((wx + half) / L0.cell));
                const sz = Math.min(n - 1, Math.floor((wz + half) / L0.cell));
                const own = L0.surf[sz * n + sx];

                if (wy < own + 0.3) {
                    wy = own + 0.3 + lift * 0.25;
                }

                let sr = 0;
                let sg = 0;
                let sb = 0;
                let kr = 0;
                let kg = 0;
                let kb = 0;
                let dx = 0;
                let dy = 0;
                let dz = 0;
                let lum = 0;
                let visNum = 0;
                let visDen = 0;

                for (let r = 0; r < K; r++) {
                    const ox = rays[r * 3];
                    const oy = rays[r * 3 + 1];
                    const oz = rays[r * 3 + 2];
                    march(wx, wy, wz, ox, oy, oz, MAX_DISTANCE, true);
                    sr += mS[0];
                    sg += mS[1];
                    sb += mS[2];
                    kr += mK[0];
                    kg += mK[1];
                    kb += mK[2];
                    const l =
                        0.2126 * (mS[0] + SKY_WEIGHT * mK[0]) +
                        0.7152 * (mS[1] + SKY_WEIGHT * mK[1]) +
                        0.0722 * (mS[2] + SKY_WEIGHT * mK[2]);
                    lum += l;
                    dx += l * ox;
                    dy += l * oy;
                    dz += l * oz;

                    if (oy > 0) {
                        visNum += (mHit ? 0 : mT) * oy;
                        visDen += oy;
                    }
                }

                // E(n) ≈ π/K Σ L + 2π/K Σ L (n·ω): the dominant direction relative to the average.
                const inv = lum > 1e-6 ? 2 / lum : 0;
                const o = ((layer * h + z) * w + x) * 4;
                a[o] = toHalf(sr * avg);
                a[o + 1] = toHalf(sg * avg);
                a[o + 2] = toHalf(sb * avg);
                a[o + 3] = toHalf(visDen > 0 ? visNum / visDen : 1);
                b[o] = toHalf(kr * avg);
                b[o + 1] = toHalf(kg * avg);
                b[o + 2] = toHalf(kb * avg);
                b[o + 3] = toHalf(1);
                c[o] = toHalf(dx * inv);
                c[o + 1] = toHalf(dy * inv);
                c[o + 2] = toHalf(dz * inv);
                c[o + 3] = toHalf(1);
            }
        }
    }

    return { x0, z0, w, h, a, b, c };
}

/** The dirty tile nearest to the focus, or -1. */
function nextTile(): number {
    const probeCell = scene!.size / res;
    let best = -1;
    let bestD = Infinity;

    for (let i = 0; i < dirty.length; i++) {
        if (!dirty[i]) {
            continue;
        }

        const tx = i % tilesPerSide;
        const tz = Math.floor(i / tilesPerSide);
        const cx = -half + (tx + 0.5) * TILE * probeCell;
        const cz = -half + (tz + 0.5) * TILE * probeCell;
        const d = (cx - focus.x) ** 2 + (cz - focus.z) ** 2;

        if (d < bestD) {
            bestD = d;
            best = i;
        }
    }

    return best;
}

const yieldToMessages = () =>
    new Promise<void>((resolve) => setTimeout(resolve, 0));

async function run(): Promise<void> {
    if (running) {
        return;
    }

    running = true;

    try {
        let batch: BounceTile[] = [];
        let batchStart = performance.now();

        while (scene && !paused) {
            const gen = generation;
            const index = nextTile();

            if (index < 0) {
                break;
            }

            if (passStart === 0) {
                passStart = performance.now();
            }

            const t0 = performance.now();
            dirty[index] = 0;
            const tile = computeTile(
                index % tilesPerSide,
                Math.floor(index / tilesPerSide),
            );
            passWork += performance.now() - t0;

            if (gen === generation) {
                batch.push(tile);
            } else {
                // The scene or light changed while computing: do it again.
                dirty[index] = 1;
            }

            if (performance.now() - batchStart > 60) {
                flush(batch);
                batch = [];
                await yieldToMessages();
                batchStart = performance.now();
            }
        }

        flush(batch);

        if (scene && !paused && nextTile() < 0) {
            post({ op: 'done', ms: Math.round(passWork), probes: res * res * PROBE_LAYERS });
            passWork = 0;
            passStart = 0;
        }
    } finally {
        running = false;
    }
}

function flush(batch: BounceTile[]): void {
    if (!batch.length) {
        return;
    }

    let remaining = 0;

    for (let i = 0; i < dirty.length; i++) {
        remaining += dirty[i];
    }

    const transfer: Transferable[] = [];

    for (const t of batch) {
        transfer.push(t.a.buffer, t.b.buffer, t.c.buffer);
    }

    post({ op: 'tiles', tiles: batch, remaining }, transfer);
}
