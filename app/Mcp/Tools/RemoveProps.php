<?php

namespace App\Mcp\Tools;

use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\Validator;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;
use Laravel\Mcp\Server\Tools\Annotations\IsDestructive;

#[Name('remove_props')]
#[IsDestructive]
#[Description('Removes placed props, live in the open editor (one undo step; saved unless save is false): the given prop `ids` (from list_props / place_props), or every prop whose centre is inside `shape`, optionally only of some `models`.')]
class RemoveProps extends WaterwaysTool
{
    use PropModelArguments;
    use ShapeArgument;

    public function schema(JsonSchema $schema): array
    {
        return [
            'map' => $this->mapArgument($schema),
            'ids' => $schema->array()->items($schema->string())->description('Prop ids to remove.'),
            'shape' => $this->shapeSchema($schema)->description('Remove the props inside this area.'),
            'models' => $schema->array()->items($schema->string())->description('Only these prop model ids or names.'),
            'save' => $schema->boolean()->description('Save the map after the edit (default true).'),
        ];
    }

    protected function run(Request $request): Response
    {
        $input = $request->all();
        $shape = $this->validatedShape($input, 'shape', false);
        $data = Validator::make($input, [
            'ids' => [$shape === null ? 'required' : 'sometimes', 'array', 'max:2000'],
            'ids.*' => ['string'],
            'models' => ['sometimes', 'array', 'max:20'],
        ], [
            'ids.required' => 'Give prop ids or a shape.',
        ])->validate();
        $models = isset($data['models'])
            ? array_values(array_map(fn ($m) => $m->id, $this->resolvePropModels($data['models'])))
            : null;

        return $this->worldEdit($this->map($request), $request, 'remove_props', [
            'kind' => 'props',
            'action' => 'remove',
            'shape' => $shape,
            'ids' => $data['ids'] ?? null,
            'models' => $models,
        ]);
    }
}
