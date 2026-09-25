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
    | 'place';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export type GameStats = {
    fps: number;
    frameMs: number;
    drawCalls: number;
    triangles: number;
    position: { x: number; y: number; z: number };
    foliageInstances: number;
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
    | { type: 'focusGame' };

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
    | { type: 'error'; message: string };

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
