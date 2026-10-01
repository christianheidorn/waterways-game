<?php

namespace App\Mcp\Tools;

use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\Validator;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;

#[Name('paint_surf')]
#[Description(<<<'MD'
Surf along shores (beaches), painted inside a `shape`, live in the open editor (one undo step; saved unless save is false). Same as the editor's Water › Surf brush; stored per map.
- mode "on" (default): surf breaks on the shore inside the shape at `strength` (0-1, default 1), even where the body has surf off; steep shores get a gentler version.
- mode "off": no surf there (e.g. a harbour or rocky stretch).
- mode "auto": back to automatic: the body's surf setting (edit_water_body settings.surf) on gentle shores, found by slope.
Paint over where water meets land (a path along the shoreline with some width works well); the result reports the shoreline inside the shape and how much of it now has surf. The waves (height, period, direction) are set per body with edit_water_body (surf_height, surf_period, surf_direction). Surf needs a gentle beach: shape one with sculpt_terrain (a smooth ramp of ~1:10 to 1:30 into the water) and paint sand.
MD)]
class PaintSurf extends WaterwaysTool
{
    use ShapeArgument;

    public function schema(JsonSchema $schema): array
    {
        return [
            'map' => $this->mapArgument($schema),
            'shape' => $this->shapeSchema($schema)->required(),
            'mode' => $schema->string()->enum(['on', 'off', 'auto'])->description('on (default), off, or auto (back to the body setting on gentle shores).'),
            'strength' => $schema->number()->min(0.05)->max(1)->description('mode on: surf strength 0.05-1 (default 1).'),
            'save' => $schema->boolean()->description('Save the map after the edit (default true).'),
        ];
    }

    protected function run(Request $request): Response
    {
        $input = $request->all();
        $shape = $this->validatedShape($input);
        $data = Validator::make($input, [
            'mode' => ['sometimes', 'in:on,off,auto'],
            'strength' => ['sometimes', 'numeric', 'between:0.05,1'],
        ])->validate();
        $mode = $data['mode'] ?? 'on';

        return $this->worldEdit($this->map($request), $request, "paint_surf {$mode}", [
            'kind' => 'surf',
            'action' => $mode,
            'shape' => $shape,
            'params' => $mode === 'on' ? ['strength' => (float) ($data['strength'] ?? 1)] : [],
        ]);
    }
}
