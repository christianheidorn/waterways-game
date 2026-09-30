/**
 * postMessage protocol between the studio shell (Laravel/React page hosting the iframe)
 * and the game running inside the iframe.
 */
import type {
    EnvironmentSettings,
    FoliageType,
    GameSettings,
    TerrainLayer,
} from './types';

export type GameMode = 'edit' | 'play';

export type EditorToolGroup =
    | 'sculpt'
    | 'paint'
    | 'foliage'
    | 'water'
    | 'place'
    | 'request'
    /** World settings (layers, environment), history, snapshots and new maps. */
    | 'world';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** One foliage type's LOD chain and what it currently costs (Foliage.stats()). */
export type FoliageTypeStat = {
    name: string;
    kind: string;
    /** procedural = built-in mesh, baked = FoliageAsset GLB, model = other GLB, loading = model pending. */
    source: 'procedural' | 'baked' | 'model' | 'loading';
    /** Stored instances. */
    instances: number;
    /** Instances submitted in the main pass (frustum-culled cells excluded). */
    drawn: number;
    drawCalls: number;
    triangles: number;
    /** Triangles per instance of each LOD (LOD0 first). */
    lodTriangles: number[];
    /** Instances drawn with each LOD (same order). */
    lodInstances: number[];
    /** Distance (m) where each LOD starts, after foliage distance scale and LOD bias. */
    lodDistances: number[];
    /** Cull distance (m) after the foliage distance scale. */
    cullDistance: number;
    /** Cells casting shadows (GPU-culled foliage: instances in the shadow list). */
    shadowCasters: number;
    /** Instances rejected by GPU occlusion culling (WebGPU only). */
    occluded?: number;
    /** LODs generated at runtime (simplified mid LOD, impostor, …). */
    generated: string[];
    /** Missing / over-budget LODs worth fixing (e.g. rebake the asset). */
    warnings: string[];
};

export type GameStats = {
    fps: number;
    frameMs: number;
    drawCalls: number;
    triangles: number;
    position: { x: number; y: number; z: number };
    foliageInstances: number;
    /** Foliage instances / draw calls / triangles submitted in the main pass (see Foliage.stats()). */
    foliageDrawn?: number;
    foliageDrawCalls?: number;
    foliageTriangles?: number;
    /** Per foliage type LOD / culling detail (see Foliage.stats().types). */
    foliageTypes?: FoliageTypeStat[];
    /** Effective render scale (× device pixel ratio) while dynamic resolution is active. */
    renderScale?: number;
    /** GPU time of the last measured frame (ms), when EXT_disjoint_timer_query is available. */
    gpuMs?: number;
};

/** Messages the shell sends into the game. */
export type ShellToGameMessage =
    | { type: 'setMode'; mode: GameMode; fromCamera?: boolean }
    | { type: 'save' }
    | { type: 'reload' }
    | { type: 'undo' }
    | { type: 'redo' }
    | { type: 'setToolGroup'; group: EditorToolGroup }
    | { type: 'updateEnvironment'; environment: Partial<EnvironmentSettings> }
    | {
          type: 'updateSettings';
          settings: Partial<{
              [K in keyof GameSettings]: Partial<GameSettings[K]>;
          }>;
      }
    | { type: 'updateLayers'; layers: TerrainLayer[] }
    | { type: 'updateFoliageTypes'; foliageTypes: FoliageType[] }
    | { type: 'focusGame' }
    /** Ask the game for a screenshot of the current view (used by the AI review). */
    | { type: 'captureScreenshot'; requestId: string };

/** Messages the game posts to the shell. */
export type GameToShellMessage =
    | { type: 'ready'; mapId: number; mode: GameMode }
    | { type: 'loading'; progress: number; label: string }
    | { type: 'modeChanged'; mode: GameMode }
    | { type: 'dirty'; dirty: boolean }
    | { type: 'history'; canUndo: boolean; canRedo: boolean }
    | { type: 'saveState'; state: SaveState; message?: string }
    | { type: 'toolGroupChanged'; group: EditorToolGroup }
    | { type: 'stats'; stats: GameStats }
    | { type: 'error'; message: string }
    /** A foliage type edited in the in-game editor was saved to the studio library. */
    | { type: 'foliageTypeSaved'; foliageType: FoliageType }
    | { type: 'terrainLayerSaved'; layer: TerrainLayer }
    | {
          type: 'screenshot';
          requestId: string;
          /** JPEG data URL, max 1280 px wide, editor overlays hidden. */
          dataUrl: string;
          mode: GameMode;
          camera: {
              x: number;
              y: number;
              z: number;
              yaw: number;
              pitch: number;
          };
      };

export const SHELL_SOURCE = 'waterways-shell';
export const GAME_SOURCE = 'waterways-game';

export type Envelope<T> = { source: string; payload: T };

export function isEnvelope<T>(
    data: unknown,
    source: string,
): data is Envelope<T> {
    return (
        typeof data === 'object' &&
        data !== null &&
        (data as { source?: unknown }).source === source &&
        typeof (data as { payload?: unknown }).payload === 'object'
    );
}
