<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\AgentRequest;
use App\Models\Map;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;

/**
 * Build requests for AI agents from the editor: create (outline, note, screenshot, reference
 * images), list, dismiss / reopen and delete.
 */
class AgentRequestController extends Controller
{
    public function index(Map $map): JsonResponse
    {
        return response()->json(
            $map->agentRequests()->latest('id')->limit(50)->get()->map->toEditorArray()->values(),
        );
    }

    public function store(Request $request, Map $map): JsonResponse
    {
        $half = $map->size / 2 + 1;
        $data = $request->validate([
            'note' => ['required', 'string', 'max:5000'],
            'area' => ['required', 'json'],
            'camera' => ['nullable', 'json'],
            'screenshot' => ['nullable', 'image', 'max:8192'],
            'references' => ['nullable', 'array', 'max:6'],
            'references.*' => ['image', 'max:10240'],
        ]);

        $area = json_decode($data['area'], true);
        $points = validator(['area' => $area], [
            'area' => ['required', 'array', 'min:3', 'max:200'],
            'area.*.x' => ['required', 'numeric', "between:-{$half},{$half}"],
            'area.*.z' => ['required', 'numeric', "between:-{$half},{$half}"],
        ])->validate()['area'];

        $agentRequest = $map->agentRequests()->create([
            'note' => $data['note'],
            'area' => array_map(fn ($p) => ['x' => round((float) $p['x'], 2), 'z' => round((float) $p['z'], 2)], $points),
            'camera' => isset($data['camera']) ? json_decode($data['camera'], true) : null,
        ]);

        $dir = $agentRequest->directory();
        $references = [];

        foreach ($request->file('references', []) as $i => $file) {
            $references[] = $file->storeAs($dir, 'reference-'.($i + 1).'.'.$file->extension(), 'public');
        }

        $agentRequest->update([
            'screenshot_path' => $request->file('screenshot')?->storeAs($dir, 'view.'.$request->file('screenshot')->extension(), 'public'),
            'reference_paths' => $references,
        ]);

        return response()->json($agentRequest->refresh()->toEditorArray(), 201);
    }

    public function update(Request $request, Map $map, AgentRequest $agentRequest): JsonResponse
    {
        abort_unless($agentRequest->map_id === $map->id, 404);

        $data = $request->validate([
            'status' => ['sometimes', 'in:open,dismissed'],
            'note' => ['sometimes', 'string', 'max:5000'],
        ]);
        $agentRequest->update($data);

        return response()->json($agentRequest->toEditorArray());
    }

    public function destroy(Map $map, AgentRequest $agentRequest): Response
    {
        abort_unless($agentRequest->map_id === $map->id, 404);
        $agentRequest->delete();

        return response()->noContent();
    }
}
