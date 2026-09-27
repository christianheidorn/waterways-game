<?php

namespace App\Jobs;

use App\Models\Map;
use App\Services\LandCover\LandCoverService;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Str;
use Throwable;

/**
 * Re-paints a real-world map's splat.u8 from ESA WorldCover land cover (fetched again when
 * landcover.u8 is missing) and bumps the map revision so open editors reload it.
 */
class ApplyLandCover implements ShouldQueue
{
    use Queueable;

    public int $timeout = 600;

    public int $tries = 1;

    public function __construct(public Map $map) {}

    public function handle(LandCoverService $landCover): void
    {
        $limit = ini_get('memory_limit');
        if ($limit !== false && $limit !== '-1' && ini_parse_quantity($limit) < 1024 ** 3) {
            ini_set('memory_limit', '1G');
        }

        $landCover->apply($this->map);
    }

    public function failed(?Throwable $exception): void
    {
        $this->map->forceFill([
            'terrain_message' => LandCoverService::withSummary(
                $this->map->terrain_message,
                Str::limit('Land cover failed: '.($exception?->getMessage() ?? 'unknown error'), 120),
            ),
        ])->save();
    }
}
