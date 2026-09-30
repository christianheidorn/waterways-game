<?php

namespace App\Mcp\Tools;

use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;

#[Name('control_editor')]
#[Description('Drives the open editor. action: "save" writes unsaved terrain, paint, water and foliage edits to the server (edits made in the editor are only kept once saved); "undo" / "redo" steps through the editor history (`steps`, default 1); "set_view_mode" switches the analysis view (`view_mode`); "set_mode" switches between edit and play (`mode`); "auto_paint" re-applies every layer\'s auto-paint rules to the whole map (undoable, unsaved until "save").')]
class ControlEditor extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        return [
            'map' => $this->mapArgument($schema),
            'action' => $schema->string()->enum(['save', 'undo', 'redo', 'set_view_mode', 'set_mode', 'auto_paint'])->required(),
            'steps' => $schema->integer()->min(1)->max(100),
            'view_mode' => $schema->string()->enum(['lit', 'lighting', 'layers', 'slope', 'height', 'density', 'wireframe']),
            'mode' => $schema->string()->enum(['edit', 'play']),
        ];
    }

    protected function run(Request $request): Response
    {
        $data = $request->validate([
            'action' => ['required', 'in:save,undo,redo,set_view_mode,set_mode,auto_paint'],
            'steps' => ['sometimes', 'integer', 'between:1,100'],
            'view_mode' => ['required_if:action,set_view_mode', 'in:lit,lighting,layers,slope,height,density,wireframe'],
            'mode' => ['required_if:action,set_mode', 'in:edit,play'],
        ]);
        $map = $this->map($request);

        if ($data['action'] === 'auto_paint') {
            $this->snapshots()->autoBefore($map, 'auto_paint');
        }

        $result = $this->bridge()->run($map, $data['action'], array_diff_key($data, ['action' => true]), timeout: $data['action'] === 'save' ? 60 : 30);

        return $this->json(['map' => $map->slug, 'action' => $data['action'], ...$result]);
    }
}
