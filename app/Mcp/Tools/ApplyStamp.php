<?php

namespace App\Mcp\Tools;

use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\Validator;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;

#[Name('apply_stamp')]
#[Description(<<<'MD'
Stamps a procedural landform onto the terrain, like the Sculpt tool's Stamp (live in the open editor, one undo step; saved unless save is false).
Shapes: mountain (ridged peak), volcano (cone with a crater), crater (bowl with a rim; height = depth), mesa (flat top, cliffs, scree), dunes (a field of dunes, crests across the rotation), ridge (long crest along the rotation), canyon (meandering, stepped gorge along the rotation; height = depth), hills (rolling hills).
Place it with x, z (centre), `radius` (m; ridge, canyon, dunes and hills are `aspect` times longer along `rotation`, degrees, 0 = along +x), `height` (m), `seed` for another variation.
Blend: add (on top of the ground, default), max (only raises the ground to the landform: good for mesas and mountains in hilly land), min (only lowers), replace (blends the ground into the landform, built on the ground level around it). `strength` 0-1 and `falloff` (0-1 share of the radius that fades into the terrain) soften it.
MD)]
class ApplyStamp extends WaterwaysTool
{
    private const SHAPES = ['mountain', 'volcano', 'crater', 'mesa', 'dunes', 'ridge', 'canyon', 'hills'];

    public function schema(JsonSchema $schema): array
    {
        return [
            'map' => $this->mapArgument($schema),
            'shape' => $schema->string()->enum(self::SHAPES)->required(),
            'x' => $schema->number()->description('Centre, world x (m).')->required(),
            'z' => $schema->number()->description('Centre, world z (m).')->required(),
            'radius' => $schema->number()->min(5)->max(10000)->description('Footprint radius in m.')->required(),
            'height' => $schema->number()->min(0.5)->max(3000)->description('Height of the landform in m (depth for crater and canyon).')->required(),
            'rotation' => $schema->number()->description('Degrees (0 = long axis along +x).'),
            'blend' => $schema->string()->enum(['add', 'max', 'min', 'replace'])->description('Default add.'),
            'strength' => $schema->number()->min(0)->max(1)->description('Default 1.'),
            'aspect' => $schema->number()->min(1)->max(10)->description('Length / width of elongated shapes (defaults: ridge 3, canyon 3, dunes 1.6, hills 1.3, others 1).'),
            'falloff' => $schema->number()->min(0.02)->max(1)->description('Share of the radius over which the edge fades (default 0.3).'),
            'seed' => $schema->integer()->description('Variation of the noise details.'),
            'save' => $schema->boolean()->description('Save the map after the edit (default true).'),
        ];
    }

    protected function run(Request $request): Response
    {
        $data = Validator::make($request->all(), [
            'shape' => ['required', 'in:'.implode(',', self::SHAPES)],
            'x' => ['required', 'numeric'],
            'z' => ['required', 'numeric'],
            'radius' => ['required', 'numeric', 'between:5,10000'],
            'height' => ['required', 'numeric', 'between:0.5,3000'],
            'rotation' => ['sometimes', 'numeric'],
            'blend' => ['sometimes', 'in:add,max,min,replace'],
            'strength' => ['sometimes', 'numeric', 'between:0,1'],
            'aspect' => ['sometimes', 'numeric', 'between:1,10'],
            'falloff' => ['sometimes', 'numeric', 'between:0.02,1'],
            'seed' => ['sometimes', 'integer'],
        ])->validate();

        $params = ['shape' => $data['shape']];

        foreach (['x', 'z', 'radius', 'height', 'rotation', 'strength', 'aspect', 'falloff'] as $key) {
            if (isset($data[$key])) {
                $params[$key] = (float) $data[$key];
            }
        }

        if (isset($data['blend'])) {
            $params['blend'] = $data['blend'];
        }

        if (isset($data['seed'])) {
            $params['seed'] = (int) $data['seed'];
        }

        return $this->worldEdit($this->map($request), $request, "apply_stamp {$data['shape']}", [
            'kind' => 'stamp',
            'params' => $params,
        ]);
    }
}
