<?php

namespace App\Mcp\Tools;

use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\Validator;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;

#[Name('paint_terrain')]
#[Description('Paints a terrain layer (slot 0-7, or its name) inside a shape, live in the open editor (one undo step; saved unless save is false). Wherever a layer is painted its ground cover grows (grass, flowers, trees of an applied biome), so this is also how to plant a biome in an area. Optional rules limit it to fitting ground: min_slope / max_slope (degrees), min_height / max_height (m), e.g. rock only on slopes over 35°. `strength` is the share of the layer at full effect (1 = only this layer), `breakup` (0-1) gives natural patchy edges, mode "erase" removes the layer (others take over).')]
class PaintTerrain extends WaterwaysTool
{
    use ShapeArgument;

    public function schema(JsonSchema $schema): array
    {
        return [
            'map' => $this->mapArgument($schema),
            'shape' => $this->shapeSchema($schema)->required(),
            'layer' => $schema->string()->description('Layer slot (0-7) or layer name, see get_map.')->required(),
            'strength' => $schema->number()->min(0)->max(1)->description('Default 1.'),
            'mode' => $schema->string()->enum(['paint', 'erase']),
            'min_slope' => $schema->number()->min(0)->max(90),
            'max_slope' => $schema->number()->min(0)->max(90),
            'min_height' => $schema->number(),
            'max_height' => $schema->number(),
            'breakup' => $schema->number()->min(0)->max(1)->description('Natural, patchy coverage (default 0).'),
            'save' => $schema->boolean()->description('Save the map after the edit (default true).'),
        ];
    }

    protected function run(Request $request): Response
    {
        $input = $request->all();
        $shape = $this->validatedShape($input);
        $data = Validator::make($input, [
            'layer' => ['required'],
            'strength' => ['sometimes', 'numeric', 'between:0,1'],
            'mode' => ['sometimes', 'in:paint,erase'],
            'min_slope' => ['sometimes', 'numeric', 'between:0,90'],
            'max_slope' => ['sometimes', 'numeric', 'between:0,90'],
            'min_height' => ['sometimes', 'numeric'],
            'max_height' => ['sometimes', 'numeric'],
            'breakup' => ['sometimes', 'numeric', 'between:0,1'],
        ])->validate();
        $map = $this->map($request);
        $ref = (string) $data['layer'];
        $layer = is_numeric($ref)
            ? $map->layers()->where('slot', (int) $ref)->first()
            : $map->layers()->whereRaw('lower(name) = ?', [mb_strtolower($ref)])->first();

        if ($layer === null) {
            return Response::error("No layer \"{$ref}\" on this map. get_map lists the layer slots and names.");
        }

        $params = ['slot' => $layer->slot];

        foreach (['strength', 'min_slope', 'max_slope', 'min_height', 'max_height', 'breakup'] as $key) {
            if (isset($data[$key])) {
                $params[$key] = (float) $data[$key];
            }
        }

        $params['mode'] = $data['mode'] ?? 'paint';

        return $this->worldEdit($map, $request, "paint_terrain {$layer->name}", [
            'kind' => 'paint',
            'shape' => $shape,
            'params' => $params,
        ]);
    }
}
