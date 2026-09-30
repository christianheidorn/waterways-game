<?php

namespace App\Mcp\Tools;

use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[Name('get_editor_state')]
#[Description('Live state of the open editor: mode (edit / play), camera position and direction, view mode, selected tool and layer, unsaved changes, undo / redo availability and rendering stats (fps, draw calls, foliage).')]
#[IsReadOnly]
class GetEditorState extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        return ['map' => $this->mapArgument($schema)];
    }

    protected function run(Request $request): Response
    {
        $map = $this->map($request);

        return $this->json(['map' => $map->slug, ...$this->bridge()->run($map, 'state')]);
    }
}
