<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Controllers\MapController;
use App\Http\Controllers\TerrainLayerController;
use App\Mcp\Tools\UpdateTerrainLayer;
use App\Models\Map;
use App\Models\Material;
use App\Models\TerrainLayer;
use App\Support\EnvironmentDefaults;
use App\Support\MapTemplates;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Validator;
use Illuminate\Validation\ValidationException;

/**
 * Settings edited inside the game editor (World tab): the map's environment, a terrain layer's look,
 * material and auto-paint rules, the material library, and new maps from templates. Each change is
 * saved at once and applied live by the editor.
 */
class EditorSettingsApiController extends Controller
{
    public function environment(Map $map): JsonResponse
    {
        return response()->json([
            'group' => EnvironmentDefaults::group()->toArray(),
            'values' => $map->resolvedEnvironment(),
        ]);
    }

    /** Only the sent fields change (the editor sends one field at a time while a slider moves). */
    public function updateEnvironment(Request $request, Map $map): JsonResponse
    {
        $group = EnvironmentDefaults::group();
        $values = $request->all();
        $unknown = array_diff(array_keys($values), array_keys($group->defaults()));

        if ($unknown !== []) {
            throw ValidationException::withMessages(['values' => 'Unknown environment fields: '.implode(', ', $unknown).'.']);
        }

        $data = Validator::make($values, array_intersect_key($group->rules(), $values))->validate();
        $map->update(['environment' => $group->merge([...$map->resolvedEnvironment(), ...$data])]);

        return response()->json(['values' => $map->resolvedEnvironment()]);
    }

    /** Partial layer update: the merged layer is validated like the studio form. */
    public function updateLayer(Request $request, Map $map, TerrainLayer $layer): JsonResponse
    {
        abort_unless($layer->map_id === $map->id, 404);

        $values = $request->all();
        $rules = TerrainLayerController::rules();
        $unknown = array_diff(array_keys($values), array_keys(array_filter($rules, fn ($k) => ! str_contains($k, '.'), ARRAY_FILTER_USE_KEY)));

        if ($unknown !== []) {
            throw ValidationException::withMessages(['values' => 'Unknown layer fields: '.implode(', ', $unknown).'.']);
        }

        $merged = [...UpdateTerrainLayer::current($layer), ...$values];
        $data = array_intersect_key(Validator::make($merged, $rules)->validate(), $values);

        if (array_key_exists('material_id', $data) && $data['material_id'] !== null && ! array_key_exists('texture_scale', $data)) {
            $data['texture_scale'] = (float) Material::query()->whereKey($data['material_id'])->value('tile_size');
        }

        if (array_key_exists('ground_cover', $data)) {
            $data['ground_cover'] = array_values($data['ground_cover'] ?? []);
        }

        $layer->update($data);

        return response()->json($layer->refresh()->load('material')->toGameArray());
    }

    /** Ready materials for the editor's material picker. */
    public function materials(): JsonResponse
    {
        return response()->json(
            Material::query()->where('status', 'ready')->whereNotNull('albedo_path')->orderBy('name')->get()
                ->map(fn (Material $m) => [...$m->toGameArray(), 'category' => $m->category])->values(),
        );
    }

    public function templates(): JsonResponse
    {
        return response()->json(MapTemplates::all());
    }

    /** A new map from the editor (template or description); the editor then opens its studio page. */
    public function createMap(Request $request): JsonResponse
    {
        $input = $request->all();

        if (! MapTemplates::exists($input['template'] ?? null)) {
            $input = ['resolution' => 513, 'size' => 2048, 'source' => 'procedural', ...array_filter($input, fn ($v) => $v !== null)];
        }

        $map = MapController::createMap(MapController::validateNewMap($input));

        return response()->json([
            'id' => $map->id,
            'slug' => $map->slug,
            'name' => $map->name,
            'url' => route('maps.show', $map),
        ], 201);
    }
}
