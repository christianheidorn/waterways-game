<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\Ai\AiNotConfiguredException;
use App\Services\Ai\FoliagePlanner;
use App\Services\Ai\OpenRouterException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * AI foliage palette plan (keep / change / remove / add) for review in the studio.
 */
class FoliageAiController extends Controller
{
    public function plan(Request $request, FoliagePlanner $planner): JsonResponse
    {
        $data = $request->validate([
            'map_id' => ['nullable', 'integer', 'exists:maps,id'],
            'region' => ['nullable', 'string', 'max:200'],
            'style' => ['required', 'integer', 'between:0,100'],
            'direction' => ['nullable', 'string', 'max:600'],
            'allow_generation' => ['sometimes', 'boolean'],
        ]);

        if (empty($data['map_id']) && trim((string) ($data['region'] ?? '')) === '') {
            return response()->json(['message' => 'Pick a map or describe a region.', 'errors' => ['region' => ['Pick a map or describe a region.']]], 422);
        }

        try {
            return response()->json($planner->plan($data));
        } catch (AiNotConfiguredException $e) {
            return response()->json(['message' => $e->getMessage(), 'configured' => false], 422);
        } catch (OpenRouterException $e) {
            return response()->json(['message' => $e->getMessage()], 502);
        }
    }
}
