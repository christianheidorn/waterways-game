<?php

namespace App\Console\Commands;

use App\Mcp\HeadlessEditor;
use App\Models\HeadlessBrowser;
use Illuminate\Console\Attributes\Description;
use Illuminate\Console\Attributes\Signature;
use Illuminate\Console\Command;

/**
 * Lists and stops the hidden editors the MCP server started (open_editor).
 */
#[Signature('waterways:headless {action=list : list or stop} {--map= : stop: only this map (slug)} {--idle : stop: only idle ones, and those whose map the user opened (saving first), as the scheduler does}')]
#[Description('List or stop the hidden (headless) editors started for AI agents')]
class HeadlessCommand extends Command
{
    public function handle(HeadlessEditor $headless): int
    {
        return match ($this->argument('action')) {
            'list' => $this->list($headless),
            'stop' => $this->stop($headless),
            default => $this->invalid(),
        };
    }

    private function list(HeadlessEditor $headless): int
    {
        $browsers = $headless->all();

        if ($browsers->isEmpty()) {
            $this->info('No hidden editors are running.');

            return self::SUCCESS;
        }

        $this->table(
            ['Map', 'PID', 'Running', 'Started', 'Last used', 'URL'],
            $browsers->map(fn (HeadlessBrowser $b) => [
                $b->map->slug,
                $b->pid,
                $headless->running($b) ? 'yes' : 'no',
                $b->started_at->diffForHumans(),
                $b->last_used_at->diffForHumans(),
                $b->url,
            ])->all(),
        );

        return self::SUCCESS;
    }

    private function stop(HeadlessEditor $headless): int
    {
        if ($this->option('idle')) {
            foreach ($headless->sweep() as $closed) {
                $this->line("Closed {$closed}");
            }

            return self::SUCCESS;
        }

        $map = $this->option('map');
        $browsers = $headless->all()->filter(fn (HeadlessBrowser $b) => $map === null || $b->map->slug === $map);

        if ($browsers->isEmpty()) {
            $this->info($map === null ? 'No hidden editors are running.' : "No hidden editor of \"{$map}\" is running.");

            return self::SUCCESS;
        }

        foreach ($browsers as $browser) {
            $headless->stop($browser);
            $this->line("Stopped the hidden editor of {$browser->map->slug} (pid {$browser->pid}).");
        }

        return self::SUCCESS;
    }

    private function invalid(): int
    {
        $this->error('Action must be "list" or "stop".');

        return self::INVALID;
    }
}
