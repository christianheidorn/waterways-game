<?php

namespace App\Mcp\Tools;

use App\Models\FoliageType;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\Validator;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;

#[Name('edit_foliage')]
#[Description('Places or removes individual foliage (saved with the map), live in the open editor (one undo step; saved unless save is false). "scatter" fills a shape with the given types up to `density` × the type\'s own density (instances already there count, so scattering again does not stack), following each type\'s slope / altitude / water rules, optionally in groves (`clustering` 0-1). "clear" removes placed instances of the given types (all when omitted) inside a shape, e.g. for a clearing, a road or a building site. For large natural areas prefer ground cover (paint a layer whose biome grows the plants): it regrows by itself when the terrain changes.')]
class EditFoliage extends WaterwaysTool
{
    use ShapeArgument;

    public function schema(JsonSchema $schema): array
    {
        return [
            'map' => $this->mapArgument($schema),
            'action' => $schema->string()->enum(['scatter', 'clear'])->required(),
            'shape' => $this->shapeSchema($schema)->required(),
            'types' => $schema->array()->items($schema->string())->description('Foliage type ids or names (list_foliage_types). clear: omit for all.'),
            'density' => $schema->number()->min(0)->max(20)->description('scatter: multiplier on each type\'s density (default 1).'),
            'clustering' => $schema->number()->min(0)->max(1)->description('scatter: 0 even … 1 groves and clearings.'),
            'strength' => $schema->number()->min(0)->max(1)->description('clear: share removed at full effect (default 1).'),
            'save' => $schema->boolean()->description('Save the map after the edit (default true).'),
        ];
    }

    protected function run(Request $request): Response
    {
        $input = $request->all();
        $shape = $this->validatedShape($input);
        $data = Validator::make($input, [
            'action' => ['required', 'in:scatter,clear'],
            'types' => ['required_if:action,scatter', 'array', 'max:20'],
            'types.*' => ['required'],
            'density' => ['sometimes', 'numeric', 'between:0,20'],
            'clustering' => ['sometimes', 'numeric', 'between:0,1'],
            'strength' => ['sometimes', 'numeric', 'between:0,1'],
        ])->validate();

        $ids = null;

        if (isset($data['types'])) {
            $ids = [];

            foreach ($data['types'] as $ref) {
                $type = is_numeric($ref)
                    ? FoliageType::query()->find((int) $ref)
                    : FoliageType::query()->whereRaw('lower(name) = ?', [mb_strtolower((string) $ref)])->first();

                if ($type === null) {
                    return Response::error("No foliage type \"{$ref}\". See list_foliage_types.");
                }

                $ids[] = $type->id;
            }
        }

        return $this->worldEdit($this->map($request), $request, "edit_foliage {$data['action']}", [
            'kind' => 'foliage',
            'action' => $data['action'],
            'shape' => $shape,
            'params' => array_filter([
                'type_ids' => $ids,
                'density' => isset($data['density']) ? (float) $data['density'] : null,
                'clustering' => isset($data['clustering']) ? (float) $data['clustering'] : null,
                'strength' => isset($data['strength']) ? (float) $data['strength'] : null,
            ], fn ($v) => $v !== null),
        ]);
    }
}
