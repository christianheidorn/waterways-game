<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\BiomeController;
use App\Http\Controllers\Controller;
use App\Models\Biome;
use App\Models\Map;
use App\Models\TerrainLayer;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * Biomes from the in-game editor: apply one to a layer (returns the updated layer for live use),
 * save the selected layer as a new biome.
 */
class BiomeApiController extends Controller
{
    public function apply(Request $request, Map $map, TerrainLayer $layer): JsonResponse
    {
        abort_unless($layer->map_id === $map->id, 404);

        $biome = Biome::query()->findOrFail($request->validate(BiomeController::applyRules())['biome_id']);
        $biome->applyTo($layer);

        return response()->json($layer->refresh()->load('material')->toGameArray());
    }

    public function store(Request $request): JsonResponse
    {
        return response()->json(BiomeController::createFromLayer($request)->toStudioArray(), 201);
    }
}
