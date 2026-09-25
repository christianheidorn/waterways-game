<?php

namespace Database\Seeders;

use App\Models\FoliageType;
use Illuminate\Database\Seeder;

class FoliageTypeSeeder extends Seeder
{
    public function run(): void
    {
        $types = [
            ['name' => 'Spruce', 'kind' => 'conifer', 'color' => '#2c4a2b', 'color_secondary' => '#4a3524', 'min_scale' => 0.7, 'max_scale' => 1.35, 'density' => 0.6, 'max_slope' => 38, 'cull_distance' => 1600],
            ['name' => 'Oak', 'kind' => 'broadleaf', 'color' => '#4c6b2c', 'color_secondary' => '#57402b', 'min_scale' => 0.75, 'max_scale' => 1.3, 'density' => 0.35, 'max_slope' => 28, 'cull_distance' => 1500],
            ['name' => 'Birch', 'kind' => 'broadleaf', 'color' => '#7b9a3a', 'color_secondary' => '#d8d2c4', 'min_scale' => 0.6, 'max_scale' => 1.0, 'density' => 0.4, 'max_slope' => 30, 'cull_distance' => 1400],
            ['name' => 'Palm', 'kind' => 'palm', 'color' => '#5d8a34', 'color_secondary' => '#8a6d4a', 'min_scale' => 0.8, 'max_scale' => 1.2, 'density' => 0.2, 'max_slope' => 20, 'cull_distance' => 1200],
            ['name' => 'Shrub', 'kind' => 'bush', 'color' => '#40602a', 'color_secondary' => '#4a3a26', 'min_scale' => 0.6, 'max_scale' => 1.4, 'density' => 2, 'max_slope' => 40, 'cull_distance' => 500, 'cast_shadows' => true],
            ['name' => 'Meadow grass', 'kind' => 'grass', 'color' => '#6f8f38', 'color_secondary' => '#4f6b28', 'min_scale' => 0.7, 'max_scale' => 1.3, 'density' => 40, 'max_slope' => 35, 'cull_distance' => 140, 'cast_shadows' => false, 'align_to_normal' => true],
            ['name' => 'Wildflowers', 'kind' => 'flower', 'color' => '#e3c54a', 'color_secondary' => '#4d7a2c', 'min_scale' => 0.7, 'max_scale' => 1.2, 'density' => 6, 'max_slope' => 25, 'cull_distance' => 110, 'cast_shadows' => false, 'align_to_normal' => true],
            ['name' => 'Reeds', 'kind' => 'reed', 'color' => '#7a8a45', 'color_secondary' => '#5a4630', 'min_scale' => 0.8, 'max_scale' => 1.3, 'density' => 12, 'max_slope' => 20, 'cull_distance' => 220, 'cast_shadows' => false, 'allow_underwater' => true],
            ['name' => 'Boulder', 'kind' => 'rock', 'color' => '#77716a', 'color_secondary' => '#56663a', 'min_scale' => 0.5, 'max_scale' => 2.5, 'density' => 0.3, 'max_slope' => 60, 'cull_distance' => 900, 'align_to_normal' => true, 'allow_underwater' => true],
        ];

        foreach ($types as $type) {
            FoliageType::query()->updateOrCreate(['name' => $type['name']], $type);
        }
    }
}
