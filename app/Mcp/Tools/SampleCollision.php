<?php

namespace App\Mcp\Tools;

use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\Validator;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[Name('sample_collision')]
#[Description(<<<'TXT'
Live: what blocks the player in the open editor, from the colliders of placed foliage, ground cover and props (as they are now, unsaved edits included). Either `points` (a capsule standing at each: the ground it stands on — terrain, or a rock / prop top it stepped onto — and the colliders it overlaps), or a straight walk `from` → `to` (the capsule moves in steps of half its radius, stepping up ledges up to `step` m like the player; every collider it runs into is listed once with where along the path it was first hit, and `first_blocked`). The capsule is the player's (radius from the character height, 0.4 m step) unless `radius`, `height` or `step` are given. Blockers name their source (foliage, ground_cover, prop), foliage type or prop model / prop id, collision mode and position. Use it to check that paths, doorways and bridges are walkable, or that a forest isn't too dense to pass.
TXT)]
#[IsReadOnly]
class SampleCollision extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        $point = fn () => $schema->object(['x' => $schema->number()->required(), 'z' => $schema->number()->required()]);

        return [
            'map' => $this->mapArgument($schema),
            'points' => $schema->array()->items($point())->description('Points to test (up to 400).'),
            'from' => $point()->description('Or: start of a straight walk.'),
            'to' => $point()->description('End of the walk.'),
            'radius' => $schema->number()->min(0.05)->max(5)->description('Capsule radius (m); default the player\'s.'),
            'height' => $schema->number()->min(0.2)->max(20)->description('Capsule height (m); default the character height.'),
            'step' => $schema->number()->min(0)->max(2)->description('Highest ledge stepped onto (m, default 0.4).'),
        ];
    }

    protected function run(Request $request): Response
    {
        $data = Validator::make($request->all(), [
            'points' => ['required_without_all:from,to', 'array', 'min:1', 'max:400'],
            'points.*.x' => ['required', 'numeric'],
            'points.*.z' => ['required', 'numeric'],
            'from' => ['required_without:points', 'array'],
            'from.x' => ['required_with:from', 'numeric'],
            'from.z' => ['required_with:from', 'numeric'],
            'to' => ['required_without:points', 'array'],
            'to.x' => ['required_with:to', 'numeric'],
            'to.z' => ['required_with:to', 'numeric'],
            'radius' => ['sometimes', 'numeric', 'between:0.05,5'],
            'height' => ['sometimes', 'numeric', 'between:0.2,20'],
            'step' => ['sometimes', 'numeric', 'between:0,2'],
        ])->validate();

        $map = $this->map($request);
        $point = fn (array $p) => ['x' => (float) $p['x'], 'z' => (float) $p['z']];
        $payload = array_filter([
            'points' => isset($data['points']) ? array_map($point, $data['points']) : null,
            'from' => isset($data['points']) ? null : $point($data['from']),
            'to' => isset($data['points']) ? null : $point($data['to']),
            'radius' => $data['radius'] ?? null,
            'height' => $data['height'] ?? null,
            'step' => $data['step'] ?? null,
        ], fn ($v) => $v !== null);

        return $this->json(['map' => $map->slug, ...$this->bridge()->run($map, 'sample_collision', $payload)]);
    }
}
