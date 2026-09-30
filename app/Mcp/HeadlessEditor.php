<?php

namespace App\Mcp;

use App\Mcp\Headless\BrowserLauncher;
use App\Mcp\Headless\BrowserLocator;
use App\Models\AgentCommand;
use App\Models\AgentSession;
use App\Models\HeadlessBrowser;
use App\Models\Map;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Carbon;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\File;

/**
 * Hidden editors: the MCP server starts a headless browser on a map's game page in edit mode, so
 * agents can build and render without the user having the map open (e.g. overnight).
 *
 * The page opens with `?agent=1` and reports `headless: true` in the state of every bridge poll,
 * which is how its session is told apart from the user's own tabs. Rules:
 * - One editor per map. open_editor uses an editor that is already open (the user's or a hidden one)
 *   and never starts a second one next to it.
 * - The user wins: when the user opens a map that has a hidden editor, the hidden one stops taking
 *   commands (they go to the user's tab), saves its unsaved edits and closes, so two editors never
 *   save over each other.
 * - A hidden editor that ran no command for `idle_minutes` saves and closes. Checked on the hidden
 *   editor's own polls, on every MCP tool call and by the scheduler (`waterways:headless stop --idle`).
 * - close_editor and `waterways:headless stop` close only browsers this service started.
 */
class HeadlessEditor
{
    public function __construct(private readonly BrowserLauncher $launcher) {}

    /**
     * Makes sure an editor of the map is open: uses an open one, else starts a hidden editor and
     * (with `$wait`) waits until it runs.
     *
     * @return array<string, mixed>
     *
     * @throws ToolError when no browser is found, it exits or it does not load in time
     */
    public function open(Map $map, bool $wait = true): array
    {
        $this->sweep();

        $session = $this->bridge()->session($map);

        if ($session !== null) {
            $headless = self::isHeadless($session);

            if ($headless) {
                $this->touch($map);
            }

            return ['map' => $map->slug, 'status' => 'already_open', 'headless' => $headless, 'mode' => $session->mode];
        }

        $browser = HeadlessBrowser::query()->where('map_id', $map->id)->first() ?? $this->launch($map);

        if (! $wait) {
            return [
                'map' => $map->slug,
                'status' => 'loading',
                'headless' => true,
                'tip' => 'Call open_editor again (wait: true) to wait until it runs, or get_project_overview to see it in open_editors.',
            ];
        }

        $timeout = (int) config('services.mcp.headless.start_timeout', 120);
        $deadline = microtime(true) + $timeout;

        while (microtime(true) < $deadline) {
            $this->sleep();

            $session = $this->bridge()->session($map);

            if ($session !== null) {
                return [
                    'map' => $map->slug,
                    'status' => 'open',
                    'headless' => self::isHeadless($session),
                    'mode' => $session->mode,
                    'loaded_in_s' => (int) $browser->started_at->diffInSeconds(Carbon::now()),
                    'closes_when_idle_min' => $this->idleMinutes(),
                ];
            }

            if (! $this->launcher->running($browser->pid, $browser->profile_dir)) {
                $this->forget($browser);

                throw new ToolError("The hidden editor's browser exited while loading \"{$map->slug}\".".$this->logTail($map));
            }
        }

        throw new ToolError("The hidden editor of \"{$map->slug}\" did not finish loading within {$timeout} s. It keeps loading: call open_editor again to wait longer, or close_editor to stop it.".$this->logTail($map));
    }

    /**
     * Closes the hidden editor of the map (never the user's own tabs).
     *
     * @return array<string, mixed>
     *
     * @throws ToolError when none runs or it holds unsaved edits
     */
    public function close(Map $map, bool $discardUnsaved = false): array
    {
        $browser = HeadlessBrowser::query()->where('map_id', $map->id)->first();

        if ($browser === null) {
            throw new ToolError($this->userSession($map) !== null
                ? "Map \"{$map->slug}\" is open in the user's own editor; close_editor only closes hidden editors started with open_editor."
                : "No hidden editor of \"{$map->slug}\" is running.");
        }

        $unsaved = $this->headlessSession($map)?->state['unsaved'] ?? [];

        if ($unsaved !== [] && ! $discardUnsaved) {
            throw new ToolError('The hidden editor has unsaved changes ('.implode(', ', $unsaved).'). Save them first (control_editor action "save"), or pass discard_unsaved: true to drop them.');
        }

        $ranFor = (int) $browser->started_at->diffInSeconds(Carbon::now());
        $this->stop($browser);

        return ['map' => $map->slug, 'status' => 'closed', 'ran_for_s' => $ranFor];
    }

