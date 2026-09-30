<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Mcp\MapSnapshots;
use App\Models\Map;
use App\Models\MapSnapshot;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * Snapshots in the editor (World → Snapshots): list, take one, the automatic ones after saves, and
 * restore. The editor saves or discards its unsaved edits before it restores, then reloads.
 */
class MapSnapshotApiController extends Controller
{
    public function __construct(private readonly MapSnapshots $snapshots) {}

    public function index(Map $map): JsonResponse
    {
        return response()->json([
            'snapshots' => $map->snapshots()->latest('id')->get()->map(fn (MapSnapshot $s) => MapSnapshots::summary($s))->values(),
            'settings' => $this->snapshots->settings(),
        ]);
    }

    public function store(Request $request, Map $map): JsonResponse
    {
        $data = $request->validate(['label' => ['nullable', 'string', 'max:200']]);
        $snapshot = $this->snapshots->create($map, ($data['label'] ?? null) ?: 'Snapshot');

        return response()->json(['snapshot' => MapSnapshots::summary($snapshot)], 201);
    }

    /** Called by the editor after each save; `first` on the first save of an editing session. */
    public function auto(Request $request, Map $map): JsonResponse
    {
        $data = $request->validate(['first' => ['sometimes', 'boolean']]);
        $snapshot = $this->snapshots->afterEditorSave($map, (bool) ($data['first'] ?? false));

        return response()->json(['snapshot' => $snapshot ? MapSnapshots::summary($snapshot) : null]);
    }

    public function restore(Map $map, MapSnapshot $snapshot): JsonResponse
    {
        abort_unless($snapshot->map_id === $map->id, 404);

        // The current state becomes a restore point too, so a restore can be undone.
        $this->snapshots->create($map, "Before restoring snapshot {$snapshot->id}", auto: true);
        $this->snapshots->restore($snapshot);

        return response()->json(['restored' => MapSnapshots::summary($snapshot), 'revision' => $map->refresh()->revision]);
    }
}
