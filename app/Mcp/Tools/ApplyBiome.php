<?php

namespace App\Mcp\Tools;

use App\Models\Biome;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;

#[Name('apply_biome')]
#[Description('Applies a library biome (id or name, see list_biomes) to a terrain layer slot: the layer takes its name, ground look and ground cover (grass, flowers, shrubs, rocks, trees). Wherever that layer is painted, the biome grows. Keeps the slot, its paint and auto-paint rules. Applies live in an open editor.')]
class ApplyBiome extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        return [
            'map' => $this->mapArgument($schema),
            'slot' => $schema->integer()->min(0)->max(7)->required(),
            'biome' => $schema->string()->description('Biome id or name.')->required(),
        ];
    }

    protected function run(Request $request): Response
    {
        $map = $this->map($request);
        $layer = $map->layers()->where('slot', (int) $request->get('slot'))->first();
        $ref = (string) $request->get('biome');
        $biome = Biome::query()->where('name', $ref)->first() ?? (is_numeric($ref) ? Biome::query()->find((int) $ref) : null);

        if ($layer === null) {
            return Response::error('No layer in slot '.$request->get('slot').'. Use add_terrain_layer first.');
        }

        if ($biome === null) {
            return Response::error("No biome \"{$ref}\". See list_biomes.");
        }

        $this->snapshots()->autoBefore($map, 'apply_biome');
        $biome->applyTo($layer);
        $live = $this->bridge()->notify($map, 'refresh', ['parts' => ['layers']]);

        return $this->json(['layer' => $layer->refresh()->toGameArray(), 'live' => $live]);
    }
}
