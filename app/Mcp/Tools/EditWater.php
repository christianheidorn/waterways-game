<?php

namespace App\Mcp\Tools;

use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\Validator;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;

#[Name('edit_water')]
#[Description(<<<'MD'
Water, live in the open editor (one undo step; saved unless save is false).
- lake: floods the basin around `point` up to `level` m (or `depth` m above the ground there, or fill_to_rim: as high as the basin holds): all connected ground below the level fills, optionally limited to a `shape`. Refuses levels that would spill over the map edge and says how high the basin holds water and where it overflows. Dig a basin first (sculpt_terrain hill with a negative height) for a lake in flat land.
- river: along a path shape (first point = source): carves a channel `depth` m (default 2) below a water surface that follows the ground downhill; the path width is the water width, its falloff the banks.
- erase: removes water inside a shape.
The sea level is an environment setting (update_environment sea_level).
MD)]
class EditWater extends WaterwaysTool
{
    use ShapeArgument;

    public function schema(JsonSchema $schema): array
    {
        return [
            'map' => $this->mapArgument($schema),
            'action' => $schema->string()->enum(['lake', 'river', 'erase'])->required(),
            'point' => $schema->object(['x' => $schema->number()->required(), 'z' => $schema->number()->required()])->description('lake: a point in the basin.'),
            'level' => $schema->number()->description('lake: water surface height in m.'),
            'fill_to_rim' => $schema->boolean()->description('lake: fill the basin as high as it holds water (instead of level / depth).'),
            'depth' => $schema->number()->description('lake without level: m above the ground at the point (default 3); river: channel depth (default 2).'),
            'shape' => $this->shapeSchema($schema)->description('river: the path; erase: the area; lake: optional limit.'),
            'save' => $schema->boolean()->description('Save the map after the edit (default true).'),
        ];
    }

    protected function run(Request $request): Response
    {
        $input = $request->all();
        $action = $input['action'] ?? null;
        $shape = $this->validatedShape($input, required: $action !== 'lake');
        $data = Validator::make($input, [
            'action' => ['required', 'in:lake,river,erase'],
            'point' => ['required_if:action,lake', 'array'],
            'point.x' => ['required_with:point', 'numeric'],
            'point.z' => ['required_with:point', 'numeric'],
            'level' => ['sometimes', 'numeric'],
            'fill_to_rim' => ['sometimes', 'boolean'],
            'depth' => ['sometimes', 'numeric', 'between:0.2,200'],
        ])->validate();

        if ($action === 'river' && $shape['type'] !== 'path') {
            return Response::error('A river needs a path shape (its centre line, from source to mouth).');
        }

        $params = match ($action) {
            'lake' => array_filter([
                'point' => ['x' => (float) $data['point']['x'], 'z' => (float) $data['point']['z']],
                'level' => isset($data['level']) ? (float) $data['level'] : null,
                'depth' => isset($data['depth']) ? (float) $data['depth'] : null,
                'fill_to_rim' => ($data['fill_to_rim'] ?? false) ?: null,
            ], fn ($v) => $v !== null),
            'river' => ['depth' => (float) ($data['depth'] ?? 2)],
            default => [],
        };

        return $this->worldEdit($this->map($request), $request, "edit_water {$action}", array_filter([
            'kind' => 'water',
            'action' => $action,
            'shape' => $shape,
            'params' => $params,
        ], fn ($v) => $v !== null));
    }
}
