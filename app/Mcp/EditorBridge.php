<?php

namespace App\Mcp;

use App\Models\AgentCommand;
use App\Models\AgentSession;
use App\Models\HeadlessBrowser;
use App\Models\Map;
use Illuminate\Support\Carbon;

/**
 * The live bridge between the MCP server and an open editor. World edits, screenshots and other
 * engine work run in the game, so the server queues a command for the map's open editor, which polls
 * for commands (about once a second), runs them and posts the result back. The two sides only share
 * the database: the MCP server can run as its own process (stdio) next to the web server.
 */
class EditorBridge
{
    /**
     * An editor that has not polled for this long is considered closed. Generous: loading a map or
     * compiling shaders can block the page's main thread for several seconds.
     */
    public const SESSION_TIMEOUT = 20;

    /** Map tools without an explicit map default to the map open in an editor within this time. */
    private const RECENT_MINUTES = 30;

    /** Commands nobody picked up are dropped after this long. */
    private const STALE_COMMAND = 120;

    /** The most recently active open editor of a map (or of any map). */
    public function session(?Map $map = null): ?AgentSession
    {
        return AgentSession::query()
            ->when($map !== null, fn ($q) => $q->where('map_id', $map->id))
            ->where('last_seen_at', '>=', Carbon::now()->subSeconds(self::SESSION_TIMEOUT))
            ->latest('last_seen_at')
            ->first();
    }

    /** The map most recently open in an editor (the default target of map tools). */
    public function recentMap(): ?Map
    {
        return AgentSession::query()
            ->where('last_seen_at', '>=', Carbon::now()->subMinutes(self::RECENT_MINUTES))
            ->latest('last_seen_at')
            ->first()?->map;
    }

    /**
     * Runs a command in the open editor of the map and waits for its result.
     *
     * @param  array<string, mixed>  $payload
     * @return array<string, mixed>
     *
     * @throws ToolError when no editor is open (and none may be started) or the command fails / times out
     */
    public function run(Map $map, string $type, array $payload = [], int $timeout = 30): array
    {
        if ($this->session($map) === null) {
            if (! config('services.mcp.headless.auto')) {
                throw new ToolError($this->notOpenMessage($map));
            }

            // WATERWAYS_AUTO_HEADLESS: start a hidden editor instead of failing.
            $this->headless()->open($map);
        }

        $this->headless()->touch($map);

        $command = AgentCommand::query()->create([
            'map_id' => $map->id,
            'type' => $type,
            'payload' => $payload,
            'status' => 'pending',
        ]);

        $deadline = microtime(true) + $timeout;

        while (microtime(true) < $deadline) {
            $this->sleep();
            $command->refresh();

            if ($command->status === 'done' || $command->status === 'failed') {
                $result = json_decode($command->result ?? 'null', true);
                $error = $command->error;
                $command->delete();
                $this->headless()->touch($map);

                if ($error !== null || $command->status === 'failed') {
                    throw new ToolError($error ?: "The editor could not run {$type}.");
                }

                return is_array($result) ? $result : [];
            }
        }

        $command->delete();

        throw new ToolError("The editor did not finish {$type} within {$timeout} s. Is the tab in the foreground? Browsers throttle background tabs.");
    }

    /**
     * Queues a command without waiting for it (live updates after a server-side change). Does nothing
     * when the map is not open.
     *
     * @param  array<string, mixed>  $payload
     */
    public function notify(Map $map, string $type, array $payload = []): bool
    {
        if ($this->session($map) === null) {
            return false;
        }

        AgentCommand::query()->create(['map_id' => $map->id, 'type' => $type, 'payload' => $payload, 'status' => 'pending']);

        return true;
    }

    /** Pushes a server-side change of shared data (foliage types, game settings) to every open editor. */
    public function notifyAll(string $type, array $payload = []): void
    {
        $maps = AgentSession::query()
            ->where('last_seen_at', '>=', Carbon::now()->subSeconds(self::SESSION_TIMEOUT))
            ->distinct()
            ->pluck('map_id');

        foreach ($maps as $mapId) {
            AgentCommand::query()->create(['map_id' => $mapId, 'type' => $type, 'payload' => $payload, 'status' => 'pending']);
        }
    }

