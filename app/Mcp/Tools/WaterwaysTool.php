<?php

namespace App\Mcp\Tools;

use App\Mcp\EditorBridge;
use App\Mcp\MapSnapshots;
use App\Mcp\ToolError;
use App\Models\Map;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\JsonSchema\Types\Type;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\ResponseFactory;
use Laravel\Mcp\Server\Tool;

/**
 * Base of the Waterways agent tools: resolves maps, turns expected failures (ToolError) into
 * readable tool errors and gives access to the editor bridge and snapshots.
 */
abstract class WaterwaysTool extends Tool
{
    public function handle(Request $request): Response|ResponseFactory
    {
        try {
            return $this->run($request);
        } catch (ToolError $e) {
            return Response::error($e->getMessage());
        }
    }

    abstract protected function run(Request $request): Response|ResponseFactory;

    /** Schema of the optional `map` argument shared by map tools. */
    protected function mapArgument(JsonSchema $schema): Type
    {
        return $schema->string()->description('Map slug or id. Defaults to the map open in the editor (the most recent one), else the default map.');
    }

    /**
     * The map named by `map` (slug or id); without it the map open in the editor, else the default map.
     */
    protected function map(Request $request): Map
    {
        $ref = $request->get('map');

        if ($ref !== null && $ref !== '') {
            $map = Map::query()->where('slug', (string) $ref)->first()
                ?? (is_numeric($ref) ? Map::query()->find((int) $ref) : null);

            return $map ?? throw new ToolError("No map \"{$ref}\". Use get_project_overview to list the maps.");
        }

        return $this->bridge()->recentMap()
            ?? Map::query()->where('is_default', true)->first()
            ?? Map::query()->oldest()->first()
            ?? throw new ToolError('There are no maps yet. Create one with create_map.');
    }

    protected function bridge(): EditorBridge
    {
        return app(EditorBridge::class);
    }

    protected function snapshots(): MapSnapshots
    {
        return app(MapSnapshots::class);
    }

    /**
     * Refuses to replace a map under an editor that holds unsaved edits (they would be lost on reload,
     * or overwrite the replaced map when saved), unless the agent says they may be discarded.
     */
    protected function guardUnsaved(Map $map, Request $request): void
    {
        $unsaved = $this->bridge()->session($map)?->state['unsaved'] ?? [];

        if ($unsaved !== [] && ! $request->get('discard_unsaved')) {
            throw new ToolError('The open editor has unsaved changes ('.implode(', ', $unsaved).'). Save them first (control_editor action "save"), or ask the user and pass discard_unsaved: true to drop them.');
        }
    }

    /**
     * Runs a scripted world edit in the map's open editor (one undo step there), after an automatic
     * snapshot, and saves it unless `save` is false.
     *
     * @param  array<string, mixed>  $payload  kind, action, shape, params (see editor/agent/runWorldEdit.ts)
     */
    protected function worldEdit(Map $map, Request $request, string $label, array $payload): Response
    {
        $snapshot = $this->snapshots()->autoBefore($map, $label);
        $save = $request->get('save') !== false;
        $result = $this->bridge()->run($map, 'world_edit', [...$payload, 'save' => $save], timeout: 180);

        return $this->json([
            'map' => $map->slug,
            ...$result,
            'saved' => $save,
            'snapshot_taken' => $snapshot?->id,
            'tip' => 'Check the result with take_screenshot or get_map_image.',
        ]);
    }

    /** Structured result as JSON text (readable by any MCP client). */
    protected function json(mixed $data): Response
    {
        return Response::text(json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    }
}
