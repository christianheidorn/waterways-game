<?php

namespace Tests\Feature\Mcp;

use App\Mcp\Headless\BrowserLauncher;
use App\Models\AgentSession;
use App\Models\Map;
use Illuminate\Support\Carbon;

/**
 * Hidden editor browsers without processes. With `$boots`, a launched "browser" loads the map's
 * editor at once: its session polls as a headless editor.
 */
class FakeBrowserLauncher implements BrowserLauncher
{
    /** @var list<array{binary: string, arguments: list<string>, log: string}> */
    public array $launched = [];

    /** @var list<int> */
    public array $stopped = [];

    /** @var array<int, string> pid => marker of the running "processes" */
    public array $alive = [];

    private int $nextPid = 4000;

    public function __construct(private readonly ?Map $boots = null) {}

    public function launch(string $binary, array $arguments, string $logFile): int
    {
        $this->launched[] = ['binary' => $binary, 'arguments' => $arguments, 'log' => $logFile];
        $pid = $this->nextPid++;
        $marker = collect($arguments)->first(fn (string $a) => str_starts_with($a, '--user-data-dir='));
        $this->alive[$pid] = substr((string) $marker, strlen('--user-data-dir='));

        if ($this->boots !== null) {
            AgentSession::query()->create([
                'id' => "headless-{$pid}",
                'map_id' => $this->boots->id,
                'mode' => 'edit',
                'state' => ['headless' => true, 'unsaved' => []],
                'last_seen_at' => Carbon::now(),
            ]);
        }

        return $pid;
    }

    public function running(int $pid, string $marker): bool
    {
        return ($this->alive[$pid] ?? null) === $marker;
    }

    public function stop(int $pid, string $marker): void
    {
        $this->stopped[] = $pid;
        unset($this->alive[$pid]);
    }
}
