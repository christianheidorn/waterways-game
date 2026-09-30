<?php

namespace App\Mcp\Tools;

use App\Support\MapTemplates;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[Name('list_map_templates')]
#[Description('Curated starting points for new maps (coastal village, alpine lake, river valley, desert canyon): terrain generation values (size, resolution, relief, coast, terraces, water depths), the starter biomes put on layer slots, environment values and the foliage kinds scattered on first load. Pass a `key` as create_map `template`.')]
#[IsReadOnly]
class ListMapTemplates extends WaterwaysTool
{
    protected function run(Request $request): Response
    {
        return $this->json(['templates' => MapTemplates::all()]);
    }
}
