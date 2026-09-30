<?php

namespace App\Mcp\Tools;

use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;
use Laravel\Mcp\Server\Tools\Annotations\IsDestructive;

#[Name('delete_terrain_layer')]
#[Description('Removes a terrain layer (slot 0-7). Areas painted with it fall back to the other layers. A map keeps at least one layer.')]
#[IsDestructive]
class DeleteTerrainLayer extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        return [
            'map' => $this->mapArgument($schema),
            'slot' => $schema->integer()->min(0)->max(7)->required(),
        ];
    }

    protected function run(Request $request): Response
    {
        $map = $this->map($request);
        $layer = $map->layers()->where('slot', (int) $request->get('slot'))->first();

        if ($layer === null) {
            return Response::error('No layer in slot '.$request->get('slot').'.');
        }

        if ($map->layers()->count() <= 1) {
            return Response::error('A map needs at least one layer.');
        }

        $this->snapshots()->autoBefore($map, 'delete_terrain_layer');
        $layer->delete();
        $live = $this->bridge()->notify($map, 'refresh', ['parts' => ['layers']]);

        return $this->json(['deleted_slot' => $layer->slot, 'live' => $live]);
    }
}