    /** Marks the map's hidden editor as used (it closes after idle_minutes without use). */
    public function touch(Map $map): void
    {
        HeadlessBrowser::query()->where('map_id', $map->id)->update(['last_used_at' => Carbon::now()]);
    }

    /**
     * Closes hidden editors whose browser exited, that sat idle, or whose map the user opened
     * (after saving their unsaved edits; that takes a few polls).
     *
     * @return list<string> what was closed and why
     */
    public function sweep(): array
    {
        $closed = [];

        foreach (HeadlessBrowser::query()->with('map')->get() as $browser) {
            if (! $this->launcher->running($browser->pid, $browser->profile_dir)) {
                $this->forget($browser);
                $closed[] = "{$browser->map->slug}: the browser had exited";

                continue;
            }

            $reason = $this->retireReason($browser);

            if ($reason !== null && $this->retire($browser)) {
                $closed[] = "{$browser->map->slug}: {$reason}";
            }
        }

        return $closed;
    }

    /**
     * Called on each poll of a hidden editor (App\Mcp\EditorBridge::poll): 'serve' when it takes
     * commands as usual, 'yield' when it only runs commands addressed to it (it is saving before it
     * closes; the user's tab gets the agent's commands), 'closed' when it was just closed.
     *
     * @return 'serve'|'yield'|'closed'
     */
    public function onPoll(Map $map): string
    {
        $browser = HeadlessBrowser::query()->where('map_id', $map->id)->first();

        // A page opened with ?agent=1 by hand is not ours: it behaves like any editor.
        if ($browser === null || $this->retireReason($browser) === null) {
            return 'serve';
        }

        return $this->retire($browser) ? 'closed' : 'yield';
    }

    /** @return Collection<int, HeadlessBrowser> */
    public function all(): Collection
    {
        return HeadlessBrowser::query()->with('map')->orderBy('id')->get();
    }

    public function running(HeadlessBrowser $browser): bool
    {
        return $this->launcher->running($browser->pid, $browser->profile_dir);
    }

    /** Stops the browser right away (unsaved edits in it are lost). */
    public function stop(HeadlessBrowser $browser): void
    {
        $this->launcher->stop($browser->pid, $browser->profile_dir);
        $this->forget($browser);
    }

    public static function isHeadless(AgentSession $session): bool
    {
        return ($session->state['headless'] ?? false) === true;
    }

    /**
     * The URL the hidden editor opens: the game page in edit mode with the `agent=1` flag.
     */
    public function url(Map $map): string
    {
        $template = (string) config('services.mcp.headless.url');
        $url = $template !== '' ? str_replace('{map}', $map->slug, $template) : route('game.show', $map);

        return $url.(str_contains($url, '?') ? '&' : '?').'agent=1';
    }

    /**
     * Browser flags. Headless pages count as visible, so the game keeps rendering and polling; the
     * background-throttling switches make sure of that.
     *
     * @return list<string>
     */
    public function arguments(string $profileDir, string $url): array
    {
        $extra = preg_split('/\s+/', trim((string) config('services.mcp.headless.flags')), -1, PREG_SPLIT_NO_EMPTY) ?: [];
        // Chrome refuses to run as root without it (containers, CI).
        $root = function_exists('posix_geteuid') && posix_geteuid() === 0 ? ['--no-sandbox'] : [];

        return [
            '--headless=new',
            "--user-data-dir={$profileDir}",
            '--window-size='.config('services.mcp.headless.window', '1600,900'),
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding',
            '--disable-backgrounding-occluded-windows',
            '--mute-audio',
            ...$root,
            ...$extra,
            $url,
        ];
    }

    public function logFile(Map $map): string
    {
        return storage_path("logs/headless-{$map->slug}.log");
    }

