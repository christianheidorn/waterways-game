<?php

namespace App\Mcp\Tools;

use App\Models\Material;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[Name('list_materials')]
#[Description('PBR terrain materials in the library (ready to use on terrain layers via update_terrain_layer material_id), optionally filtered by category or name.')]
#[IsReadOnly]
class ListMaterials extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        return [
            'category' => $schema->string()->enum(array_keys(Material::CATEGORIES))->description('Only this category.'),
            'search' => $schema->string()->description('Part of the name.'),
        ];
    }

    protected function run(Request $request): Response
    {
        $materials = Material::query()
            ->where('status', 'ready')
            ->when($request->get('category'), fn ($q, $c) => $q->where('category', $c))
            ->when($request->get('search'), fn ($q, $s) => $q->where('name', 'like', "%{$s}%"))
            ->orderBy('category')->orderBy('name')
            ->get()
            ->map(fn (Material $m) => [
                'id' => $m->id,
                'name' => $m->name,
                'category' => $m->category,
                'tile_size_m' => $m->tile_size,
                'source' => $m->source ?? null,
            ]);

        return $this->json(['materials' => $materials->values(), 'categories' => Material::CATEGORIES]);
    }
}
