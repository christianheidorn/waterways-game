<?php

namespace Tests\Feature\Terrain;

use App\Enums\MapSource;
use App\Enums\TerrainStatus;
use App\Jobs\GenerateMapTerrain;
use App\Models\Map;
use App\Services\Terrain\HeightGrid;
use App\Services\Terrain\MapProjection;
use App\Services\Terrain\TerrainGenerator;
use App\Services\Terrain\TerrainStorage;
use App\Services\Terrain\TerrariumElevationSource;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Sleep;
use RuntimeException;
use Tests\TestCase;

class GenerateMapTerrainTest extends TestCase
{
    use RefreshDatabase;

    private TerrainStorage $storage;

    protected function setUp(): void
    {
        parent::setUp();

        Storage::fake('local');
        $this->storage = app(TerrainStorage::class);
    }

    /**
     * @param  array<string, mixed>  $attributes
     */
    private function makeMap(array $attributes = []): Map
    {
        return Map::create(array_merge([
            'name' => 'Test map',
            'slug' => 'test-map-'.uniqid(),
            'source' => MapSource::Procedural,
            'resolution' => 65,
            'size' => 2048,
            'seed' => 1337,
            'height_scale' => 1,
            'import_water' => true,
            'terrain_status' => TerrainStatus::Queued,
            'revision' => 3,
        ], $attributes));
    }

    public function test_procedural_map_end_to_end(): void
    {
        $map = $this->makeMap();
        $this->storage->disk()->put($this->storage->path($map, 'splatmap'), 'stale');
        $this->storage->disk()->put($this->storage->path($map, 'foliage'), '{}');

        GenerateMapTerrain::dispatch($map);

        $map->refresh();
        $this->assertSame(TerrainStatus::Ready, $map->terrain_status);
        $this->assertSame(100, $map->terrain_progress);
        $this->assertNull($map->terrain_message);
        $this->assertSame(4, $map->revision);
        $this->assertNotNull($map->terrain_generated_at);
        $this->assertGreaterThan($map->min_height + 50, $map->max_height);
        $this->assertCount(8, $map->layers);

        $this->assertSame(65 * 65 * 4, strlen((string) $this->storage->read($map, 'heightmap')));
        $this->assertSame(65 * 65 * 4, strlen((string) $this->storage->read($map, 'water')));
        $this->assertFalse($this->storage->exists($map, 'splatmap'));
        $this->assertFalse($this->storage->exists($map, 'foliage'));

        [$min, $max] = TerrainStorage::range((string) $this->storage->read($map, 'heightmap'));
        $this->assertEqualsWithDelta($map->min_height, $min, 0.01);
        $this->assertEqualsWithDelta($map->max_height, $max, 0.01);
    }

    public function test_flat_map_has_no_water_and_keeps_existing_layers(): void
    {
        $map = $this->makeMap(['source' => MapSource::Flat]);
        $map->layers()->create([
            'slot' => 0, 'name' => 'Custom', 'color' => '#000000', 'color_secondary' => '#111111',
        ]);
        $this->storage->disk()->put($this->storage->path($map, 'water'), 'stale');

        $progress = [];
        app(TerrainGenerator::class)->generate($map, function (int $percent, string $message) use (&$progress) {
            $progress[] = $percent;
        });

        $map->refresh();
        $this->assertSame(10.0, $map->min_height);
        $this->assertSame(10.0, $map->max_height);
        $this->assertFalse($this->storage->exists($map, 'water'));
        $this->assertCount(1, $map->layers);
        $this->assertSame(100, end($progress));
        $this->assertSame($progress, collect($progress)->sort()->values()->all(), 'Progress is monotonic.');
    }

