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

    const send = useCallback((message: ShellToGameMessage) => {
        iframeRef.current?.contentWindow?.postMessage(
            { source: SHELL_SOURCE, payload: message },
            window.location.origin,
        );
    }, []);

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

    return { iframeRef, state, send, onFrameLoad };
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
