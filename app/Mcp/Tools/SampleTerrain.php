<?php

namespace App\Mcp\Tools;

use App\Mcp\TerrainData;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\Validator;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[Name('sample_terrain')]
#[Description('Exact terrain values at world points, or at even steps along a path (a height profile): ground height (m), slope (degrees), water surface (m or null) and the painted layers there. Use it to pick lake levels, check that a river path runs downhill, or find flat building ground. Reads the SAVED map; works without an open editor.')]
#[IsReadOnly]
class SampleTerrain extends WaterwaysTool
{
    /** Most samples returned by one call. */
    private const MAX_SAMPLES = 400;

    public function schema(JsonSchema $schema): array
    {
        $point = fn () => $schema->object(['x' => $schema->number()->required(), 'z' => $schema->number()->required()]);

        return [
            'map' => $this->mapArgument($schema),
            'points' => $schema->array()->items($point())->description('Points to sample.'),
            'path' => $schema->array()->items($point())->description('Or: a polyline sampled every `spacing` metres.'),
            'spacing' => $schema->number()->min(1)->description('path: metres between samples (default 25).'),
        ];
    }

    protected function run(Request $request): Response
    {
        $data = Validator::make($request->all(), [
            'points' => ['required_without:path', 'array', 'max:'.self::MAX_SAMPLES],
            'points.*.x' => ['required', 'numeric'],
            'points.*.z' => ['required', 'numeric'],
            'path' => ['required_without:points', 'array', 'min:2', 'max:500'],
            'path.*.x' => ['required', 'numeric'],
            'path.*.z' => ['required', 'numeric'],
            'spacing' => ['sometimes', 'numeric', 'min:1'],
        ])->validate();

        $map = $this->map($request);
        $t = TerrainData::load($map);
        $names = $map->layers()->pluck('name', 'slot');
        $points = isset($data['path'])
            ? $this->along($data['path'], (float) ($data['spacing'] ?? 25))
            : array_map(fn ($p) => ['x' => (float) $p['x'], 'z' => (float) $p['z']], $data['points']);

        if (count($points) > self::MAX_SAMPLES) {
            return Response::error('Too many samples ('.count($points).'); use a larger spacing (at most '.self::MAX_SAMPLES.' samples).');
        }

        $samples = array_map(function (array $p) use ($t, $names) {
            if (! $t->contains($p['x'], $p['z'])) {
                return [...$p, 'outside_map' => true];
            }

            [$gx, $gz] = $t->toGrid($p['x'], $p['z']);
            $col = (int) round($gx);
            $row = (int) round($gz);
            $weights = $t->weightsAt($col, $row);
            arsort($weights);
            $layers = [];

            foreach ($weights as $slot => $w) {
                if ($w > 12) {
                    $layers[$names[$slot] ?? "slot {$slot}"] = round($w / 2.55).'%';
                }
            }

            return [
                ...(isset($p['distance']) ? ['distance_m' => $p['distance']] : []),
                'x' => round($p['x'], 1),
                'z' => round($p['z'], 1),
                'height' => round($t->height($p['x'], $p['z']), 2),
                'slope_deg' => round($t->slopeAt($col, $row), 1),
                'water_level' => ($w = $t->waterAt($col, $row)) !== null ? round($w, 2) : null,
                'layers' => $layers,
            ];
        }, $points);

        $unsaved = $this->bridge()->session($map)?->state['unsaved'] ?? [];

        return $this->json([
            'map' => $map->slug,
            'samples' => $samples,
            'warning' => $unsaved ? 'The open editor has unsaved changes ('.implode(', ', $unsaved).') not reflected here.' : null,
        ]);
    }

    /**
     * Points every `spacing` metres along a polyline, with their distance from the start.
     *
     * @param  list<array{x: float|int|string, z: float|int|string}>  $path
     * @return list<array{x: float, z: float, distance: float}>
     */
    private function along(array $path, float $spacing): array
    {
        $out = [];
        $walked = 0.0;
        $next = 0.0;

        for ($k = 0; $k + 1 < count($path); $k++) {
            $ax = (float) $path[$k]['x'];
            $az = (float) $path[$k]['z'];
            $bx = (float) $path[$k + 1]['x'];
            $bz = (float) $path[$k + 1]['z'];
            $len = hypot($bx - $ax, $bz - $az);

            while ($next <= $walked + $len + 1e-6 && count($out) <= self::MAX_SAMPLES) {
                $f = $len > 0 ? ($next - $walked) / $len : 0;
                $out[] = ['x' => $ax + ($bx - $ax) * $f, 'z' => $az + ($bz - $az) * $f, 'distance' => round($next, 1)];
                $next += $spacing;
            }

            $walked += $len;
        }

        return $out;
    }
}
