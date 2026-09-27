<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Material;
use App\Services\Ai\AiNotConfiguredException;
use App\Services\Ai\MaterialPrompts;
use App\Services\Ai\MeshyClient;
use App\Services\Ai\MeshyException;
use App\Services\Ai\OpenRouterClient;
use App\Services\Ai\OpenRouterException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
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

    /**
     * Remaining OpenRouter (USD) and Meshy credits. Keys never leave the server.
     */
    public function credits(Request $request, OpenRouterClient $openRouter, MeshyClient $meshy): JsonResponse
    {
        $fresh = $request->boolean('fresh');
        $result = [
            'openrouter' => ['configured' => $openRouter->configured()],
            'meshy' => ['configured' => $meshy->configured()],
        ];

        if ($openRouter->configured()) {
            try {
                $result['openrouter'] += $fresh
                    ? tap($openRouter->credits(), fn ($c) => Cache::put('openrouter.credits', $c, 20))
                    : Cache::remember('openrouter.credits', 20, fn () => $openRouter->credits());
            } catch (OpenRouterException $e) {
                $result['openrouter']['error'] = $e->getMessage();
            }
        }

        if ($meshy->configured()) {
            try {
                $result['meshy']['balance'] = $meshy->balance($fresh);
            } catch (MeshyException $e) {
                $result['meshy']['error'] = $e->getMessage();
            }
        }

        return response()->json($result);
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
