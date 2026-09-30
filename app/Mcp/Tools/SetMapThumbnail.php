<?php

namespace App\Mcp\Tools;

use App\Mcp\ToolError;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\Storage;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;

#[Name('set_map_thumbnail')]
#[Description('Renders the map in the open editor and stores it as the map\'s thumbnail (the studio\'s map cards). The editor also refreshes the thumbnail from the user\'s current view whenever it saves, as in the UI, so a later save replaces it. Camera options as take_screenshot (default: the current view); the user\'s camera is put back.')]
class SetMapThumbnail extends WaterwaysTool
{
    use CameraArguments;

    public function schema(JsonSchema $schema): array
    {
        return [
            'map' => $this->mapArgument($schema),
            ...$this->cameraSchema($schema),
        ];
    }

    protected function run(Request $request): Response
    {
        $map = $this->map($request);
        $shot = $this->bridge()->run($map, 'screenshot', [...$this->cameraPayload($request), 'max_width' => 640], timeout: 60);
        $image = base64_decode((string) ($shot['image'] ?? ''), true);

        if ($image === false || $image === '') {
            throw new ToolError('The editor returned no image.');
        }

        Storage::disk('public')->put($map->thumbnailPath(), $image);

        return $this->json(['map' => $map->slug, 'thumbnail_url' => $map->thumbnailUrl(), 'width' => $shot['width'] ?? null, 'height' => $shot['height'] ?? null]);
    }
}
