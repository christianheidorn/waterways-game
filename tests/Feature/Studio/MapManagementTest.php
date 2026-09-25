<?php

namespace Tests\Feature\Studio;

use App\Enums\TerrainStatus;
use App\Jobs\GenerateMapTerrain;
use App\Models\Map;
use App\Support\DefaultTerrainLayers;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Queue;
use Tests\TestCase;

class MapManagementTest extends TestCase
{
    use RefreshDatabase;

    public function test_creating_a_map_queues_terrain_generation(): void
    {
        Queue::fake();

        $this->post('/maps', [
            'name' => 'Alpine Lake',
            'source' => 'real_world',
            'resolution' => 513,
            'size' => 4096,
            'center_lat' => 46.3625,
            'center_lng' => 14.0936,
            'height_scale' => 1,
            'import_water' => true,
        ])->assertRedirect('/maps/alpine-lake');

        $map = Map::query()->where('slug', 'alpine-lake')->firstOrFail();
        $this->assertSame(TerrainStatus::Queued, $map->terrain_status);
        $this->assertTrue($map->is_default, 'The first map becomes the default.');
        $this->assertNotNull($map->bounds());
        Queue::assertPushed(GenerateMapTerrain::class, fn ($job) => $job->map->is($map));
    }

    public function test_real_world_maps_require_coordinates(): void
    {
        $this->post('/maps', ['name' => 'Nowhere', 'source' => 'real_world', 'resolution' => 513, 'size' => 2048])
            ->assertSessionHasErrors(['center_lat', 'center_lng']);
    }

    public function test_resolution_must_be_supported(): void
    {
        $this->post('/maps', ['name' => 'Odd', 'source' => 'flat', 'resolution' => 500, 'size' => 2048])
            ->assertSessionHasErrors('resolution');
    }

    public function test_slugs_are_unique(): void
    {
        Queue::fake();
        Map::factory()->create(['name' => 'Valley', 'slug' => 'valley']);

        $this->post('/maps', ['name' => 'Valley', 'source' => 'flat', 'resolution' => 257, 'size' => 1024])
            ->assertRedirect('/maps/valley-2');
    }

    public function test_regenerating_resets_the_status_and_spawn(): void
    {
        Queue::fake();
        $map = Map::factory()->create(['spawn_x' => 10, 'spawn_z' => 20]);

        $this->post("/maps/{$map->slug}/regenerate", ['source' => 'procedural', 'resolution' => 257, 'size' => 2048, 'seed' => 42])
            ->assertRedirect();

        $map->refresh();
        $this->assertSame(TerrainStatus::Queued, $map->terrain_status);
        $this->assertSame(42, $map->seed);
        $this->assertNull($map->spawn_x);
        Queue::assertPushed(GenerateMapTerrain::class);
    }

    public function test_default_map_can_be_switched_and_deleting_it_promotes_another(): void
    {
        $a = Map::factory()->create(['is_default' => true]);
        $b = Map::factory()->create();

        $this->post("/maps/{$b->slug}/default")->assertRedirect();
        $this->assertFalse($a->fresh()->is_default);
        $this->assertTrue($b->fresh()->is_default);

        $this->delete("/maps/{$b->slug}")->assertRedirect('/maps');
        $this->assertTrue($a->fresh()->is_default);
    }

    public function test_environment_is_validated_and_merged(): void
    {
        $map = Map::factory()->create();

        $this->put("/maps/{$map->slug}/environment", ['time_of_day' => 7.25, 'ocean_enabled' => true])->assertRedirect();
        $env = $map->fresh()->resolvedEnvironment();
        $this->assertSame(7.25, $env['time_of_day']);
        $this->assertTrue($env['ocean_enabled']);
        $this->assertSame(2.5, $env['turbidity']);

        $this->put("/maps/{$map->slug}/environment", ['water_deep_color' => 'blue'])->assertSessionHasErrors('water_deep_color');
    }

    public function test_terrain_layers_crud_respects_the_eight_slot_limit(): void
    {
        $map = Map::factory()->create();
        DefaultTerrainLayers::createFor($map);
        $this->assertSame(8, $map->layers()->count());

        $layer = $map->layers()->firstOrFail();
        $payload = [
            'name' => 'Lush grass', 'color' => '#336622', 'color_secondary' => '#447733', 'roughness' => 0.9,
            'noise_scale' => 5, 'variation' => 0.5, 'bump' => 0.3, 'texture_scale' => 4,
            'auto_min_height' => null, 'auto_max_height' => null, 'auto_min_slope' => null, 'auto_max_slope' => null,
            'auto_priority' => 0,
        ];

        $this->post("/maps/{$map->slug}/layers", $payload)->assertRedirect();
        $this->assertSame(8, $map->layers()->count(), 'No free slot left.');

        $this->put("/maps/{$map->slug}/layers/{$layer->id}", $payload)->assertRedirect();
        $this->assertSame('Lush grass', $layer->fresh()->name);

        $this->delete("/maps/{$map->slug}/layers/{$layer->id}")->assertRedirect();
        $this->post("/maps/{$map->slug}/layers", $payload)->assertRedirect();
        $this->assertSame(0, $map->layers()->where('name', 'Lush grass')->value('slot'), 'Freed slot is reused.');

        $other = Map::factory()->create();
        $this->put("/maps/{$other->slug}/layers/{$layer->id}", $payload)->assertNotFound();
    }
}
