<?php

namespace App\Jobs;

use App\Enums\TerrainStatus;
use App\Models\Map;
use App\Services\Terrain\TerrainGenerator;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Str;
use Throwable;

/**
 * Generates (or regenerates) a map's terrain in the background, reporting progress on the map row.
 */
class GenerateMapTerrain implements ShouldQueue
{
    use Queueable;

    public int $timeout = 900;

    public int $tries = 1;

    /** Minimum seconds between progress writes. */
    private const PROGRESS_INTERVAL = 1.0;

    public function __construct(public Map $map) {}

    public function handle(TerrainGenerator $generator): void
    {
        // A 1025² map peaks around 400 MB of PHP arrays.
        $limit = ini_get('memory_limit');
        if ($limit !== false && $limit !== '-1' && ini_parse_quantity($limit) < 1024 ** 3) {
            ini_set('memory_limit', '1G');
        }

        $this->map->forceFill([
            'terrain_status' => TerrainStatus::Importing,
            'terrain_progress' => 0,
            'terrain_message' => 'Starting terrain generation',
        ])->save();

        $lastWrite = 0.0;
        $lastPercent = 0;

        $generator->generate($this->map, function (int $percent, string $message) use (&$lastWrite, &$lastPercent): void {
            $now = microtime(true);

            if ($percent >= 100 || $percent === $lastPercent || $now - $lastWrite < self::PROGRESS_INTERVAL) {
                return;
            }

            $lastWrite = $now;
            $lastPercent = $percent;

            // Only touch the progress columns so concurrent edits to the map are not overwritten.
            Map::query()->whereKey($this->map->getKey())->update([
                'terrain_progress' => $percent,
                'terrain_message' => Str::limit($message, 250),
            ]);
        });
    }

    public function failed(?Throwable $exception): void
    {
        $this->map->forceFill([
            'terrain_status' => TerrainStatus::Failed,
            'terrain_message' => Str::limit('Terrain generation failed: '.($exception?->getMessage() ?? 'unknown error'), 250),
        ])->save();
    }
}
