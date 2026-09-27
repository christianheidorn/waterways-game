<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Map;
use App\Services\Ai\AiNotConfiguredException;
use App\Services\Ai\MapAiAssistant;
use App\Services\Ai\OpenRouterException;
use Closure;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

/**
 * Claude-assisted art direction for a map: material suggestions, screenshot review and applying
 * the reviewed changes live.
 */
class MapAiController extends Controller
{
    /** Max decoded screenshot size. */
    public const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

    public function suggestMaterials(Map $map, MapAiAssistant $assistant): JsonResponse
    {
        return $this->ai(fn () => $assistant->suggestMaterials($map));
    }

    public function review(Request $request, Map $map, MapAiAssistant $assistant): JsonResponse
    {
        $data = $request->validate([
            'image' => ['required', 'string', 'max:'.(int) ceil(self::MAX_IMAGE_BYTES * 4 / 3 + 100), function (string $attribute, mixed $value, Closure $fail) {
                $comma = is_string($value) ? strpos($value, ',') : false;
                if ($comma === false || preg_match('#^data:image/(jpeg|jpg|png|webp);base64$#', substr($value, 0, $comma)) !== 1) {
                    $fail('The image must be a JPEG, PNG or WebP data URL.');

                    return;
                }
                $bytes = base64_decode(substr($value, $comma + 1), true);
                if ($bytes === false || strlen($bytes) > self::MAX_IMAGE_BYTES || @getimagesizefromstring($bytes) === false) {
                    $fail('The image must be a valid picture of at most 3 MB.');
                }
            }],
            'mode' => ['nullable', Rule::in(['edit', 'play'])],
            'camera' => ['nullable', 'array'],
            'camera.x' => ['nullable', 'numeric'],
            'camera.y' => ['nullable', 'numeric'],
            'camera.z' => ['nullable', 'numeric'],
            'camera.yaw' => ['nullable', 'numeric'],
            'camera.pitch' => ['nullable', 'numeric'],
        ]);

        $camera = isset($data['camera']) ? array_map(
            fn ($v) => $v === null ? null : round((float) $v, 2),
            array_intersect_key($data['camera'], array_flip(['x', 'y', 'z', 'yaw', 'pitch'])),
        ) : null;

        return $this->ai(fn () => $assistant->review($map, $data['image'], $data['mode'] ?? 'edit', $camera));
    }

    public function applyChanges(Request $request, Map $map, MapAiAssistant $assistant): JsonResponse
    {
        $request->validate([
            'changes' => ['required', 'array'],
            'changes.environment' => ['sometimes', 'array'],
            'changes.layers' => ['sometimes', 'array', 'max:8'],
            'changes.layers.*' => ['array'],
            'changes.layers.*.slot' => ['required', 'integer', 'between:0,7'],
        ]);

        // Every key is re-checked (and clamped) by the assistant's sanitizer.
        return response()->json($assistant->applyChanges($map, (array) $request->input('changes')));
    }

    /**
     * @param  Closure(): array<string, mixed>  $call
     */
    private function ai(Closure $call): JsonResponse
    {
        try {
            return response()->json($call());
        } catch (AiNotConfiguredException $e) {
            return response()->json(['message' => $e->getMessage(), 'configured' => false], 422);
        } catch (OpenRouterException $e) {
            return response()->json(['message' => $e->getMessage()], 502);
        }
    }
}
