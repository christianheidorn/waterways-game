<?php

namespace App\Services\Foliage;

use App\Enums\FoliageKind;

/**
 * Sensible starting settings for a new foliage type of each kind.
 */
class FoliageTypeDefaults
{
    public const DEFAULTS = [
        'conifer' => ['color' => '#2c4a2b', 'color_secondary' => '#4a3524', 'density' => 0.6, 'max_slope' => 38, 'cull_distance' => 1600, 'cast_shadows' => true, 'align_to_normal' => false],
        'broadleaf' => ['color' => '#4c6b2c', 'color_secondary' => '#57402b', 'density' => 0.35, 'max_slope' => 28, 'cull_distance' => 1500, 'cast_shadows' => true, 'align_to_normal' => false],
        'palm' => ['color' => '#5d8a34', 'color_secondary' => '#8a6d4a', 'density' => 0.2, 'max_slope' => 20, 'cull_distance' => 1200, 'cast_shadows' => true, 'align_to_normal' => false],
        'bush' => ['color' => '#40602a', 'color_secondary' => '#4a3a26', 'density' => 2, 'max_slope' => 40, 'cull_distance' => 500, 'cast_shadows' => true, 'align_to_normal' => false],
        'grass' => ['color' => '#6f8f38', 'color_secondary' => '#4f6b28', 'density' => 40, 'max_slope' => 35, 'cull_distance' => 140, 'cast_shadows' => false, 'align_to_normal' => true],
        'flower' => ['color' => '#e3c54a', 'color_secondary' => '#4d7a2c', 'density' => 6, 'max_slope' => 25, 'cull_distance' => 110, 'cast_shadows' => false, 'align_to_normal' => true],
        'reed' => ['color' => '#7a8a45', 'color_secondary' => '#5a4630', 'density' => 12, 'max_slope' => 20, 'cull_distance' => 220, 'cast_shadows' => false, 'align_to_normal' => false, 'allow_underwater' => true],
        'rock' => ['color' => '#77716a', 'color_secondary' => '#56663a', 'density' => 0.3, 'max_slope' => 60, 'cull_distance' => 900, 'cast_shadows' => true, 'align_to_normal' => true, 'allow_underwater' => true],
    ];

    /**
     * @return array<string, mixed>
     */
    public function forKind(FoliageKind $kind): array
    {
        return [
            'kind' => $kind->value,
            'min_scale' => $kind === FoliageKind::Rock ? 0.5 : 0.8,
            'max_scale' => $kind === FoliageKind::Rock ? 2.0 : 1.2,
            'min_slope' => 0,
            'min_height' => null,
            'max_height' => null,
            'random_yaw' => true,
            'allow_underwater' => false,
            'tint' => '#ffffff',
            ...self::DEFAULTS[$kind->value],
        ];
    }
}
