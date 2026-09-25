<?php

namespace Tests\Feature\Studio;

use App\Enums\TerrainStatus;
use App\Models\FoliageType;
use App\Models\Map;
use App\Services\Terrain\TerrainStorage;
use App\Support\DefaultTerrainLayers;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

class MapDataApiTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('local');
        Storage::fake('public');
    }

    private function mapWithTerrain(): Map
    {
        $map = Map::factory()->create(['resolution' => 65, 'size' => 256]);
        DefaultTerrainLayers::createFor($map);
        app(TerrainStorage::class)->write($map, 'heightmap', TerrainStorage::packFloats(array_fill(0, 65 * 65, 12.5)));

        return $map;
    }

    public function test_manifest_describes_the_map_assets_and_settings(): void
    {
        $map = $this->mapWithTerrain();
        FoliageType::query()->create(['name' => 'Oak', 'kind' => 'broadleaf', 'color' => '#335522', 'color_secondary' => '#553311']);

        $this->getJson("/api/maps/{$map->slug}/manifest")
            ->assertOk()
            ->assertJsonPath('map.slug', $map->slug)
            ->assertJsonPath('map.resolution', 65)
            ->assertJsonPath('assets.splatmap', null)
            ->assertJsonPath('foliage_types.0.name', 'Oak')
            ->assertJsonCount(8, 'layers')
            ->assertJsonStructure([
                'environment' => ['time_of_day', 'water_shallow_color'],
                'settings' => ['player' => ['walk_speed'], 'graphics' => ['shadow_quality'], 'editor' => ['undo_steps']],
                'assets' => ['heightmap'],
                'endpoints' => ['save_heightmap', 'save_splatmap', 'save_water', 'save_foliage', 'save_meta', 'save_thumbnail'],
            ]);
    }

    public function test_heightmap_round_trips_including_gzip_payloads(): void
    {
        $map = $this->mapWithTerrain();
        $bytes = TerrainStorage::packFloats(array_fill(0, 65 * 65, 40.0));

        $this->call('PUT', "/api/maps/{$map->slug}/assets/heightmap", [], [], [], [
            'CONTENT_TYPE' => 'application/octet-stream',
            'HTTP_X_PAYLOAD_ENCODING' => 'gzip',
            'HTTP_X_MIN_HEIGHT' => '40',
            'HTTP_X_MAX_HEIGHT' => '40',
        ], gzencode($bytes))->assertOk()->assertJsonPath('revision', 1);

        $map->refresh();
        $this->assertSame(40.0, $map->max_height);
        $this->assertSame($bytes, $this->get("/api/maps/{$map->slug}/assets/heightmap")->getContent());
    }

    public function test_payloads_with_the_wrong_size_are_rejected(): void
    {
        $map = $this->mapWithTerrain();

        $this->call('PUT', "/api/maps/{$map->slug}/assets/splatmap", [], [], [], ['CONTENT_TYPE' => 'application/octet-stream'], str_repeat("\0", 10))
            ->assertStatus(422);
        $this->call('PUT', "/api/maps/{$map->slug}/assets/foliage", [], [], [], ['CONTENT_TYPE' => 'application/octet-stream'], '{"nope":1}')
            ->assertStatus(422);
        $this->call('PUT', "/api/maps/{$map->slug}/assets/secrets", [], [], [], [], 'x')->assertNotFound();
    }

    public function test_saving_is_refused_while_terrain_is_generating(): void
    {
        $map = $this->mapWithTerrain();
        $map->update(['terrain_status' => TerrainStatus::Importing]);

        $this->call('PUT', "/api/maps/{$map->slug}/assets/foliage", [], [], [], [], '{"version":1,"instances":{}}')->assertStatus(409);
    }

    public function test_spawn_and_thumbnail_can_be_saved(): void
    {
        $map = $this->mapWithTerrain();

        $this->patchJson("/api/maps/{$map->slug}/meta", ['spawn' => ['x' => 12.5, 'z' => -4, 'yaw' => 1.2]])
            ->assertOk()
            ->assertJsonPath('map.spawn.x', 12.5);

        $jpeg = 'data:image/jpeg;base64,'.base64_encode('fake-jpeg-bytes');
        $this->postJson("/api/maps/{$map->slug}/thumbnail", ['image' => $jpeg])->assertOk();
        Storage::disk('public')->assertExists($map->thumbnailPath());

        $this->postJson("/api/maps/{$map->slug}/thumbnail", ['image' => 'data:text/html;base64,AAAA'])->assertStatus(422);
    }

    public function test_deleting_a_map_removes_its_files(): void
    {
        $map = $this->mapWithTerrain();
        Storage::disk('local')->assertExists("maps/{$map->id}/heightmap.f32");

        $this->delete("/maps/{$map->slug}");

        Storage::disk('local')->assertMissing("maps/{$map->id}/heightmap.f32");
    }
}
