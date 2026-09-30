<?php

namespace App\Mcp\Tools;

use App\Models\Map;
use App\Models\MapSnapshot;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;
use Laravel\Mcp\Server\Tools\Annotations\IsDestructive;

#[Name('map_snapshots')]
#[Description('Restore points of a map (saved terrain, paint, water, foliage, layers and environment). action "list" shows them (automatic ones are taken before agent tools change a map, at most every 10 minutes); "create" takes one now (`label`), e.g. before a big change; "restore" puts the map back to `snapshot_id` and reloads the open editor. Unsaved editor edits are not part of a snapshot: save them first (control_editor save) if they should be.')]
#[IsDestructive]
class ManageSnapshots extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        return [
            'map' => $this->mapArgument($schema),
            'action' => $schema->string()->enum(['list', 'create', 'restore'])->required(),
            'label' => $schema->string()->description('create: what the snapshot is for.'),
            'snapshot_id' => $schema->integer()->description('restore: which snapshot.'),
            'discard_unsaved' => $schema->boolean()->description('restore: drop unsaved editor changes (ask the user first).'),
        ];
    }

    protected function run(Request $request): Response
    {
        $map = $this->map($request);
        $unsaved = $this->bridge()->session($map)?->state['unsaved'] ?? [];

        return match ($request->get('action')) {
            'create' => $this->json([
                'snapshot' => $this->summary($this->snapshots()->create($map, (string) ($request->get('label') ?: 'Snapshot'))),
                'warning' => $unsaved ? 'The open editor has unsaved changes ('.implode(', ', $unsaved).') that are not in this snapshot.' : null,
            ]),
            'restore' => $this->restore($map->snapshots()->find((int) $request->get('snapshot_id')), $map, $request),
            default => $this->json([
                'map' => $map->slug,
                'snapshots' => $map->snapshots()->latest('id')->get()->map(fn (MapSnapshot $s) => $this->summary($s))->values(),
            ]),
        };
    }

    private function restore(?MapSnapshot $snapshot, Map $map, Request $request): Response
    {
        if ($snapshot === null) {
            return Response::error('No such snapshot of this map. Use action "list".');
        }

        $this->guardUnsaved($map, $request);

        // The current state becomes a restore point too, so a restore can be undone.
        $this->snapshots()->create($map, "Before restoring snapshot {$snapshot->id}", auto: true);
        $this->snapshots()->restore($snapshot);
        $live = $this->bridge()->notify($map, 'reload');

        return $this->json(['restored' => $this->summary($snapshot), 'editor_reloaded' => $live]);
    }

    /**
     * @return array<string, mixed>
     */
    private function summary(MapSnapshot $s): array
    {
        return ['id' => $s->id, 'label' => $s->label, 'auto' => $s->auto, 'created_at' => $s->created_at->toIso8601String()];
    }
}
