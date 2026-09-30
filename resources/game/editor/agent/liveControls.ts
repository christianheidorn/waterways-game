import * as THREE from 'three/webgpu';
import type { GameMode } from '../../shared/protocol';
import type {
    EnvironmentSettings,
    GraphicsSettings,
    QualityLevel,
} from '../../shared/types';
import {
    applyGroupLevel,
    applyPreset,
    detectGroupLevel,
    detectPreset,
    PRESET_NAMES,
    QUALITY_LEVELS,
    SCALABILITY_GROUPS,
    withDetectedPreset,
} from '../../shared/graphicsPresets';
import type { PresetName } from '../../shared/graphicsPresets';
import { diffGraphics } from '../../ui/GraphicsMenu';

/**
 * Live controls for AI agents that mirror the game's menus: the graphics menu (F10, per-device
 * overrides), photo mode (F9) and play mode (walking the player, looking around). Engine side of the
 * MCP tools set_device_graphics, take_photo and control_player.
 */

// ------------------------------------------------------------------ graphics

export type GraphicsHost = {
    /** Currently applied (project defaults + device overrides). */
    current: () => GraphicsSettings;
    /** Project defaults from the studio. */
    defaults: () => GraphicsSettings;
    /** Applies settings as the graphics menu does (stores what differs from the defaults). */
    apply: (settings: GraphicsSettings) => void;
};

/** Graphics menu state: preset, scalability group levels and the device's overrides. */
export function graphicsState(host: GraphicsHost): Record<string, unknown> {
    const g = host.current();

    return {
        preset: detectPreset(g),
        groups: Object.fromEntries(
            SCALABILITY_GROUPS.map((group) => [
                group.key,
                detectGroupLevel(g, group),
            ]),
        ),
        overrides: diffGraphics(g, host.defaults()),
        settings: g,
    };
}

/** set_device_graphics: a preset, group levels and / or single settings; or back to the defaults. */
export function changeGraphics(
    host: GraphicsHost,
    payload: Record<string, unknown>,
): Record<string, unknown> {
    let g: GraphicsSettings = payload.reset
        ? { ...host.defaults() }
        : { ...host.current() };

    if (payload.preset !== undefined) {
        if (!PRESET_NAMES.includes(payload.preset as PresetName)) {
            throw new Error(
                `Unknown preset ${JSON.stringify(payload.preset)}.`,
            );
        }

        g = applyPreset(payload.preset as PresetName, g);
    }

    const groups = (payload.groups ?? {}) as Record<string, string>;

    for (const [key, level] of Object.entries(groups)) {
        if (!SCALABILITY_GROUPS.some((x) => x.key === key)) {
            throw new Error(`Unknown scalability group ${key}.`);
        }

        if (!QUALITY_LEVELS.includes(level as QualityLevel)) {
            throw new Error(`Unknown quality level ${level}.`);
        }

        g = applyGroupLevel(
            g,
            key as (typeof SCALABILITY_GROUPS)[number]['key'],
            level as QualityLevel,
        );
    }

    const settings = (payload.settings ?? {}) as Partial<GraphicsSettings>;

    if (Object.keys(settings).length) {
        g = withDetectedPreset({ ...g, ...settings });
    }

    host.apply(g);

    return graphicsState(host);
}

// ------------------------------------------------------------------ photo mode

export type PhotoHost = {
    environment: () => EnvironmentSettings;
    /** Applies a look without saving it. */
    previewEnvironment: (env: EnvironmentSettings) => void;
    setCinematic: (on: boolean) => void;
    fov: () => number;
    setFov: (fov: number) => void;
    /** Focus depth of field on a screen point (NDC); null returns to the look's focus. */
    focusAt: (ndcX: number | null, ndcY?: number) => void;
    /** Renders a still at `scale` × the current resolution (PNG). */
    capture: (scale: number) => Promise<Blob>;
};

/**
 * take_photo: like photo mode's capture, with optional look changes (colour grade, exposure, depth
 * of field, lens, letterbox, time of day), field of view and cinematic quality, all restored after.
 */
