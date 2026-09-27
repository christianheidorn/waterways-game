import { GAME_SOURCE, isEnvelope, SHELL_SOURCE } from '@game/shared/protocol';
import type {
    EditorToolGroup,
    GameMode,
    GameStats,
    GameToShellMessage,
    SaveState,
    ShellToGameMessage,
} from '@game/shared/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';

export type GameScreenshot = Extract<
    GameToShellMessage,
    { type: 'screenshot' }
>;

type PendingScreenshot = {
    resolve: (shot: GameScreenshot) => void;
    reject: (error: Error) => void;
    timer: number;
};

export type GameBridgeState = {
    ready: boolean;
    loading: { progress: number; label: string } | null;
    mode: GameMode;
    dirty: boolean;
    saveState: SaveState;
    saveMessage: string | null;
    canUndo: boolean;
    canRedo: boolean;
    toolGroup: EditorToolGroup;
    stats: GameStats | null;
    error: string | null;
};

/**
 * Two-way postMessage bridge between the studio shell and the game iframe.
 */
export function useGameBridge(initialMode: GameMode) {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const [state, setState] = useState<GameBridgeState>({
        ready: false,
        loading: { progress: 0, label: 'Starting engine' },
        mode: initialMode,
        dirty: false,
        saveState: 'idle',
        saveMessage: null,
        canUndo: false,
        canRedo: false,
        toolGroup: 'sculpt',
        stats: null,
        error: null,
    });

    const pendingShots = useRef(new Map<string, PendingScreenshot>());

    const send = useCallback((message: ShellToGameMessage) => {
        iframeRef.current?.contentWindow?.postMessage(
            { source: SHELL_SOURCE, payload: message },
            window.location.origin,
        );
    }, []);

    /** Asks the game for a JPEG of the current view (editor overlays hidden). */
    const captureScreenshot = useCallback(
        (timeoutMs = 15000): Promise<GameScreenshot> =>
            new Promise((resolve, reject) => {
                if (!iframeRef.current?.contentWindow) {
                    reject(new Error('The game is not running.'));

                    return;
                }

                const requestId =
                    typeof crypto !== 'undefined' && 'randomUUID' in crypto
                        ? crypto.randomUUID()
                        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
                const timer = window.setTimeout(() => {
                    pendingShots.current.delete(requestId);
                    reject(
                        new Error(
                            'The game did not return a screenshot in time.',
                        ),
                    );
                }, timeoutMs);
                pendingShots.current.set(requestId, { resolve, reject, timer });
                send({ type: 'captureScreenshot', requestId });
            }),
        [send],
    );

    useEffect(() => {
        const onMessage = (event: MessageEvent) => {
            if (
                event.origin !== window.location.origin ||
                event.source !== iframeRef.current?.contentWindow ||
                !isEnvelope<GameToShellMessage>(event.data, GAME_SOURCE)
            ) {
                return;
            }

            const message = event.data.payload;

            if (message.type === 'screenshot') {
                const pending = pendingShots.current.get(message.requestId);

                if (pending) {
                    window.clearTimeout(pending.timer);
                    pendingShots.current.delete(message.requestId);
                    pending.resolve(message);
                }

                return;
            }

            setState((prev) => reduce(prev, message));
        };

        window.addEventListener('message', onMessage);

        return () => window.removeEventListener('message', onMessage);
    }, []);

    /** Reset transient state when the iframe (re)loads. */
    const onFrameLoad = useCallback(() => {
        setState((prev) => ({
            ...prev,
            ready: false,
            loading: prev.loading ?? { progress: 0, label: 'Starting engine' },
            dirty: false,
            saveState: 'idle',
            error: null,
        }));
    }, []);

    // Reject outstanding screenshot requests on unmount.
    useEffect(() => {
        const pending = pendingShots.current;

        return () => {
            pending.forEach((p) => {
                window.clearTimeout(p.timer);
                p.reject(new Error('The studio was closed.'));
            });
            pending.clear();
        };
    }, []);

    return { iframeRef, state, send, onFrameLoad, captureScreenshot };
}

function reduce(
    prev: GameBridgeState,
    message: GameToShellMessage,
): GameBridgeState {
    switch (message.type) {
        case 'ready':
            return { ...prev, ready: true, loading: null, mode: message.mode };
        case 'loading':
            return {
                ...prev,
                loading: { progress: message.progress, label: message.label },
            };
        case 'modeChanged':
            return { ...prev, mode: message.mode };
        case 'dirty':
            return { ...prev, dirty: message.dirty };
        case 'history':
            return {
                ...prev,
                canUndo: message.canUndo,
                canRedo: message.canRedo,
            };
        case 'saveState':
            return {
                ...prev,
                saveState: message.state,
                saveMessage: message.message ?? null,
                dirty: message.state === 'saved' ? false : prev.dirty,
            };
        case 'toolGroupChanged':
            return { ...prev, toolGroup: message.group };
        case 'stats':
            return { ...prev, stats: message.stats };
        case 'error':
            return { ...prev, error: message.message, loading: null };
        default:
            return prev;
    }
}
