<?php

namespace App\Support;

use App\Models\Biome;
use App\Models\FoliageType;
use App\Models\Map;
use App\Models\PropModel;
use App\Services\Terrain\TerrainStorage;

/**
 * Everything the game needs to boot a map. Mirrors `GameManifest` in resources/game/shared/types.ts.
 */
final class GameManifest
{
    public function __construct(
        private readonly TerrainStorage $storage,
        private readonly GameSettingsRepository $settings,
        private readonly ActiveCharacter $character,
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
            // Placeable models (props) that are ready to use.
            'prop_models' => PropModel::query()->where('status', 'ready')->whereNotNull('model_path')->orderBy('name')->get()->map->toGameArray()->values()->all(),
            'biomes' => Biome::query()->orderBy('name')->get()->map->toStudioArray()->values()->all(),
            'foliage_types' => FoliageType::query()->with('asset')->orderBy('name')->get()->map->toGameArray()->values()->all(),
            'character' => $this->character->get()?->toGameArray(),
            // Foliage types scattered on the first load of a template map (null: all types).
            'initial_foliage' => MapTemplates::initialFoliage($map),
            'assets' => [
                'heightmap' => $asset('heightmap'),
                'splatmap' => $asset('splatmap'),
                'water' => $asset('water'),
                'foliage' => $asset('foliage'),
                'props' => $asset('props'),
                // Roads and rivers as editable splines (JSON).
                'splines' => $asset('splines'),
                // ESA WorldCover class per sample (Uint8, resolution²), real-world maps only.
                'landcover' => $asset('landcover'),
            ],
            'endpoints' => [
                'save_heightmap' => route('api.maps.assets.update', [$map, 'heightmap']),
                'save_splatmap' => route('api.maps.assets.update', [$map, 'splatmap']),
                'save_water' => route('api.maps.assets.update', [$map, 'water']),
                'save_foliage' => route('api.maps.assets.update', [$map, 'foliage']),
                'save_props' => route('api.maps.assets.update', [$map, 'props']),
                'save_splines' => route('api.maps.assets.update', [$map, 'splines']),
                'save_meta' => route('api.maps.meta.update', $map),
                'save_thumbnail' => route('api.maps.thumbnail.store', $map),
                'update_foliage_type' => url('/api/foliage-types'),
                'update_layers' => url("/api/maps/{$map->slug}/layers"),
                'biomes' => url('/api/biomes'),
                // Live bridge for AI agents (MCP server): poll for commands, post results to `${agent}/commands/{id}`.
                'agent' => url("/api/maps/{$map->slug}/agent"),
                // Build requests for agents (outline + note + images), made in the editor.
                'agent_requests' => url("/api/maps/{$map->slug}/agent-requests"),
                // Settings inside the editor (World tab): environment, layer settings, material library,
                // snapshots (automatic ones after saves) and new maps from templates.
                'environment' => url("/api/maps/{$map->slug}/environment"),
                'materials' => url('/api/materials'),
                'snapshots' => url("/api/maps/{$map->slug}/snapshots"),
                'map_templates' => url('/api/map-templates'),
                'create_map' => url('/api/maps'),
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
