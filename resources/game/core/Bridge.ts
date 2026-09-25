import { GAME_SOURCE, isEnvelope, SHELL_SOURCE } from '../shared/protocol';
import type {
    GameToShellMessage,
    ShellToGameMessage,
} from '../shared/protocol';

type Handler = (message: ShellToGameMessage) => void;

/**
 * postMessage channel to the studio shell hosting this game in an iframe.
 */
export class Bridge {
    private handlers = new Set<Handler>();
    readonly embedded: boolean;

    constructor() {
        this.embedded = window.parent !== window;
        window.addEventListener('message', this.onMessage);
    }

    on(handler: Handler): () => void {
        this.handlers.add(handler);

        return () => this.handlers.delete(handler);
    }

    send(message: GameToShellMessage): void {
        if (!this.embedded) {
            return;
        }

        window.parent.postMessage(
            { source: GAME_SOURCE, payload: message },
            window.location.origin,
        );
    }

    dispose(): void {
        window.removeEventListener('message', this.onMessage);
        this.handlers.clear();
    }

    private onMessage = (event: MessageEvent): void => {
        if (
            event.origin !== window.location.origin ||
            !isEnvelope<ShellToGameMessage>(event.data, SHELL_SOURCE)
        ) {
            return;
        }

        for (const handler of this.handlers) {
            handler(event.data.payload);
        }
    };
}
