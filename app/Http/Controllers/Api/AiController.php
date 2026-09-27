<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Material;
use App\Services\Ai\AiNotConfiguredException;
use App\Services\Ai\MaterialPrompts;
use App\Services\Ai\OpenRouterClient;
use App\Services\Ai\OpenRouterException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

/**
 * OpenRouter model lists and prompt enhancement for the studio.
 */
class AiController extends Controller
{
    public function models(OpenRouterClient $client): JsonResponse
    {
        if (! $client->configured()) {
            return response()->json(['configured' => false, 'image' => [], 'text' => []]);
        }

        try {
            return response()->json([
                'configured' => true,
                'image' => $client->imageModels(),
                'text' => $client->textModels(),
            ]);
        } catch (OpenRouterException $e) {
            return response()->json(['configured' => true, 'image' => [], 'text' => [], 'message' => $e->getMessage()], 502);
        }
    }

    public function enhancePrompt(Request $request, MaterialPrompts $prompts): JsonResponse
    {
        $data = $request->validate([
            'prompt' => ['required', 'string', 'max:1000'],
            'category' => ['nullable', Rule::in(array_keys(Material::CATEGORIES))],
        ]);

        try {
            return response()->json(['prompt' => $prompts->enhance($data['prompt'], $data['category'] ?? 'other')]);
        } catch (AiNotConfiguredException $e) {
            return response()->json(['message' => $e->getMessage(), 'configured' => false], 422);
        }
    }
}