export async function takePhoto(
    host: PhotoHost,
    payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
    const env = host.environment();
    const look = (payload.look ?? {}) as Partial<EnvironmentSettings>;
    const fovBefore = host.fov();
    const cinematic = payload.cinematic !== false;
    const scale = payload.scale === 2 ? 2 : 1;
    const focus = payload.focus as { x: number; y: number } | undefined;

    try {
        host.setCinematic(cinematic);

        if (Object.keys(look).length) {
            host.previewEnvironment({ ...env, ...look });
        }

        if (typeof payload.fov === 'number') {
            host.setFov(payload.fov);
        }

        if (focus) {
            host.focusAt(focus.x, focus.y);
        }

        const blob = await host.capture(scale);
        const bitmap = await createImageBitmap(blob);
        const maxWidth = Math.min(
            1920,
            Math.max(256, Number(payload.max_width) || 1280),
        );
        const s = Math.min(1, maxWidth / bitmap.width);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(bitmap.width * s);
        canvas.height = Math.round(bitmap.height * s);
        canvas
            .getContext('2d')!
            .drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const preview = canvas.toDataURL('image/jpeg', 0.9);
        // Full resolution as a high-quality JPEG (a PNG would be too large for the bridge).
        const fullCanvas = document.createElement('canvas');
        fullCanvas.width = bitmap.width;
        fullCanvas.height = bitmap.height;
        fullCanvas.getContext('2d')!.drawImage(bitmap, 0, 0);
        const full = fullCanvas.toDataURL('image/jpeg', 0.94);
        bitmap.close();

        return {
            mime: 'image/jpeg',
            image: preview.slice(preview.indexOf(',') + 1),
            width: canvas.width,
            height: canvas.height,
            full: full.slice(full.indexOf(',') + 1),
            full_width: fullCanvas.width,
            full_height: fullCanvas.height,
            cinematic,
        };
    } finally {
        host.previewEnvironment(env);
        host.setFov(fovBefore);
        host.focusAt(null);
        host.setCinematic(false);
    }
}

// ------------------------------------------------------------------ player

export type PlayerHost = {
    mode: () => GameMode;
    /** Walk mode in the editor (the character with collision, control_editor action "walk"). */
    walking?: () => boolean;
    /** Switches to play mode at the map's player start. */
    play: () => void;
    position: () => THREE.Vector3;
    /** Facing of the character (radians, 0 = north / −z). */
    yaw: () => number;
    swimming: () => boolean;
    /** Puts the player at (x, z), facing yaw, on the ground. */
    teleport: (x: number, z: number, yaw: number) => void;
    view: () => { yaw: number; pitch: number };
    setView: (yaw: number, pitch?: number) => void;
    /** Holds a key down (or releases it) as if the user pressed it. */
    hold: (code: string, down: boolean) => void;
    contains: (x: number, z: number) => boolean;
};

/** Longest a walk may take (s). */
const WALK_MAX_S = 60;

const deg = (rad: number) =>
    Math.round(THREE.MathUtils.radToDeg(rad) * 10) / 10;
const rad = (d: number) => THREE.MathUtils.degToRad(d);

/** Yaw that faces from (x, z) towards (tx, tz) (the game's convention: 0 looks towards −z). */
export function yawTowards(
    x: number,
    z: number,
    tx: number,
    tz: number,
): number {
    return Math.atan2(-(tx - x), -(tz - z));
}

function playerState(host: PlayerHost): Record<string, unknown> {
    const p = host.position();
    const v = host.view();

    return {
        mode: host.mode(),
        walking: host.walking?.() ?? false,
        position: {
            x: Math.round(p.x * 100) / 100,
            y: Math.round(p.y * 100) / 100,
            z: Math.round(p.z * 100) / 100,
        },
        facing_deg: deg(host.yaw()),
        camera: { yaw_deg: deg(v.yaw), pitch_deg: deg(v.pitch) },
        swimming: host.swimming(),
    };
}

/**
 * control_player: play mode as the user plays it. "state"; "teleport" (x, z, facing); "look" (turn
 * the camera: yaw / pitch in degrees, or towards a point); "walk_to" walks (or runs) with the real
 * movement (slopes, water, collision) until the target is reached, the player is stuck or the time
 * runs out; "jump".
 */
