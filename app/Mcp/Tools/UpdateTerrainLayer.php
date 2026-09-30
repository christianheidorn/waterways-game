<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\TerrainLayerController;
use App\Models\Material;
use App\Models\TerrainLayer;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\Validator;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;

#[Name('update_terrain_layer')]
#[Description('Changes one terrain layer (by slot 0-7) of a map: name, PBR material (material_id from list_materials, or null for procedural colours), tint, texture_scale (m per repeat), colours / roughness / noise of the procedural look, auto-paint rules (auto_min_height, auto_max_height in m, auto_min_slope, auto_max_slope in degrees, auto_priority 0-10) and ground_cover ([{foliage_type_id, density 0-4, clustering 0-1, spacing m}]: foliage that grows by itself wherever the layer is painted). Pass only what changes. Applies live in an open editor.')]
class UpdateTerrainLayer extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        return [
            'map' => $this->mapArgument($schema),
            'slot' => $schema->integer()->min(0)->max(7)->required(),
            'values' => $schema->object()->description('Layer field → new value.')->required(),
        ];
    }

    protected function run(Request $request): Response
    {
        $map = $this->map($request);
        $layer = $map->layers()->where('slot', (int) $request->get('slot'))->first();

        if ($layer === null) {
            return Response::error('No layer in slot '.$request->get('slot').'. Use add_terrain_layer, or get_map to see the used slots.');
        }

        $values = (array) $request->get('values', []);
        $rules = TerrainLayerController::rules();
        $unknown = array_diff(array_keys($values), array_keys(array_filter($rules, fn ($k) => ! str_contains($k, '.'), ARRAY_FILTER_USE_KEY)));

        if ($unknown !== []) {
            return Response::error('Unknown layer fields: '.implode(', ', $unknown).'.');
        }

        // The rules describe a complete layer: validate the merged result.
        $merged = [...self::current($layer), ...$values];
        $data = array_intersect_key(Validator::make($merged, $rules)->validate(), $values);

        if (array_key_exists('material_id', $data) && $data['material_id'] !== null && ! array_key_exists('texture_scale', $data)) {
            $data['texture_scale'] = (float) Material::query()->whereKey($data['material_id'])->value('tile_size');
        }

        if (array_key_exists('ground_cover', $data)) {
            $data['ground_cover'] = array_values($data['ground_cover'] ?? []);
        }

        $this->snapshots()->autoBefore($map, 'update_terrain_layer');
        $layer->update($data);
        $live = $this->bridge()->notify($map, 'refresh', ['parts' => ['layers']]);

        return $this->json(['layer' => $layer->refresh()->load('material')->toGameArray(), 'live' => $live]);
    }

    /**
     * @return array<string, mixed>
     */
    public static function current(TerrainLayer $layer): array
    {
        return [
            ...$layer->only([
                'name', 'color', 'color_secondary', 'roughness', 'noise_scale', 'variation', 'bump', 'texture_scale',
                'material_id', 'tint', 'roughness_scale', 'normal_strength', 'auto_min_height', 'auto_max_height',
                'auto_min_slope', 'auto_max_slope', 'auto_priority',
            ]),
            'ground_cover' => $layer->groundCover(),
        ];
    }
}
