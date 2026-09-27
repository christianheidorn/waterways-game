<?php

namespace App\Http\Controllers;

use App\Models\Map;
use App\Models\Material;
use App\Services\Ai\MapAiAssistant;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

/**
 * Applies an AI material suggestion (see Api\MapAiController::suggestMaterials) to a map's layers.
 */
class MapAiController extends Controller
{
    public function applySuggestion(Request $request, Map $map, MapAiAssistant $assistant): RedirectResponse
    {
        $data = $request->validate([
            'layers' => ['required', 'array', 'min:1', 'max:8'],
            'layers.*.slot' => ['required', 'integer', 'between:0,7', 'distinct'],
            'layers.*.name' => ['required', 'string', 'max:60'],
            'layers.*.material_id' => ['nullable', 'integer', 'exists:materials,id'],
            'layers.*.generate_prompt' => ['nullable', 'string', 'max:500'],
            'layers.*.category' => ['nullable', Rule::in(array_keys(Material::CATEGORIES))],
            'layers.*.tint' => ['nullable', 'string', 'regex:/^#[0-9a-fA-F]{6}$/'],
            'layers.*.auto_min_height' => ['nullable', 'numeric'],
            'layers.*.auto_max_height' => ['nullable', 'numeric'],
            'layers.*.auto_min_slope' => ['nullable', 'numeric', 'between:0,90'],
            'layers.*.auto_max_slope' => ['nullable', 'numeric', 'between:0,90'],
            'layers.*.auto_priority' => ['nullable', 'integer', 'between:0,10'],
            'layers.*.reason' => ['nullable', 'string', 'max:1000'],
        ]);

        // Same normalisation as the model output (clamping, ordering, defaults).
        $layers = $assistant->sanitizeSuggestion(['layers' => $data['layers']], $map)['layers'];
        $result = $assistant->applySuggestion($map, $layers);

        $message = "{$result['layers']} layer(s) updated.";
        if ($result['generating'] > 0) {
            $message .= " Generating {$result['generating']} new material(s) — they appear in the game when ready.";
        }
        if ($result['skipped_generation'] > 0) {
            $message .= " {$result['skipped_generation']} material(s) not generated: AI is not configured.";
        }

        $this->toast($result['skipped_generation'] > 0 ? 'warning' : 'success', $message);

        return back();
    }
}
