<?php

namespace App\Console\Commands;

use App\Mcp\ToolError;
use App\Support\Updates\EngineUpdater;
use Illuminate\Console\Attributes\Description;
use Illuminate\Console\Attributes\Signature;
use Illuminate\Console\Command;

/**
 * Pulls merged engine / editor changes and rebuilds what they touched (docs/AUTONOMY.md).
 */
#[Signature('waterways:update {--check : Only fetch and report whether updates are available} {--dry-run : Show what an update would do, change nothing} {--force : Update even with uncommitted local changes (no automatic rollback then)} {--json : Print the result as JSON}')]
#[Description('Update this checkout from its upstream branch: snapshot maps, git pull, install, migrate, build, reload editors')]
class UpdateCommand extends Command
{
    public function handle(EngineUpdater $updater): int
    {
        try {
            $result = $this->option('check')
                ? $updater->check()
                : $updater->update((bool) $this->option('force'), (bool) $this->option('dry-run'));
        } catch (ToolError $e) {
            $this->error($e->getMessage());

            return self::FAILURE;
        }

        if ($this->option('json')) {
            $this->line((string) json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
        } else {
            $this->report($result);
        }

        return in_array($result['status'], ['failed', 'refused'], true) ? self::FAILURE : self::SUCCESS;
    }

    /** @param array<string, mixed> $result */
    private function report(array $result): void
    {
        $where = isset($result['upstream'], $result['behind'])
            ? " ({$result['branch']} ← {$result['upstream']}, {$result['behind']} behind, {$result['ahead']} ahead)"
            : '';

        match ($result['status']) {
            'up_to_date' => $this->info('Up to date'.$where.'.'),
            'updates_available' => $this->info('Updates available'.$where.'.'),
            'dry_run' => $this->info('Dry run'.$where.': nothing was changed.'),
            'refused' => $this->error($result['reason']),
            'updated' => $this->info("Updated {$result['branch']} ".substr($result['from'], 0, 8).' → '.substr($result['to'], 0, 8)." ({$result['commits']} commit(s))."),
            default => $this->error("Update failed at {$result['failed_step']}."),
        };

        if (! empty($result['local_changes'])) {
            $this->warn('Local changes: '.implode(', ', $result['local_changes']));
        }

        if (isset($result['plan']) && $result['plan'] !== []) {
            $steps = array_keys(array_filter($result['plan']));
            $this->line('Would run: git pull'.($steps === [] ? '' : ', '.implode(', ', $steps)));
        }

        foreach (['error', 'rollback', 'rollback_error', 'migrations_note', 'hint', 'next'] as $key) {
            if (! empty($result[$key])) {
                $this->line($result[$key]);
            }
        }

        foreach ($result['editors'] ?? [] as $editor) {
            $this->line("Editor {$editor['map']} ({$editor['editor']}): {$editor['action']}");
        }

        if ($this->output->isVerbose()) {
            foreach ($result['log'] ?? [] as $line) {
                $this->line($line);
            }
        }
    }
}
