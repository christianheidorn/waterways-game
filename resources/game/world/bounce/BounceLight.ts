import * as THREE from 'three/webgpu';
import {
    dot,
    float,
    max,
    mix,
    positionWorld,
    normalWorld,
    pow,
    floor,
    min,
    texture,
    uniform,
    vec2,
} from 'three/tsl';
import type { GameRenderer } from '../../core/renderer';
import { NO_WATER } from '../../shared/types';
import type { Foliage } from '../Foliage';
import type { Heightfield } from '../Heightfield';
import type { Props } from '../Props';
import type { SplatMap } from '../SplatMap';
import type { TerrainMaterial } from '../TerrainMaterial';
import { PROBE_LAYERS, QUALITY_PARAMS } from './bounceShared';
import type {
    BounceQuality,
    BounceRequest,
    BounceResponse,
    BounceScene,
} from './bounceShared';

type Node<T extends string> = THREE.Node<T>;

export type BounceSources = {
    heights: Heightfield;
    water: Heightfield;
    splat: SplatMap;
    material: TerrainMaterial;
    foliage: Foliage;
    props: Props;
};

export type BounceStats = {
    quality: BounceQuality;
    strength: number;
    probes: string;
    probe_spacing_m: number;
    rays_per_probe: number;
    /** Worker time of the last complete update (ms). */
    last_update_ms: number | null;
    updating: boolean;
};

/** Albedo of a water surface for diffuse bounce (most of its light is reflected specularly). */
const WATER_ALBEDO = [0.03, 0.045, 0.05];
/** Props whose material we don't know: a neutral stone / wood albedo. */
const PROP_ALBEDO = 0.28;
/** Main-thread time per frame spent gathering the scene for the worker at 60 fps (ms). */
const FRAME_BUDGET_MS = 2.5;
/** Edits are gathered this long after the last one (s). */
const SETTLE_DELAY = 0.4;
/** A new light direction is sent when it turned by more than this (radians, ~1.5°). */
const LIGHT_EPSILON = 0.026;
/** Brightness of the "Bounce light only" view (the bounce is a small part of the light). */
const VIEW_GAIN = 3;

/**
 * The probe texture and the shading uniforms, shared by every material (one game per page). One
 * texture keeps the terrain shader within WebGPU's 16 sampled textures per stage: an atlas 3·res wide
 * (A | B | C side by side) and res·layers high (the layers stacked). It starts as one empty probe: no
 * bounce, full sky visibility.
 */
const shared = {
    probes: texture(emptyAtlas()),
    /** Probe columns per side. */
    res: uniform(1),
    /** Sun / moon irradiance (colour × intensity) and the sky's irradiance on flat open ground. */
    sun: uniform(new THREE.Color(0, 0, 0)),
    sky: uniform(new THREE.Color(0, 0, 0)),
    /** Environment `bounce_light` while active (0 = off: no bounce, no sky occlusion). */
    strength: uniform(0),
    half: uniform(1024),
    size: uniform(2048),
    /** Height the probes' ground (C.w) is stored relative to (half floats). */
    reference: uniform(0),
    /** 1 in the "Bounce light only" view. */
    view: uniform(0),
};

/** Probe values at the shaded point: A (sun bounce, sky visibility), B (sky bounce), C (direction). */
function probes(): { a: Node<'vec4'>; b: Node<'vec4'>; c: Node<'vec4'> } {
    const u = shared;
    const tex = u.probes;
    const uv = positionWorld.xz.add(u.half).div(u.size);
    // Texel coordinates clamped inside a block, so filtering never reaches a neighbouring one.
    const col = uv.x.mul(u.res).clamp(0.5, u.res.sub(0.5));
    const row = uv.y.mul(u.res).clamp(0.5, u.res.sub(0.5));
    const width = u.res.mul(3);
    const rows = u.res.mul(PROBE_LAYERS);
    const at = (block: number, layer: Node<'float'>) =>
        vec2(
            col.add(u.res.mul(block)).div(width),
            layer.mul(u.res).add(row).div(rows),
        );
    const ground = tex.sample(at(2, float(0))).w.add(u.reference);
    const above = positionWorld.y.sub(ground);
    // Piecewise linear over the layer heights (1, 5, 13, 30 m; see PROBE_HEIGHTS).
    const layer = above
        .sub(1)
        .div(4)
        .clamp(0, 1)
        .add(above.sub(5).div(8).clamp(0, 1))
        .add(above.sub(13).div(17).clamp(0, 1));
    // The two layers around the shaded height, blended.
    const lower = floor(layer).toVar();
    const upper = min(lower.add(1), float(PROBE_LAYERS - 1));
    const t = layer.sub(lower);
    const blend = (block: number) =>
        mix(
            tex.sample(at(block, lower)),
            tex.sample(at(block, upper)),
            t,
        ) as Node<'vec4'>;

    return { a: blend(0), b: blend(1), c: blend(2) };
}

