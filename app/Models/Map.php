<?php

namespace App\Models;

use App\Enums\MapSource;
use App\Enums\TerrainStatus;
use App\Support\EnvironmentDefaults;
use Database\Factories\MapFactory;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Storage;

/**
 * @property int $id
 * @property string $name
 * @property string $slug
 * @property string|null $description
 * @property MapSource $source
 * @property int $resolution
 * @property float $size
 * @property float|null $center_lat
 * @property float|null $center_lng
 * @property float $height_scale
 * @property bool $import_water
 * @property float $lake_depth
 * @property float $river_depth
 * @property float $shore_angle
 * @property float $bank_angle
 * @property float $smoothing
 * @property int $seed
 * @property float $min_height
 * @property float $max_height
 * @property float|null $spawn_x
 * @property float|null $spawn_z
 * @property float $spawn_yaw
 * @property array<string, mixed>|null $environment
 * @property TerrainStatus $terrain_status
 * @property int $terrain_progress
 * @property string|null $terrain_message
 * @property int $revision
 * @property bool $is_default
 * @property Carbon|null $terrain_generated_at
 * @property Carbon|null $created_at
 * @property Carbon|null $updated_at
 */
#[Fillable([
    'name', 'slug', 'description', 'source', 'resolution', 'size', 'center_lat', 'center_lng',
    'height_scale', 'import_water', 'lake_depth', 'river_depth', 'shore_angle', 'bank_angle', 'smoothing', 'seed', 'min_height', 'max_height', 'spawn_x', 'spawn_z', 'spawn_yaw',
    'environment', 'terrain_status', 'terrain_progress', 'terrain_message', 'revision', 'is_default',
    'terrain_generated_at',
])]
class Map extends Model
{
    /** @use HasFactory<MapFactory> */
    use HasFactory;

    public const RESOLUTIONS = [257, 513, 1025];

    protected function casts(): array
    {
        return [
            'source' => MapSource::class,
            'terrain_status' => TerrainStatus::class,
            'environment' => 'array',
            'import_water' => 'boolean',
            'is_default' => 'boolean',
            'resolution' => 'integer',
            'size' => 'float',
            'center_lat' => 'float',
            'center_lng' => 'float',
            'height_scale' => 'float',
            'lake_depth' => 'float',
            'river_depth' => 'float',
            'shore_angle' => 'float',
            'bank_angle' => 'float',
            'smoothing' => 'float',
            'min_height' => 'float',
            'max_height' => 'float',
            'spawn_x' => 'float',
            'spawn_z' => 'float',
            'spawn_yaw' => 'float',
            'terrain_generated_at' => 'datetime',
        ];
    }

    protected static function booted(): void
    {
        static::deleting(function (Map $map) {
            Storage::disk('local')->deleteDirectory($map->storageDirectory());
            Storage::disk('public')->delete($map->thumbnailPath());
        });
    }

    /** @return HasMany<TerrainLayer, $this> */
    public function layers(): HasMany
    {
        return $this->hasMany(TerrainLayer::class)->orderBy('slot');
    }

    public function getRouteKeyName(): string
    {
        return 'slug';
    }

    /**
     * @return array<string, mixed>
     */
    public function resolvedEnvironment(): array
    {
        return EnvironmentDefaults::merge($this->environment ?? []);
    }

    public function storageDirectory(): string
    {
        return "maps/{$this->id}";
    }

    public function thumbnailPath(): string
    {
        return "thumbnails/map-{$this->id}.jpg";
    }

    public function thumbnailUrl(): ?string
    {
        if (! Storage::disk('public')->exists($this->thumbnailPath())) {
            return null;
        }

        return '/storage/'.$this->thumbnailPath().'?v='.$this->revision;
    }

    /**
     * Bounding box of a real-world map in degrees.
     *
     * @return array{south: float, west: float, north: float, east: float}|null
     */
    public function bounds(): ?array
    {
        if ($this->center_lat === null || $this->center_lng === null) {
            return null;
        }

        $latDelta = ($this->size / 2) / 111_320;
        $lngDelta = ($this->size / 2) / (111_320 * cos(deg2rad($this->center_lat)));

        return [
            'south' => $this->center_lat - $latDelta,
            'west' => $this->center_lng - $lngDelta,
            'north' => $this->center_lat + $latDelta,
            'east' => $this->center_lng + $lngDelta,
        ];
    }
}
