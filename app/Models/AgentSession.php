<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * An open editor that runs commands for AI agents (see App\Mcp\EditorBridge).
 *
 * @property string $id
 * @property int $map_id
 * @property string $mode
 * @property array<string, mixed>|null $state
 * @property Carbon $last_seen_at
 */
#[Fillable(['id', 'map_id', 'mode', 'state', 'last_seen_at'])]
class AgentSession extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected function casts(): array
    {
        return [
            'state' => 'array',
            'last_seen_at' => 'datetime',
        ];
    }

    /** @return BelongsTo<Map, $this> */
    public function map(): BelongsTo
    {
        return $this->belongsTo(Map::class);
    }
}
