<?php

namespace Tests\Feature\Terrain;

use App\Services\Terrain\HeightGrid;
use App\Services\Terrain\MapProjection;
use App\Services\Terrain\OverpassWaterSource;
use App\Services\Terrain\TerrainStorage;
use App\Services\Terrain\WaterSurfaceBuilder;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class OverpassWaterSourceTest extends TestCase
{
    private MapProjection $projection;

    protected function setUp(): void
    {
        parent::setUp();

        // 65 × 65 grid, 32 m cells.
        $this->projection = new MapProjection(50.0, 8.0, 2048, 65);
    }

    /**
     * @param  list<array{0: float, 1: float}>  $gridPoints
     * @return list<array{lat: float, lon: float}>
     */
    private function geometry(array $gridPoints): array
    {
        return array_map(function (array $p) {
            [$lat, $lng] = $this->projection->toLatLng($p[0], $p[1]);

            return ['lat' => round($lat, 7), 'lon' => round($lng, 7)];
        }, $gridPoints);
    }

    /**
     * @return array<string, mixed>
     */
    private function fixture(): array
    {
        return [
            'version' => 0.6,
            'elements' => [
                // Closed-way lake.
                ['type' => 'way', 'id' => 1, 'tags' => ['natural' => 'water', 'water' => 'lake'],
                    'geometry' => $this->geometry([[8, 8], [20, 8], [20, 20], [8, 20], [8, 8]])],
                // Multipolygon reservoir: two outer ways that must be stitched (second reversed) plus a hole.
                ['type' => 'relation', 'id' => 2, 'tags' => ['type' => 'multipolygon', 'landuse' => 'reservoir'],
                    'members' => [
                        ['type' => 'way', 'ref' => 21, 'role' => 'outer', 'geometry' => $this->geometry([[36, 36], [56, 36], [56, 56]])],
                        ['type' => 'way', 'ref' => 22, 'role' => 'outer', 'geometry' => $this->geometry([[36, 36], [36, 56], [56, 56]])],
                        ['type' => 'way', 'ref' => 23, 'role' => 'inner', 'geometry' => $this->geometry([[43, 43], [49, 43], [49, 49], [43, 49], [43, 43]])],
                    ]],
                // River with an explicit width.
                ['type' => 'way', 'id' => 3, 'tags' => ['waterway' => 'river', 'width' => '70'],
                    'geometry' => $this->geometry([[0, 30], [30, 29], [64, 30]])],
                // Stream without width.
                ['type' => 'way', 'id' => 4, 'tags' => ['waterway' => 'stream'],
                    'geometry' => $this->geometry([[5, 60], [25, 60]])],
                // Wetland is not water.
                ['type' => 'way', 'id' => 5, 'tags' => ['natural' => 'wetland', 'water' => 'pond'],
                    'geometry' => $this->geometry([[50, 5], [60, 5], [60, 15], [50, 15], [50, 5]])],
            ],
        ];
    }

    public function test_parses_lakes_multipolygons_and_rivers(): void
    {
        Http::fake(['overpass-api.de/*' => Http::response($this->fixture())]);

        $features = app(OverpassWaterSource::class)->fetch($this->projection->bounds());

        $this->assertNull($features->warning);
        $this->assertCount(2, $features->polygons);
        $this->assertCount(2, $features->lines);

        $relation = $features->polygons[1];
        $this->assertCount(5, $relation['outer'], 'Two ways stitched into one closed ring.');
        $this->assertSame($relation['outer'][0], end($relation['outer']));
        $this->assertCount(1, $relation['inners']);

        $this->assertSame(70.0, $features->lines[0]['width']);
        $this->assertSame('stream', $features->lines[1]['kind']);
        $this->assertSame(3.0, $features->lines[1]['width']);

        Http::assertSent(function (Request $request) {
            return $request->method() === 'POST'
                && str_contains($request['data'], 'out geom;')
                && str_contains($request['data'], 'waterway"~"^(river|stream|canal|drain|ditch)$"');
        });
    }

    public function test_water_features_are_rasterized_and_carved(): void
    {
        Http::fake(['overpass-api.de/*' => Http::response($this->fixture())]);

        $features = app(OverpassWaterSource::class)->fetch($this->projection->bounds());
        $grid = $features->toGrid($this->projection);

        $terrain = new HeightGrid(65);
        foreach ($terrain->data as $i => $_) {
            $terrain->data[$i] = 100 + 0.1 * sin($i);
        }

        $result = (new WaterSurfaceBuilder)->build($terrain, 2048, $grid['polygons'], $grid['lines']);
        $water = $result->water;

        // Lake cells are water, with a flat surface and carved bed.
        $lake = [];
        for ($row = 9; $row <= 19; $row++) {
            for ($col = 9; $col <= 19; $col++) {
                $this->assertNotSame(TerrainStorage::NO_WATER, $water->get($col, $row));
                $this->assertLessThan($water->get($col, $row) - 0.5, $result->terrain->get($col, $row));
                $lake[] = $water->get($col, $row);
            }
        }
        $this->assertLessThan(0.3, max($lake) - min($lake));
        $this->assertLessThan($water->get(14, 14) - 7.9, $result->terrain->get(14, 14), 'Lake centre reaches 8 m depth.');

        // Stitched relation with its hole; river; dry land; ignored wetland.
        $this->assertNotSame(TerrainStorage::NO_WATER, $water->get(40, 40));
        $this->assertSame(TerrainStorage::NO_WATER, $water->get(46, 46));
        $this->assertNotSame(TerrainStorage::NO_WATER, $water->get(50, 30));
        $this->assertSame(TerrainStorage::NO_WATER, $water->get(50, 25));
        $this->assertSame(TerrainStorage::NO_WATER, $water->get(55, 10));
        $this->assertGreaterThanOrEqual($water->get(50, 30) - 2.5001, $result->terrain->get(50, 30));
    }

    public function test_http_failure_returns_no_water_and_a_warning(): void
    {
        Http::fake(['*' => Http::response('Too busy', 500)]);

        $features = app(OverpassWaterSource::class)->fetch($this->projection->bounds());

        $this->assertTrue($features->isEmpty());
        $this->assertStringContainsString('500', (string) $features->warning);
    }

    public function test_stitches_ways_in_any_order_and_direction(): void
    {
        $source = new OverpassWaterSource;

        $rings = $source->stitch([
            [[0.0, 1.0], [1.0, 1.0]],
            [[0.0, 0.0], [1.0, 0.0]],
            [[1.0, 1.0], [1.0, 0.0]],
            [[0.0, 0.0], [0.0, 1.0]],
            [[5.0, 5.0], [6.0, 6.0]], // dangling way cannot be closed
        ]);

        $this->assertCount(1, $rings);
        $this->assertCount(5, $rings[0]);
        $this->assertSame($rings[0][0], $rings[0][4]);
    }
}
