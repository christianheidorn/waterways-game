<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Facades\Storage;

/**
 * A reusable PBR terrain material (albedo, normal, roughness, ambient occlusion, height).
 *
 * Map files live on the public disk under materials/{id}/.
 *
 * @property int $id
 * @property string $name
 * @property string $slug
 * @property string $category
 * @property string $source
 * @property string|null $source_ref
 * @property string|null $source_url
 * @property string|null $author
 * @property string|null $license
 * @property list<string>|null $tags
 * @property float $tile_size
 * @property int|null $resolution
 * @property string|null $albedo_path
 * @property string|null $normal_path
 * @property string|null $roughness_path
 * @property string|null $ao_path
 * @property string|null $height_path
 * @property string|null $thumbnail_path
 * @property string $tint
 * @property float $roughness_scale
 * @property float $normal_strength
 * @property float $height_contrast
 * @property string $status
 * @property string|null $status_message
 * @property string|null $ai_prompt
 * @property string|null $ai_model
 * @property int|null $parent_id
 */
#[Fillable([
    'name', 'slug', 'category', 'source', 'source_ref', 'source_url', 'author', 'license', 'tags',
    'tile_size', 'resolution', 'albedo_path', 'normal_path', 'roughness_path', 'ao_path', 'height_path',
    'thumbnail_path', 'tint', 'roughness_scale', 'normal_strength', 'height_contrast', 'status',
    'status_message', 'ai_prompt', 'ai_model', 'parent_id',
])]
class Material extends Model
{
    public const CATEGORIES = [
        'grass' => 'Grass', 'forest' => 'Forest floor', 'soil' => 'Soil & dirt', 'rock' => 'Rock & cliff',
        'gravel' => 'Gravel & pebbles', 'sand' => 'Sand', 'mud' => 'Mud', 'snow' => 'Snow & ice',
        'field' => 'Fields & crops', 'urban' => 'Paved & urban', 'other' => 'Other',
    ];

    public const MAPS = ['albedo', 'normal', 'roughness', 'ao', 'height'];

    protected function casts(): array
    {
        return [
            'tags' => 'array',
            'tile_size' => 'float',
            'resolution' => 'integer',
            'roughness_scale' => 'float',
            'normal_strength' => 'float',
            'height_contrast' => 'float',
        ];
    }

    protected static function booted(): void
    {
        static::deleting(function (Material $material) {
            Storage::disk('public')->deleteDirectory($material->storageDirectory());
        });
    }

    /** @return BelongsTo<Material, $this> */
    public function parent(): BelongsTo
    {
        return $this->belongsTo(Material::class, 'parent_id');
    }

    /** @return HasMany<TerrainLayer, $this> */
    public function layers(): HasMany
    {
        return $this->hasMany(TerrainLayer::class);
    }

    public function storageDirectory(): string
    {
        return "materials/{$this->id}";
    }

    public function isReady(): bool
    {
        return $this->status === 'ready' && $this->albedo_path !== null;
    }

    /**
     * Root-relative URLs of the available maps (cache-busted by updated_at).
     *
     * @return array<string, string|null>
     */
    public function mapUrls(): array
    {
        $v = $this->updated_at?->timestamp ?? 0;
        $urls = [];

        foreach (self::MAPS as $map) {
            $path = $this->{$map.'_path'};
            $urls[$map] = $path ? '/storage/'.$path.'?v='.$v : null;
        }

        return $urls;
    }

    /**
     * Shape consumed by the game (see TerrainMaterialRef in resources/game/shared/types.ts).
     *
     * @return array<string, mixed>
     */
    public function toGameArray(): array
    {
        return [
            'id' => $this->id,
            'name' => $this->name,
            'maps' => $this->mapUrls(),
            'thumbnail_url' => $this->thumbnail_path
                ? '/storage/'.$this->thumbnail_path.'?v='.($this->updated_at?->timestamp ?? 0)
                : ($this->mapUrls()['albedo'] ?? null),
            'tile_size' => $this->tile_size,
            'tint' => $this->tint,
            'roughness_scale' => $this->roughness_scale,
            'normal_strength' => $this->normal_strength,
            'height_contrast' => $this->height_contrast,
        ];
    }

    /**
     * Shape used by the studio library.
     *
     * @return array<string, mixed>
     */
    public function toStudioArray(): array
    {
        return [
            ...$this->toGameArray(),
            'slug' => $this->slug,
            'category' => $this->category,
            'source' => $this->source,
            'source_ref' => $this->source_ref,
            'source_url' => $this->source_url,
            'author' => $this->author,
            'license' => $this->license,
            'tags' => $this->tags ?? [],
            'resolution' => $this->resolution,
            'thumbnail_url' => $this->thumbnail_path ? '/storage/'.$this->thumbnail_path.'?v='.($this->updated_at?->timestamp ?? 0) : null,
            'status' => $this->status,
            'status_message' => $this->status_message,
            'ai_prompt' => $this->ai_prompt,
            'ai_model' => $this->ai_model,
            'parent_id' => $this->parent_id,
            'layers_count' => $this->layers_count ?? null,
            'created_at' => $this->created_at?->toIso8601String(),
        ];
    }
}
