<?php

namespace App\Models;

use App\Enums\FoliageKind;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;

/**
 * @property int $id
 * @property string $name
 * @property FoliageKind $kind
 * @property string $color
 * @property string $color_secondary
 * @property string|null $model_path
 * @property float $min_scale
 * @property float $max_scale
 * @property float $density
 * @property float $min_slope
 * @property float $max_slope
 * @property float|null $min_height
 * @property float|null $max_height
 * @property bool $align_to_normal
 * @property bool $random_yaw
 * @property bool $cast_shadows
 * @property float $cull_distance
 * @property bool $allow_underwater
 */
#[Fillable([
    'name', 'kind', 'color', 'color_secondary', 'model_path', 'min_scale', 'max_scale', 'density',
    'min_slope', 'max_slope', 'min_height', 'max_height', 'align_to_normal', 'random_yaw',
    'cast_shadows', 'cull_distance', 'allow_underwater',
])]
class FoliageType extends Model
{
    protected function casts(): array
    {
        return [
            'kind' => FoliageKind::class,
            'min_scale' => 'float',
            'max_scale' => 'float',
            'density' => 'float',
            'min_slope' => 'float',
            'max_slope' => 'float',
            'min_height' => 'float',
            'max_height' => 'float',
            'align_to_normal' => 'boolean',
            'random_yaw' => 'boolean',
            'cast_shadows' => 'boolean',
            'cull_distance' => 'float',
            'allow_underwater' => 'boolean',
        ];
    }

    /**
     * @return array<string, mixed>
     */
    public function toGameArray(): array
    {
        return [
            'id' => $this->id,
            'name' => $this->name,
            'kind' => $this->kind->value,
            'color' => $this->color,
            'color_secondary' => $this->color_secondary,
            'model_url' => $this->model_path ? '/storage/'.$this->model_path : null,
            'min_scale' => $this->min_scale,
            'max_scale' => $this->max_scale,
            'density' => $this->density,
            'min_slope' => $this->min_slope,
            'max_slope' => $this->max_slope,
            'min_height' => $this->min_height,
            'max_height' => $this->max_height,
            'align_to_normal' => $this->align_to_normal,
            'random_yaw' => $this->random_yaw,
            'cast_shadows' => $this->cast_shadows,
            'cull_distance' => $this->cull_distance,
            'allow_underwater' => $this->allow_underwater,
        ];
    }
}
