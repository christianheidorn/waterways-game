<?php

namespace App\Mcp\Tools;

use App\Enums\MapSource;
use App\Http\Controllers\MapController;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\Validator;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;
use Laravel\Mcp\Server\Tools\Annotations\IsDestructive;

#[Name('regenerate_terrain')]
#[Description('Re-generates a map\'s terrain from scratch (new seed, source, size, area or height scale). DISCARDS all sculpting, paint, water edits and placed foliage (a snapshot is taken first; restore_snapshot undoes it). Confirm with the user before using this on a map they worked on.')]
#[IsDestructive]
class RegenerateTerrain extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        return [
            'map' => $this->mapArgument($schema),
            'source' => $schema->string()->enum(['procedural', 'real_world'])->description('Defaults to the current source.'),
            'size' => $schema->number()->min(256)->max(32768),
            'resolution' => $schema->integer(),
            'center_lat' => $schema->number(),
            'center_lng' => $schema->number(),
            'height_scale' => $schema->number()->min(0.1)->max(5),
            'seed' => $schema->integer()->min(1)->max(999999),
            'discard_unsaved' => $schema->boolean()->description('Drop unsaved editor changes (ask the user first).'),
        ];
    }

    protected function run(Request $request): Response
    {
        $map = $this->map($request);
        $input = [
            'source' => $map->source->value,
            'size' => $map->size,
            'resolution' => $map->resolution,
            'center_lat' => $map->center_lat,
            'center_lng' => $map->center_lng,
            ...array_filter($request->all(), fn ($v) => $v !== null),
        ];
        unset($input['map'], $input['discard_unsaved']);
        $this->guardUnsaved($map, $request);
        $data = Validator::make($input, MapController::terrainRules($input['source'] === MapSource::RealWorld->value, requireName: false))->validate();

        $snapshot = $this->snapshots()->create($map, 'Before regenerate_terrain', auto: true);
        MapController::regenerateMap($map, $data);
        $this->bridge()->notify($map, 'reload');

        return $this->json([
            'terrain_status' => $map->refresh()->terrain_status->value,
            'snapshot_id' => $snapshot->id,
            'next' => 'Poll get_map until terrain_status is "ready".',
        ]);
    }
}
