<?php

namespace App\Http\Controllers;

use App\Models\Map;
use App\Models\TerrainLayer;
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

        $data = $this->validated($request);
        $map->layers()->create([...$data, 'slot' => $free[0]]);

        $this->toast('success', 'Layer added.');

        return back();
    }

    public function update(Request $request, Map $map, TerrainLayer $layer): RedirectResponse
    {
        abort_unless($layer->map_id === $map->id, 404);

        $layer->update($this->validated($request));

        $this->toast('success', "{$layer->name} saved.");

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
     * @return array<string, mixed>
     */
    private function validated(Request $request): array
    {
        $color = ['required', 'string', 'regex:/^#[0-9a-fA-F]{6}$/'];

        return $request->validate([
            'name' => ['required', 'string', 'max:60'],
            'color' => $color,
            'color_secondary' => $color,
            'roughness' => ['required', 'numeric', 'between:0,1'],
            'noise_scale' => ['required', 'numeric', 'between:0.1,500'],
            'variation' => ['required', 'numeric', 'between:0,1'],
            'bump' => ['required', 'numeric', 'between:0,2'],
            'texture_scale' => ['required', 'numeric', 'between:0.1,200'],
            'auto_min_height' => ['nullable', 'numeric'],
            'auto_max_height' => ['nullable', 'numeric'],
            'auto_min_slope' => ['nullable', 'numeric', 'between:0,90'],
            'auto_max_slope' => ['nullable', 'numeric', 'between:0,90'],
            'auto_priority' => ['required', 'integer', Rule::in(range(0, 10))],
        ]);
    }
}
