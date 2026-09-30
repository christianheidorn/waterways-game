<?php

namespace App\Mcp\Tools;

use App\Mcp\ToolError;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\Validator;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;

#[Name('update_props')]
#[Description('Edits props that are already placed, live in the open editor (one undo step; saved unless save is false), like Select & edit in the Props tool. Either exact `updates` per prop id (x, z, rotation in degrees, scale, offset above the ground), or one `change` for every prop selected by `ids`, a `shape` and / or `models`: move_x / move_z (m), rotate_by (degrees), rotation (set), scale_by, scale (set), offset (set), random_rotation and scale_min / scale_max to re-roll rotation and size, align (tilt with the terrain slope, or false to stand upright), snap_grid (m) to snap positions to a grid. Ids come from list_props / place_props.')]
class UpdateProps extends WaterwaysTool
{
    use PropModelArguments;
    use ShapeArgument;

    public function schema(JsonSchema $schema): array
    {
        return [
            'map' => $this->mapArgument($schema),
            'updates' => $schema->array()->items($schema->object([
                'id' => $schema->string()->required(),
                'x' => $schema->number(),
                'z' => $schema->number(),
                'rotation' => $schema->number()->description('Degrees around the vertical axis (0 faces +Z).'),
                'scale' => $schema->number()->min(0.05)->max(20),
                'offset' => $schema->number()->min(-50)->max(50),
                'align' => $schema->boolean()->description('Tilt with the terrain slope (false: upright).'),
            ]))->description('Exact new values per prop (up to 500).'),
            'ids' => $schema->array()->items($schema->string())->description('change: the props to change.'),
            'shape' => $this->shapeSchema($schema)->description('change: the props whose centre is inside this area.'),
            'models' => $schema->array()->items($schema->string())->description('change: only props of these model ids or names.'),
            'change' => $schema->object([
                'move_x' => $schema->number(),
                'move_z' => $schema->number(),
                'rotate_by' => $schema->number(),
                'rotation' => $schema->number(),
                'random_rotation' => $schema->boolean(),
                'scale_by' => $schema->number()->min(0.05)->max(20),
                'scale' => $schema->number()->min(0.05)->max(20),
                'scale_min' => $schema->number()->min(0.05)->max(20),
                'scale_max' => $schema->number()->min(0.05)->max(20),
                'offset' => $schema->number()->min(-50)->max(50),
                'seed' => $schema->integer(),
                'align' => $schema->boolean()->description('Tilt with the terrain slope (false: upright).'),
                'snap_grid' => $schema->number()->min(0.1)->max(100)->description('Snap positions to a grid of this size (m).'),
            ])->description('What to do with every selected prop.'),
            'save' => $schema->boolean()->description('Save the map after the edit (default true).'),
        ];
    }

    protected function run(Request $request): Response
    {
        $input = $request->all();
        $map = $this->map($request);

        if (! empty($input['updates'])) {
            $data = Validator::make($input, [
                'updates' => ['required', 'array', 'max:500'],
                'updates.*.id' => ['required', 'string'],
                'updates.*.x' => ['sometimes', 'numeric'],
                'updates.*.z' => ['sometimes', 'numeric'],
                'updates.*.rotation' => ['sometimes', 'numeric'],
                'updates.*.scale' => ['sometimes', 'numeric', 'between:0.05,20'],
                'updates.*.offset' => ['sometimes', 'numeric', 'between:-50,50'],
                'updates.*.align' => ['sometimes', 'boolean'],
            ])->validate();

            $updates = array_map(fn (array $u) => array_map(
                fn ($v) => is_numeric($v) && ! is_string($v) ? (float) $v : $v,
                array_intersect_key($u, array_flip(['id', 'x', 'z', 'rotation', 'scale', 'offset', 'align'])),
            ), $data['updates']);

            return $this->worldEdit($map, $request, 'update_props', [
                'kind' => 'props',
                'action' => 'update',
                'updates' => $updates,
            ]);
        }

        $shape = $this->validatedShape($input, 'shape', false);
        $data = Validator::make($input, [
            'ids' => [$shape === null ? 'required' : 'sometimes', 'array', 'max:2000'],
            'ids.*' => ['string'],
            'models' => ['sometimes', 'array', 'max:20'],
            'change' => ['required', 'array'],
            'change.move_x' => ['sometimes', 'numeric', 'between:-5000,5000'],
            'change.move_z' => ['sometimes', 'numeric', 'between:-5000,5000'],
            'change.rotate_by' => ['sometimes', 'numeric'],
            'change.rotation' => ['sometimes', 'numeric'],
            'change.random_rotation' => ['sometimes', 'boolean'],
            'change.scale_by' => ['sometimes', 'numeric', 'between:0.05,20'],
            'change.scale' => ['sometimes', 'numeric', 'between:0.05,20'],
            'change.scale_min' => ['sometimes', 'numeric', 'between:0.05,20'],
            'change.scale_max' => ['sometimes', 'numeric', 'between:0.05,20'],
            'change.offset' => ['sometimes', 'numeric', 'between:-50,50'],
            'change.seed' => ['sometimes', 'integer'],
            'change.align' => ['sometimes', 'boolean'],
            'change.snap_grid' => ['sometimes', 'numeric', 'between:0.1,100'],
        ], [
            'ids.required' => 'Give `updates`, or prop ids or a shape with a `change`.',
            'change.required' => 'Say what to change (`change`), or give exact `updates`.',
        ])->validate();

        $change = array_intersect_key((array) ($data['change'] ?? []), array_flip([
            'move_x', 'move_z', 'rotate_by', 'rotation', 'random_rotation', 'scale_by', 'scale', 'scale_min', 'scale_max', 'offset', 'seed', 'align', 'snap_grid',
        ]));

        if ($change === []) {
            throw new ToolError('The change is empty: give move_x / move_z, rotate_by, rotation, random_rotation, scale_by, scale, scale_min / scale_max, offset, align or snap_grid.');
        }

        $models = isset($data['models'])
            ? array_values(array_map(fn ($m) => $m->id, $this->resolvePropModels($data['models'])))
            : null;

        return $this->worldEdit($map, $request, 'update_props', [
            'kind' => 'props',
            'action' => 'update',
            'shape' => $shape,
            'ids' => $data['ids'] ?? null,
            'models' => $models,
            'change' => $change,
        ]);
    }
}
