<?php

namespace App\Console\Commands;

use App\Services\Materials\StarterMaterials;
use Illuminate\Console\Attributes\Description;
use Illuminate\Console\Attributes\Signature;
use Illuminate\Console\Command;

/**
 * Imports the curated CC0 starter materials from Poly Haven and assigns them to the default
 * terrain layers of every map. Never fails hard (offline-safe): problems are reported as warnings.
 */
#[Signature('waterways:starter-materials {--resolution=1k : Texture resolution to download (1k, 2k or 4k)}')]
#[Description('Import the starter terrain materials (Poly Haven, CC0) and assign them to map layers')]
class StarterMaterialsCommand extends Command
{
    public function handle(StarterMaterials $starter): int
    {
        $resolution = strtolower((string) $this->option('resolution'));
        if (! in_array($resolution, ['1k', '2k', '4k'], true)) {
            $this->error('Resolution must be 1k, 2k or 4k.');

            return self::INVALID;
        }

        $limit = ini_get('memory_limit');
        if ($limit !== false && $limit !== '-1' && ini_parse_quantity($limit) < 1024 ** 3) {
            ini_set('memory_limit', $resolution === '4k' ? '2G' : '1G');
        }

        $this->info("Importing starter materials at {$resolution}…");

        $result = $starter->import($resolution, function (string $level, string $message) {
            $level === 'warn' ? $this->warn($message) : $this->line("  {$message}");
        });

        $assigned = $starter->assignToAllMaps();

        $this->info(sprintf(
            'Starter materials: %d imported, %d already present, %d failed; %d layer(s) assigned.',
            count($result['imported']),
            count($result['skipped']),
            count($result['failed']),
            $assigned,
        ));

        return self::SUCCESS;
    }
}
