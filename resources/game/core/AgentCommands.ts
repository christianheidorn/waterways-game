import * as THREE from 'three/webgpu';
import type { AgentBridgeHost } from './AgentBridge';
import type { GameMode } from '../shared/protocol';
import type { TerrainViewMode } from '../world/TerrainDebugView';
import type { Heightfield } from '../world/Heightfield';
import { bakeFoliageAssetInBackground } from '../editor/agent/bakeFoliageAsset';
import type { FoliageBakeJob } from '../editor/agent/bakeFoliageAsset';

/** What the agent commands need from the game (built by Game; keeps them out of its internals). */
export type AgentContext = {
    camera: THREE.PerspectiveCamera;
    heights: () => Heightfield;
    spawn: () => { x: number; z: number; yaw: number } | null;
    mode: () => GameMode;
    setMode: (mode: GameMode) => void;
    /** The editor's fly camera takes over the current camera transform. */
    syncFlyCamera: () => void;
    viewMode: () => TerrainViewMode;
    setViewMode: (mode: TerrainViewMode) => void;
    /** Foliage around the camera is still growing / building. */
    settling: () => boolean;
    /** Renders a still frame and returns it (JPEG), scaled to at most maxWidth. */
    capture: (maxWidth: number) => {
        dataUrl: string;
        width: number;
        height: number;
    };
    unsaved: () => string[];
    save: () => Promise<void>;
    history: () => { canUndo: boolean; canRedo: boolean };
    undo: () => void;
    redo: () => void;
    autoPaint: () => void;
    /** A scripted world edit (editor/agent/runWorldEdit); throws with a message for the agent. */
    worldEdit: (payload: Record<string, unknown>) => Record<string, unknown>;
    refresh: (parts: string[]) => Promise<void>;
    reload: () => void;
    editorState: () => Record<string, unknown>;
    stats: () => Record<string, unknown>;
};

const VIEW_MODES: readonly TerrainViewMode[] = [
    'lit',
    'lighting',
    'layers',
    'slope',
    'height',
    'density',
    'wireframe',
];

type Vec = { x: number; y?: number; z: number };

const HEADLESS = new URLSearchParams(location.search).get('agent') === '1';

/** Longest a screenshot waits for foliage to grow after the camera moved (ms). */
const SETTLE_MAX_MS = 10000;

/**
 * The commands AI agents can run in the open editor (see App\Mcp\EditorBridge and the MCP tools
 * take_screenshot, set_camera, get_editor_state and control_editor).
 */
