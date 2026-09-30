<?php

namespace App\Mcp\Tools;

use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\Validator;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;

#[Name('sculpt_terrain')]
#[Description(<<<'MD'
Shapes the terrain inside a shape, live in the open editor (one undo step; saved unless save is false).
Operations:
- raise / lower `amount` m;
- set_height to an absolute `height` m;
- flatten to the mean height inside the shape;
- smooth (`strength` 0-1, `iterations`);
- noise (`amplitude` m, feature `scale` m) for roughness;
- terrace (`step` m, `sharpness` 0-1);
- hill: adds a landform of `height` m (negative = basin, valley, crater, riverbed) with a `profile` (dome, peak, plateau) following the shape: a circle makes a round hill, a polygon a massif following its outline, a path a ridge (or a valley when negative), plus natural `roughness` (0-1, default 0.25);
- erode: weathering (`kind` hydraulic = gullies and deposits, thermal = slopes relax; `strength` 0-1);
- grade: turns a path shape into an even road bed / ramp (`smoothing` m).
Use a falloff so edits blend into the surroundings. get_map_image / sample_terrain show heights and coordinates.
MD)]
class SculptTerrain extends WaterwaysTool
{
    use ShapeArgument;

    public function schema(JsonSchema $schema): array
    {
        return [
            'map' => $this->mapArgument($schema),
            'shape' => $this->shapeSchema($schema)->required(),
            'operation' => $schema->string()->enum(['raise', 'lower', 'set_height', 'flatten', 'smooth', 'noise', 'terrace', 'hill', 'erode', 'grade'])->required(),
            'amount' => $schema->number()->description('raise / lower: metres.'),
            'height' => $schema->number()->description('set_height: target height (m); hill: height of the landform (m, negative digs).'),
            'profile' => $schema->string()->enum(['dome', 'peak', 'plateau'])->description('hill: shape of the landform (default dome).'),
            'roughness' => $schema->number()->min(0)->max(1)->description('hill: natural irregularity (default 0.25).'),
            'strength' => $schema->number()->min(0)->max(1)->description('smooth / erode: 0-1.'),
            'iterations' => $schema->integer()->min(1)->max(50)->description('smooth: passes (default 6).'),
            'amplitude' => $schema->number()->description('noise: metres.'),
            'scale' => $schema->number()->description('noise: feature size in metres (default 40).'),
            'step' => $schema->number()->description('terrace: step height in metres.'),
            'sharpness' => $schema->number()->min(0)->max(1)->description('terrace: 0 soft … 1 sharp steps (default 0.7).'),
            'kind' => $schema->string()->enum(['hydraulic', 'thermal'])->description('erode: default hydraulic.'),
            'smoothing' => $schema->number()->description('grade: metres over which the road evens out (default 40).'),
            'seed' => $schema->integer()->description('noise / hill: variation seed.'),
            'save' => $schema->boolean()->description('Save the map after the edit (default true).'),
        ];
    }

    protected function run(Request $request): Response
    {
        $input = $request->all();
        $shape = $this->validatedShape($input);
        $data = Validator::make($input, [
            'operation' => ['required', 'in:raise,lower,set_height,flatten,smooth,noise,terrace,hill,erode,grade'],
            'amount' => ['required_if:operation,raise,lower', 'numeric', 'between:-2000,2000'],
            'height' => ['required_if:operation,set_height,hill', 'numeric', 'between:-5000,10000'],
            'profile' => ['sometimes', 'in:dome,peak,plateau'],
            'roughness' => ['sometimes', 'numeric', 'between:0,1'],
            'strength' => ['sometimes', 'numeric', 'between:0,1'],
            'iterations' => ['sometimes', 'integer', 'between:1,50'],
            'amplitude' => ['required_if:operation,noise', 'numeric', 'between:-500,500'],
            'scale' => ['sometimes', 'numeric', 'between:1,5000'],
            'step' => ['required_if:operation,terrace', 'numeric', 'between:0.2,500'],
            'sharpness' => ['sometimes', 'numeric', 'between:0,1'],
            'kind' => ['sometimes', 'in:hydraulic,thermal'],
            'smoothing' => ['sometimes', 'numeric', 'between:0,2000'],
            'seed' => ['sometimes', 'integer'],
        ])->validate();

        if ($data['operation'] === 'grade' && $shape['type'] !== 'path') {
            return Response::error('grade needs a path shape (the road centre line).');
        }

        $op = $data['operation'];
        $params = match ($op) {
            'raise' => ['op' => 'raise', 'amount' => (float) $data['amount']],
            'lower' => ['op' => 'raise', 'amount' => -abs((float) $data['amount'])],
            default => ['op' => $op, ...array_map(
                fn ($v) => is_numeric($v) ? (float) $v : $v,
                array_intersect_key($data, array_flip(['height', 'profile', 'roughness', 'strength', 'iterations', 'amplitude', 'scale', 'step', 'sharpness', 'kind', 'smoothing', 'seed'])),
            )],
        };

        return $this->worldEdit($this->map($request), $request, "sculpt_terrain {$op}", [
            'kind' => 'sculpt',
            'shape' => $shape,
            'params' => $params,
        ]);
    }
}
