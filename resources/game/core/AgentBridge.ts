import type { Api } from './Api';

/** What the game exposes to agents: its current state and the commands it can run. */
export type AgentBridgeHost = {
    mode(): 'edit' | 'play';
    /** Small state sent with every poll (camera, view mode, unsaved changes, …). */
    state(): Record<string, unknown>;
    /** Runs one command; resolves to its result or rejects with a message for the agent. */
    execute(type: string, payload: Record<string, unknown>): Promise<unknown>;
};

type Command = {
    id: number;
    type: string;
    payload: Record<string, unknown>;
};

/** Poll interval while idle (ms); commands queued by an agent wait at most this long. */
const POLL_MS = 1000;

/**
 * The game's side of the agent bridge (App\Mcp\EditorBridge): polls the server for commands queued
 * by AI agents through the MCP server, runs them one at a time and posts each result back. Every open
 * tab is its own session; a command is claimed by exactly one of them.
 */
export class AgentBridge {
    private readonly session =
        globalThis.crypto?.randomUUID?.() ??
        `s${Date.now()}${Math.random().toString(16).slice(2)}`;
    private timer = 0;
    private stopped = false;

    constructor(
        private readonly api: Api,
        private readonly url: string,
        private readonly host: AgentBridgeHost,
    ) {}

    start(): void {
        this.schedule(0);
    }

    stop(): void {
        this.stopped = true;
        window.clearTimeout(this.timer);
    }

    private schedule(delay: number): void {
        if (!this.stopped) {
            this.timer = window.setTimeout(() => void this.poll(), delay);
        }
    }

    private async poll(): Promise<void> {
        let commands: Command[] = [];

        try {
            const response = await this.api.postJson<{ commands: Command[] }>(
                `${this.url}/poll`,
                {
                    session: this.session,
                    mode: this.host.mode(),
                    state: this.host.state(),
                },
            );
            commands = response.commands;
        } catch {
            // Server restarting or offline: try again later.
        }

        for (const command of commands) {
            await this.run(command);
        }

        // Straight back after work: agents often send several commands in a row.
        this.schedule(commands.length ? 50 : POLL_MS);
    }

    private async run(command: Command): Promise<void> {
        let body: { ok: boolean; result?: unknown; error?: string };

        try {
            body = {
                ok: true,
                result: await this.host.execute(command.type, command.payload),
            };
        } catch (error) {
            body = {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }

        try {
            await this.api.postJson(`${this.url}/commands/${command.id}`, body);
        } catch {
            // The agent times out and reports it.
        }
    }
}