/**
 * Sky visibility at the shaded point raised to the bounce strength: 1 without bounce light. For
 * shading terms of their own that stand for sky light (e.g. the foliage's light through leaves).
 */
export function bounceSkyVisibility(): Node<'float'> {
    return pow(max(probes().a.w, float(0.02)), shared.strength) as Node<'float'>;
}

function emptyAtlas(res = 1): THREE.DataTexture {
    const width = res * 3;
    const data = new Uint16Array(width * res * PROBE_LAYERS * 4);
    // Empty probes: no bounce, full sky visibility (A.w = 1.0 in half float).
    const one = 0x3c00;

    for (let row = 0; row < res * PROBE_LAYERS; row++) {
        for (let x = 0; x < res; x++) {
            data[(row * width + x) * 4 + 3] = one;
        }
    }

    const tex = new THREE.DataTexture(
        data,
        width,
        res * PROBE_LAYERS,
        THREE.RGBAFormat,
        THREE.HalfFloatType,
    );
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;

    return tex;
}

type CanopyKind = { bottom: number; lai: number; solid: boolean };

/** Crown bottom (fraction of the height) and leaf area index per foliage kind; rocks are solid. */
const CANOPY: Partial<Record<string, CanopyKind>> = {
    conifer: { bottom: 0.18, lai: 5.5, solid: false },
    broadleaf: { bottom: 0.35, lai: 4.5, solid: false },
    palm: { bottom: 0.72, lai: 2.5, solid: false },
    bush: { bottom: 0, lai: 3, solid: false },
    rock: { bottom: 0, lai: 0, solid: true },
};

/**
 * Bounce light (diffuse global illumination) from a heightfield-following irradiance probe volume
 * (see bounceShared.ts for the layout and bounceWorker.ts for how it is computed).
 *
 * - The probes are computed in a web worker from a coarse copy of the world (terrain albedo from the
 *   paint, water, tree / bush canopies, rocks and props) that this class gathers a few rows per frame.
 *   Edits (`invalidate`) are gathered again after a short pause and only nearby probes change; a new
 *   sun or moon direction recomputes them all. Nothing here ever blocks a frame.
 * - Shading goes through the renderer's lighting context, so every lit material of the main scene
 *   (terrain, foliage, props, water, characters) gets it: `getGI` adds the bounce irradiance and
 *   `getAO` multiplies the sky light (hemisphere light and environment map) by the probes' sky
 *   visibility, so forests are darker underneath and valleys pick up the light of their slopes.
 */
export class BounceLight {
    private quality: BounceQuality = 'off';
    private res = 0;
    private rays = 0;
    private installed = false;
    private worker: Worker | null = null;
    private atlas = shared.probes.value as THREE.DataTexture;
    private readonly u = shared;
    private envStrength = 1;
    private build: Generator<void, BounceScene | null> | null = null;
    private settleTimer = -1;
    private pendingTiles = 0;
    private uploadPending = false;
    private uploadCooldown = 0;
    private sentLight = new THREE.Vector3(0, -2, 0);
    private lightCooldown = 0;
    private lastMs: number | null = null;
    private working = false;
    private readonly focus = new THREE.Vector2(Infinity, Infinity);
    /** Ground colours and weather the last gathered scene used (a change gathers it again). */
    private groundSignature = '';
    private pollTimer = 0;
    private lastUpdate = 0;

    constructor(
        private readonly renderer: GameRenderer,
        private readonly scene: THREE.Scene,
        private readonly sources: BounceSources,
    ) {
        this.u.half.value = sources.heights.half;
        this.u.size.value = sources.heights.size;
        this.u.reference.value = sources.heights.minMax().min;
    }

