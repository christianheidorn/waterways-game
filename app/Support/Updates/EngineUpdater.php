<?php

namespace App\Support\Updates;

use App\Mcp\EditorBridge;
use App\Mcp\HeadlessEditor;
use App\Mcp\MapSnapshots;
use App\Mcp\ToolError;
use App\Models\AgentSession;
use App\Models\HeadlessBrowser;
use App\Models\Map;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Process;
use Illuminate\Support\Str;
use Throwable;

/**
 * Brings this checkout up to date with its upstream branch and rebuilds what changed
 * (`php artisan waterways:update`, MCP tool update_engine): the step of the autonomy loop that picks
 * up engine / editor changes merged on GitHub (docs/AUTONOMY.md).
 *
 * Order: check git (refuses on local changes unless forced) → snapshot every map → `git pull --ff-only`
 * → composer install / migrate / npm ci / npm run build, each only when its inputs changed → reload
 * open editors (hidden ones are closed and reopened). When a step after the pull fails, the checkout
 * goes back to the commit it was on (only when the pull happened in this run and the tree was clean)
 * and the dependencies and build are redone for it.
 *
 * Every command runs through the Process facade, so tests fake them (Process::fake()).
 */
class EngineUpdater
{
    /** Seconds a single install / build step may take. */
    public const STEP_TIMEOUT = 1200;

    /** @var list<string> */
    private array $log = [];

    public function __construct(
        private readonly MapSnapshots $snapshots,
        private readonly EditorBridge $bridge,
        private readonly HeadlessEditor $headless,
    ) {}

    /**
     * Fetches and reports whether updates are available, without changing anything.
     *
     * @return array<string, mixed>
     */
    public function check(): array
    {
        $this->log = [];
        $state = $this->gitState(fetch: true);

        return [
            'status' => $state['behind'] > 0 ? 'updates_available' : 'up_to_date',
            ...$state,
            'plan' => $state['behind'] > 0 ? $this->plan($state['changed_files']) : [],
        ];
    }

    /**
     * @return array<string, mixed>
     */
    public function update(bool $force = false, bool $dryRun = false): array
    {
        $this->log = [];
        $state = $this->gitState(fetch: true);
        $clean = $state['local_changes'] === [];

        if (! $clean && ! $force) {
            return [
                'status' => 'refused',
                'reason' => 'The checkout has uncommitted local changes. Commit or stash them, or pass --force (force: true) to update anyway (no automatic rollback then).',
                ...$state,
            ];
        }

        if ($state['behind'] === 0) {
            return ['status' => 'up_to_date', ...$state];
        }

        $plan = $this->plan($state['changed_files']);

        if ($dryRun) {
            return ['status' => 'dry_run', ...$state, 'plan' => $plan];
        }

        $snapshots = $this->snapshotMaps();
        $before = $state['head'];

        $pull = $this->git('pull --ff-only');

        if (! $pull['ok']) {
            return [
                'status' => 'failed',
                'failed_step' => 'git pull --ff-only',
                'error' => $pull['output'],
                'rolled_back' => false,
                'hint' => $state['ahead'] > 0
                    ? "The branch has {$state['ahead']} local commit(s) not on {$state['upstream']}: a fast-forward is not possible. Push or rebase them first."
                    : 'Nothing was changed. Check the error, fix it and run the update again.',
                ...$state,
                'snapshots' => $snapshots,
                'log' => $this->log,
            ];
        }

        $after = trim($this->git('rev-parse HEAD')['output']);
        $failure = $this->runPlan($plan);

        if ($failure !== null) {
            return $this->rollBack($state, $before, $after, $plan, $failure, $clean, $snapshots);
        }

        return [
            'status' => 'updated',
            'branch' => $state['branch'],
            'from' => $before,
            'to' => $after,
            'commits' => $state['behind'],
            'changed_files' => count($state['changed_files']),
            'steps' => array_keys(array_filter($plan)),
            'snapshots' => $snapshots,
            'editors' => $this->reloadEditors(),
            'mcp_server_changed' => $plan['reconnect_mcp'],
            'next' => $plan['reconnect_mcp']
                ? 'The MCP server\'s own PHP code changed: reconnect the Waterways MCP server (e.g. /mcp → reconnect in Claude Code) before using its tools again; this process still runs the old code.'
                : 'Done. The MCP server can keep running.',
            'log' => $this->log,
        ];
    }

