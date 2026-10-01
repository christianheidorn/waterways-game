<?php

namespace App\Mcp\Tools;

use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;

#[Name('control_editor')]
#[Description('Drives the open editor. action: "save" writes unsaved terrain, paint, water and foliage edits to the server (edits made in the editor are only kept once saved); "undo" / "redo" steps through the editor history (`steps`, default 1); "history" lists the undo history (every step with its label, oldest first, and `position` = how many are applied, as the History panel shows it); "history_jump" moves to `position` (0 = before the first listed step); "set_view_mode" switches the analysis view (`view_mode`); "set_mode" switches between edit and play (`mode`); "auto_paint" re-applies every layer\'s auto-paint rules to the whole map (undoable, unsaved until "save"); "walk" turns the editor\'s walk mode (J: the character with collision, the editor stays open) on (`walk` true, default; optionally dropped at x, z facing `facing` degrees) or off (`walk` false) — control_player then walks, looks and jumps without switching to play mode.')]
class ControlEditor extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        return [
            'map' => $this->mapArgument($schema),
            'action' => $schema->string()->enum(['save', 'undo', 'redo', 'history', 'history_jump', 'set_view_mode', 'set_mode', 'auto_paint', 'walk'])->required(),
            'steps' => $schema->integer()->min(1)->max(100),
            'position' => $schema->integer()->min(0)->description('history_jump: the number of history steps that stay applied (from "history").'),
            'view_mode' => $schema->string()->enum(['lit', 'lighting', 'bounce', 'layers', 'slope', 'height', 'density', 'wireframe', 'collision']),
            'mode' => $schema->string()->enum(['edit', 'play']),
            'walk' => $schema->boolean()->description('walk: on (default) or off.'),
            'x' => $schema->number()->description('walk: where the character starts (world x, m; default under the cursor / camera).'),
            'z' => $schema->number()->description('walk: world z (m).'),
            'facing' => $schema->number()->description('walk: facing in degrees (0 = north / −z).'),
        ];
    }

    protected function run(Request $request): Response
    {
        $data = $request->validate([
            'action' => ['required', 'in:save,undo,redo,history,history_jump,set_view_mode,set_mode,auto_paint,walk'],
            'position' => ['required_if:action,history_jump', 'integer', 'min:0'],
            'steps' => ['sometimes', 'integer', 'between:1,100'],
            'view_mode' => ['required_if:action,set_view_mode', 'in:lit,lighting,bounce,layers,slope,height,density,wireframe,collision'],
            'mode' => ['required_if:action,set_mode', 'in:edit,play'],
            'walk' => ['sometimes', 'boolean'],
            'x' => ['required_with:z', 'numeric'],
            'z' => ['required_with:x', 'numeric'],
            'facing' => ['sometimes', 'numeric'],
        ]);

        foreach (['x', 'z', 'facing'] as $key) {
            if (isset($data[$key])) {
                $data[$key] = (float) $data[$key];
            }
        }
        $map = $this->map($request);

        if ($data['action'] === 'auto_paint') {
            $this->snapshots()->autoBefore($map, 'auto_paint');
        }

        $result = $this->bridge()->run($map, $data['action'], array_diff_key($data, ['action' => true]), timeout: $data['action'] === 'save' ? 60 : 30);

        return $this->json(['map' => $map->slug, 'action' => $data['action'], ...$result]);
    }
}