    private function launch(Map $map): HeadlessBrowser
    {
        $binary = (new BrowserLocator(config('services.mcp.headless.browser')))->find();
        $profile = storage_path("app/headless/profile-{$map->id}");
        File::ensureDirectoryExists($profile);
        File::ensureDirectoryExists(dirname($this->logFile($map)));
        $url = $this->url($map);

        $pid = $this->launcher->launch($binary, $this->arguments($profile, $url), $this->logFile($map));

        try {
            return HeadlessBrowser::query()->create([
                'map_id' => $map->id,
                'pid' => $pid,
                'browser' => $binary,
                'url' => $url,
                'profile_dir' => $profile,
                'started_at' => Carbon::now(),
                'last_used_at' => Carbon::now(),
            ]);
        } catch (UniqueConstraintViolationException) {
            // Another call started one at the same moment: keep that one.
            $this->launcher->stop($pid, $profile);

            return HeadlessBrowser::query()->where('map_id', $map->id)->firstOrFail();
        }
    }

    /** Why the hidden editor should close now, or null. */
    private function retireReason(HeadlessBrowser $browser): ?string
    {
        $map = $browser->map;

        if ($this->userSession($map) !== null) {
            return 'the user opened the map';
        }

        if ($browser->last_used_at->lt(Carbon::now()->subMinutes($this->idleMinutes()))) {
            return "idle for more than {$this->idleMinutes()} min";
        }

        return null;
    }

    /**
     * Closes the hidden editor, saving its unsaved edits first: queues one save command addressed to
     * it and closes once that finished (or failed). True when it was closed.
     */
    private function retire(HeadlessBrowser $browser): bool
    {
        $session = $this->headlessSession($browser->map);
        $unsaved = $session?->state['unsaved'] ?? [];

        if ($session === null || $unsaved === []) {
            $this->stop($browser);

            return true;
        }

        $save = $this->closingSaves([$session->id])->latest('id')->first();

        if ($save === null) {
            AgentCommand::query()->create([
                'map_id' => $browser->map_id,
                'session_id' => $session->id,
                'type' => 'save',
                'payload' => ['closing' => true],
                'status' => 'pending',
            ]);

            return false;
        }

        if ($save->status === 'done' || $save->status === 'failed') {
            $save->delete();
            $this->stop($browser);

            return true;
        }

        return false;
    }

    private function forget(HeadlessBrowser $browser): void
    {
        $sessions = AgentSession::query()->where('map_id', $browser->map_id)->get()
            ->filter(fn (AgentSession $s) => self::isHeadless($s))
            ->modelKeys();

        // Its sessions (it no longer counts as open) and the commands only it would have run.
        $this->closingSaves($sessions)->delete();
        AgentSession::query()->whereKey($sessions)->delete();

        $browser->delete();
    }

    /**
     * The saves queued by retire() for these sessions (not the agents' own saves).
     *
     * @param  array<int, string>  $sessions
     * @return Builder<AgentCommand>
     */
    private function closingSaves(array $sessions): Builder
    {
        return AgentCommand::query()
            ->whereIn('session_id', $sessions)
            ->where('type', 'save')
            ->where('payload->closing', true);
    }

    /** The user's own open editor of the map (not a hidden one). */
    private function userSession(Map $map): ?AgentSession
    {
        return $this->liveSessions($map)->first(fn (AgentSession $s) => ! self::isHeadless($s));
    }

    private function headlessSession(Map $map): ?AgentSession
    {
        return $this->liveSessions($map)->first(fn (AgentSession $s) => self::isHeadless($s));
    }

    /** @return Collection<int, AgentSession> */
    private function liveSessions(Map $map): Collection
    {
        return AgentSession::query()
            ->where('map_id', $map->id)
            ->where('last_seen_at', '>=', Carbon::now()->subSeconds(EditorBridge::SESSION_TIMEOUT))
            ->latest('last_seen_at')
            ->get();
    }

    private function idleMinutes(): int
    {
        return max(1, (int) config('services.mcp.headless.idle_minutes', 15));
    }

    private function logTail(Map $map): string
    {
        $file = $this->logFile($map);

        if (! is_file($file)) {
            return '';
        }

        $lines = array_slice(file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [], -8);

        return $lines === [] ? '' : " Browser log ({$file}):\n".implode("\n", $lines);
    }

    private function bridge(): EditorBridge
    {
        return app(EditorBridge::class);
    }

    protected function sleep(): void
    {
        usleep(500_000);
    }
}
