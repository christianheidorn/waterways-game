<?php

namespace App\Mcp\Tools;

use App\Models\FoliageType;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[Name('list_foliage_types')]
#[Description('The foliage library: every plant / rock type with kind, model, size range, density (instances per 100 m²), slope and altitude rules, visible distance and shadows. Types are shared by all maps; terrain layers grow them as ground cover.')]
#[IsReadOnly]
class ListFoliageTypes extends WaterwaysTool
{
    protected function run(Request $request): Response
    {
        return $this->json(FoliageType::query()->with('asset')->orderBy('name')->get()->map(function (FoliageType $t) {
            $data = $t->toGameArray();
            unset($data['asset']);
            $data['model'] = $t->asset ? ['asset_id' => $t->asset->id, 'name' => $t->asset->name, 'height_m' => $t->asset->height ?? null] : ($data['model_url'] ? 'uploaded GLB' : 'procedural');

            return $data;
        })->values());
    }
}
