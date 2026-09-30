<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * A restore point of a map (see App\Mcp\MapSnapshots): its terrain assets are copied to
 * `storageDirectory()`, its layers and settings are kept in `data`.
 *
 * @property int $id
 * @property int $map_id
 * @property string $label
 * @property bool $auto
 * @property array<string, mixed> $data
 * @property Carbon $created_at
 */
#[Fillable(['map_id', 'label', 'auto', 'data'])]
class MapSnapshot extends Model
{
    protected function casts(): array
    {
        return [
            'auto' => 'boolean',
            'data' => 'array',
        ];
    }

    /** @return BelongsTo<Map, $this> */
    public function map(): BelongsTo
    {
        return $this->belongsTo(Map::class);
    }

    public function storageDirectory(): string
    {
        return $this->map->storageDirectory().'/snapshots/'.$this->id;
    }
}
