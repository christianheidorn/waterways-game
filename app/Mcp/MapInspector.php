<?php

namespace App\Mcp;

use App\Http\Controllers\MapController;
use App\Models\FoliageType;
use App\Models\Map;
use App\Models\TerrainLayer;
use App\Services\Terrain\TerrainStorage;

/**
 * What an agent needs to reason about a map: its settings, layers and a numeric summary of the
 * stored terrain (height range, how much of the map each layer covers, water, foliage counts).
 */
class MapInspector
{
    /** Every n-th sample in both directions is read for the coverage statistics. */
    private const STRIDE = 4;

    public function __construct(
        private readonly TerrainStorage $storage,
        private readonly EditorBridge $bridge,
    ) {}

    /**
     * @return array<string, mixed>
     */
    public function describe(Map $map): array
    {
        $detail = MapController::detail($map);
        $types = FoliageType::query()->pluck('name', 'id');
        $session = $this->bridge->session($map);

        return [
            'map' => array_intersect_key($detail, array_flip([
                'id', 'slug', 'name', 'description', 'source', 'resolution', 'size', 'center_lat', 'center_lng',
                'min_height', 'max_height', 'terrain_status', 'terrain_progress', 'terrain_message', 'is_default',
                'spawn', 'seed', 'height_scale', 'bounds', 'updated_at',
            ])),
            'coordinates' => sprintf(
                'World metres, y up. x runs west → east and z north → south, both from %s to %s (the map centre is 0, 0). One height sample every %.2f m.',
                -$map->size / 2,
                $map->size / 2,
                $map->size / max(1, $map->resolution - 1),
            ),
            'environment' => $map->resolvedEnvironment(),
            'layers' => $map->layers()->with('material')->orderBy('slot')->get()->map(fn (TerrainLayer $l) => [
                'slot' => $l->slot,
                'name' => $l->name,
                'material' => $l->material ? ['id' => $l->material->id, 'name' => $l->material->name] : null,
                'colors' => [$l->color, $l->color_secondary],
                'tint' => $l->tint,
                'texture_scale' => $l->texture_scale,
                'auto_paint' => [
                    'min_height' => $l->auto_min_height,
                    'max_height' => $l->auto_max_height,
                    'min_slope' => $l->auto_min_slope,
                    'max_slope' => $l->auto_max_slope,
                    'priority' => $l->auto_priority,
                ],
                'ground_cover' => array_map(
                    fn (array $e) => [...$e, 'name' => $types[$e['foliage_type_id']] ?? null],
                    $l->groundCover(),
                ),
            ])->values()->all(),
            'terrain' => $this->terrainStats($map),
            'foliage' => $this->foliageStats($map, $types->all()),
            'editor' => $session ? [
                'open' => true,
                'mode' => $session->mode,
                'state' => $session->state,
            ] : ['open' => false],
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function terrainStats(Map $map): array
    {
        $res = $map->resolution;
        $stats = [];
        $heights = $this->storage->read($map, 'heightmap');

        if ($heights !== null) {
            [$min, $max] = TerrainStorage::range($heights);
            $stats['height_range'] = ['min' => round($min, 1), 'max' => round($max, 1)];
        }

        $splat = $this->storage->read($map, 'splatmap');
        $water = $this->storage->read($map, 'water');
        $weights = array_fill(0, TerrainStorage::SPLAT_CHANNELS, 0);
        $wet = 0;
        $samples = 0;

        for ($row = 0; $row < $res; $row += self::STRIDE) {
            for ($col = 0; $col < $res; $col += self::STRIDE) {
                $i = $row * $res + $col;
                $samples++;

                if ($splat !== null) {
                    foreach (unpack('C8', $splat, $i * TerrainStorage::SPLAT_CHANNELS) as $k => $w) {
                        $weights[$k - 1] += $w;
                    }
                }

                if ($water !== null && unpack('g', $water, $i * 4)[1] > TerrainStorage::NO_WATER + 1) {
                    $wet++;
                }
            }
        }

        if ($splat !== null && $samples > 0) {
            $total = max(1, array_sum($weights));
            $stats['layer_coverage_percent'] = collect($weights)
                ->mapWithKeys(fn (int $w, int $slot) => ["slot_{$slot}" => round($w / $total * 100, 1)])
                ->filter(fn (float $p) => $p > 0)
                ->all();
        } else {
            $stats['layer_coverage_percent'] = null;
        }

        $stats['water_coverage_percent'] = $water !== null && $samples > 0 ? round($wet / $samples * 100, 1) : 0;

        return $stats;
    }

    /**
     * @param  array<int, string>  $types
     * @return array<string, mixed>
     */
    private function foliageStats(Map $map, array $types): array
    {
        $file = json_decode($this->storage->read($map, 'foliage') ?? 'null', true);
        $counts = [];

        foreach ($file['instances'] ?? [] as $id => $values) {
            $counts[$types[(int) $id] ?? "type {$id} (deleted)"] = intdiv(count($values), 7);
        }

        arsort($counts);

        return [
            'painted_instances' => $counts,
            'note' => 'Hand-painted / scattered instances as saved. Ground cover (see layers) grows at runtime and is not stored.',
        ];
    }
}
