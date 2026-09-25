<?php

namespace App\Services\Terrain;

use App\Enums\MapSource;
use App\Enums\TerrainStatus;
use App\Models\Map;
use App\Support\DefaultTerrainLayers;
use Illuminate\Support\Str;

/**
 * Builds a map's heightmap and water grids from its source settings and stores them.
 */
class TerrainGenerator
{
    public function __construct(
        private readonly TerrainStorage $storage,
        private readonly ProceduralHeightmapGenerator $procedural,
        private readonly TerrariumElevationSource $elevation,
        private readonly OverpassWaterSource $overpass,
        private readonly WaterSurfaceBuilder $water,
    ) {}

    /**
     * @param  (callable(int, string): void)|null  $progress  percent 0-100 and a status message
     */
    public function generate(Map $map, ?callable $progress = null): void
    {
        $report = static function (int $percent, string $message) use ($progress): void {
            if ($progress !== null) {
                $progress(max(0, min(100, $percent)), $message);
            }
        };
        $stage = static fn (int $from, int $to): callable => static function (float $fraction, string $message) use ($report, $from, $to): void {
            $report((int) round($from + ($to - $from) * $fraction), $message);
        };

        $message = null;
        $report(0, 'Preparing terrain');

        switch ($map->source) {
            case MapSource::Flat:
                $report(10, 'Generating flat terrain');
                $result = new WaterSurfaceResult(
                    $this->procedural->flat($map->resolution),
                    HeightGrid::filled($map->resolution, TerrainStorage::NO_WATER),
                    0,
                    0,
                );
                break;

            case MapSource::Procedural:
                $result = $this->procedural->proceduralWithWater(
                    $map->resolution, $map->size, $map->seed, $stage(5, 85), TerrainShaping::fromMap($map),
                );
                break;

            case MapSource::RealWorld:
                [$result, $message] = $this->realWorld($map, $stage);
                break;
        }

        $report(90, 'Saving terrain');
        $this->store($map, $result, $message);
        $report(100, $message ?? 'Terrain ready');
    }

    /**
     * @param  callable(int, int): callable(float, string): void  $stage
     * @return array{0: WaterSurfaceResult, 1: string|null} result and a terrain message (import summary or warning)
     */
    private function realWorld(Map $map, callable $stage): array
    {
        $projection = MapProjection::forMap($map);
        $shaping = TerrainShaping::fromMap($map);
        $heightScale = (float) $map->height_scale;
        $terrain = $this->elevation->build($projection, $stage(5, 65))->scale($heightScale);

        $stage(65, 70)(0.0, 'Smoothing terrain');
        // Source elevation is quantized to whole metres (× height scale).
        TerrainSmoother::deterrace($terrain, $projection->cell, $shaping->smoothing, max(0.1, $heightScale));

        $seaLevel = (float) $map->resolvedEnvironment()['sea_level'];
        $grid = ['polygons' => [], 'lines' => [], 'coastlines' => []];
        $features = null;

        if ($map->import_water) {
            $stage(70, 80)(0.0, 'Fetching water from OpenStreetMap');
            $features = $this->overpass->fetch($projection->bounds());
            $grid = $features->toGrid($projection);
        }

        $stage(80, 90)(0.0, 'Building water surfaces');
        $result = $this->water->build(
            $terrain, $map->size, $grid['polygons'], $grid['lines'], $seaLevel, true, $shaping, $grid['coastlines'],
        );

        return [$result, $this->waterMessage($features, $result)];
    }

    private function waterMessage(?WaterFeatures $features, WaterSurfaceResult $result): ?string
    {
        $ocean = $result->oceanDetected() ? 'ocean' : null;

        if ($features === null) {
            return $ocean === null ? null : 'Ocean detected from elevation data.';
        }

        $summary = $features->summary();
        $imported = implode(', ', array_filter([$summary, $ocean]));

        if ($features->isEmpty() && $features->warning !== null) {
            $suffix = $ocean === null ? '' : ' Ocean detected from elevation data.';

            return Str::limit('Water data unavailable: '.$features->warning, 250 - strlen($suffix)).$suffix;
        }

        $message = $imported === '' ? 'No water found in OpenStreetMap for this area.' : "Imported {$imported}.";

        if ($features->warning !== null) {
            $message .= ' '.$features->warning;
        }

        return Str::limit($message, 250);
    }

    private function store(Map $map, WaterSurfaceResult $result, ?string $warning): void
    {
        $this->storage->write($map, 'heightmap', $result->terrain->toBinary());

        if ($result->hasWater()) {
            $this->storage->write($map, 'water', $result->water->toBinary());
        } else {
            $this->storage->delete($map, 'water');
        }

        // Fresh terrain invalidates painting and foliage; the game auto-paints on load.
        $this->storage->delete($map, 'splatmap');
        $this->storage->delete($map, 'foliage');

        [$min, $max] = $result->terrain->range();
        $attributes = [
            'min_height' => $min,
            'max_height' => $max,
            'terrain_status' => TerrainStatus::Ready,
            'terrain_progress' => 100,
            'terrain_message' => $warning,
            'terrain_generated_at' => now(),
            'revision' => $map->revision + 1,
        ];

        if ($result->oceanDetected()) {
            $attributes['environment'] = array_merge($map->environment ?? [], ['ocean_enabled' => true]);
        }

        $map->forceFill($attributes)->save();

        if (! $map->layers()->exists()) {
            DefaultTerrainLayers::createFor($map);
        }
    }
}