    /**
     * Called by the editor's poll: records the session and hands out the map's pending commands.
     *
     * @param  array<string, mixed>|null  $state
     * @return list<array{id: int, type: string, payload: array<string, mixed>}>
     */
    public function poll(Map $map, string $sessionId, string $mode, ?array $state): array
    {
        AgentSession::query()->updateOrCreate(
            ['id' => $sessionId],
            ['map_id' => $map->id, 'mode' => $mode, 'state' => $state, 'last_seen_at' => Carbon::now()],
        );

        // A hidden editor (HeadlessEditor) steps aside when the user opens the same map or it sat
        // idle: it then only runs commands addressed to it (its final save) until it is closed.
        $headless = ($state['headless'] ?? false) === true ? $this->headless()->onPoll($map) : 'serve';

        if ($headless === 'closed') {
            return [];
        }

        AgentCommand::query()
            ->where('status', 'pending')
            ->where('created_at', '<', Carbon::now()->subSeconds(self::STALE_COMMAND))
            ->delete();

        $commands = AgentCommand::query()
            ->where('map_id', $map->id)
            ->where('status', 'pending')
            // Commands can be addressed to one session (session_id set when queued).
            ->when(
                $headless === 'yield',
                fn ($q) => $q->where('session_id', $sessionId),
                fn ($q) => $q->where(fn ($q) => $q->whereNull('session_id')->orWhere('session_id', $sessionId)),
            )
            ->orderBy('id')
            ->limit(10)
            ->get();

        $claimed = [];

        foreach ($commands as $command) {
            // Claim atomically: two open tabs of the same map never run a command twice.
            $won = AgentCommand::query()
                ->whereKey($command->id)
                ->where('status', 'pending')
                ->update(['status' => 'running', 'session_id' => $sessionId, 'claimed_at' => Carbon::now()]);

            if ($won === 1) {
                $claimed[] = ['id' => $command->id, 'type' => $command->type, 'payload' => $command->payload ?? []];
            }
        }

        return $claimed;
    }

    /** Called by the editor when a command finished. */
    public function complete(AgentCommand $command, bool $ok, mixed $result, ?string $error): void
    {
        $command->update([
            'status' => $ok ? 'done' : 'failed',
            'result' => json_encode($result),
            'error' => $ok ? null : ($error ?: 'Unknown error'),
            'finished_at' => Carbon::now(),
        ]);

        // The editor does not poll while it runs a command (a screenshot can take a while): the
        // answer is a sign of life too.
        if ($command->session_id !== null) {
            AgentSession::query()->whereKey($command->session_id)->update(['last_seen_at' => Carbon::now()]);
        }
    }

    public function notOpenMessage(Map $map): string
    {
        $browser = HeadlessBrowser::query()->where('map_id', $map->id)->first();

        if ($browser !== null) {
            $since = (int) $browser->started_at->diffInSeconds(Carbon::now());

            return "A hidden editor of \"{$map->slug}\" was started {$since} s ago but is not responding (still loading, or stuck)."
                .' Call open_editor to wait for it; if it does not come up, close_editor and open_editor again.'
                .' Its browser log is '.$this->headless()->logFile($map).'.';
        }

        $open = $this->session();
        $hint = $open !== null
            ? " The editor currently open is map \"{$open->map?->slug}\"; ask the user to open \"{$map->slug}\" instead (Studio → Maps → {$map->name} → Open Studio)."
            : " Ask the user to open it in the studio (Maps → {$map->name} → Open Studio) and keep the tab visible.";

        return "Map \"{$map->slug}\" is not open in an editor, and this needs the live game.".$hint
            .' Or start a hidden editor yourself with open_editor (no user needed; close_editor when done).';
    }

    private function headless(): HeadlessEditor
    {
        return app(HeadlessEditor::class);
    }

    protected function sleep(): void
    {
        usleep(100_000);
    }
}