    /**
     * Branch, upstream, how far behind / ahead it is, local changes and the files the update changes.
     *
     * @return array{branch: string, upstream: ?string, head: string, behind: int, ahead: int, local_changes: list<string>, changed_files: list<string>}
     */
    public function gitState(bool $fetch): array
    {
        $branch = trim($this->git('rev-parse --abbrev-ref HEAD')['output']);
        $head = trim($this->git('rev-parse HEAD')['output']);
        $upstreamResult = $this->git('rev-parse --abbrev-ref --symbolic-full-name @{u}');

        if (! $upstreamResult['ok'] || trim($upstreamResult['output']) === '') {
            throw new ToolError("The branch \"{$branch}\" has no upstream branch to update from. Set one with `git branch --set-upstream-to=origin/{$branch}`.");
        }

        $upstream = trim($upstreamResult['output']);

        if ($fetch) {
            $fetched = $this->git('fetch --quiet');

            if (! $fetched['ok']) {
                throw new ToolError('git fetch failed: '.$fetched['output']);
            }
        }

        $local = array_values(array_filter(explode("\n", $this->git('status --porcelain')['output']), fn ($l) => trim($l) !== ''));
        $behind = (int) trim($this->git('rev-list --count HEAD..@{u}')['output']);
        $ahead = (int) trim($this->git('rev-list --count @{u}..HEAD')['output']);
        $changed = $behind > 0
            ? array_values(array_filter(explode("\n", $this->git('diff --name-only HEAD...@{u}')['output']), fn ($l) => trim($l) !== ''))
            : [];

        return [
            'branch' => $branch,
            'upstream' => $upstream,
            'head' => $head,
            'behind' => $behind,
            'ahead' => $ahead,
            'local_changes' => array_map('trim', $local),
            'changed_files' => array_map('trim', $changed),
        ];
    }

    /**
     * What the changed files require.
     *
     * @param  list<string>  $files
     * @return array{composer: bool, migrate: bool, npm: bool, build: bool, reconnect_mcp: bool}
     */
    public function plan(array $files): array
    {
        $any = fn (array $patterns) => collect($files)->contains(fn (string $f) => Str::is($patterns, $f));

        $composer = $any(['composer.lock', 'composer.json']);
        $npm = $any(['package-lock.json', 'package.json']);

        return [
            'composer' => $composer,
            'migrate' => $any(['database/migrations/*']),
            'npm' => $npm,
            'build' => $npm || $any(['resources/js/*', 'resources/css/*', 'resources/game/*', 'resources/views/*', 'vite.config.*', 'tsconfig.json', 'routes/*', 'public/*']),
            // The running MCP server holds the old PHP code until it is restarted.
            'reconnect_mcp' => $composer || $any(['app/*', 'config/*', 'bootstrap/*', 'routes/ai.php']),
        ];
    }

    /**
     * Runs the install / migrate / build steps of the plan; null when all succeeded, else the failure.
     *
     * @param  array<string, bool>  $plan
     * @return array{step: string, output: string}|null
     */
    private function runPlan(array $plan, bool $migrate = true): ?array
    {
        $steps = [];

        if ($plan['composer']) {
            $steps['composer install'] = 'composer install --no-interaction --prefer-dist';
        }

        if ($plan['migrate'] && $migrate) {
            $steps['migrate'] = escapeshellarg(PHP_BINARY).' artisan migrate --force';
        }

        if ($plan['npm']) {
            $steps['npm install'] = is_file(base_path('package-lock.json')) ? 'npm ci' : 'npm install';
        }

        if ($plan['build']) {
            $steps['npm run build'] = 'npm run build';
        }

        foreach ($steps as $name => $command) {
            $result = $this->run($command, self::STEP_TIMEOUT);

            if (! $result['ok']) {
                return ['step' => $name, 'output' => $result['output']];
            }
        }

        return null;
    }

