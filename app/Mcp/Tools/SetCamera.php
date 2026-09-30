<?php

namespace App\Mcp\Tools;

use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;

#[Name('set_camera')]
#[Description('Moves the editor camera the user is looking through (e.g. to show them something). Same placement options as take_screenshot.')]
class SetCamera extends WaterwaysTool
{
    use CameraArguments;

    public function schema(JsonSchema $schema): array
    {
        return ['map' => $this->mapArgument($schema), ...$this->cameraSchema($schema)];
    }

    protected function run(Request $request): Response
    {
        return $this->json($this->bridge()->run($this->map($request), 'camera', $this->cameraPayload($request)));
    }
}
