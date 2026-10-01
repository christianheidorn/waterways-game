<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\TerrainLayerController;
use App\Models\TerrainLayer;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\Validator;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;

#[Name('add_terrain_layer')]
#[Description('Adds a terrain layer in the first free slot (a map has at most 8). Same fields as update_terrain_layer; unspecified ones get neutral defaults. Tip: apply_biome afterwards gives it a complete look and ground cover.')]
class AddTerrainLayer extends WaterwaysTool
{
    private const DEFAULTS = [
        'name' => 'New layer', 'color' => '#7c7462', 'color_secondary' => '#9a917c', 'roughness' => 0.9,
        'noise_scale' => 5, 'variation' => 0.5, 'bump' => 0.4, 'texture_scale' => 4, 'tint' => '#ffffff',
        'roughness_scale' => 1, 'normal_strength' => 1, 'macro_variation' => 1, 'auto_priority' => 0,
    ];

    public function schema(JsonSchema $schema): array
    {
        return [
            'map' => $this->mapArgument($schema),
            'values' => $schema->object()->description('Layer fields (see update_terrain_layer).'),
        ];
    }

    protected function run(Request $request): Response
    {
        $map = $this->map($request);
        $free = array_values(array_diff(range(0, TerrainLayer::MAX_LAYERS - 1), $map->layers()->pluck('slot')->all()));

        if ($free === []) {
            return Response::error('All 8 layer slots are in use. Reuse one with update_terrain_layer or apply_biome.');
        }

        $data = Validator::make([...self::DEFAULTS, ...(array) $request->get('values', [])], TerrainLayerController::rules())->validate();
        $this->snapshots()->autoBefore($map, 'add_terrain_layer');
        $layer = $map->layers()->create([...$data, 'slot' => $free[0]]);
        $live = $this->bridge()->notify($map, 'refresh', ['parts' => ['layers']]);

        return $this->json(['layer' => $layer->refresh()->toGameArray(), 'live' => $live]);
    }
}
