<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Controllers\TerrainLayerController;
use App\Models\Map;
use App\Models\TerrainLayer;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * Ground cover edits from the in-game editor (saved while the grass regrows live).
 */
class TerrainLayerApiController extends Controller
{
    public function groundCover(Request $request, Map $map, TerrainLayer $layer): JsonResponse
    {
        abort_unless($layer->map_id === $map->id, 404);

        $validated = $request->validate([
            ...TerrainLayerController::groundCoverRules(),
            'ground_cover' => ['present', 'nullable', 'array', 'max:8'],
        ]);

        $layer->update(['ground_cover' => array_values($validated['ground_cover'] ?? [])]);

        return response()->json($layer->refresh()->load('material')->toGameArray());
    }
}
