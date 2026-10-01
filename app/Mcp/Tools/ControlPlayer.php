<?php

namespace App\Mcp\Tools;

use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;

#[Name('control_player')]
#[Description('Play mode, live in the open editor: the player character as the user plays it (switches to play mode at the player start when needed; control_editor set_mode edit goes back). action: "state" (position, facing, camera, swimming, and water: wading, water_depth_m at the feet, wet 0-1 and wet_line_m, the height above the feet up to which the clothes are soaked); "teleport" to x, z (facing in degrees, 0 = north / −z, 90 = west); "look" turns the camera (yaw / pitch in degrees, or towards look_at); "walk_to" walks (run: true runs) to x, z with the real movement (slopes, water, collision; wading slows down with depth, footsteps make ripples and spray) and reports reached / stuck / timeout; "jump"; "splash" previews the water reacting to an impact at x, z (default 2 m ahead of the character; works in edit mode too): spray and droplets, a foam ring and ripples spreading and reflecting off the shore — strength 0-2 (1 ≈ a person jumping in), size = footprint in m. Use take_screenshot (view "current") to see what the player sees.')]
class ControlPlayer extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        return [
            'map' => $this->mapArgument($schema),
            'action' => $schema->string()->enum(['state', 'teleport', 'look', 'walk_to', 'jump', 'splash'])->required(),
            'x' => $schema->number()->description('teleport / walk_to / splash: world x in metres.'),
            'z' => $schema->number()->description('teleport / walk_to / splash: world z in metres.'),
            'facing' => $schema->number()->description('teleport: facing in degrees (0 = north / −z).'),
            'yaw' => $schema->number()->description('look: camera heading in degrees (0 = north / −z).'),
            'pitch' => $schema->number()->min(-75)->max(45)->description('look: camera pitch in degrees (negative looks down).'),
            'look_at' => $schema->object([
                'x' => $schema->number()->required(),
                'z' => $schema->number()->required(),
            ])->description('look: turn towards this point.'),
            'run' => $schema->boolean()->description('walk_to: run instead of walking.'),
            'tolerance' => $schema->number()->min(0.3)->max(20)->description('walk_to: arrival distance in m (default 1).'),
            'timeout' => $schema->integer()->min(1)->max(60)->description('walk_to: give up after this many seconds (default 30).'),
            'strength' => $schema->number()->min(0)->max(2)->description('splash: impact strength (default 1 ≈ a person jumping in; 0.2 a stone).'),
            'size' => $schema->number()->min(0.05)->max(5)->description('splash: footprint of what hits the water in m (default 0.6).'),
        ];
    }

    protected function run(Request $request): Response
    {
        $data = $request->validate([
            'action' => ['required', 'in:state,teleport,look,walk_to,jump,splash'],
            'x' => ['required_if:action,teleport,walk_to', 'numeric'],
            'z' => ['required_if:action,teleport,walk_to', 'numeric'],
            'facing' => ['sometimes', 'numeric'],
            'yaw' => ['sometimes', 'numeric'],
            'pitch' => ['sometimes', 'numeric', 'between:-75,45'],
            'look_at' => ['sometimes', 'array'],
            'look_at.x' => ['required_with:look_at', 'numeric'],
            'look_at.z' => ['required_with:look_at', 'numeric'],
            'run' => ['sometimes', 'boolean'],
            'tolerance' => ['sometimes', 'numeric', 'between:0.3,20'],
            'timeout' => ['sometimes', 'integer', 'between:1,60'],
            'strength' => ['sometimes', 'numeric', 'between:0,2'],
            'size' => ['sometimes', 'numeric', 'between:0.05,5'],
        ]);
        $map = $this->map($request);
        $payload = array_map(fn ($v) => is_int($v) ? (float) $v : $v, $data);
        $result = $this->bridge()->run($map, 'player', $payload, timeout: (int) ($data['timeout'] ?? 30) + 20);

        return $this->json(['map' => $map->slug, 'action' => $data['action'], ...$result]);
    }
}
