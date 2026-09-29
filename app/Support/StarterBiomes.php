<?php

namespace App\Support;

use App\Models\Biome;
use App\Models\FoliageType;
use App\Services\Materials\StarterMaterials;
use Illuminate\Support\Collection;

/**
 * The starter biome library. Plants are chosen from the foliage library by kind (the first type of
 * a kind, or the second for a mixed forest), grounds from the default terrain layer palette and the
 * starter materials, so the biomes fit whatever library this install has.
 */
final class StarterBiomes
{
    /**
     * key => [name, description, default layer to take the ground from, plants]
     * plant: [kind, nth type of that kind (0-based), density ×, clustering, spacing m]
     *
     * @var array<string, array{name: string, description: string, ground: string, plants: list<array{0: string, 1: int, 2: float, 3: float, 4: float}>}>
     */
    public const BIOMES = [
        'meadow' => [
            'name' => 'Meadow',
            'description' => 'Tall grass with patches of wildflowers and the odd shrub.',
            'ground' => 'Meadow',
            'plants' => [['grass', 0, 1.0, 0.3, 0], ['flower', 0, 0.8, 0.7, 0], ['bush', 0, 0.15, 0.8, 3]],
        ],
        'temperate_forest' => [
            'name' => 'Temperate forest',
            'description' => 'Mixed broadleaf woodland with undergrowth and clearings.',
            'ground' => 'Forest floor',
            'plants' => [['broadleaf', 0, 1.0, 0.6, 5], ['broadleaf', 1, 0.6, 0.6, 5], ['bush', 0, 0.6, 0.5, 0], ['grass', 0, 0.25, 0.6, 0]],
        ],
        'conifer_forest' => [
            'name' => 'Conifer forest',
            'description' => 'Dense evergreen stands, shrubs and scattered boulders.',
            'ground' => 'Forest floor',
            'plants' => [['conifer', 0, 1.2, 0.5, 4], ['bush', 0, 0.3, 0.6, 0], ['rock', 0, 0.5, 0.5, 0]],
        ],
        'alpine' => [
            'name' => 'Alpine pasture',
            'description' => 'Short grass and flowers, rocks and small groves of conifers.',
            'ground' => 'Grass',
            'plants' => [['grass', 0, 0.6, 0.4, 0], ['flower', 0, 0.4, 0.8, 0], ['conifer', 0, 0.25, 0.9, 8], ['rock', 0, 1.0, 0.6, 0]],
        ],
        'beach' => [
            'name' => 'Beach',
            'description' => 'Sand with palms in loose groups and tufts of grass.',
            'ground' => 'Sand',
            'plants' => [['palm', 0, 0.6, 0.7, 8], ['grass', 0, 0.1, 0.9, 0]],
        ],
        'wetland' => [
            'name' => 'Wetland',
            'description' => 'Muddy ground with reed beds and wet grass.',
            'ground' => 'Mud',
            'plants' => [['reed', 0, 1.5, 0.7, 0], ['grass', 0, 0.6, 0.4, 0]],
        ],
        'rocky_slope' => [
            'name' => 'Rocky slope',
            'description' => 'Bare rock with boulders and a few hardy shrubs.',
            'ground' => 'Rock',
            'plants' => [['rock', 0, 1.5, 0.5, 0], ['bush', 0, 0.1, 0.8, 0]],
        ],
    ];

    /**
     * Creates the starter biomes that are missing (deleted ones come back).
     *
     * @return int biomes created
     */
    public static function install(): int
    {
        /** @var Collection<string, Collection<int, FoliageType>> $byKind */
        $byKind = FoliageType::query()->orderBy('id')->get()->groupBy(fn (FoliageType $t) => $t->kind->value);
        $grounds = collect(DefaultTerrainLayers::definitions(0, 1000))->keyBy('name');
        $created = 0;

        foreach (self::BIOMES as $key => $biome) {
            if (Biome::query()->where('starter_key', $key)->exists()) {
                continue;
            }

            $ground = $grounds[$biome['ground']];
            $look = array_intersect_key($ground, array_flip(Biome::LOOK));
            $look += ['texture_scale' => 4, 'tint' => '#ffffff', 'roughness_scale' => 1, 'normal_strength' => 1, 'material_id' => null];
            $material = StarterMaterials::materialForLayer($biome['ground']);
            if ($material !== null) {
                $look['material_id'] = $material->id;
                $look['texture_scale'] = $material->tile_size;
            }

            $cover = [];
            foreach ($biome['plants'] as [$kind, $nth, $density, $clustering, $spacing]) {
                $type = $byKind[$kind][$nth] ?? null;
                if ($type !== null && ! in_array($type->id, array_column($cover, 'foliage_type_id'), true)) {
                    $cover[] = ['foliage_type_id' => $type->id, 'density' => $density, 'clustering' => $clustering, 'spacing' => $spacing];
                }
            }

            Biome::query()->create([
                'name' => $biome['name'],
                'description' => $biome['description'],
                'starter_key' => $key,
                'look' => $look,
                'ground_cover' => $cover,
            ]);
            $created++;
        }

        return $created;
    }
}
