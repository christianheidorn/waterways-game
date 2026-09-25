<?php

namespace Tests\Feature\Terrain;

use App\Services\Terrain\HeightGrid;
use App\Services\Terrain\MapProjection;
use App\Services\Terrain\OverpassWaterSource;
use App\Services\Terrain\TerrainStorage;
use App\Services\Terrain\WaterSurfaceBuilder;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Sleep;
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
        $this->assertLessThan($water->get(14, 14) - 5.9, $result->terrain->get(14, 14), 'Lake centre reaches the default 6 m depth.');

        // Stitched relation with its hole; river; dry land; ignored wetland.
        $this->assertNotSame(TerrainStorage::NO_WATER, $water->get(40, 40));
        $this->assertSame(TerrainStorage::NO_WATER, $water->get(46, 46));
        $this->assertNotSame(TerrainStorage::NO_WATER, $water->get(50, 30));
        $this->assertSame(TerrainStorage::NO_WATER, $water->get(50, 25));
        $this->assertSame(TerrainStorage::NO_WATER, $water->get(55, 10));
        $this->assertGreaterThanOrEqual($water->get(50, 30) - 2.0001, $result->terrain->get(50, 30));
    }

    public function test_http_failure_on_every_endpoint_returns_no_water_and_a_warning(): void
    {
        Sleep::fake();
        Http::fake(['*' => Http::response('Too busy', 500)]);

        $features = app(OverpassWaterSource::class)->fetch($this->projection->bounds());

        $this->assertTrue($features->isEmpty());
        $this->assertStringContainsString('all Overpass servers failed', (string) $features->warning);
        $this->assertStringContainsString('overpass.kumi.systems: HTTP 500', (string) $features->warning);
        Http::assertSentCount(2 * count(OverpassWaterSource::DEFAULT_URLS));
        Sleep::assertSleptTimes(1);
    }

    public function test_falls_back_to_the_next_endpoint(): void
    {
        Http::fake([
            'overpass-api.de/*' => Http::response('Gateway timeout', 504),
            'overpass.kumi.systems/*' => Http::response($this->fixture()),
            '*' => Http::response('unexpected', 500),
        ]);

        $features = app(OverpassWaterSource::class)->fetch($this->projection->bounds());

        $this->assertNull($features->warning);
        $this->assertCount(2, $features->polygons);
        $recorded = Http::recorded()->map(fn (array $pair) => parse_url($pair[0]->url(), PHP_URL_HOST))->all();
        $this->assertSame(['overpass-api.de', 'overpass.kumi.systems'], $recorded);
    }

    public function test_endpoints_are_configurable_and_the_legacy_url_is_tried_first(): void
    {
        config([
            'services.overpass.url' => 'https://legacy.example.test/api/interpreter',
            'services.overpass.urls' => ['https://a.example.test/api/interpreter', 'https://b.example.test/api/interpreter'],
        ]);

        $this->assertSame([
            'https://legacy.example.test/api/interpreter',
            'https://a.example.test/api/interpreter',
            'https://b.example.test/api/interpreter',
        ], OverpassWaterSource::endpoints());

        config(['services.overpass.url' => null, 'services.overpass.urls' => []]);
        $this->assertSame(OverpassWaterSource::DEFAULT_URLS, OverpassWaterSource::endpoints());
    }

    public function test_query_selects_areas_lines_and_coastline_with_full_geometry(): void
    {
        $query = (new OverpassWaterSource)->query($this->projection->bounds());

        $this->assertStringStartsWith('[out:json][timeout:90];', $query);
        $this->assertStringEndsWith('out geom;', $query);
        foreach ([
            'relation["natural"="water"]',
            'way["waterway"~"^(riverbank|dock)$"]',
            'relation["landuse"~"^(reservoir|basin)$"]',
            'way["waterway"~"^(river|stream|canal|drain|ditch)$"]',
            'way["natural"="coastline"]',
        ] as $clause) {
            $this->assertStringContainsString($clause, $query);
        }
    }

    public function test_relation_ring_closed_by_stitching_ways_that_leave_the_map(): void
    {
        // Outer ring of a lake split into three untagged member ways (tags on the relation only),
        // listed out of order, one reversed and one running far north of the map.
        $relation = ['type' => 'relation', 'id' => 7, 'tags' => ['type' => 'multipolygon', 'natural' => 'water'],
            'members' => [
                ['type' => 'way', 'ref' => 71, 'role' => 'outer', 'geometry' => $this->geometry([[40, 20], [40, -30], [10, -30]])],
                ['type' => 'way', 'ref' => 72, 'role' => 'outer', 'geometry' => $this->geometry([[10, 20], [25, 24], [40, 20]])],
                ['type' => 'way', 'ref' => 73, 'role' => 'outer', 'geometry' => $this->geometry([[10, 20], [10, -30]])],
                ['type' => 'way', 'ref' => 74, 'role' => 'inner', 'geometry' => $this->geometry([[20, 5], [30, 5], [30, 12]])],
            ]];
        // A member way is also returned on its own (tagged): it must not become a bogus polygon.
        $memberWay = ['type' => 'way', 'id' => 72, 'tags' => ['natural' => 'water'], 'geometry' => $relation['members'][1]['geometry']];

        $features = (new OverpassWaterSource)->parse([$relation, $memberWay]);

        $this->assertCount(1, $features->polygons);
        $polygon = $features->polygons[0];
        $this->assertSame('lake', $polygon['kind']);
        $this->assertSame($polygon['outer'][0], end($polygon['outer']));
        $this->assertCount(1, $polygon['inners'], 'Open inner way is closed rather than dropped.');

        $grid = $features->toGrid($this->projection);
        $result = (new WaterSurfaceBuilder)->build(HeightGrid::filled(65, 30.0), 2048, $grid['polygons']);

        $this->assertNotSame(TerrainStorage::NO_WATER, $result->water->get(25, 0), 'Lake reaches the map edge.');
        $this->assertNotSame(TerrainStorage::NO_WATER, $result->water->get(15, 18));
        $this->assertSame(TerrainStorage::NO_WATER, $result->water->get(25, 8), 'Inner ring is a hole.');
        $this->assertSame(TerrainStorage::NO_WATER, $result->water->get(45, 10));
    }

    public function test_river_areas_follow_the_river_line_and_summary_counts_features(): void
    {
        $features = (new OverpassWaterSource)->parse([
            ['type' => 'way', 'id' => 1, 'tags' => ['natural' => 'water', 'water' => 'river'],
                'geometry' => $this->geometry([[0, 28], [64, 28], [64, 36], [0, 36], [0, 28]])],
            ['type' => 'way', 'id' => 2, 'tags' => ['waterway' => 'river'], 'geometry' => $this->geometry([[0, 32], [64, 32]])],
            ['type' => 'way', 'id' => 3, 'tags' => ['natural' => 'water'], 'geometry' => $this->geometry([[5, 5], [9, 5], [9, 9], [5, 5]])],
            ['type' => 'way', 'id' => 4, 'tags' => ['natural' => 'coastline'], 'geometry' => $this->geometry([[0, 60], [64, 60]])],
        ]);

        $this->assertSame('river', $features->polygons[0]['kind']);
        $this->assertSame('1 lake, 1 river area, 1 rivers/streams, coastline', $features->summary());

        $terrain = new HeightGrid(65);
        for ($row = 0; $row < 65; $row++) {
            for ($col = 0; $col < 65; $col++) {
                $terrain->set($col, $row, 60 - 0.5 * $col + 0.2 * abs($row - 32));
            }
        }
        $grid = $features->toGrid($this->projection);
        $result = (new WaterSurfaceBuilder)->build($terrain, 2048, $grid['polygons'], $grid['lines']);

        // The river area slopes with its river instead of forming one flat (flooding) level.
        $this->assertGreaterThan($result->water->get(60, 29) + 20, $result->water->get(4, 29));
        $this->assertLessThanOrEqual($terrain->get(4, 29), $result->water->get(4, 29));
    }

    public function test_stitches_ways_in_any_order_and_direction(): void
    {
        $source = new OverpassWaterSource;

        $rings = $source->stitch([
            [[0.0, 1.0], [1.0, 1.0]],
            [[0.0, 0.0], [1.0, 0.0]],
            [[1.0, 1.0], [1.0, 0.0]],
            [[0.0, 0.0], [0.0, 1.0]],
            [[5.0, 5.0], [6.0, 6.0]], // dangling 2-point way cannot form a ring
        ]);

        $this->assertCount(1, $rings);
        $this->assertCount(5, $rings[0]);
        $this->assertSame($rings[0][0], $rings[0][4]);
    }

    public function test_chains_that_stay_open_are_closed_and_heads_are_extended(): void
    {
        $source = new OverpassWaterSource;

        // Second way attaches to the head of the first; nothing closes the chain.
        $rings = $source->stitch([
            [[1.0, 0.0], [1.0, 1.0]],
            [[0.0, 0.0], [1.0, 0.0]],
            [[0.0, 1.0], [0.5, 1.5]], // stray 2-point piece is dropped
        ]);

        $this->assertCount(1, $rings);
        $this->assertSame([[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 0.0]], $rings[0]);
    }
}
