<?php

namespace Tests\Feature\LandCover;

use App\Enums\MapSource;
use App\Enums\TerrainStatus;
use App\Jobs\GenerateMapTerrain;
use App\Models\Map;
use App\Services\LandCover\LandCoverGrid;
use App\Services\Terrain\TerrainGenerator;
use App\Services\Terrain\TerrainStorage;
use App\Support\DefaultTerrainLayers;
use App\Support\GameManifest;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Sleep;
use Inertia\Testing\AssertableInertia as Assert;
use Tests\Feature\Terrain\TerrariumElevationSourceTest;
use Tests\TestCase;

class LandCoverPipelineTest extends TestCase
{
    use RefreshDatabase;

    private TerrainStorage $storage;

    protected function setUp(): void
    {
        parent::setUp();

        Storage::fake('local');
        Sleep::fake();
        $this->storage = app(TerrainStorage::class);
    }

    /** West of 9.0°E forest, east grassland. */
    private function serveWorldCover(?int $failWith = null): void
    {
        $classAt = fn (float $lat, float $lng) => $lng < 9.0 ? 10 : 30;
        FakeWorldCover::serve([
            'N48E006' => FakeWorldCover::file(48, 6, $classAt),
            'N48E009' => FakeWorldCover::file(48, 9, $classAt),
        ], $failWith);
    }

    /**
     * @param  array<string, mixed>  $attributes
     */
    private function realWorldMap(array $attributes = []): Map
    {
        return Map::create([
            'name' => 'Land cover',
            'slug' => 'land-cover-'.uniqid(),
            'source' => MapSource::RealWorld,
            'center_lat' => 49.5,
            'center_lng' => 9.0,
            'resolution' => 65,
            'size' => 16384,
            'seed' => 5,
            'height_scale' => 1,
            'import_water' => true,
            'terrain_status' => TerrainStatus::Queued,
            'revision' => 1,
            ...$attributes,
        ]);
    }

    private function fakeTerrainAndWater(): void
    {
        TerrariumElevationSourceTest::fakeTiles(fn () => 250.0);
        Http::fake(['*/api/interpreter' => Http::response(['elements' => []])]);
    }

    public function test_generation_writes_landcover_and_a_painted_splat(): void
    {
        $this->fakeTerrainAndWater();
        $this->serveWorldCover();
        $map = $this->realWorldMap();

        $progress = [];
        app(TerrainGenerator::class)->generate($map, function (int $percent, string $message) use (&$progress) {
            $progress[] = [$percent, $message];
        });

        $map->refresh();
        $this->assertSame(TerrainStatus::Ready, $map->terrain_status);
        $this->assertContains([92, 'Reading land cover'], $progress);
        $percents = array_column($progress, 0);
        $this->assertSame($percents, collect($percents)->sort()->values()->all(), 'Progress is monotonic.');

        $this->assertMatchesRegularExpression('/Land cover: \d+% (forest|grassland), \d+% (forest|grassland)\.$/', (string) $map->terrain_message);
        $this->assertLessThanOrEqual(250, strlen((string) $map->terrain_message));

        $landcover = LandCoverGrid::fromBinary(65, (string) $this->storage->read($map, 'landcover'));
        $this->assertSame(10, $landcover->get(5, 32));
        $this->assertSame(30, $landcover->get(60, 32));

        $splat = (string) $this->storage->read($map, 'splatmap');
        $this->assertSame(65 * 65 * 8, strlen($splat));
        $west = array_values(unpack('C8', substr($splat, (32 * 65 + 5) * 8, 8)));
        $east = array_values(unpack('C8', substr($splat, (32 * 65 + 60) * 8, 8)));
        $this->assertSame(255, $west[2], 'Forest floor');
        $this->assertSame(255, $east[0], 'Grass');

        $this->assertSame(2, $map->landcover_mapping[10]);
        $this->assertSame(0, $map->landcover_mapping[30]);
        $this->assertCount(8, $map->layers);

        $manifest = app(GameManifest::class)->build($map);
        $this->assertStringContainsString('/assets/landcover', (string) $manifest['assets']['landcover']);
        $this->get($manifest['assets']['landcover'])->assertOk()->assertHeader('Content-Type', 'application/octet-stream');
    }

    public function test_generation_survives_missing_land_cover_and_can_be_disabled(): void
    {
        $this->fakeTerrainAndWater();
        $this->serveWorldCover(failWith: 503);
        $map = $this->realWorldMap();
        $this->storage->write($map, 'landcover', str_repeat("\x0A", 65 * 65));

        GenerateMapTerrain::dispatch($map);

        $map->refresh();
        $this->assertSame(TerrainStatus::Ready, $map->terrain_status);
        $this->assertStringContainsString('. Land cover unavailable: WorldCover request failed (HTTP 503)', (string) $map->terrain_message);
        $this->assertFalse($this->storage->exists($map, 'splatmap'), 'The game auto-paints instead.');
        $this->assertFalse($this->storage->exists($map, 'landcover'), 'Stale land cover is removed.');
        $this->assertNull(app(GameManifest::class)->build($map)['assets']['landcover']);

        $this->serveWorldCover();
        $map->update(['use_landcover' => false, 'import_water' => false, 'terrain_status' => TerrainStatus::Queued]);
        GenerateMapTerrain::dispatch($map);

        $map->refresh();
        $this->assertNull($map->terrain_message);
        $this->assertFalse($this->storage->exists($map, 'landcover'));
        Http::assertNotSent(fn ($request) => str_contains($request->url(), 'worldcover.test'));
    }

