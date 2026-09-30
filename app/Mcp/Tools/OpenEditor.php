<?php

namespace App\Mcp\Tools;

use App\Mcp\HeadlessEditor;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;

#[Name('open_editor')]
#[Description('Makes sure the map is open in an editor, so live tools (world edits, screenshots, control_editor) work without the user. If the map is already open (in the user\'s tab or a hidden editor) it returns at once and uses that one. Otherwise it starts a hidden (headless) browser editor on this machine and waits until it runs (usually 10–60 s; `wait: false` returns right away). Result: status already_open / open / loading and `headless` (true for a hidden editor). A hidden editor saves and closes itself after being idle (default 15 min) or when the user opens the same map; call close_editor when you are done. Unsaved edits in a hidden editor are only kept once saved, like in the user\'s editor.')]
class OpenEditor extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        return [
            'map' => $this->mapArgument($schema),
            'wait' => $schema->boolean()->description('Wait until the editor runs (default true).'),
        ];
    }

    protected function run(Request $request): Response
    {
        $map = $this->map($request);

        return $this->json(app(HeadlessEditor::class)->open($map, $request->get('wait') !== false));
    }
}
