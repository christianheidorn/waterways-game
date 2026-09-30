<?php

namespace App\Models;

use App\Enums\FoliageKind;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * @property int $id
 * @property string $name
 * @property FoliageKind $kind
 * @property string $color
 * @property string $color_secondary
 * @property string|null $model_path
 * @property int|null $foliage_asset_id
 * @property string $tint
 * @property-read FoliageAsset|null $asset
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
 * @property string $collision auto, none, trunk or bounds
 * @property float|null $collision_radius
 */
#[Fillable([
    'name', 'kind', 'color', 'color_secondary', 'model_path', 'foliage_asset_id', 'tint', 'min_scale', 'max_scale', 'density',
    'min_slope', 'max_slope', 'min_height', 'max_height', 'align_to_normal', 'random_yaw',
    'cast_shadows', 'cull_distance', 'allow_underwater', 'collision', 'collision_radius',
])]
class FoliageType extends Model
{
    /** auto: trees get a trunk, rocks their bounds, bushes and small plants none. */
    public const COLLISIONS = ['auto', 'none', 'trunk', 'bounds'];

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
            'collision_radius' => 'float',
        ];
    }

    /** @return BelongsTo<FoliageAsset, $this> */
    public function asset(): BelongsTo
    {
        return $this->belongsTo(FoliageAsset::class, 'foliage_asset_id');
    }

    /**
     * The model the game renders: the linked asset's baked GLB once it is ready, else a legacy upload.
     */
    public function modelUrl(): ?string
    {
        if ($this->asset?->isReady()) {
            return $this->asset->toGameArray()['model_url'];
        }

        return $this->model_path ? '/storage/'.$this->model_path : null;
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
            'model_url' => $this->modelUrl(),
            'foliage_asset_id' => $this->foliage_asset_id,
            'asset' => $this->asset?->toGameArray(),
            'tint' => $this->tint ?? '#ffffff',
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
            'collision' => $this->collision ?? 'auto',
            'collision_radius' => $this->collision_radius,
        ];
    }
}
