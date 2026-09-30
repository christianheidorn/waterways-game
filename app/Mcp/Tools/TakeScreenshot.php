<?php

namespace App\Mcp\Tools;

use App\Mcp\ToolError;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\ResponseFactory;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[Name('take_screenshot')]
#[Description('Renders the map in the open editor and returns the image (without editor UI). Place the camera with `view` or `position` + `look_at`; the user\'s camera is put back afterwards unless keep_camera is true. `view_mode` shows an analysis view: layers (terrain layer per colour), slope, height (contours), density (foliage per 100 m²), lighting (grey albedo), wireframe or collision (the colliders of foliage and props within 40 m of the camera, outlined). Waits until foliage around the camera has grown. Views from very high up (a top_down of a whole large map) look hazy through the atmosphere: use a lower `height` over the area of interest, or an analysis view_mode, for detail.')]
#[IsReadOnly]
class TakeScreenshot extends WaterwaysTool
{
    use CameraArguments;

    public function schema(JsonSchema $schema): array
    {
        return [
            'map' => $this->mapArgument($schema),
            ...$this->cameraSchema($schema),
            'view_mode' => $schema->string()->enum(['lit', 'lighting', 'layers', 'slope', 'height', 'density', 'wireframe', 'collision'])
                ->description('Default lit (normal rendering).'),
            'keep_camera' => $schema->boolean()->description('Leave the user\'s view at the new camera (default false).'),
            'max_width' => $schema->integer()->min(256)->max(1920)->description('Downscale to this width (default 1280).'),
        ];
    }

    protected function run(Request $request): Response|ResponseFactory
    {
        $map = $this->map($request);
        $result = $this->bridge()->run($map, 'screenshot', [
            ...$this->cameraPayload($request),
            'view_mode' => $request->get('view_mode'),
            'keep_camera' => (bool) $request->get('keep_camera', false),
            'max_width' => (int) $request->get('max_width', 1280),
        ], timeout: 60);

        $image = base64_decode((string) ($result['image'] ?? ''), true);

        if ($image === false || $image === '') {
            throw new ToolError('The editor returned no image.');
        }

        unset($result['image']);

        return Response::make([
            Response::image($image, (string) ($result['mime'] ?? 'image/jpeg')),
            Response::text(json_encode(['map' => $map->slug, ...$result], JSON_UNESCAPED_SLASHES)),
        ]);
    }
}
