<?php

namespace App\Mcp\Tools;

use App\Models\Biome;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[Name('list_biomes')]
#[Description('The biome library: reusable terrain layers (a ground material or colours plus the foliage that grows on it). apply_biome puts one on a layer slot of a map; painting that layer then paints the whole biome.')]
#[IsReadOnly]
class ListBiomes extends WaterwaysTool
{
    protected function run(Request $request): Response
    {
        return $this->json(Biome::query()->orderBy('name')->get()->map->toStudioArray()->values());
    }
}
