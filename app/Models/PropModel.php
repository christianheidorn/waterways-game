<?php

namespace App\Models;

use Database\Factories\PropModelFactory;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\Storage;

/**
 * A placeable 3D model (prop): a GLB in the library that maps place as individual objects (huts,
 * bridges, fences, rocks, …). Placements are stored per map in its props file (see the game's Props).
 *
 * @property int $id
 * @property string $name
 * @property string $category
 * @property string $source
 * @property string $status
 * @property string|null $status_message
 * @property string|null $model_path
 * @property string|null $thumbnail_path
 * @property float|null $target_height
 * @property array{x: float, y: float, z: float}|null $dimensions
 * @property list<string>|null $tags
 * @property string|null $prompt
 */
#[Fillable(['name', 'category', 'source', 'status', 'status_message', 'model_path', 'thumbnail_path', 'target_height', 'dimensions', 'tags', 'prompt'])]
class PropModel extends Model
{
    /** @use HasFactory<PropModelFactory> */
    use HasFactory;

    public const CATEGORIES = [
        'building' => 'Buildings', 'structure' => 'Structures (bridges, fences, docks)', 'nature' => 'Nature (rocks, logs)',
        'decoration' => 'Decoration', 'other' => 'Other',
    ];

    protected function casts(): array
    {
        return [
            'target_height' => 'float',
            'dimensions' => 'array',
            'tags' => 'array',
        ];
    }

    protected static function booted(): void
    {
        static::deleting(fn (PropModel $model) => Storage::disk('public')->deleteDirectory("props/{$model->id}"));
    }

    public function isReady(): bool
    {
        return $this->status === 'ready' && $this->model_path !== null;
    }

    /**
     * @return array<string, mixed>
     */
    public function toGameArray(): array
    {
        return [
            'id' => $this->id,
            'name' => $this->name,
            'category' => $this->category,
            'model_url' => $this->model_path ? '/storage/'.$this->model_path.'?v='.($this->updated_at?->timestamp ?? 0) : null,
            'thumbnail_url' => $this->thumbnail_path ? '/storage/'.$this->thumbnail_path.'?v='.($this->updated_at?->timestamp ?? 0) : null,
            'target_height' => $this->target_height,
            'dimensions' => $this->dimensions,
        ];
    }
}
