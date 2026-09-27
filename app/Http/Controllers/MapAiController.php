<?php

namespace App\Http\Controllers;

use App\Models\Map;
use App\Services\Ai\LayerPlanner;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

/**
 * Applies the reviewed (and possibly edited) rows of an AI layer plan (see
 * Api\MapAiController::suggestMaterials) to a map's layers.
 */
class MapAiController extends Controller
{
    public function applySuggestion(Request $request, Map $map, LayerPlanner $planner): RedirectResponse
    {
        $data = $request->validate([
            'layers' => ['present', 'array', 'max:8'],
            'layers.*.slot' => ['required', 'integer', 'between:0,7', 'distinct'],
            'layers.*.action' => ['required', Rule::in(LayerPlanner::ACTIONS)],
            'layers.*.name' => ['nullable', 'string', 'max:60'],
            'layers.*.material' => ['nullable', 'array'],
            'layers.*.material.type' => ['required_with:layers.*.material', Rule::in(LayerPlanner::MATERIAL_TYPES)],
            'layers.*.material.material_id' => ['nullable', 'integer', 'exists:materials,id'],
            'layers.*.material.source' => ['nullable', 'string', 'max:20'],
            'layers.*.material.ref' => ['nullable', 'string', 'max:120', 'regex:/^[A-Za-z0-9_.-]+$/'],
            'layers.*.material.resolution' => ['nullable', Rule::in(LayerPlanner::IMPORT_RESOLUTIONS)],
            'layers.*.material.prompt' => ['nullable', 'string', 'max:500'],
            'layers.*.material.category' => ['nullable', 'string', 'max:20'],
            'layers.*.material.name' => ['nullable', 'string', 'max:120'],
            'layers.*.material.tile_size' => ['nullable', 'numeric'],
            'layers.*.material.aerial' => ['nullable', 'boolean'],
            'layers.*.settings' => ['nullable', 'array'],
            'layers.*.settings.texture_scale' => ['nullable', 'numeric'],
            'layers.*.settings.tint' => ['nullable', 'string', 'regex:/^#[0-9a-fA-F]{6}$/'],
            'layers.*.settings.roughness_scale' => ['nullable', 'numeric'],
            'layers.*.settings.normal_strength' => ['nullable', 'numeric'],
            'layers.*.settings.auto_min_height' => ['nullable', 'numeric'],
            'layers.*.settings.auto_max_height' => ['nullable', 'numeric'],
            'layers.*.settings.auto_min_slope' => ['nullable', 'numeric'],
            'layers.*.settings.auto_max_slope' => ['nullable', 'numeric'],
            'layers.*.settings.auto_priority' => ['nullable', 'numeric'],
            'landcover_mapping' => ['nullable', 'array'],
            'landcover_mapping.*' => ['integer', 'between:0,7'],
            'repaint' => ['nullable', Rule::in(LayerPlanner::REPAINT)],
        ]);

        // Rows are normalised again (clamped, ordered, checked against the map) by the planner.
        $result = $planner->apply($map, $data['layers'], $data['landcover_mapping'] ?? null, $data['repaint'] ?? 'none');

        $this->toast(
            $result['skipped_generation'] > 0 || $result['repaint_skipped'] || $result['kept_last'] ? 'warning' : 'success',
            LayerPlanner::message($result),
        );

        return back();
    }
}
