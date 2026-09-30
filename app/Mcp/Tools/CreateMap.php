<?php

namespace App\Mcp\Tools;

use App\Enums\MapSource;
use App\Http\Controllers\MapController;
use App\Models\Map;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\Validator;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;

#[Name('create_map')]
#[Description('Creates a new map and queues its terrain generation: "procedural" (noise terrain from a seed) or "real_world" (elevation, rivers and lakes of the area around center_lat / center_lng). Default layers and biomes are set up automatically. Generation runs in the background: poll get_map until terrain_status is "ready".')]
class CreateMap extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        return [
            'name' => $schema->string()->required(),
            'description' => $schema->string(),
            'source' => $schema->string()->enum(['procedural', 'real_world'])->required(),
            'size' => $schema->number()->min(256)->max(32768)->description('Edge length in metres (e.g. 2048 or 4096).')->required(),
            'resolution' => $schema->integer()->enum(Map::RESOLUTIONS)->description('Height samples per edge; higher = finer terrain (1025 is a good default).')->required(),
            'center_lat' => $schema->number()->description('real_world only.'),
            'center_lng' => $schema->number()->description('real_world only.'),
            'height_scale' => $schema->number()->min(0.1)->max(5)->description('Vertical exaggeration (1 = real).'),
            'import_water' => $schema->boolean()->description('real_world: import rivers and lakes (default true).'),
            'seed' => $schema->integer()->min(1)->max(999999)->description('procedural: terrain seed (random when omitted).'),
        ];
    }

    protected function run(Request $request): Response
    {
        $input = $request->all();
        $realWorld = ($input['source'] ?? null) === MapSource::RealWorld->value;
        $data = Validator::make($input, MapController::terrainRules($realWorld, requireName: true))->validate();
        $map = MapController::createMap($data);

        return $this->json([
            'created' => ['id' => $map->id, 'slug' => $map->slug, 'name' => $map->name],
            'terrain_status' => $map->refresh()->terrain_status->value,
            'next' => 'Poll get_map until terrain_status is "ready", then ask the user to open it in the editor for live work and screenshots.',
        ]);
    }
}
