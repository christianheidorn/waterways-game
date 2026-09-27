<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * @property int $id
 * @property int $map_id
 * @property int $slot
 * @property int|null $material_id
 * @property string $tint
 * @property float $roughness_scale
 * @property float $normal_strength
 * @property string $name
 * @property string $color
 * @property string $color_secondary
 * @property float $roughness
 * @property float $noise_scale
 * @property float $variation
 * @property float $bump
 * @property string|null $texture_path
 * @property float $texture_scale
 * @property float|null $auto_min_height
 * @property float|null $auto_max_height
 * @property float|null $auto_min_slope
 * @property float|null $auto_max_slope
 * @property int $auto_priority
 */
#[Fillable([
    'slot', 'material_id', 'tint', 'roughness_scale', 'normal_strength', 'name', 'color', 'color_secondary', 'roughness', 'noise_scale', 'variation', 'bump',
    'texture_path', 'texture_scale', 'auto_min_height', 'auto_max_height', 'auto_min_slope',
    'auto_max_slope', 'auto_priority',
])]
class TerrainLayer extends Model
{
    public const MAX_LAYERS = 8;

    protected function casts(): array
    {
        return [
            'slot' => 'integer',
            'material_id' => 'integer',
            'roughness_scale' => 'float',
            'normal_strength' => 'float',
            'roughness' => 'float',
            'noise_scale' => 'float',
            'variation' => 'float',
            'bump' => 'float',
            'texture_scale' => 'float',
            'auto_min_height' => 'float',
            'auto_max_height' => 'float',
            'auto_min_slope' => 'float',
            'auto_max_slope' => 'float',
            'auto_priority' => 'integer',
        ];
    }

    /** @return BelongsTo<Material, $this> */
    public function material(): BelongsTo
    {
        return $this->belongsTo(Material::class);
    }

    /** @return BelongsTo<Map, $this> */
    public function map(): BelongsTo
    {
        return $this->belongsTo(Map::class);
    }

    /**
     * @return array<string, mixed>
     */
    public function toGameArray(): array
    {
        return [
            'id' => $this->id,
            'slot' => $this->slot,
            'name' => $this->name,
            'color' => $this->color,
            'color_secondary' => $this->color_secondary,
            'roughness' => $this->roughness,
            'noise_scale' => $this->noise_scale,
            'variation' => $this->variation,
            'bump' => $this->bump,
            'texture_url' => $this->texture_path ? '/storage/'.$this->texture_path : null,
            'texture_scale' => $this->texture_scale,
            'auto_min_height' => $this->auto_min_height,
            'auto_max_height' => $this->auto_max_height,
            'auto_min_slope' => $this->auto_min_slope,
            'auto_max_slope' => $this->auto_max_slope,
            'auto_priority' => $this->auto_priority,
            'material_id' => $this->material_id,
            'material' => $this->material?->isReady() ? $this->material->toGameArray() : null,
            'tint' => $this->tint,
            'roughness_scale' => $this->roughness_scale,
            'normal_strength' => $this->normal_strength,
        ];
    }
}
