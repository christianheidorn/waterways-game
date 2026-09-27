<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\Storage;

/**
 * A playable character in the studio's character library (generated with Meshy or uploaded).
 *
 * Files live on the public disk under characters/{id}/: model.glb (rigged) plus one GLB per extra
 * animation clip (same skeleton), which the game merges by clip name.
 *
 * @property int $id
 * @property string $name
 * @property string $source
 * @property string|null $prompt
 * @property int $style
 * @property float $height
 * @property string|null $model_path
 * @property array<string, string>|null $animations
 * @property string|null $thumbnail_path
 * @property array<string, mixed>|null $meta
 * @property string $status
 * @property string|null $status_message
 * @property string|null $ai_model
 */
#[Fillable([
    'name', 'source', 'prompt', 'style', 'height', 'model_path', 'animations', 'thumbnail_path', 'meta',
    'status', 'status_message', 'ai_model',
])]
class Character extends Model
{
    public const CLIPS = ['idle', 'walk', 'run', 'jump', 'swim'];

    protected function casts(): array
    {
        return [
            'animations' => 'array',
            'meta' => 'array',
            'height' => 'float',
            'style' => 'integer',
        ];
    }

    protected static function booted(): void
    {
        static::deleting(function (Character $character) {
            Storage::disk('public')->deleteDirectory($character->storageDirectory());
        });
    }

    public function storageDirectory(): string
    {
        return "characters/{$this->id}";
    }

    public function isReady(): bool
    {
        return $this->status === 'ready' && $this->model_path !== null;
    }

    private function url(?string $path): ?string
    {
        return $path ? '/storage/'.$path.'?v='.($this->updated_at?->timestamp ?? 0) : null;
    }

    /**
     * CharacterRef in resources/game/shared/types.ts.
     *
     * @return array<string, mixed>
     */
    public function toGameArray(): array
    {
        $animations = [];
        foreach ($this->animations ?? [] as $clip => $path) {
            if (in_array($clip, self::CLIPS, true) && is_string($path)) {
                $animations[$clip] = $this->url($path);
            }
        }

        return [
            'id' => $this->id,
            'name' => $this->name,
            'model_url' => $this->url($this->model_path),
            'animations' => (object) $animations,
            'height' => $this->height,
        ];
    }

    /**
     * @return array<string, mixed>
     */
    public function toStudioArray(bool $active = false): array
    {
        return [
            ...$this->toGameArray(),
            'source' => $this->source,
            'prompt' => $this->prompt,
            'style' => $this->style,
            'thumbnail_url' => $this->url($this->thumbnail_path),
            'clips' => array_keys($this->animations ?? []),
            'meta' => $this->meta ?? (object) [],
            'status' => $this->status,
            'status_message' => $this->status_message,
            'ai_model' => $this->ai_model,
            'active' => $active,
            'created_at' => $this->created_at?->toIso8601String(),
        ];
    }
}