    /**
     * @param  array<string, mixed>  $state
     * @param  array<string, bool>  $plan
     * @param  array{step: string, output: string}  $failure
     * @param  list<array<string, mixed>>  $snapshots
     * @return array<string, mixed>
     */
    private function rollBack(array $state, string $before, string $after, array $plan, array $failure, bool $clean, array $snapshots): array
    {
        $report = [
            'status' => 'failed',
            'failed_step' => $failure['step'],
            'error' => Str::limit($failure['output'], 4000),
            'branch' => $state['branch'],
            'from' => $before,
            'pulled' => $after,
            'snapshots' => $snapshots,
        ];

        if (! $clean) {
            return [
                ...$report,
                'rolled_back' => false,
                'hint' => "The update was forced over local changes, so it was not rolled back automatically. The checkout is on {$after}; to go back: commit or stash your changes, then `git reset --hard {$before}` and rebuild.",
                'log' => $this->log,
            ];
        }

        $reset = $this->git('reset --hard '.escapeshellarg($before));

        if (! $reset['ok']) {
            return [...$report, 'rolled_back' => false, 'rollback_error' => $reset['output'], 'log' => $this->log];
        }

        // Rebuild what the failed update touched (migrations are not undone: they rarely are reversible).
        $rebuild = $this->runPlan($plan, migrate: false);

        return [
            ...$report,
            'rolled_back' => true,
            'rollback' => "Back on {$before}.".($rebuild === null ? ' Dependencies and build were redone for it.' : " Rebuilding failed at {$rebuild['step']}: ".Str::limit($rebuild['output'], 1000)),
            'migrations_note' => $plan['migrate'] ? 'Migrations of the update may have run and were not rolled back; restore a snapshot (map_snapshots) if maps look wrong.' : null,
            'editors' => $this->reloadEditors(),
            'hint' => 'Report the failure (e.g. a comment on the merged PR or request_engine_change) instead of retrying the same update.',
            'log' => $this->log,
        ];
    }

    /**
     * A restore point of every map before the code changes.
     *
     * @return list<array<string, mixed>>
     */
    private function snapshotMaps(): array
    {
        $taken = [];

        foreach (Map::query()->orderBy('id')->get() as $map) {
            try {
                $snapshot = $this->snapshots->create($map, 'Before engine update '.Carbon::now()->format('Y-m-d H:i'));
                $taken[] = ['map' => $map->slug, 'snapshot_id' => $snapshot->id];
            } catch (Throwable $e) {
                report($e);
                $taken[] = ['map' => $map->slug, 'error' => $e->getMessage()];
            }
        }

        return $taken;
    }

    /**
     * Reloads the user's open editors; closes and reopens hidden ones so they load the new build.
     *
     * @return list<array<string, mixed>>
     */
    private function reloadEditors(): array
    {
        $done = [];
        $hidden = HeadlessBrowser::query()->with('map')->get()->keyBy('map_id');

        $open = AgentSession::query()
            ->where('last_seen_at', '>=', Carbon::now()->subSeconds(EditorBridge::SESSION_TIMEOUT))
            ->distinct()
            ->pluck('map_id');

        foreach ($open as $mapId) {
            if ($hidden->has($mapId)) {
                continue;
            }

            $map = Map::query()->find($mapId);

            if ($map !== null && $this->bridge->notify($map, 'reload')) {
                $done[] = ['map' => $map->slug, 'editor' => 'user', 'action' => 'reloaded'];
            }
        }

        foreach ($hidden as $browser) {
            $map = $browser->map;

            try {
                $this->headless->close($map);
                $this->headless->open($map, wait: false);
                $done[] = ['map' => $map->slug, 'editor' => 'hidden', 'action' => 'reopened'];
            } catch (ToolError $e) {
                // Unsaved edits: keep it open and reload it in place instead (the page asks to keep them).
                $this->bridge->notify($map, 'reload');
                $done[] = ['map' => $map->slug, 'editor' => 'hidden', 'action' => 'reload_requested', 'note' => $e->getMessage()];
            }
        }

        return $done;
    }

    /** @return array{ok: bool, output: string} */
    private function git(string $arguments): array
    {
        return $this->run('git '.$arguments, 120);
    }

    /** @return array{ok: bool, output: string} */
    private function run(string $command, int $timeout): array
    {
        $result = Process::path(base_path())->timeout($timeout)->run($command);
        $output = trim($result->output()."\n".$result->errorOutput());
        $this->log[] = '$ '.$command.($result->successful() ? '' : " (exit {$result->exitCode()})");

        return ['ok' => $result->successful(), 'output' => $output];
    }
}
