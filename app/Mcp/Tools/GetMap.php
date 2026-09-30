<?php

namespace App\Mcp\Tools;

use App\Mcp\MapInspector;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[Name('get_map')]
#[Description('Everything about one map: settings, coordinate system, environment (weather, time, fog, …), the 8 terrain layer slots with materials, auto-paint rules and ground cover, terrain statistics (height range, share of the map painted with each layer, water) and saved foliage counts. Use take_screenshot to actually see it.')]
#[IsReadOnly]
class GetMap extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        return ['map' => $this->mapArgument($schema)];
    }

    protected function run(Request $request): Response
    {
        return $this->json(app(MapInspector::class)->describe($this->map($request)));
    }
}
