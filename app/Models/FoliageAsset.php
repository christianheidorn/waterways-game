<?php

namespace App\Models;

use App\Enums\FoliageKind;
use App\Mcp\Assets\AssetOptimizer;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Facades\Storage;

/**
 * A foliage model in the studio's asset library (imported from Poly Haven, uploaded or AI generated).
 *
 * Sources are downloaded to the public disk under foliage/{id}/source/ and then "baked" in the
 * browser (resources/game/tools/FoliageBaker.ts) into a game-ready GLB with LODs, which is uploaded
 * back as foliage/{id}/model.glb.
 *
 * @property int $id
 * @property string $name
 * @property FoliageKind $kind
 * @property string $style
 * @property string $source
 * @property string|null $source_ref
 * @property string|null $source_url
 * @property string|null $author
 * @property string|null $license
 * @property list<string>|null $tags
 * @property string $source_type
 * @property string|null $source_path
 * @property array<string, mixed>|null $bake_options
 * @property float|null $target_height
 * @property string|null $model_path
 * @property string|null $thumbnail_path
 * @property array<string, mixed>|null $meta
 * @property string $status
 * @property string|null $status_message
 * @property string|null $ai_prompt
 * @property string|null $ai_model
 */
#[Fillable([
    'name', 'kind', 'style', 'source', 'source_ref', 'source_url', 'author', 'license', 'tags',
    'source_type', 'source_path', 'bake_options', 'target_height', 'model_path', 'thumbnail_path',
    'meta', 'status', 'status_message', 'ai_prompt', 'ai_model',
])]
class FoliageAsset extends Model
{
    public const STYLES = ['realistic' => 'Realistic', 'stylized' => 'Stylized'];

    public const SOURCES = ['polyhaven' => 'Poly Haven', 'upload' => 'Upload', 'ai' => 'AI generated'];

    /** Statuses in which work is still pending (queued job or waiting for the browser bake). */
    public const PENDING = ['queued', 'processing', 'awaiting_bake'];

    protected function casts(): array
    {
        return [
            'kind' => FoliageKind::class,
            'tags' => 'array',
            'bake_options' => 'array',
            'meta' => 'array',
            'target_height' => 'float',
        ];
    }

    protected static function booted(): void
    {
        static::deleting(function (FoliageAsset $asset) {
            Storage::disk('public')->deleteDirectory($asset->storageDirectory());
        });
    }

    /** @return HasMany<FoliageType, $this> */
    public function types(): HasMany
    {
        return $this->hasMany(FoliageType::class);
    }

    public function storageDirectory(): string
    {
        return "foliage/{$this->id}";
    }

    public function isReady(): bool
    {
        return $this->status === 'ready' && $this->model_path !== null;
    }

    public function canBake(): bool
    {
        return $this->source_path !== null && Storage::disk('public')->exists($this->source_path);
    }

    private function url(?string $path): ?string
    {
        return $path ? '/storage/'.$path.'?v='.($this->updated_at?->timestamp ?? 0) : null;
    }

    /**
     * Shape consumed by the game (FoliageAssetRef in resources/game/shared/types.ts).
     *
     * @return array<string, mixed>
     */
    public function toGameArray(): array
    {
        $meta = $this->meta ?? [];

        return [
            'id' => $this->id,
            'name' => $this->name,
            'style' => $this->style,
            'model_url' => $this->isReady() ? $this->url($this->model_path) : null,
            // Compressed copy (meshopt + KTX2, `waterways:optimize-assets` / optimize_assets); the game falls back to model_url.
            'optimized_url' => $this->isReady() ? AssetOptimizer::optimizedUrl($this->model_path, (string) ($this->updated_at?->timestamp ?? 0)) : null,
            'thumbnail_url' => $this->url($this->thumbnail_path),
            'height' => isset($meta['height']) ? (float) $meta['height'] : null,
            'triangles' => array_values(array_map('intval', $meta['triangles'] ?? [])),
            'lod_distances' => array_values(array_map('floatval', $meta['lod_distances'] ?? [])),
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
            'kind' => $this->kind->value,
            'source' => $this->source,
            'source_ref' => $this->source_ref,
            'source_url' => $this->source_url,
            'author' => $this->author,
            'license' => $this->license,
            'tags' => $this->tags ?? [],
            'source_type' => $this->source_type,
            'source_file_url' => $this->source_path ? '/storage/'.$this->source_path : null,
            'bake_options' => $this->bake_options ?? (object) [],
            'target_height' => $this->target_height,
            'meta' => $this->meta ?? (object) [],
            'status' => $this->status,
            'status_message' => $this->status_message,
            'ai_prompt' => $this->ai_prompt,
            'ai_model' => $this->ai_model,
            'types_count' => $this->types_count ?? null,
            'created_at' => $this->created_at?->toIso8601String(),
            'updated_at' => $this->updated_at?->format('Y-m-d\TH:i:s.uP'),
        ];
    }
}
