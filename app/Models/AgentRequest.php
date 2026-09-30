<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Facades\Storage;

/**
 * A build request for AI agents, made in the editor: an outlined area of a map, a note (what to
 * build there), reference images and a screenshot of the user's view. Agents pick it up through the
 * MCP server (list_requests / get_request), build it and report back (update_request).
 *
 * @property int $id
 * @property int $map_id
 * @property string $status
 * @property string $note
 * @property list<array{x: float, z: float}> $area
 * @property array<string, mixed>|null $camera
 * @property string|null $screenshot_path
 * @property list<string>|null $reference_paths
 * @property list<string>|null $result_paths
 * @property string|null $agent_message
 */
#[Fillable(['map_id', 'status', 'note', 'area', 'camera', 'screenshot_path', 'reference_paths', 'result_paths', 'agent_message'])]
class AgentRequest extends Model
{
    public const STATUSES = ['open', 'in_progress', 'needs_input', 'done', 'dismissed'];

    protected function casts(): array
    {
        return [
            'area' => 'array',
            'camera' => 'array',
            'reference_paths' => 'array',
            'result_paths' => 'array',
        ];
    }

    protected static function booted(): void
    {
        static::deleting(fn (AgentRequest $r) => Storage::disk('public')->deleteDirectory($r->directory()));
    }

    /** @return BelongsTo<Map, $this> */
    public function map(): BelongsTo
    {
        return $this->belongsTo(Map::class);
    }

    public function directory(): string
    {
        return "agent-requests/{$this->id}";
    }

    /** First line of the note, for lists. */
    public function title(): string
    {
        return mb_strimwidth(trim(strtok($this->note, "\n") ?: $this->note), 0, 80, '…');
    }

    /**
     * Bounding box, centre and area (m²) of the outline.
     *
     * @return array{min: array{x: float, z: float}, max: array{x: float, z: float}, center: array{x: float, z: float}, area_m2: int}
     */
    public function bounds(): array
    {
        $xs = array_column($this->area, 'x');
        $zs = array_column($this->area, 'z');
        $twice = 0.0;
        $n = count($this->area);

        for ($i = 0, $j = $n - 1; $i < $n; $j = $i++) {
            $twice += $this->area[$j]['x'] * $this->area[$i]['z'] - $this->area[$i]['x'] * $this->area[$j]['z'];
        }

        return [
            'min' => ['x' => min($xs), 'z' => min($zs)],
            'max' => ['x' => max($xs), 'z' => max($zs)],
            'center' => ['x' => array_sum($xs) / $n, 'z' => array_sum($zs) / $n],
            'area_m2' => (int) round(abs($twice) / 2),
        ];
    }

    /**
     * @return array<string, mixed>
     */
    public function toEditorArray(): array
    {
        $url = fn (string $path) => Storage::disk('public')->url($path);

        return [
            'id' => $this->id,
            'status' => $this->status,
            'note' => $this->note,
            'area' => $this->area,
            'camera' => $this->camera,
            'screenshot_url' => $this->screenshot_path ? $url($this->screenshot_path) : null,
            'reference_urls' => array_map($url, $this->reference_paths ?? []),
            'result_urls' => array_map($url, $this->result_paths ?? []),
            'agent_message' => $this->agent_message,
            'created_at' => $this->created_at?->toIso8601String(),
            'updated_at' => $this->updated_at?->toIso8601String(),
        ];
    }
}