    /** Graphics quality (off removes it from every shader). */
    setQuality(quality: BounceQuality): void {
        const q: BounceQuality = QUALITY_PARAMS[quality as 'low']
            ? quality
            : 'off';

        if (q === this.quality) {
            return;
        }

        this.quality = q;

        if (q === 'off') {
            this.stopWorker();
            this.uninstall();
            this.u.strength.value = 0;

            return;
        }

        const { res, rays } = QUALITY_PARAMS[q];

        if (res !== this.res) {
            this.res = res;
            this.replaceTextures(res);
        }

        this.rays = rays;
        this.install();
        this.ensureWorker();
        this.invalidate(true);
    }

    /** Environment `bounce_light` (0-2). */
    setStrength(strength: number): void {
        const next = THREE.MathUtils.clamp(strength, 0, 2);
        const wasOff = this.envStrength <= 0;
        this.envStrength = next;

        if (wasOff && next > 0 && this.active) {
            this.invalidate(true);
        }
    }

    /**
     * Share of the ambient light's uniform ground colour (hemisphere light, ground in the sky
     * reflections) to keep: the probes bring the real ground's light instead.
     */
    get uniformGroundShare(): number {
        return this.active ? 1 - 0.85 * Math.min(1, this.envStrength) : 1;
    }

    /** Whether bounce light shades the scene (quality on and a strength above 0). */
    get active(): boolean {
        return this.quality !== 'off' && this.envStrength > 0;
    }

    /** The "Bounce light only" debug view (Atmosphere switches the other lights off). */
    setView(bounceOnly: boolean): void {
        this.u.view.value = bounceOnly ? 1 : 0;
    }

    /** Probes are being gathered or computed (screenshots may wait for it). */
    get settling(): boolean {
        return (
            this.active &&
            (this.build !== null ||
                this.settleTimer >= 0 ||
                this.working ||
                this.uploadPending)
        );
    }

    /** Something changed the world (terrain, paint, water, foliage, props, layers, weather). */
    invalidate(now = false): void {
        if (this.quality === 'off') {
            return;
        }

        this.settleTimer = now ? 0 : SETTLE_DELAY;
    }

    /**
     * Per frame: light colours and direction (from Atmosphere), gathering the scene, uploading
     * finished probes.
     */
    update(
        dt: number,
        focus: THREE.Vector3,
        lightDir: THREE.Vector3,
        sun: THREE.Color,
        sky: THREE.Color,
    ): void {
        this.u.sun.value.copy(sun);
        this.u.sky.value.copy(sky);
        this.u.strength.value = this.active ? this.envStrength : 0;

        if (!this.active) {
            return;
        }

        const updateStart = performance.now();

        this.pollTimer -= dt;

        if (this.pollTimer <= 0) {
            this.pollTimer = 1;

            if (this.signature() !== this.groundSignature) {
                this.invalidate();
            }
        }

        if (this.settleTimer >= 0) {
            this.settleTimer -= dt;

            if (this.settleTimer < 0) {
                this.groundSignature = this.signature();
                this.build = this.gather();
            }
        }

        if (this.build) {
            // A slice of the frame: 2.5 ms at 60 fps, more when frames are slow anyway (≤ 25 ms).
            const now = performance.now();
            const interval = this.lastUpdate ? now - this.lastUpdate : 16;
            const deadline =
                now +
                THREE.MathUtils.clamp(interval * 0.1, FRAME_BUDGET_MS, 25);
            let result: IteratorResult<void, BounceScene | null>;

            do {
                result = this.build.next();
            } while (!result.done && performance.now() < deadline);

            if (result.done) {
                this.build = null;

                if (result.value) {
                    this.sendScene(result.value, lightDir);
                }
            }
        }

        this.lightCooldown -= dt;

        if (
            this.lightCooldown <= 0 &&
            this.sentLight.y > -1.5 &&
            !this.build &&
            this.sentLight.angleTo(lightDir) > LIGHT_EPSILON
        ) {
            this.sentLight.copy(lightDir);
            this.lightCooldown = 0.5;
            this.working = true;
            this.post({
                op: 'light',
                light: [lightDir.x, lightDir.y, lightDir.z],
            });
        }

        if (
            Math.abs(focus.x - this.focus.x) + Math.abs(focus.z - this.focus.y) >
            16
        ) {
            this.focus.set(focus.x, focus.z);
            this.post({ op: 'focus', x: focus.x, z: focus.z });
        }

        this.uploadCooldown -= dt;

        if (this.uploadPending && this.uploadCooldown <= 0) {
            this.uploadPending = false;
            this.uploadCooldown = this.pendingTiles > 0 ? 0.35 : 0;
            this.atlas.needsUpdate = true;
        }

        this.lastUpdate = updateStart;
    }