    private function readyMap(MapSource $source = MapSource::RealWorld): Map
    {
        $map = Map::factory()->create([
            'source' => $source,
            'center_lat' => $source === MapSource::RealWorld ? 49.5 : null,
            'center_lng' => $source === MapSource::RealWorld ? 9.0 : null,
            'resolution' => 65,
            'size' => 16384,
            'revision' => 4,
            'terrain_message' => 'Imported 2 lakes. Land cover: 1% old.',
        ]);
        DefaultTerrainLayers::createFor($map);
        $this->storage->write($map, 'heightmap', TerrainStorage::packFloats(array_fill(0, 65 * 65, 40.0)));

        return $map;
    }

    public function test_apply_refetches_missing_land_cover_and_repaints(): void
    {
        $this->serveWorldCover();
        $map = $this->readyMap();

        $this->post(route('maps.landcover.apply', $map))
            ->assertRedirect()
            ->assertSessionHas('inertia.flash_data.toast.type', 'info');

        $map->refresh();
        $this->assertSame(5, $map->revision);
        $this->assertTrue($map->use_landcover);
        $this->assertSame(65 * 65, strlen((string) $this->storage->read($map, 'landcover')));
        $this->assertSame(65 * 65 * 8, strlen((string) $this->storage->read($map, 'splatmap')));
        $this->assertMatchesRegularExpression('/^Imported 2 lakes\. Land cover: \d+% /', (string) $map->terrain_message);

        // Stored land cover is reused without network access.
        Http::fake(fn () => Http::response('offline', 500));
        $this->post(route('maps.landcover.apply', $map))->assertRedirect();
        $this->assertSame(6, $map->refresh()->revision);

        $this->get(route('maps.show', $map))->assertInertia(fn (Assert $page) => $page
            ->where('map.use_landcover', true)
            ->where('map.landcover_available', true)
            ->where('map.landcover_mapping.10', 2)
            ->has('map.landcover_stats.10')
            ->has('map.landcover_stats.30')
            ->has('map.landcover_classes', 12)
            ->etc());
    }

    public function test_apply_is_rejected_for_other_maps(): void
    {
        $map = $this->readyMap(MapSource::Procedural);

        $this->post(route('maps.landcover.apply', $map))
            ->assertRedirect()
            ->assertSessionHas('inertia.flash_data.toast.type', 'error');
        $this->postJson(route('maps.landcover.apply', $map))->assertStatus(422);
        $this->putJson(route('maps.landcover.mapping', $map), ['mapping' => ['10' => 1]])->assertStatus(422);

        $this->assertFalse($this->storage->exists($map, 'splatmap'));
        $this->assertSame(4, $map->refresh()->revision);
    }

    public function test_mapping_is_validated_saved_and_repainted(): void
    {
        $map = $this->readyMap();
        $this->storage->write($map, 'landcover', str_repeat("\x0A", 65 * 65));
        $map->layers()->where('slot', 7)->delete();

        $this->putJson(route('maps.landcover.mapping', $map), ['mapping' => ['15' => 1]])
            ->assertStatus(422)->assertJsonValidationErrors('mapping');
        $this->putJson(route('maps.landcover.mapping', $map), ['mapping' => ['10' => 7]])
            ->assertStatus(422)->assertJsonValidationErrors('mapping.10');
        $this->putJson(route('maps.landcover.mapping', $map), ['mapping' => ['10' => 'rock']])
            ->assertStatus(422)->assertJsonValidationErrors('mapping.10');
        $this->assertFalse($this->storage->exists($map, 'splatmap'));

        $this->put(route('maps.landcover.mapping', $map), ['mapping' => ['10' => 6, '30' => 4]])
            ->assertRedirect()
            ->assertSessionHas('inertia.flash_data.toast.type', 'success');

        $map->refresh();
        $this->assertSame(6, $map->landcover_mapping[10]);
        $this->assertSame(4, $map->landcover_mapping[30]);
        $this->assertSame(3, $map->landcover_mapping[60], 'Other classes keep their defaults');
        $splat = (string) $this->storage->read($map, 'splatmap');
        $this->assertSame(255, ord($splat[(32 * 65 + 32) * 8 + 6]), 'All tree cover painted with slot 6');

        $this->put(route('maps.landcover.mapping', $map), ['mapping' => ['10' => null]])->assertRedirect();
        $this->assertSame(2, $map->refresh()->landcover_mapping[10], 'null resets to the default');
        $this->assertSame(4, $map->landcover_mapping[30]);
    }

    public function test_use_landcover_is_validated_on_regenerate(): void
    {
        $map = $this->readyMap();

        $this->post(route('maps.regenerate', $map), [
            'source' => 'real_world', 'resolution' => 257, 'size' => 2048,
            'center_lat' => 49.5, 'center_lng' => 9.0, 'use_landcover' => 'maybe',
        ])->assertSessionHasErrors('use_landcover');
    }
}