export async function controlPlayer(
    host: PlayerHost,
    payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
    const action =
        typeof payload.action === 'string' ? payload.action : 'state';

    // Walk mode drives the same character in the editor: no switch to play mode needed.
    if (action !== 'state' && host.mode() !== 'play' && !host.walking?.()) {
        host.play();
        await frames(2);
    }

    switch (action) {
        case 'state':
            return playerState(host);
        case 'teleport': {
            const x = Number(payload.x);
            const z = Number(payload.z);

            if (!host.contains(x, z)) {
                throw new Error(`(${x}, ${z}) is outside the map.`);
            }

            const yaw =
                typeof payload.facing === 'number'
                    ? rad(payload.facing)
                    : host.yaw();
            host.teleport(x, z, yaw);
            host.setView(yaw);
            await frames(3);

            return playerState(host);
        }
        case 'look': {
            const target = payload.look_at as
                | { x: number; z: number }
                | undefined;
            const p = host.position();
            const yaw = target
                ? yawTowards(p.x, p.z, target.x, target.z)
                : typeof payload.yaw === 'number'
                  ? rad(payload.yaw)
                  : host.view().yaw;
            const pitch =
                typeof payload.pitch === 'number'
                    ? rad(payload.pitch)
                    : undefined;
            host.setView(yaw, pitch);
            await frames(3);

            return playerState(host);
        }
        case 'jump':
            host.hold('Space', true);
            await frames(1);
            host.hold('Space', false);
            await wait(900);

            return playerState(host);
        case 'walk_to':
            return walkTo(host, payload);
        default:
            throw new Error(`Unknown player action ${action}.`);
    }
}

async function walkTo(
    host: PlayerHost,
    payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
    const tx = Number(payload.x);
    const tz = Number(payload.z);

    if (!host.contains(tx, tz)) {
        throw new Error(`(${tx}, ${tz}) is outside the map.`);
    }

    const run = payload.run === true;
    const tolerance = Math.max(0.3, Number(payload.tolerance) || 1);
    const limit =
        Math.min(WALK_MAX_S, Math.max(1, Number(payload.timeout) || 30)) * 1000;
    const start = performance.now();
    const from = host.position().clone();
    let travelled = 0;
    let last = from.clone();
    let checkpoint = { at: start, pos: from.clone() };
    let outcome: 'reached' | 'stuck' | 'timeout' = 'timeout';

    try {
        if (run) {
            host.hold('ShiftLeft', true);
        }

        host.hold('KeyW', true);

        while (performance.now() - start < limit) {
            const p = host.position();
            const d = Math.hypot(tx - p.x, tz - p.z);

            if (d <= tolerance) {
                outcome = 'reached';
                break;
            }

            host.setView(yawTowards(p.x, p.z, tx, tz));
            await frames(1);
            const now = host.position();
            travelled += Math.hypot(now.x - last.x, now.z - last.z);
            last = now.clone();

            // Stuck: less than 0.5 m of progress in 2.5 s (a wall, a cliff, deep water).
            if (performance.now() - checkpoint.at > 2500) {
                if (
                    Math.hypot(
                        now.x - checkpoint.pos.x,
                        now.z - checkpoint.pos.z,
                    ) < 0.5
                ) {
                    outcome = 'stuck';
                    break;
                }

                checkpoint = { at: performance.now(), pos: now.clone() };
            }
        }
    } finally {
        host.hold('KeyW', false);
        host.hold('ShiftLeft', false);
    }

    await frames(10);
    const end = host.position();

    return {
        outcome,
        distance_left_m:
            Math.round(Math.hypot(tx - end.x, tz - end.z) * 10) / 10,
        travelled_m: Math.round(travelled * 10) / 10,
        seconds: Math.round((performance.now() - start) / 100) / 10,
        ...playerState(host),
    };
}

function frames(n: number): Promise<void> {
    return new Promise((resolve) => {
        const step = (left: number) =>
            left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1));
        step(n);
    });
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}