export function createAgentHost(ctx: AgentContext): AgentBridgeHost {
    const cameraState = () => {
        const p = ctx.camera.position;
        const dir = ctx.camera.getWorldDirection(new THREE.Vector3());

        return {
            position: round3({ x: p.x, y: p.y, z: p.z }),
            direction: round3({ x: dir.x, y: dir.y, z: dir.z }),
            fov: ctx.camera.fov,
        };
    };

    const state = () => {
        const h = ctx.history();

        return {
            mode: ctx.mode(),
            camera: cameraState(),
            view_mode: ctx.viewMode(),
            unsaved: ctx.unsaved(),
            can_undo: h.canUndo,
            can_redo: h.canRedo,
            tab_visible: !document.hidden,
            // A hidden editor the MCP server started (App\Mcp\HeadlessEditor opens ?agent=1).
            headless: HEADLESS,
            ...ctx.editorState(),
        };
    };

    /** Places the camera from a take_screenshot / set_camera payload; false when nothing changes. */
    const place = (payload: Record<string, unknown>): boolean => {
        const heights = ctx.heights();
        const ground = (x: number, z: number) =>
            heights.contains(x, z) ? heights.sample(x, z) : 0;
        const position = payload.position as Vec | undefined;
        const lookAt = payload.look_at as Vec | undefined;
        const view = (payload.view as string | undefined) ?? 'current';
        const cam = ctx.camera;
        const size = heights.size;

        if (position) {
            const y = position.y ?? ground(position.x, position.z) + 2;
            cam.position.set(position.x, y, position.z);
            const target = lookAt
                ? new THREE.Vector3(
                      lookAt.x,
                      lookAt.y ?? ground(lookAt.x, lookAt.z),
                      lookAt.z,
                  )
                : new THREE.Vector3(position.x, y, position.z - 1);
            cam.lookAt(target);
        } else if (view === 'top_down') {
            const cx = lookAt?.x ?? 0;
            const cz = lookAt?.z ?? 0;
            const g = ground(cx, cz);
            // Whole map in view unless a height is given; north (−z) at the top.
            const h =
                (payload.height as number | undefined) ??
                (size * 0.55) / Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
            cam.position.set(cx, g + h, cz + h * 1e-3);
            cam.lookAt(cx, g, cz);
        } else if (view === 'overview') {
            const h = (payload.height as number | undefined) ?? size * 0.45;
            const cx = lookAt?.x ?? 0;
            const cz = lookAt?.z ?? 0;
            cam.position.set(cx, ground(cx, cz) + h, cz + size * 0.62);
            cam.lookAt(cx, ground(cx, cz), cz - size * 0.05);
        } else if (view === 'spawn') {
            const s = ctx.spawn() ?? { x: 0, z: 0, yaw: 0 };
            const y = ground(s.x, s.z) + 1.7;
            cam.position.set(s.x, y, s.z);
            cam.lookAt(
                s.x - Math.sin(s.yaw) * 10,
                y - 0.3,
                s.z - Math.cos(s.yaw) * 10,
            );
        } else {
            return false;
        }

        cam.updateMatrixWorld();
        ctx.syncFlyCamera();

        return true;
    };

    const requireEdit = (action: string) => {
        if (ctx.mode() !== 'edit') {
            throw new Error(
                `The game is in play mode; ${action} needs the editor (control_editor set_mode edit).`,
            );
        }
    };

    const requireVisible = () => {
        if (document.hidden) {
            throw new Error(
                'The editor tab is in the background, where the browser pauses rendering. Ask the user to bring it to the front.',
            );
        }
    };

    const setView = (mode: unknown) => {
        if (!VIEW_MODES.includes(mode as TerrainViewMode)) {
            throw new Error(`Unknown view mode ${String(mode)}.`);
        }

        ctx.setViewMode(mode as TerrainViewMode);
    };

    const screenshot = async (payload: Record<string, unknown>) => {
        requireVisible();
        const saved = {
            position: ctx.camera.position.clone(),
            quaternion: ctx.camera.quaternion.clone(),
            viewMode: ctx.viewMode(),
        };
        const moves =
            payload.position !== undefined ||
            (payload.view !== undefined && payload.view !== 'current');

        if (moves) {
            requireEdit('placing the camera');
            place(payload);
        }

        if (payload.view_mode) {
            setView(payload.view_mode);
        }

        await settle(moves || Boolean(payload.view_mode));
        const maxWidth = Math.min(
            1920,
            Math.max(256, Number(payload.max_width) || 1280),
        );
        const image = ctx.capture(maxWidth);
        const result = {
            mime: 'image/jpeg',
            image: image.dataUrl.slice(image.dataUrl.indexOf(',') + 1),
            width: image.width,
            height: image.height,
            mode: ctx.mode(),
            view_mode: ctx.viewMode(),
            camera: cameraState(),
        };

        if (!payload.keep_camera) {
            if (moves) {
                ctx.camera.position.copy(saved.position);
                ctx.camera.quaternion.copy(saved.quaternion);
                ctx.camera.updateMatrixWorld();
                ctx.syncFlyCamera();
            }

            if (payload.view_mode) {
                ctx.setViewMode(saved.viewMode);
            }
        }

        return result;
    };

    /** Waits a few frames, and after a camera move until foliage around it has grown. */
    const settle = async (moved: boolean) => {
        const start = performance.now();
        let frames = 0;

        while (performance.now() - start < SETTLE_MAX_MS) {
            await nextFrame();
            frames++;

            if (frames >= (moved ? 12 : 3) && (!moved || !ctx.settling())) {
                break;
            }
        }
    };

    return {
        mode: ctx.mode,
        state,
        async execute(type, payload) {
            switch (type) {
                case 'state':
                    return { ...state(), stats: ctx.stats() };
                case 'screenshot':
                    return screenshot(payload);
                case 'camera':
                    requireEdit('moving the camera');
                    place(payload);

                    return { camera: cameraState() };
                case 'set_view_mode':
                    setView(payload.view_mode);

                    return { view_mode: ctx.viewMode() };
                case 'set_mode':
                    ctx.setMode(payload.mode === 'play' ? 'play' : 'edit');

                    return { mode: ctx.mode() };
                case 'save': {
                    const channels = ctx.unsaved();
                    await ctx.save();

                    return { saved: channels, still_unsaved: ctx.unsaved() };
                }
                case 'undo':
                case 'redo': {
                    const steps = Math.max(1, Number(payload.steps) || 1);
                    let done = 0;

                    for (; done < steps; done++) {
                        const h = ctx.history();

                        if (type === 'undo' ? !h.canUndo : !h.canRedo) {
                            break;
                        }

                        if (type === 'undo') {
                            ctx.undo();
                        } else {
                            ctx.redo();
                        }
                    }

                    return {
                        steps: done,
                        ...ctx.history(),
                        unsaved: ctx.unsaved(),
                    };
                }
                case 'world_edit': {
                    requireEdit('editing the world');
                    const result = ctx.worldEdit(payload);

                    if (payload.save !== false) {
                        await ctx.save();
                    }

                    return {
                        result,
                        undo: 'control_editor action "undo" reverts this edit (one step).',
                        unsaved: ctx.unsaved(),
                    };
                }
                case 'auto_paint':
                    requireEdit('auto paint');
                    ctx.autoPaint();

                    return { unsaved: ctx.unsaved() };
                case 'refresh':
                    await ctx.refresh(
                        Array.isArray(payload.parts)
                            ? (payload.parts as string[])
                            : [],
                    );

                    return {};
                case 'bake_foliage_asset':
                    // Answers right away; the server watches the asset's status while it bakes.
                    bakeFoliageAssetInBackground(
                        payload as unknown as FoliageBakeJob,
                        () => ctx.refresh(['foliage_types']),
                    );

                    return { started: true };
                case 'reload':
                    // Answer first: the page goes away.
                    window.setTimeout(ctx.reload, 100);

                    return {};
                default:
                    throw new Error(`Unknown editor command "${type}".`);
            }
        },
    };
}

function nextFrame(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function round3<T extends Record<string, number>>(v: T): T {
    return Object.fromEntries(
        Object.entries(v).map(([k, n]) => [k, Math.round(n * 1000) / 1000]),
    ) as T;
}
