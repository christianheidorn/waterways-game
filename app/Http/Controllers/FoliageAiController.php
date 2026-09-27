<?php

namespace App\Http\Controllers;

use App\Enums\FoliageKind;
use App\Services\Ai\FoliagePlanner;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

/**
 * Applies the reviewed (and possibly edited) rows of an AI foliage plan.
 */
class FoliageAiController extends Controller
{
    public function apply(Request $request, FoliagePlanner $planner): RedirectResponse
    {
        $data = $request->validate([
            'style' => ['required', 'integer', 'between:0,100'],
            'types' => ['required', 'array', 'min:1', 'max:60'],
            'types.*.action' => ['required', Rule::in(FoliagePlanner::ACTIONS)],
            'types.*.type_id' => ['nullable', 'integer'],
            'types.*.name' => ['nullable', 'string', 'max:60'],
            'types.*.kind' => ['nullable', Rule::enum(FoliageKind::class)],
            'types.*.asset' => ['nullable', 'array'],
            'types.*.asset.type' => ['required_with:types.*.asset', Rule::in(FoliagePlanner::ASSET_TYPES)],
            'types.*.asset.asset_id' => ['nullable', 'integer'],
            'types.*.asset.ref' => ['nullable', 'string', 'max:120', 'regex:/^[A-Za-z0-9_.-]+$/'],
            'types.*.asset.prompt' => ['nullable', 'string', 'max:600'],
            'types.*.settings' => ['nullable', 'array'],
        ]);

        // Rows are normalised again (clamped, checked against the library) by the planner.
        $result = $planner->apply($data['types'], (int) $data['style']);

        $this->toast($result['skipped'] === [] ? 'success' : 'warning', FoliagePlanner::message($result));

        return back();
    }
}
