<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * A hidden editor the MCP server started: a headless browser process showing a map's editor
 * (see App\Mcp\HeadlessEditor).
 *
 * @property int $id
 * @property int $map_id
 * @property int $pid
 * @property string $browser
 * @property string $url
 * @property string $profile_dir
 * @property Carbon $started_at
 * @property Carbon $last_used_at
 */
#[Fillable(['map_id', 'pid', 'browser', 'url', 'profile_dir', 'started_at', 'last_used_at'])]
class HeadlessBrowser extends Model
{
    protected function casts(): array
    {
        return [
            'pid' => 'integer',
            'started_at' => 'datetime',
            'last_used_at' => 'datetime',
        ];
    }

    /** @return BelongsTo<Map, $this> */
    public function map(): BelongsTo
    {
        return $this->belongsTo(Map::class);
    }
}
