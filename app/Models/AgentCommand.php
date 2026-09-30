<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;

/**
 * A command queued for the open editor of a map (see App\Mcp\EditorBridge).
 *
 * @property int $id
 * @property int $map_id
 * @property string|null $session_id
 * @property string $type
 * @property array<string, mixed>|null $payload
 * @property string $status
 * @property string|null $result
 * @property string|null $error
 */
#[Fillable(['map_id', 'session_id', 'type', 'payload', 'status', 'result', 'error', 'claimed_at', 'finished_at'])]
class AgentCommand extends Model
{
    protected function casts(): array
    {
        return [
            'payload' => 'array',
            'claimed_at' => 'datetime',
            'finished_at' => 'datetime',
        ];
    }
}
