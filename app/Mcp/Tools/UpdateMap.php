<?php

namespace App\Mcp\Tools;

use App\Models\Map;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\Validator;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;

#[Name('update_map')]
#[Description('Renames a map, changes its description, sets the player start (spawn: world x / z in metres and facing yaw in radians) or makes it the default map.')]
class UpdateMap extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        return [
            'map' => $this->mapArgument($schema),
            'name' => $schema->string(),
            'description' => $schema->string(),
            'spawn' => $schema->object([
                'x' => $schema->number()->required(),
                'z' => $schema->number()->required(),
                'yaw' => $schema->number(),
            ]),
            'make_default' => $schema->boolean(),
        ];
    }

    protected function run(Request $request): Response
    {
        $map = $this->map($request);
        $half = $map->size / 2;
        $data = Validator::make($request->all(), [
            'name' => ['sometimes', 'string', 'max:120'],
            'description' => ['sometimes', 'nullable', 'string', 'max:2000'],
            'spawn' => ['sometimes', 'array'],
            'spawn.x' => ['required_with:spawn', 'numeric', "between:-{$half},{$half}"],
            'spawn.z' => ['required_with:spawn', 'numeric', "between:-{$half},{$half}"],
            'spawn.yaw' => ['sometimes', 'numeric'],
            'make_default' => ['sometimes', 'boolean'],
        ])->validate();

        $this->snapshots()->autoBefore($map, 'update_map');
        $map->update(array_filter([
            'name' => $data['name'] ?? null,
            'description' => $data['description'] ?? null,
            'spawn_x' => $data['spawn']['x'] ?? null,
            'spawn_z' => $data['spawn']['z'] ?? null,
            'spawn_yaw' => $data['spawn']['yaw'] ?? null,
        ], fn ($v) => $v !== null));

        if ($data['make_default'] ?? false) {
            Map::query()->whereKeyNot($map->id)->update(['is_default' => false]);
            $map->update(['is_default' => true]);
        }

        $live = isset($data['spawn']) && $this->bridge()->notify($map, 'refresh', ['parts' => ['map']]);

        return $this->json(['updated' => $map->only('slug', 'name', 'description', 'spawn_x', 'spawn_z', 'spawn_yaw', 'is_default'), 'live' => $live]);
    }
}