    public function test_real_world_map_detects_ocean_and_survives_missing_water_data(): void
    {
        // West of the map centre is sea (-15 m), east is land (+30 m).
        $centreLng = 8.0;
        $zoom = TerrariumElevationSource::chooseZoom(
            (new MapProjection(50.0, $centreLng, 2048, 65))->bounds(), 2048 / 64,
        );
        $coast = TerrariumElevationSource::lngToPixelX($centreLng, $zoom);
        Sleep::fake();
        Http::fake(['*/api/interpreter' => Http::response('Gateway timeout', 504)]);
        TerrariumElevationSourceTest::fakeTiles(fn (int $gx) => $gx < $coast ? -15.0 : 30.0);

        $map = $this->makeMap([
            'source' => MapSource::RealWorld,
            'center_lat' => 50.0,
            'center_lng' => $centreLng,
            'size' => 2048,
            'resolution' => 65,
            'height_scale' => 2,
            'environment' => ['time_of_day' => 9],
        ]);

        GenerateMapTerrain::dispatch($map);

        $map->refresh();
        $this->assertSame(TerrainStatus::Ready, $map->terrain_status);
        $this->assertStringStartsWith('Water data unavailable:', (string) $map->terrain_message);
        $this->assertStringEndsWith('Ocean detected from elevation data.', (string) $map->terrain_message);
        $this->assertLessThanOrEqual(250, strlen((string) $map->terrain_message));
        $this->assertTrue($map->environment['ocean_enabled']);
        $this->assertSame(9, $map->environment['time_of_day']);
        $this->assertEqualsWithDelta(60.0, $map->max_height, 0.05, 'Heights are multiplied by height_scale.');
        $this->assertEqualsWithDelta(-30.0, $map->min_height, 0.05);

        $water = HeightGrid::fromBinary(65, (string) $this->storage->read($map, 'water'));
        $this->assertSame(0.0, $water->get(2, 32));
        $this->assertSame(TerrainStorage::NO_WATER, $water->get(62, 32));
    }

    public function test_real_world_map_imports_water_with_the_map_settings(): void
    {
        $projection = new MapProjection(50.0, 8.0, 2048, 65);
        $geometry = fn (array $points) => array_map(function (array $p) use ($projection) {
            [$lat, $lng] = $projection->toLatLng($p[0], $p[1]);

            return ['lat' => $lat, 'lon' => $lng];
        }, $points);

        TerrariumElevationSourceTest::fakeTiles(fn () => 200.0);
        Http::fake(['*/api/interpreter' => Http::response(['elements' => [
            ['type' => 'way', 'id' => 1, 'tags' => ['natural' => 'water'],
                'geometry' => $geometry([[10, 10], [40, 10], [40, 40], [10, 40], [10, 10]])],
            ['type' => 'way', 'id' => 2, 'tags' => ['waterway' => 'stream'], 'geometry' => $geometry([[45, 0], [50, 64]])],
        ]])]);

        $map = $this->makeMap([
            'source' => MapSource::RealWorld,
            'center_lat' => 50.0,
            'center_lng' => 8.0,
            'lake_depth' => 12,
            'river_depth' => 1,
            'shore_angle' => 60,
        ]);

        GenerateMapTerrain::dispatch($map);

        $map->refresh();
        $this->assertSame(TerrainStatus::Ready, $map->terrain_status);
        $this->assertSame('Imported 1 lake, 1 rivers/streams.', $map->terrain_message);

        $terrain = HeightGrid::fromBinary(65, (string) $this->storage->read($map, 'heightmap'));
        $water = HeightGrid::fromBinary(65, (string) $this->storage->read($map, 'water'));
        $this->assertEqualsWithDelta(200.0, $water->get(25, 25), 0.01);
        $this->assertEqualsWithDelta(188.0, $terrain->get(25, 25), 0.01, 'Lake depth comes from the map.');
        $this->assertEqualsWithDelta(199.0, $terrain->get(48, 32) + ($water->get(48, 32) - 200.0), 0.05, 'Stream depth comes from the map.');
        $this->assertEqualsWithDelta(188.0, $map->min_height, 0.01);
    }

    public function test_failure_marks_the_map_as_failed(): void
    {
        Http::fake(['*' => Http::response('unavailable', 503)]);

        $map = $this->makeMap([
            'source' => MapSource::RealWorld,
            'center_lat' => 50.0,
            'center_lng' => 8.0,
        ]);

        try {
            GenerateMapTerrain::dispatch($map);
            $this->fail('Expected the job to throw.');
        } catch (RuntimeException $e) {
            $this->assertStringContainsString('elevation tile', $e->getMessage());
        }

        $map->refresh();
        $this->assertSame(TerrainStatus::Failed, $map->terrain_status);
        $this->assertStringStartsWith('Terrain generation failed:', (string) $map->terrain_message);
        $this->assertSame(3, $map->revision);
    }
}
