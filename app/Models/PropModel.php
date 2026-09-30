<?php

namespace App\Models;

use App\Mcp\Assets\GltfInspector;
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
 * @property string $collision auto, box, mesh or none
 * @property array{x: float, y: float, z: float}|null $dimensions
 * @property int|null $triangles
 * @property int|null $meshes
 * @property int|null $materials
 * @property list<string>|null $tags
 * @property string|null $prompt
 */
#[Fillable(['name', 'category', 'source', 'status', 'status_message', 'model_path', 'thumbnail_path', 'target_height', 'collision', 'dimensions', 'triangles', 'meshes', 'materials', 'tags', 'prompt'])]
class PropModel extends Model
{
    /** @use HasFactory<PropModelFactory> */
    use HasFactory;

    public const CATEGORIES = [
        'building' => 'Buildings', 'structure' => 'Structures (bridges, fences, docks)', 'nature' => 'Nature (rocks, logs)',
        'decoration' => 'Decoration', 'other' => 'Other',
    ];

    /** How placed copies collide: boxes fitted to the model, one box, the exact triangles, or not at all. */
    public const COLLISIONS = ['auto', 'box', 'mesh', 'none'];

    protected function casts(): array
    {
        return [
            'target_height' => 'float',
            'dimensions' => 'array',
            'triangles' => 'integer',
            'meshes' => 'integer',
            'materials' => 'integer',
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
     * Fills triangles / meshes / materials from the stored GLB when they were never measured (models
     * made before they were recorded). Returns whether they are known.
     */
    public function measure(): bool
    {
        if ($this->triangles !== null) {
            return true;
        }

        $disk = Storage::disk('public');
        if (! $this->isReady() || ! $disk->exists((string) $this->model_path)) {
            return false;
        }

        $document = GltfInspector::document((string) $disk->get((string) $this->model_path));
        if ($document === null) {
            return false;
        }

        // Not a change the user made: keep updated_at (it versions the model URL).
        $this->timestamps = false;
        $this->forceFill(GltfInspector::stats($document))->save();
        $this->timestamps = true;

        return true;
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
            'triangles' => $this->triangles,
            'meshes' => $this->meshes,
            'materials' => $this->materials,
            'collision' => $this->collision ?? 'auto',
        ];
    }
}
