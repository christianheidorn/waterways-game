<?php

namespace App\Mcp\Tools;

use App\Mcp\HeadlessEditor;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;

#[Name('close_editor')]
#[Description('Closes the hidden editor of a map that open_editor started (never the user\'s own editor tabs). Refuses while it has unsaved changes: save them first (control_editor action "save"), or pass discard_unsaved: true to drop them.')]
class CloseEditor extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        return [
            'map' => $this->mapArgument($schema),
            'discard_unsaved' => $schema->boolean()->description('Close even if the hidden editor has unsaved changes (they are lost).'),
        ];
    }

    protected function run(Request $request): Response
    {
        $map = $this->map($request);

        return $this->json(app(HeadlessEditor::class)->close($map, (bool) $request->get('discard_unsaved')));
    }
}
