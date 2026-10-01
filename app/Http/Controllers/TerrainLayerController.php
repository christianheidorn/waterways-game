<?php

namespace App\Http\Controllers;

use App\Models\Biome;
use App\Models\FoliageType;
use App\Models\Map;
use App\Models\Material;
use App\Models\TerrainLayer;
use App\Services\Materials\MaterialLibrary;
use App\Support\AiSettings;
use App\Support\DefaultTerrainLayers;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Storage;
use Illuminate\Validation\Rule;
use Inertia\Inertia;
use Inertia\Response;

class TerrainLayerController extends Controller
{
    public function index(Map $map): Response
    {
        return Inertia::render('maps/layers', [
            'map' => MapController::summary($map),
            'layers' => $map->layers->map->toGameArray()->values(),
            'maxLayers' => TerrainLayer::MAX_LAYERS,
            'biomes' => Biome::query()->orderBy('name')->get()->map->toStudioArray()->values(),
            // For the ground cover picker.
            'foliageTypes' => FoliageType::query()->orderBy('name')->get(['id', 'name', 'kind'])
                ->map(fn (FoliageType $t) => ['id' => $t->id, 'name' => $t->name, 'kind' => $t->kind->value])->values(),
            // Library for the material picker; loaded lazily (partial reload) when the picker opens.
            'materials' => Inertia::optional(fn () => Material::query()->withCount('layers')->latest()->latest('id')->get()
                ->map(fn (Material $m) => $m->toStudioArray())->values()),
            'categories' => MaterialLibrary::categoryOptions(),
            'ai' => ['configured' => app(AiSettings::class)->configured()],
        ]);
    }

    public function store(Request $request, Map $map): RedirectResponse
    {
        $used = $map->layers()->pluck('slot')->all();
        $free = array_values(array_diff(range(0, TerrainLayer::MAX_LAYERS - 1), $used));

        if ($free === []) {
            $this->toast('error', 'All 8 layer slots are in use.');

            return back();
        }

        $data = $this->withMaterialDefaults($request, $this->validated($request));
        $map->layers()->create([...$data, 'slot' => $free[0]]);

        $this->toast('success', 'Layer added.');

        return back();
    }

    public function update(Request $request, Map $map, TerrainLayer $layer): RedirectResponse
    {
        abort_unless($layer->map_id === $map->id, 404);

        $data = $this->validated($request);
        if (array_key_exists('material_id', $data)) {
            $data['material_id'] = $data['material_id'] !== null ? (int) $data['material_id'] : null;
        }
        if (array_key_exists('material_id', $data) && $data['material_id'] !== $layer->material_id) {
            $data = $this->withMaterialDefaults($request, $data);
        }

        $layer->update($data);

        $this->toast('success', "{$layer->name} saved.");

        return back();
    }

    /**
     * Quick material assignment from the picker; texture_scale follows the material's tile size.
     */
    public function assignMaterial(Request $request, Map $map, TerrainLayer $layer): RedirectResponse
    {
        abort_unless($layer->map_id === $map->id, 404);

        $data = $request->validate([
            'material_id' => ['present', 'nullable', 'integer', 'exists:materials,id'],
        ]);

        $material = $data['material_id'] !== null ? Material::query()->find($data['material_id']) : null;

        $layer->update([
            'material_id' => $material?->id,
            ...($material ? ['texture_scale' => $material->tile_size] : []),
        ]);

        $this->toast('success', $material ? "{$layer->name} now uses {$material->name}." : "{$layer->name} uses procedural colours.");

        return back();
    }

    public function uploadTexture(Request $request, Map $map, TerrainLayer $layer): RedirectResponse
    {
        abort_unless($layer->map_id === $map->id, 404);

        $request->validate(['texture' => ['required', 'image', 'mimes:jpg,jpeg,png,webp', 'max:8192']]);

        if ($layer->texture_path) {
            Storage::disk('public')->delete($layer->texture_path);
        }

        $layer->update(['texture_path' => $request->file('texture')->store('textures', 'public')]);

        $this->toast('success', 'Texture uploaded.');

        return back();
    }