    /**
     * Layer ground colours (they change when a layer's textures finish loading) and the weather's
     * wetness and snow cover, coarsely: changes gather the scene again.
     */
    private signature(): string {
        const u = this.sources.material.uniforms;
        const parts = u.layers.ground.map(
            (c, i) =>
                `${u.layers.mat[i].x}:${c.r.toFixed(2)},${c.g.toFixed(2)},${c.b.toFixed(2)}`,
        );
        parts.push(
            (Math.round(Number(u.uWeatherWet.value) * 8) / 8).toString(),
            (Math.round(Number(u.uSnowCover.value) * 8) / 8).toString(),
        );

        return parts.join('|');
    }

    stats(): BounceStats {
        const spacing = this.res
            ? this.sources.heights.size / this.res
            : 0;

        return {
            quality: this.quality,
            strength: this.envStrength,
            probes: this.res
                ? `${this.res}×${this.res}×${PROBE_LAYERS}`
                : 'none',
            probe_spacing_m: Math.round(spacing * 10) / 10,
            rays_per_probe: this.quality === 'off' ? 0 : this.rays,
            last_update_ms: this.lastMs,
            updating: this.settling,
        };
    }

    dispose(): void {
        this.stopWorker();
        this.uninstall();
        this.atlas.dispose();
    }

    // ------------------------------------------------------------------ shading

    private install(): void {
        if (this.installed) {
            return;
        }

        this.installed = true;
        const ctx = this.renderer.contextNode;
        const value = ctx.value as Record<string, unknown>;
        value.getAO = (aoNode: Node<'float'> | null, builder: THREE.NodeBuilder) =>
            this.applies(builder)
                ? aoNode
                    ? aoNode.mul(this.occlusion(builder))
                    : this.occlusion(builder)
                : aoNode;
        value.getGI = (_: unknown, builder: THREE.NodeBuilder) =>
            this.applies(builder) ? this.irradiance(builder) : null;
        // Every render object's cache key includes the context's version: materials rebuild.
        ctx.needsUpdate = true;
    }

    private uninstall(): void {
        if (!this.installed) {
            return;
        }

        this.installed = false;
        const ctx = this.renderer.contextNode;
        const value = ctx.value as Record<string, unknown>;
        delete value.getAO;
        delete value.getGI;
        ctx.needsUpdate = true;
    }

    /** Only lit materials of the game's scene (not previews, thumbnails or impostor captures). */
    private applies(builder: THREE.NodeBuilder): boolean {
        const b = builder as THREE.NodeBuilder & {
            scene: THREE.Scene | null;
        };

        return (
            b.scene === this.scene &&
            builder.material?.userData?.bounceLight !== false
        );
    }

    /**
     * Sky visibility raised to the strength (0 = none), eased per material: `userData.bounceOcclusion`
     * (0-1, default 1) for surfaces the coarse probes can't place well (e.g. the outer leaves of a crown).
     */
    private occlusion(builder: THREE.NodeBuilder): Node<'float'> {
        const occ = bounceSkyVisibility();
        const weight = Number(
            builder.material?.userData?.bounceOcclusion ?? 1,
        );

        return (weight >= 1 ? occ : mix(float(1), occ, weight)) as Node<'float'>;
    }

    /**
     * Bounce irradiance for the shaded normal. The lighting model multiplies all indirect diffuse
     * light by the AO (the sky visibility from getAO): divided by it here, so the bounce itself is only
     * occluded by the material's own AO.
     */
    private irradiance(builder: THREE.NodeBuilder): Node<'vec3'> {
        const { a, b, c } = probes();
        const u = this.u;
        const e = a.rgb.mul(u.sun).add(b.rgb.mul(u.sky));
        const facing = max(float(0), dot(normalWorld, c.xyz).add(1));
        const gain = mix(float(1), float(VIEW_GAIN), u.view);

        return e
            .mul(facing)
            .mul(u.strength)
            .mul(gain)
            .div(max(this.occlusion(builder), float(0.02))) as Node<'vec3'>;
    }

    // ------------------------------------------------------------------ textures

    private replaceTextures(res: number): void {
        const old = this.atlas;
        this.atlas = emptyAtlas(res);
        shared.probes.value = this.atlas;
        shared.res.value = res;
        old.dispose();
    }

