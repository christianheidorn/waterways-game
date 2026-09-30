<?php

namespace App\Mcp\Tools;

use App\Models\PropModel;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[Name('list_prop_models')]
#[Description('The prop model library (placeable 3D objects: buildings, bridges, fences, rocks, …) with status (ready ones can be placed with place_props), size and tags; optionally filtered by category, status or name / tag.')]
#[IsReadOnly]
class ListPropModels extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        return [
            'category' => $schema->string()->enum(array_keys(PropModel::CATEGORIES))->description('Only this category.'),
            'status' => $schema->string()->enum(['ready', 'processing', 'failed'])->description('Only this status.'),
            'search' => $schema->string()->description('Part of the name or a tag.'),
        ];
    }

    protected function run(Request $request): Response
    {
        $search = trim((string) $request->get('search', ''));
        $models = PropModel::query()
            ->when($request->get('category'), fn ($q, $c) => $q->where('category', $c))
            ->when($request->get('status'), fn ($q, $s) => $q->where('status', $s))
            ->when($search !== '', fn ($q) => $q->where(fn ($q) => $q->where('name', 'like', "%{$search}%")->orWhere('tags', 'like', "%{$search}%")))
            ->orderBy('category')->orderBy('name')
            ->get()
            ->map(fn (PropModel $m) => GetAssetStatus::propSummary($m));

        return $this->json(['prop_models' => $models->values(), 'categories' => PropModel::CATEGORIES]);
    }
}
