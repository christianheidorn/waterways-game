<?php

namespace App\Http\Controllers;

use App\Enums\FoliageKind;
use App\Models\FoliageAsset;
use App\Models\FoliageType;
use App\Models\Map;
use App\Services\Foliage\FoliageLibrary;
use App\Support\AiSettings;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Storage;
use Illuminate\Validation\Rule;
use Inertia\Inertia;
use Inertia\Response;

class FoliageTypeController extends Controller
{
    public function index(AiSettings $ai): Response
    {
        $ai = $ai->toFrontend();

        return Inertia::render('foliage/index', [
            'foliageTypes' => FoliageType::query()->with('asset')->orderBy('name')->get()->map->toGameArray()->values(),
            'kinds' => collect(FoliageKind::cases())->map(fn (FoliageKind $k) => ['value' => $k->value, 'label' => $k->label()]),
            'assets' => FoliageAsset::query()->withCount('types')->latest()->latest('id')->get()
                ->map(fn (FoliageAsset $a) => $a->toStudioArray())->values(),
            'maps' => Map::query()->orderBy('name')->get(['id', 'name', 'source', 'center_lat', 'center_lng'])
                ->map(fn (Map $m) => ['id' => $m->id, 'name' => $m->name, 'source' => $m->source->value, 'real_world' => $m->center_lat !== null])->values(),
            'kindHeights' => FoliageLibrary::KIND_HEIGHT,
            'proceduralHeights' => FoliageLibrary::PROCEDURAL_HEIGHT,
            'ai' => [
                'configured' => $ai['configured'],
                'image_model' => $ai['image_model'],
                'text_model' => $ai['text_model'],
                'meshy_configured' => $ai['meshy']['configured'],
            ],
        ]);
    }

    public function store(Request $request): RedirectResponse
    {
        FoliageType::query()->create($this->validated($request));

        $this->toast('success', 'Foliage type created.');

        return back();
    }

    public function update(Request $request, FoliageType $foliageType): RedirectResponse
    {
        $foliageType->update($this->validated($request));

        $this->toast('success', "{$foliageType->name} saved.");

        return back();
    }

    public function uploadModel(Request $request, FoliageType $foliageType): RedirectResponse
    {
        $request->validate(['model' => ['required', 'file', 'max:51200', function ($attribute, $value, $fail) {
            if (strtolower($value->getClientOriginalExtension()) !== 'glb') {
                $fail('The model must be a binary glTF (.glb) file.');
            }
        }]]);

        if ($foliageType->model_path) {
            Storage::disk('public')->delete($foliageType->model_path);
        }

        $path = $request->file('model')->storeAs('models', "foliage-{$foliageType->id}-".time().'.glb', 'public');
        $foliageType->update(['model_path' => $path]);

        $this->toast('success', 'Model uploaded.');

        return back();
    }

    public function removeModel(FoliageType $foliageType): RedirectResponse
    {
        if ($foliageType->model_path) {
            Storage::disk('public')->delete($foliageType->model_path);
            $foliageType->update(['model_path' => null]);
        }

        return back();
    }

    public function destroy(FoliageType $foliageType): RedirectResponse
    {
        if ($foliageType->model_path) {
            Storage::disk('public')->delete($foliageType->model_path);
        }

        $foliageType->delete();

        $this->toast('success', 'Foliage type deleted. Placed instances of it will no longer render.');

        return back();
    }

    /**
     * @return array<string, mixed>
     */
    private function validated(Request $request): array
    {
        $data = $request->validate(self::rules());
        $data['tint'] ??= '#ffffff';

        return $data;
    }

    /**
     * Validation rules of a foliage type (also used by the in-game editor's partial updates).
     *
     * @return array<string, list<mixed>>
     */
    public static function rules(): array
    {
        $color = ['required', 'string', 'regex:/^#[0-9a-fA-F]{6}$/'];

        return [
            'name' => ['required', 'string', 'max:60'],
            'kind' => ['required', Rule::enum(FoliageKind::class)],
            'color' => $color,
            'color_secondary' => $color,
            'min_scale' => ['required', 'numeric', 'between:0.05,20'],
            'max_scale' => ['required', 'numeric', 'between:0.05,20', 'gte:min_scale'],
            'density' => ['required', 'numeric', 'between:0.01,500'],
            'min_slope' => ['required', 'numeric', 'between:0,90'],
            'max_slope' => ['required', 'numeric', 'between:0,90', 'gte:min_slope'],
            'min_height' => ['nullable', 'numeric'],
            'max_height' => ['nullable', 'numeric'],
            'align_to_normal' => ['required', 'boolean'],
            'random_yaw' => ['required', 'boolean'],
            'cast_shadows' => ['required', 'boolean'],
            'cull_distance' => ['required', 'numeric', 'between:20,5000'],
            'allow_underwater' => ['required', 'boolean'],
            'foliage_asset_id' => ['nullable', 'integer', 'exists:foliage_assets,id'],
            'tint' => ['nullable', 'string', 'regex:/^#[0-9a-fA-F]{6}$/'],
            'collision' => ['sometimes', 'string', Rule::in(FoliageType::COLLISIONS)],
            'collision_radius' => ['nullable', 'numeric', 'between:0.02,20'],
        ];
    }
}
