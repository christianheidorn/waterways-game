<?php

namespace App\Mcp\Tools;

use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;

/**
 * Camera placement shared by take_screenshot and set_camera.
 */
trait CameraArguments
{
    /**
     * @return array<string, mixed>
     */
    protected function cameraSchema(JsonSchema $schema): array
    {
        return [
            'view' => $schema->string()->enum(['current', 'overview', 'top_down', 'spawn'])
                ->description('current: as the user sees it; overview: the whole map at an angle; top_down: straight down over the map (or over `look_at`); spawn: from the player start. Ignored when `position` is given.'),
            'position' => $schema->object([
                'x' => $schema->number()->required(),
                'y' => $schema->number()->description('Height in m; omitted = 2 m above the ground. Below a water surface for the view under water.'),
                'z' => $schema->number()->required(),
            ])->description('Camera position in world metres.'),
            'look_at' => $schema->object([
                'x' => $schema->number()->required(),
                'y' => $schema->number()->description('Omitted = ground height.'),
                'z' => $schema->number()->required(),
            ])->description('Point to look at (with `position`, or the centre of a top_down view).'),
            'height' => $schema->number()->description('top_down / overview: camera height above the ground in m.'),
        ];
    }

    /**
     * @return array<string, mixed>
     */
    protected function cameraPayload(Request $request): array
    {
        return array_filter([
            'view' => $request->get('view'),
            'position' => $request->get('position'),
            'look_at' => $request->get('look_at'),
            'height' => $request->get('height'),
        ], fn ($v) => $v !== null);
    }
}
