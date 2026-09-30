<?php

namespace App\Console\Commands;

use App\Mcp\Assets\AssetOptimizer;
use Illuminate\Console\Attributes\Description;
use Illuminate\Console\Attributes\Signature;
use Illuminate\Console\Command;

/**
 * Compresses the library's GLBs (foliage assets, prop models) for the game: meshopt meshes and
 * KTX2 / Basis textures, stored next to the originals (see AssetOptimizer). Reports the savings.
 */
#[Signature('waterways:optimize-assets
    {--kind=all : all, foliage or props}
    {--id=* : Only these ids (with --kind foliage or props)}
    {--no-textures : Keep the textures as they are (meshes only; fast)}
    {--no-meshes : Keep the meshes as they are (textures only)}
    {--force : Optimise again even when the compressed copy is up to date}
    {--dry-run : Only list what would be optimised}')]
#[Description('Compress foliage and prop models (meshopt meshes, KTX2 textures) and report the size savings')]
class OptimizeAssetsCommand extends Command
{
    public function handle(AssetOptimizer $optimizer): int
    {
        $kind = (string) $this->option('kind');
        if (! in_array($kind, ['all', 'foliage', 'props'], true)) {
            $this->error('--kind must be all, foliage or props.');

            return self::INVALID;
        }

        $ids = array_map('intval', (array) $this->option('id'));
        $rows = $optimizer->run(
            $kind,
            $ids === [] ? null : $ids,
            textures: ! $this->option('no-textures'),
            meshes: ! $this->option('no-meshes'),
            force: (bool) $this->option('force'),
            dryRun: (bool) $this->option('dry-run'),
            progress: fn (string $line) => $this->line("  {$line}"),
        );

        $this->table(
            ['Kind', 'Id', 'Name', 'Status', 'File before', 'File after', 'GPU textures before', 'GPU textures after'],
            array_map(fn (array $r) => [
                $r['kind'],
                $r['id'],
                $r['name'],
                $r['status'].(isset($r['result']['error']) ? ': '.$r['result']['error'] : ''),
                self::mb($r['result']['bytes_before'] ?? $r['bytes'] ?? null),
                self::mb($r['result']['bytes_after'] ?? $r['optimized_bytes'] ?? null),
                self::mb($r['result']['texture_memory_before'] ?? null),
                self::mb($r['result']['texture_memory_after'] ?? null),
            ], $rows),
        );

        $s = AssetOptimizer::summary($rows);
        $this->info(sprintf(
            '%d optimised, %d up to date, %d failed%s%s. Files %s → %s (%s); GPU texture memory %s → %s (%s%% less).',
            $s['optimized'], $s['up_to_date'], $s['failed'], $s['pending'] ? ", {$s['pending']} pending" : '', $s['missing'] ? ", {$s['missing']} without a model file" : '',
            self::mb($s['bytes_before']), self::mb($s['bytes_after']), $s['file_saving_percent'] >= 0 ? "{$s['file_saving_percent']}% smaller" : abs($s['file_saving_percent']).'% larger: KTX2 trades file size for GPU memory',
            self::mb($s['texture_memory_before']), self::mb($s['texture_memory_after']), $s['texture_memory_saving_percent'],
        ));

        return $s['failed'] > 0 ? self::FAILURE : self::SUCCESS;
    }

    private static function mb(int|float|null $bytes): string
    {
        return $bytes === null ? '–' : number_format($bytes / 1048576, 2).' MB';
    }
}