    public function removeTexture(Map $map, TerrainLayer $layer): RedirectResponse
    {
        abort_unless($layer->map_id === $map->id, 404);

        if ($layer->texture_path) {
            Storage::disk('public')->delete($layer->texture_path);
            $layer->update(['texture_path' => null]);
        }

        return back();
    }

    public function destroy(Map $map, TerrainLayer $layer): RedirectResponse
    {
        abort_unless($layer->map_id === $map->id, 404);

        if ($map->layers()->count() <= 1) {
            $this->toast('error', 'A map needs at least one layer.');

            return back();
        }

        $layer->delete();

        $this->toast('success', 'Layer removed. Painted weights in its slot will fall back to other layers.');

        return back();
    }

    public function reset(Map $map): RedirectResponse
    {
        $map->layers()->delete();
        DefaultTerrainLayers::createFor($map);

        $this->toast('success', 'Layers reset to defaults.');

        return back();
    }

    /**
     * Default texture_scale to the assigned material's tile size unless it was sent explicitly.
     *
     * @param  array<string, mixed>  $data
     * @return array<string, mixed>
     */
    private function withMaterialDefaults(Request $request, array $data): array
    {
        $materialId = $data['material_id'] ?? null;

        if ($materialId !== null && ! $request->has('texture_scale')) {
            $data['texture_scale'] = (float) Material::query()->whereKey($materialId)->value('tile_size');
        }

        return $data;
    }

    /**
     * @return array<string, mixed>
     */
    private function validated(Request $request): array
    {
        return $request->validate(self::rules());
    }

    /**
     * Rules of a complete layer (the studio form sends every field).
     *
     * @return array<string, mixed>
     */
    public static function rules(): array
    {
        $color = ['required', 'string', 'regex:/^#[0-9a-fA-F]{6}$/'];

        return [
            'name' => ['required', 'string', 'max:60'],
            'color' => $color,
            'color_secondary' => $color,
            'roughness' => ['required', 'numeric', 'between:0,1'],
            'noise_scale' => ['required', 'numeric', 'between:0.1,500'],
            'variation' => ['required', 'numeric', 'between:0,1'],
            'bump' => ['required', 'numeric', 'between:0,2'],
            'texture_scale' => ['sometimes', 'required', 'numeric', 'between:0.1,200'],
            'material_id' => ['sometimes', 'nullable', 'integer', 'exists:materials,id'],
            'tint' => ['sometimes', 'required', 'string', 'regex:/^#[0-9a-fA-F]{6}$/'],
            'roughness_scale' => ['sometimes', 'required', 'numeric', 'between:0,3'],
            'normal_strength' => ['sometimes', 'required', 'numeric', 'between:0,3'],
            'macro_variation' => ['sometimes', 'required', 'numeric', 'between:0,2'],
            'auto_min_height' => ['nullable', 'numeric'],
            'auto_max_height' => ['nullable', 'numeric'],
            'auto_min_slope' => ['nullable', 'numeric', 'between:0,90'],
            'auto_max_slope' => ['nullable', 'numeric', 'between:0,90'],
            'auto_priority' => ['required', 'integer', Rule::in(range(0, 10))],
            ...self::groundCoverRules(),
        ];
    }

    /**
     * Foliage types that grow by themselves on a layer, with a density multiplier each.
     *
     * @return array<string, mixed>
     */
    public static function groundCoverRules(): array
    {
        return [
            'ground_cover' => ['sometimes', 'nullable', 'array', 'max:8'],
            'ground_cover.*.foliage_type_id' => ['required', 'integer', 'distinct', 'exists:foliage_types,id'],
            'ground_cover.*.density' => ['required', 'numeric', 'between:0,4'],
            'ground_cover.*.clustering' => ['sometimes', 'numeric', 'between:0,1'],
            'ground_cover.*.spacing' => ['sometimes', 'numeric', 'between:0,50'],
        ];
    }
}