    // ------------------------------------------------------------------ worker

    private ensureWorker(): void {
        if (this.worker) {
            return;
        }

        try {
            this.worker = new Worker(
                new URL('./bounceWorker.ts', import.meta.url),
                { type: 'module', name: 'waterways-bounce' },
            );
            this.worker.onmessage = (event: MessageEvent<BounceResponse>) =>
                this.receive(event.data);
            this.worker.onerror = (event) => {
                console.warn('Bounce light worker failed', event);
                this.working = false;
            };
        } catch (error) {
            console.warn('Bounce light worker unavailable', error);
            this.worker = null;
        }
    }

    private stopWorker(): void {
        this.worker?.terminate();
        this.worker = null;
        this.build = null;
        this.settleTimer = -1;
        this.working = false;
        this.sentLight.set(0, -2, 0);
        this.focus.set(Infinity, Infinity);
    }

    private post(msg: BounceRequest, transfer: Transferable[] = []): void {
        this.worker?.postMessage(msg, transfer);
    }

    private sendScene(scene: BounceScene, lightDir: THREE.Vector3): void {
        if (!this.worker) {
            return;
        }

        this.sentLight.copy(lightDir);
        this.working = true;
        this.post(
            {
                op: 'scene',
                scene,
                res: this.res,
                rays: this.rays,
                reference: this.u.reference.value,
                light: [lightDir.x, lightDir.y, lightDir.z],
            },
            [
                scene.ground.buffer,
                scene.base.buffer,
                scene.surf.buffer,
                scene.albedo.buffer,
                scene.canopyBottom.buffer,
                scene.canopyTop.buffer,
                scene.canopySigma.buffer,
                scene.canopyAlbedo.buffer,
            ],
        );
    }

    private receive(msg: BounceResponse): void {
        if (msg.op === 'tiles') {
            const res = this.res;
            const width = res * 3;
            const atlas = this.atlas.image.data as Uint16Array;

            for (const tile of msg.tiles) {
                if (tile.x0 + tile.w > res || tile.z0 + tile.h > res) {
                    continue;
                }

                const sources = [tile.a, tile.b, tile.c];

                for (let block = 0; block < 3; block++) {
                    const src = sources[block];

                    for (let layer = 0; layer < PROBE_LAYERS; layer++) {
                        for (let z = 0; z < tile.h; z++) {
                            const from = (layer * tile.h + z) * tile.w * 4;
                            const to =
                                ((layer * res + tile.z0 + z) * width +
                                    block * res +
                                    tile.x0) *
                                4;
                            atlas.set(src.subarray(from, from + tile.w * 4), to);
                        }
                    }
                }
            }

            this.pendingTiles = msg.remaining;
            this.uploadPending = true;

            return;
        }

        if (msg.op === 'done') {
            this.lastMs = msg.ms;
            this.working = false;
            this.pendingTiles = 0;
        }
    }

    // ------------------------------------------------------------------ scene gathering

