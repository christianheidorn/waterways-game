<?php

namespace App\Mcp\Tools;

use App\Models\PropModel;
use App\Services\Terrain\TerrainStorage;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\Validator;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[Name('list_props')]
#[IsReadOnly]
#[Description('Lists the props placed on a map (as saved): id, model, position (x, z), rotation in degrees and scale, with a count per model. Optionally only those within `radius` metres of (x, z).')]
class ListProps extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        return [
            'map' => $this->mapArgument($schema),
            'x' => $schema->number(),
            'z' => $schema->number(),
            'radius' => $schema->number()->min(0)->description('With x and z: only props this close (m).'),
        ];
    }

    protected function run(Request $request): Response
    {
        $data = Validator::make($request->all(), [
            'x' => ['required_with:radius', 'numeric'],
            'z' => ['required_with:radius', 'numeric'],
            'radius' => ['sometimes', 'numeric', 'min:0'],
        ])->validate();
        $map = $this->map($request);
        $raw = app(TerrainStorage::class)->read($map, 'props');
        $file = $raw ? json_decode($raw, true) : null;
        $props = collect($file['props'] ?? []);

        if (isset($data['radius'])) {
            $props = $props->filter(fn (array $p) => hypot($p['x'] - $data['x'], $p['z'] - $data['z']) <= $data['radius']);
        }

        $names = PropModel::query()->whereIn('id', $props->pluck('model')->unique())->pluck('name', 'id');

        return $this->json([
            'map' => $map->slug,
            'count' => $props->count(),
            'per_model' => $props->countBy('model')->mapWithKeys(fn ($n, $id) => [($names[$id] ?? "#{$id}")." ({$id})" => $n]),
            'props' => $props->take(500)->map(fn (array $p) => [
                'id' => $p['id'],
                'model' => $p['model'],
                'name' => $names[$p['model']] ?? null,
                'x' => round($p['x'], 1),
                'z' => round($p['z'], 1),
                'rotation' => round(rad2deg($p['yaw'] ?? 0), 1),
                'scale' => $p['scale'] ?? 1,
            ])->values(),
            'note' => $props->count() > 500 ? 'Only the first 500 are listed; narrow with x, z and radius.' : null,
        ]);
    }
}
