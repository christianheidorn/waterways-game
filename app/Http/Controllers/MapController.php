<?php

namespace App\Http\Controllers;

use App\Enums\MapSource;
use App\Enums\TerrainStatus;
use App\Jobs\GenerateMapTerrain;
use App\Models\Map;
use App\Support\EnvironmentDefaults;
use App\Support\GameManifest;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;
use Inertia\Inertia;
use Inertia\Response;

class MapController extends Controller
{
    public function index(): Response
    {
        return Inertia::render('maps/index', [
            'maps' => Map::query()->latest()->get()->map(fn (Map $map) => self::summary($map)),
        ]);
    }

    public function create(): Response
    {
        return Inertia::render('maps/create', [
            'resolutions' => Map::RESOLUTIONS,
        ]);
    }

    public function store(Request $request): RedirectResponse
    {
        $data = $this->validateTerrain($request, requireName: true);

        $map = Map::query()->create([
            ...$data,
            'slug' => $this->uniqueSlug($data['name']),
            'seed' => $data['seed'] ?? random_int(1, 999_999),
            'environment' => EnvironmentDefaults::group()->defaults(),
            'terrain_status' => TerrainStatus::Queued,
            'is_default' => ! Map::query()->exists(),
        ]);

        GenerateMapTerrain::dispatch($map);

        $this->toast('success', 'Map created — generating terrain…');

        return to_route('maps.show', $map);
    }

    public function show(Map $map): Response
    {
        return Inertia::render('maps/show', [
            'map' => self::detail($map),
            'resolutions' => Map::RESOLUTIONS,
        ]);
    }

    public function update(Request $request, Map $map): RedirectResponse
    {
        $data = $request->validate([
            'name' => ['required', 'string', 'max:120'],
            'description' => ['nullable', 'string', 'max:2000'],
        ]);

        $map->update($data);

        $this->toast('success', 'Map updated.');

        return back();
    }

    /**
     * Re-generate the terrain, optionally with a new source / area. Discards sculpting, paint and foliage.
     */
    public function regenerate(Request $request, Map $map): RedirectResponse
    {
        $data = $this->validateTerrain($request, requireName: false);

        $map->update([
            ...$data,
            'seed' => $data['seed'] ?? $map->seed,
            'terrain_status' => TerrainStatus::Queued,
            'terrain_progress' => 0,
            'terrain_message' => null,
            'spawn_x' => null,
            'spawn_z' => null,
        ]);

        GenerateMapTerrain::dispatch($map);

        $this->toast('info', 'Terrain regeneration queued.');

        return back();
    }

    public function makeDefault(Map $map): RedirectResponse
    {
        Map::query()->whereKeyNot($map->id)->update(['is_default' => false]);
        $map->update(['is_default' => true]);

        $this->toast('success', "{$map->name} is now the default map.");

        return back();
    }

    public function destroy(Map $map): RedirectResponse
    {
        $map->delete();

        if (! Map::query()->where('is_default', true)->exists()) {
            Map::query()->oldest()->first()?->update(['is_default' => true]);
        }

        $this->toast('success', 'Map deleted.');

        return to_route('maps.index');
    }

    /**
     * @return array<string, mixed>
     */
    private function validateTerrain(Request $request, bool $requireName): array
    {
        $realWorld = $request->input('source') === MapSource::RealWorld->value;

        return $request->validate([
            'name' => [$requireName ? 'required' : 'sometimes', 'string', 'max:120'],
            'description' => ['nullable', 'string', 'max:2000'],
            'source' => ['required', Rule::enum(MapSource::class)],
            'resolution' => ['required', 'integer', Rule::in(Map::RESOLUTIONS)],
            'size' => ['required', 'numeric', 'min:256', 'max:32768'],
            'center_lat' => [$realWorld ? 'required' : 'nullable', 'numeric', 'between:-85,85'],
            'center_lng' => [$realWorld ? 'required' : 'nullable', 'numeric', 'between:-180,180'],
            'height_scale' => ['sometimes', 'numeric', 'min:0.1', 'max:5'],
            'import_water' => ['sometimes', 'boolean'],
            'seed' => ['nullable', 'integer', 'min:1', 'max:999999'],
        ]);
    }

    private function uniqueSlug(string $name): string
    {
        $base = Str::slug($name) ?: 'map';
        $slug = $base;
        $i = 2;

        while (Map::query()->where('slug', $slug)->exists()) {
            $slug = "{$base}-{$i}";
            $i++;
        }

        return $slug;
    }

    /**
     * @return array<string, mixed>
     */
    public static function summary(Map $map): array
    {
        return [
            ...GameManifest::mapInfo($map),
            'description' => $map->description,
            'is_default' => $map->is_default,
            'terrain_progress' => $map->terrain_progress,
            'terrain_message' => $map->terrain_message,
            'thumbnail_url' => $map->thumbnailUrl(),
            'updated_at' => $map->updated_at?->toIso8601String(),
        ];
    }

    /**
     * @return array<string, mixed>
     */
    public static function detail(Map $map): array
    {
        return [
            ...self::summary($map),
            'height_scale' => $map->height_scale,
            'import_water' => $map->import_water,
            'seed' => $map->seed,
            'bounds' => $map->bounds(),
            'terrain_generated_at' => $map->terrain_generated_at?->toIso8601String(),
        ];
    }
}
