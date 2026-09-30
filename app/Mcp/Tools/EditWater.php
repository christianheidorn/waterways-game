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
- river: along a path shape (first point = source): carves a channel `depth` m (default 2) below a water surface that follows the ground downhill; the path width is the water width, its falloff the banks. The river is kept as an editable spline (smooth curve through the path points) and its id returned.
- list_rivers: the map's rivers as saved (id, name, width, depth, bank, points); needs no editor.
- update_river: re-carves river `id` with a new course (`shape` path) and / or `width`, `depth`, `bank`, `name`: its old carve and water are taken out first (sculpting done since stays).
- delete_river: removes river `id`, its water and its carve.
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
            'action' => $schema->string()->enum(['lake', 'river', 'erase', 'list_rivers', 'update_river', 'delete_river'])->required(),
            'id' => $schema->string()->description('update_river / delete_river: the river id (see list_rivers).'),
            'width' => $schema->number()->min(1)->max(400)->description('update_river: water width in m.'),
            'bank' => $schema->number()->min(0)->max(200)->description('update_river: width of the banks in m.'),
            'name' => $schema->string()->description('river / update_river: display name.'),
            'point' => $schema->object(['x' => $schema->number()->required(), 'z' => $schema->number()->required()])->description('lake: a point in the basin.'),
            'level' => $schema->number()->description('lake: water surface height in m.'),
            'fill_to_rim' => $schema->boolean()->description('lake: fill the basin as high as it holds water (instead of level / depth).'),
            'depth' => $schema->number()->description('lake without level: m above the ground at the point (default 3); river: channel depth (default 2).'),
            'shape' => $this->shapeSchema($schema)->description('river: the path; update_river: optional new course; erase: the area; lake: optional limit.'),
            'save' => $schema->boolean()->description('Save the map after the edit (default true).'),
        ];
    }

    protected function run(Request $request): Response
    {
        $input = $request->all();
        $action = $input['action'] ?? null;

        if ($action === 'list_rivers') {
            $map = $this->map($request);

            return $this->json(['map' => $map->slug, ...EditRoad::listSplines($map, 'rivers')]);
        }

        $shape = $this->validatedShape($input, required: in_array($action, ['river', 'erase'], true));
        $data = Validator::make($input, [
            'action' => ['required', 'in:lake,river,erase,update_river,delete_river'],
            'id' => ['required_if:action,update_river,delete_river', 'string'],
            'width' => ['sometimes', 'numeric', 'between:1,400'],
            'bank' => ['sometimes', 'numeric', 'between:0,200'],
            'name' => ['sometimes', 'string', 'max:80'],
            'point' => ['required_if:action,lake', 'array'],
            'point.x' => ['required_with:point', 'numeric'],
            'point.z' => ['required_with:point', 'numeric'],
            'level' => ['sometimes', 'numeric'],
            'fill_to_rim' => ['sometimes', 'boolean'],
            'depth' => ['sometimes', 'numeric', 'between:0.2,200'],
        ])->validate();

        if (in_array($action, ['river', 'update_river'], true) && $shape !== null && $shape['type'] !== 'path') {
            return Response::error('A river needs a path shape (its centre line, from source to mouth).');
        }

        if ($action === 'update_river' || $action === 'delete_river') {
            $params = [];

            foreach (['width', 'depth', 'bank'] as $key) {
                if (isset($data[$key])) {
                    $params[$key] = (float) $data[$key];
                }
            }

            if (isset($data['name'])) {
                $params['name'] = $data['name'];
            }

            if ($action === 'update_river' && $params === [] && $shape === null) {
                return Response::error('Nothing to change: give a new course (shape), width, depth, bank or name.');
            }

            return $this->worldEdit($this->map($request), $request, "edit_water {$action}", array_filter([
                'kind' => 'water',
                'action' => $action,
                'id' => $data['id'],
                'shape' => $shape,
                'params' => $params,
            ], fn ($v) => $v !== null));
        }

        $params = match ($action) {
            'lake' => array_filter([
                'point' => ['x' => (float) $data['point']['x'], 'z' => (float) $data['point']['z']],
                'level' => isset($data['level']) ? (float) $data['level'] : null,
                'depth' => isset($data['depth']) ? (float) $data['depth'] : null,
                'fill_to_rim' => ($data['fill_to_rim'] ?? false) ?: null,
            ], fn ($v) => $v !== null),
            'river' => array_filter([
                'depth' => (float) ($data['depth'] ?? 2),
                'name' => $data['name'] ?? null,
            ], fn ($v) => $v !== null),
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