    /** Builds the worker's copy of the world, yielding whenever the frame budget is used up. */
    private *gather(): Generator<void, BounceScene | null> {
        const { heights, water, splat, material, foliage, props } =
            this.sources;
        const n = this.res * 2;

        if (!n) {
            return null;
        }

        const size = heights.size;
        const half = size / 2;
        const cell = size / n;
        const count = n * n;
        const ground = new Float32Array(count);
        const base = new Float32Array(count);
        const surf = new Float32Array(count);
        const albedo = new Float32Array(count * 3);
        const canopyBottom = new Float32Array(count).fill(Infinity);
        const canopyTop = new Float32Array(count).fill(-Infinity);
        const canopySigma = new Float32Array(count);
        const canopyAlbedo = new Float32Array(count * 3);

        // ---- terrain, water and paint
        const layers = material.uniforms.layers;
        const colors = layers.ground.map((c) => [c.r, c.g, c.b]);
        const enabled = layers.mat.map((m) => m.x);
        const wet = Number(material.uniforms.uWeatherWet.value) || 0;
        const snowCover = Number(material.uniforms.uSnowCover.value) || 0;
        const sres = splat.resolution;
        const sdata = splat.data;
        const hres = heights.resolution;

        for (let z = 0; z < n; z++) {
            const wz = -half + (z + 0.5) * cell;

            for (let x = 0; x < n; x++) {
                const wx = -half + (x + 0.5) * cell;
                const k = z * n + x;
                const g = heights.sample(wx, wz);
                ground[k] = g;
                const gx = (wx + half) / heights.cell;
                const gz = (wz + half) / heights.cell;
                const col = Math.min(hres - 1, Math.max(0, Math.round(gx)));
                const row = Math.min(hres - 1, Math.max(0, Math.round(gz)));
                const level = water.data[row * water.resolution + col];
                const isWater = level > NO_WATER + 1 && level > g + 0.05;
                base[k] = isWater ? level : g;
                surf[k] = base[k];
                let r = 0;
                let gg = 0;
                let b = 0;

                if (isWater) {
                    [r, gg, b] = WATER_ALBEDO;
                } else {
                    // The paint, as TerrainMaterial.groundColor (cubed weights).
                    const sc = Math.min(sres - 1, col);
                    const sr = Math.min(sres - 1, row);
                    const s = (sr * sres + sc) * 8;
                    let sum = 0;

                    for (let i = 0; i < 8; i++) {
                        const w = sdata[s + i] / 255;
                        const w3 = w * w * w * enabled[i];

                        if (w3 > 0) {
                            sum += w3;
                            r += colors[i][0] * w3;
                            gg += colors[i][1] * w3;
                            b += colors[i][2] * w3;
                        }
                    }

                    if (sum > 1e-5) {
                        r /= sum;
                        gg /= sum;
                        b /= sum;
                    } else {
                        [r, gg, b] = colors[0];
                    }

                    const dark = 1 - wet * 0.38;
                    r *= dark;
                    gg *= dark;
                    b *= dark;

                    if (snowCover > 0) {
                        // Snow settles on flatter ground first (as the terrain shader).
                        const slope =
                            Math.abs(
                                heights.sample(wx + cell, wz) -
                                    heights.sample(wx - cell, wz),
                            ) +
                            Math.abs(
                                heights.sample(wx, wz + cell) -
                                    heights.sample(wx, wz - cell),
                            );
                        const flat = THREE.MathUtils.clamp(
                            1.4 - slope / (2 * cell),
                            0,
                            1,
                        );
                        const snow =
                            THREE.MathUtils.clamp(
                                (snowCover * 1.4 - (1 - snowCover) * 0.3) / 0.25,
                                0,
                                1,
                            ) * flat;
                        r += (0.86 - r) * snow;
                        gg += (0.89 - gg) * snow;
                        b += (0.93 - b) * snow;
                    }
                }

                albedo[k * 3] = r;
                albedo[k * 3 + 1] = gg;
                albedo[k * 3 + 2] = b;
            }

            yield;
        }

        // ---- canopies and rocks
        const lai = new Float32Array(count);
        const color = new THREE.Color();
        const tint = new THREE.Color();
        const solid = (
            x0: number,
            z0: number,
            x1: number,
            z1: number,
            top: number,
            r: number,
            g: number,
            b: number,
        ) => {
            // Cells whose centre the footprint covers; small footprints only if they fill most of a cell.
            const c0 = Math.max(0, Math.ceil((x0 + half) / cell - 0.5));
            const c1 = Math.min(n - 1, Math.floor((x1 + half) / cell - 0.5));
            const r0 = Math.max(0, Math.ceil((z0 + half) / cell - 0.5));
            const r1 = Math.min(n - 1, Math.floor((z1 + half) / cell - 0.5));
            let cells: [number, number][] = [];

            for (let row = r0; row <= r1; row++) {
                for (let col = c0; col <= c1; col++) {
                    cells.push([col, row]);
                }
            }

            if (!cells.length) {
                if ((x1 - x0) * (z1 - z0) < cell * cell * 0.35) {
                    return;
                }

                cells = [
                    [
                        Math.min(n - 1, Math.max(0, Math.floor(((x0 + x1) / 2 + half) / cell))),
                        Math.min(n - 1, Math.max(0, Math.floor(((z0 + z1) / 2 + half) / cell))),
                    ],
                ];
            }

            for (const [col, row] of cells) {
                const k = row * n + col;

                if (top > surf[k]) {
                    surf[k] = top;
                    albedo[k * 3] = r;
                    albedo[k * 3 + 1] = g;
                    albedo[k * 3 + 2] = b;
                }
            }
        };

        let budget = 0;

        for (const { type, bounds, data } of foliage.placedCells()) {
            const kind = CANOPY[type.kind];

            if (!kind) {
                continue;
            }

            color
                .set(type.color)
                .multiply(tint.set(type.tint ?? '#ffffff'));
            const reach =
                Math.max(
                    bounds.max.x - bounds.min.x,
                    bounds.max.z - bounds.min.z,
                ) / 2;
            const height = bounds.max.y - Math.max(0, bounds.min.y);

            for (let i = 0; i + 4 < data.length; i += 7) {
                const x = data[i];
                const y = data[i + 1];
                const z = data[i + 2];
                const s = data[i + 4];
                const top = y + bounds.max.y * s;
                const r = reach * s;

                if (kind.solid) {
                    const rr = r * 0.8;
                    solid(x - rr, z - rr, x + rr, z + rr, top, color.r, color.g, color.b);
                    continue;
                }

                const bottom = y + height * s * kind.bottom;
                // Leaf area spread over the cells under the crown (cone weights; conserves the area).
                const area = Math.PI * r * r * kind.lai;
                const c0 = Math.max(0, Math.floor((x - r + half) / cell));
                const c1 = Math.min(n - 1, Math.floor((x + r + half) / cell));
                const r0 = Math.max(0, Math.floor((z - r + half) / cell));
                const r1 = Math.min(n - 1, Math.floor((z + r + half) / cell));
                let total = 0;

                for (let pass = 0; pass < 2; pass++) {
                    for (let row = r0; row <= r1; row++) {
                        for (let col = c0; col <= c1; col++) {
                            const dx = -half + (col + 0.5) * cell - x;
                            const dz = -half + (row + 0.5) * cell - z;
                            const w = Math.max(
                                0,
                                1 - Math.hypot(dx, dz) / (r + cell * 0.71),
                            );

                            if (pass === 0) {
                                total += w;
                            } else if (w > 0 && total > 0) {
                                const k = row * n + col;
                                const l = (area * w) / total / (cell * cell);

                                if (l <= 0) {
                                    continue;
                                }

                                const prev = lai[k];
                                const sum = prev + l;
                                canopyBottom[k] =
                                    prev > 0
                                        ? (canopyBottom[k] * prev + bottom * l) / sum
                                        : bottom;
                                canopyTop[k] =
                                    prev > 0
                                        ? (canopyTop[k] * prev + top * l) / sum
                                        : top;
                                canopyAlbedo[k * 3] =
                                    (canopyAlbedo[k * 3] * prev + color.r * l) / sum;
                                canopyAlbedo[k * 3 + 1] =
                                    (canopyAlbedo[k * 3 + 1] * prev + color.g * l) / sum;
                                canopyAlbedo[k * 3 + 2] =
                                    (canopyAlbedo[k * 3 + 2] * prev + color.b * l) / sum;
                                lai[k] = sum;
                            }
                        }
                    }
                }
            }

            if (++budget % 8 === 0) {
                yield;
            }
        }

        // ---- props (their bounding boxes)
        const box = new THREE.Box3();
        const unit = new THREE.Box3(
            new THREE.Vector3(-0.5, -0.5, -0.5),
            new THREE.Vector3(0.5, 0.5, 0.5),
        );

        for (const p of props.list()) {
            const m = props.boundsMatrix(p.id);

            if (!m) {
                continue;
            }

            box.copy(unit).applyMatrix4(m);

            if (box.max.y - box.min.y > 0.4) {
                solid(
                    box.min.x,
                    box.min.z,
                    box.max.x,
                    box.max.z,
                    box.max.y,
                    PROP_ALBEDO,
                    PROP_ALBEDO,
                    PROP_ALBEDO * 0.95,
                );
            }

            if (++budget % 64 === 0) {
                yield;
            }
        }

        // Extinction: half the leaf area per metre of crown (random leaf angles).
        for (let k = 0; k < count; k++) {
            if (lai[k] > 0) {
                const depth = Math.max(1, canopyTop[k] - canopyBottom[k]);
                canopySigma[k] = (0.5 * Math.min(lai[k], 12)) / depth;
                // Crowns standing on a prop or rock start above it.
                canopyBottom[k] = Math.max(canopyBottom[k], surf[k]);
            }
        }

        return {
            n,
            size,
            ground,
            base,
            surf,
            albedo,
            canopyBottom,
            canopyTop,
            canopySigma,
            canopyAlbedo,
        };
    }
}
