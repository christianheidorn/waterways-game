<?php

namespace App\Http\Controllers;

use App\Enums\FoliageKind;
use App\Models\FoliageType;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Storage;
use Illuminate\Validation\Rule;
use Inertia\Inertia;
use Inertia\Response;

class FoliageTypeController extends Controller
{
    public function index(): Response
    {
        return Inertia::render('foliage/index', [
            'foliageTypes' => FoliageType::query()->orderBy('name')->get()->map->toGameArray()->values(),
            'kinds' => collect(FoliageKind::cases())->map(fn (FoliageKind $k) => ['value' => $k->value, 'label' => $k->label()]),
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
        $color = ['required', 'string', 'regex:/^#[0-9a-fA-F]{6}$/'];

        return $request->validate([
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
        ]);
    }
}
