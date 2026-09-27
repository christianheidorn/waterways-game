<?php

namespace App\Services\LandCover;

use App\Enums\MapSource;
use App\Models\Map;
use App\Models\TerrainLayer;
use App\Services\Terrain\HeightGrid;
use App\Services\Terrain\TerrainStorage;
use App\Support\DefaultTerrainLayers;
use Illuminate\Support\Str;
use RuntimeException;

/**
 * Glue between WorldCover, the painter, the map's layers / mapping and the stored assets.
 */
class LandCoverService
{
    /** @var array<string, array<int, float>|null> "id:revision" → stats */
    private static array $statsCache = [];

    public function __construct(
        private readonly WorldCoverSource $source,
        private readonly LandCoverPainter $painter,
        private readonly TerrainStorage $storage,
    ) {}

    public function source(): WorldCoverSource
    {
        return $this->source;
    }

    /**
     * Searchable text per slot: layer name plus material name / category (default layers when
     * the map has none yet).
     *
     * @return array<int, string>
     */
    public function slotTexts(Map $map): array
    {
        $layers = $map->layers()->get();

        if ($layers->isEmpty()) {
            $texts = [];
            foreach (DefaultTerrainLayers::definitions(0, 1) as $definition) {
                $texts[$definition['slot']] = $definition['name'];
            }

            return $texts;
        }

        return $layers->mapWithKeys(fn (TerrainLayer $layer) => [
            $layer->slot => trim($layer->name.' '.($layer->material?->name ?? '').' '.($layer->material?->category ?? '')),
        ])->all();
    }

    /**
     * The map's class → slot mapping (user choices over name-based defaults).
     *
     * @param  array<int, string>|null  $slots
     * @return array<int, int>
     */
    public function mapping(Map $map, ?array $slots = null): array
    {
        return LandCoverMapping::resolve($slots ?? $this->slotTexts($map), $map->landcover_mapping);
    }

    /**
     * Paint splat.u8 bytes for a map from a class grid and its final terrain / water grids.
     *
     * @return array{0: string, 1: array<int, int>} splat bytes and the mapping used
     */
    public function paint(Map $map, LandCoverGrid $classes, HeightGrid $terrain, ?HeightGrid $water): array
    {
        $slots = $this->slotTexts($map);
        $mapping = $this->mapping($map, $slots);
        $splat = $this->painter->paint(
            $classes, $terrain, $water, $map->size, $mapping, LandCoverMapping::roles($slots), (int) $map->seed,
        );

        return [$splat, $mapping];
    }

    /**
     * The stored class grid (null when missing or not matching the resolution).
     */
    public function stored(Map $map): ?LandCoverGrid
    {
        $bytes = $this->storage->read($map, 'landcover');

        return $bytes !== null && strlen($bytes) === $map->resolution ** 2
            ? LandCoverGrid::fromBinary($map->resolution, $bytes)
            : null;
    }

    /**
     * Re-paint a real-world map's splat from its stored land cover (fetched again when missing)
     * and its current heightmap / water. Returns the land cover summary.
     */
    public function apply(Map $map): string
    {
        if ($map->source !== MapSource::RealWorld) {
            throw new RuntimeException('Land cover is only available for real-world maps.');
        }

        $heightmap = $this->storage->read($map, 'heightmap');
        if ($heightmap === null || strlen($heightmap) !== $map->resolution ** 2 * 4) {
            throw new RuntimeException('The map has no terrain yet.');
        }

        $classes = $this->stored($map);
        if ($classes === null) {
            $classes = $this->source->classGrid($map)
                ?? throw new RuntimeException('Land cover unavailable: '.$this->source->warning);
            $this->storage->write($map, 'landcover', $classes->toBinary());
        }

        $waterBytes = $this->storage->read($map, 'water');
        $water = $waterBytes !== null && strlen($waterBytes) === strlen($heightmap)
            ? HeightGrid::fromBinary($map->resolution, $waterBytes)
            : null;

        [$splat, $mapping] = $this->paint($map, $classes, HeightGrid::fromBinary($map->resolution, $heightmap), $water);
        $this->storage->write($map, 'splatmap', $splat);

        $summary = $classes->summary();
        $map->forceFill([
            'landcover_mapping' => $mapping,
            'use_landcover' => true,
            'terrain_message' => self::withSummary($map->terrain_message, $summary),
            'revision' => $map->revision + 1,
        ])->save();

        return $summary;
    }

    /**
     * Class → percentage from the stored landcover.u8 (memoised per map revision).
     *
     * @return array<int, float>|null
     */
    public function stats(Map $map): ?array
    {
        $key = $map->id.':'.$map->revision;

        if (! array_key_exists($key, self::$statsCache)) {
            self::$statsCache[$key] = $this->stored($map)?->stats();
        }

        return self::$statsCache[$key];
    }

    /**
     * Replace (or append) the "Land cover: …" part of a terrain message, keeping it ≤ 250 chars.
     */
    public static function withSummary(?string $message, string $summary): string
    {
        $message = trim((string) preg_replace('/\s*Land cover(?: unavailable)?:.*$/s', '', (string) $message));

        if ($message === '') {
            return Str::limit($summary, 250);
        }

        $room = 250 - strlen($summary) - 1;

        return $room < 20 ? Str::limit($summary, 250) : Str::limit($message, $room - 3).' '.$summary;
    }
}
