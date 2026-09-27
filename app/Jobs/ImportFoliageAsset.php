<?php

namespace App\Jobs;

use App\Models\FoliageAsset;
use App\Services\Foliage\PolyHavenModels;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Str;
use Throwable;

/**
 * Downloads a CC0 plant / tree / rock model from Poly Haven into the foliage asset library.
 * The browser bakes it into a game-ready GLB afterwards.
 */
class ImportFoliageAsset implements ShouldQueue
{
    use Queueable;

    public int $timeout = 900;

    public int $tries = 1;

    public function __construct(public FoliageAsset $asset, public string $ref) {}

    public function handle(PolyHavenModels $polyHaven): void
    {
        $this->asset->forceFill(['status' => 'processing', 'status_message' => 'Downloading from Poly Haven…'])->save();

        $polyHaven->import($this->asset, $this->ref);
    }

    public function failed(?Throwable $exception): void
    {
        $this->asset->forceFill([
            'status' => 'failed',
            'status_message' => Str::limit('Import failed: '.($exception?->getMessage() ?? 'unknown error'), 250),
        ])->save();
    }
}
