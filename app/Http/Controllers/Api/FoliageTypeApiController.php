<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Controllers\FoliageTypeController;
use App\Models\FoliageType;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Arr;
use Illuminate\Validation\ValidationException;

/**
 * Partial foliage type updates from the in-game editor (density, scale, rules, … without leaving it).
 */
class FoliageTypeApiController extends Controller
{
    /** Fields the in-game editor may change. */
    public const EDITABLE = [
        'name', 'min_scale', 'max_scale', 'density', 'min_slope', 'max_slope', 'min_height', 'max_height',
        'align_to_normal', 'random_yaw', 'cast_shadows', 'cull_distance', 'allow_underwater', 'color', 'color_secondary', 'tint',
    ];

    public function update(Request $request, FoliageType $foliageType): JsonResponse
    {
        $input = Arr::only($request->all(), self::EDITABLE);
        if ($input === []) {
            throw ValidationException::withMessages(['settings' => 'Nothing to update.']);
        }

        // Validate the merged result so cross-field rules (max ≥ min) hold.
        $merged = [...$foliageType->only(array_keys(FoliageTypeController::rules())), 'kind' => $foliageType->kind->value, ...$input];
        $validated = validator($merged, FoliageTypeController::rules())->validate();

        $changes = Arr::only($validated, array_keys($input));
        if (array_key_exists('tint', $changes)) {
            $changes['tint'] ??= '#ffffff';
        }
        $foliageType->update($changes);

        return response()->json($foliageType->refresh()->load('asset')->toGameArray());
    }
}
