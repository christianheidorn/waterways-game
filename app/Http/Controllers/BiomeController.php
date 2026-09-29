<?php

namespace App\Http\Controllers;

use App\Models\Biome;
use App\Models\Map;
use App\Models\TerrainLayer;
use App\Support\StarterBiomes;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;

/**
 * The biome library from the studio's terrain layers page: apply a biome to a layer, save a layer
 * as a biome, delete one, restore the starter biomes.
 */
class BiomeController extends Controller
{
    public function apply(Request $request, Map $map, TerrainLayer $layer): RedirectResponse
    {
        abort_unless($layer->map_id === $map->id, 404);

        $biome = Biome::query()->findOrFail($request->validate(self::applyRules())['biome_id']);
        $biome->applyTo($layer);

        $this->toast('success', 'Layer '.($layer->slot + 1)." is now {$biome->name}.");

        return back();
    }

    public function store(Request $request): RedirectResponse
    {
        $biome = self::createFromLayer($request);

        $this->toast('success', "Saved {$biome->name} to the biome library.");

        return back();
    }

    public function destroy(Biome $biome): RedirectResponse
    {
        $biome->delete();

        $this->toast('success', "{$biome->name} removed from the library.");

        return back();
    }

    public function starters(): RedirectResponse
    {
        $count = StarterBiomes::install();

        $this->toast('success', $count > 0 ? "Added {$count} starter biomes." : 'All starter biomes are already in the library.');

        return back();
    }

    /**
     * @return array<string, mixed>
     */
    public static function applyRules(): array
    {
        return ['biome_id' => ['required', 'integer', 'exists:biomes,id']];
    }

    /** Validates a "save layer as biome" request and creates the biome. */
    public static function createFromLayer(Request $request): Biome
    {
        $data = $request->validate([
            'layer_id' => ['required', 'integer', 'exists:terrain_layers,id'],
            'name' => ['required', 'string', 'max:60'],
            'description' => ['nullable', 'string', 'max:200'],
        ]);
        $layer = TerrainLayer::query()->findOrFail($data['layer_id']);

        return Biome::query()->create([
            'name' => $data['name'],
            'description' => $data['description'] ?? null,
            ...Biome::attributesFromLayer($layer),
        ]);
    }
}
