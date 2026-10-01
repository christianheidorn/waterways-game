<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\PropModel;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

/**
 * Prop model settings from the in-game editor (Place → Props, Select & edit): collision and buoyancy.
 */
class PropModelApiController extends Controller
{
    public function update(Request $request, PropModel $propModel): JsonResponse
    {
        if (! $request->hasAny(['collision', 'buoyancy'])) {
            throw ValidationException::withMessages(['settings' => 'Nothing to update.']);
        }

        $data = $request->validate([
            'collision' => ['sometimes', Rule::in(PropModel::COLLISIONS)],
            'buoyancy' => ['sometimes', 'nullable', 'array'],
            'buoyancy.mode' => ['sometimes', Rule::in(PropModel::BUOYANCY_MODES)],
            'buoyancy.density' => ['sometimes', 'numeric', 'between:0.05,0.95'],
            'buoyancy.drift' => ['sometimes', Rule::in(PropModel::BUOYANCY_DRIFTS)],
        ]);

        if (array_key_exists('buoyancy', $data)) {
            $data['buoyancy'] = $data['buoyancy'] === null
                ? null
                : PropModel::normalizeBuoyancy($data['buoyancy'], $propModel->buoyancy);
        }

        $propModel->update($data);

        return response()->json($propModel->refresh()->toGameArray());
    }
}
