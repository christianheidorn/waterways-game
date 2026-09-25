<?php

namespace App\Support;

use App\Models\Map;

/**
 * The starter material palette every new map receives. Auto-paint rules are relative to the
 * map's height range, so they are resolved when the layers are created.
 */
final class DefaultTerrainLayers
{
    /**
     * @return list<array<string, mixed>>
     */
    public static function definitions(float $minHeight, float $maxHeight, float $seaLevel = 0): array
    {
        $range = max(1.0, $maxHeight - $minHeight);
        // Snow needs real altitude: never below 1600 m, and only on the upper part of the map.
        $snowLine = max(1600.0, $minHeight + $range * 0.8);
        $hasSnow = $maxHeight > $snowLine + 50;
        $beach = $seaLevel + max(1.5, $range * 0.004);

        return [
            ['slot' => 0, 'name' => 'Grass', 'color' => '#4f6b2a', 'color_secondary' => '#6f8a34', 'roughness' => 0.95, 'noise_scale' => 6, 'variation' => 0.55, 'bump' => 0.35,
                'auto_min_height' => null, 'auto_max_height' => null, 'auto_min_slope' => null, 'auto_max_slope' => null, 'auto_priority' => 0],
            ['slot' => 1, 'name' => 'Meadow', 'color' => '#6d7f35', 'color_secondary' => '#8e9443', 'roughness' => 0.95, 'noise_scale' => 22, 'variation' => 0.6, 'bump' => 0.3,
                'auto_min_height' => null, 'auto_max_height' => null, 'auto_min_slope' => 0.0, 'auto_max_slope' => 8.0, 'auto_priority' => 1],
            ['slot' => 2, 'name' => 'Forest floor', 'color' => '#3d3521', 'color_secondary' => '#56462a', 'roughness' => 0.97, 'noise_scale' => 4, 'variation' => 0.5, 'bump' => 0.5,
                'auto_min_height' => null, 'auto_max_height' => null, 'auto_min_slope' => 18.0, 'auto_max_slope' => 30.0, 'auto_priority' => 2],
            ['slot' => 3, 'name' => 'Rock', 'color' => '#5c574f', 'color_secondary' => '#7a746a', 'roughness' => 0.92, 'noise_scale' => 5, 'variation' => 0.6, 'bump' => 0.9,
                'auto_min_height' => null, 'auto_max_height' => null, 'auto_min_slope' => 32.0, 'auto_max_slope' => 90.0, 'auto_priority' => 5],
            ['slot' => 4, 'name' => 'Sand', 'color' => '#c2ad7f', 'color_secondary' => '#d8c595', 'roughness' => 0.9, 'noise_scale' => 3, 'variation' => 0.35, 'bump' => 0.25,
                'auto_min_height' => $minHeight - 1000, 'auto_max_height' => $beach, 'auto_min_slope' => 0.0, 'auto_max_slope' => 20.0, 'auto_priority' => 4],
            ['slot' => 5, 'name' => 'Mud', 'color' => '#4a3b2a', 'color_secondary' => '#3a2f22', 'roughness' => 0.6, 'noise_scale' => 3, 'variation' => 0.4, 'bump' => 0.4,
                'auto_min_height' => null, 'auto_max_height' => null, 'auto_min_slope' => null, 'auto_max_slope' => null, 'auto_priority' => 0],
            ['slot' => 6, 'name' => 'Gravel', 'color' => '#7d776d', 'color_secondary' => '#5e5950', 'roughness' => 0.9, 'noise_scale' => 1.5, 'variation' => 0.7, 'bump' => 0.7,
                'auto_min_height' => null, 'auto_max_height' => null, 'auto_min_slope' => null, 'auto_max_slope' => null, 'auto_priority' => 0],
            ['slot' => 7, 'name' => 'Snow', 'color' => '#e9eef2', 'color_secondary' => '#cfd9e3', 'roughness' => 0.5, 'noise_scale' => 12, 'variation' => 0.3, 'bump' => 0.2,
                // Only maps with high mountains get automatic snow caps.
                'auto_min_height' => $hasSnow ? $snowLine : null, 'auto_max_height' => $hasSnow ? $maxHeight + 1000 : null,
                'auto_min_slope' => $hasSnow ? 0.0 : null, 'auto_max_slope' => $hasSnow ? 40.0 : null, 'auto_priority' => $hasSnow ? 6 : 0],
        ];
    }

    public static function createFor(Map $map): void
    {
        $env = $map->resolvedEnvironment();

        foreach (self::definitions($map->min_height, $map->max_height, (float) $env['sea_level']) as $definition) {
            $map->layers()->updateOrCreate(['slot' => $definition['slot']], $definition);
        }
    }
}
