<?php

namespace App\Support;

use App\Models\FoliageType;
use App\Models\Map;
use App\Services\Terrain\TerrainStorage;

/**
 * Everything the game needs to boot a map. Mirrors `GameManifest` in resources/game/shared/types.ts.
 */
final class GameManifest
{
    public function __construct(
        private readonly TerrainStorage $storage,
        private readonly GameSettingsRepository $settings,
    ) {}

    /**
     * @return array<string, mixed>
     */
    public function build(Map $map): array
    {
        $asset = fn (string $name) => $this->storage->exists($map, $name)
            ? route('api.maps.assets.show', [$map, $name, 'v' => $map->revision])
            : null;

        return [
            'map' => self::mapInfo($map),
            'environment' => $map->resolvedEnvironment(),
            'settings' => $this->settings->all(),
            'layers' => $map->layers->map->toGameArray()->values()->all(),
            'foliage_types' => FoliageType::query()->orderBy('name')->get()->map->toGameArray()->values()->all(),
            'assets' => [
                'heightmap' => $asset('heightmap'),
                'splatmap' => $asset('splatmap'),
                'water' => $asset('water'),
                'foliage' => $asset('foliage'),
            ],
            'endpoints' => [
                'save_heightmap' => route('api.maps.assets.update', [$map, 'heightmap']),
                'save_splatmap' => route('api.maps.assets.update', [$map, 'splatmap']),
                'save_water' => route('api.maps.assets.update', [$map, 'water']),
                'save_foliage' => route('api.maps.assets.update', [$map, 'foliage']),
                'save_meta' => route('api.maps.meta.update', $map),
                'save_thumbnail' => route('api.maps.thumbnail.store', $map),
            ],
        ];
    }

    /**
     * @return array<string, mixed>
     */
    public static function mapInfo(Map $map): array
    {
        return [
            'id' => $map->id,
            'name' => $map->name,
            'slug' => $map->slug,
            'source' => $map->source->value,
            'resolution' => $map->resolution,
            'size' => $map->size,
            'center_lat' => $map->center_lat,
            'center_lng' => $map->center_lng,
            'min_height' => $map->min_height,
            'max_height' => $map->max_height,
            'spawn' => $map->spawn_x !== null && $map->spawn_z !== null
                ? ['x' => $map->spawn_x, 'z' => $map->spawn_z, 'yaw' => $map->spawn_yaw]
                : null,
            'terrain_status' => $map->terrain_status->value,
            'revision' => $map->revision,
        ];
    }
}
