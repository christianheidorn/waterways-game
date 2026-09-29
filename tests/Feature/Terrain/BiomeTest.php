<?php

namespace Tests\Feature\Terrain;

use App\Models\Biome;
use App\Models\FoliageType;
use App\Models\Map;
use App\Support\DefaultTerrainLayers;
use App\Support\GameManifest;
use App\Support\StarterBiomes;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class BiomeTest extends TestCase
{
    use RefreshDatabase;

    private function type(string $name, string $kind, float $density = 1): FoliageType
    {
        return FoliageType::query()->create([
            'name' => $name, 'kind' => $kind, 'color' => '#4f7a2a', 'color_secondary' => '#7a9a3a',
            'min_scale' => 0.8, 'max_scale' => 1.2, 'density' => $density, 'max_slope' => 35, 'cull_distance' => 500,
        ]);
    }

    public function test_starter_biomes_pick_plants_by_kind_and_are_not_duplicated(): void
    {
        $grass = $this->type('Grass', 'grass', 40);
        $oak = $this->type('Oak', 'broadleaf');
        $birch = $this->type('Birch', 'broadleaf');

        $this->assertSame(count(StarterBiomes::BIOMES), StarterBiomes::install());
        $this->assertSame(0, StarterBiomes::install());

        $forest = Biome::query()->where('starter_key', 'temperate_forest')->sole();
        // No bush type in this library: only the kinds that exist, the second broadleaf included.
        $this->assertSame([$oak->id, $birch->id, $grass->id], array_column($forest->groundCover(), 'foliage_type_id'));
        $this->assertSame('#3d3521', $forest->look['color']);

        $forest->delete();
        $this->assertSame(1, StarterBiomes::install());
    }

    public function test_applying_a_biome_replaces_the_layer_look_and_ground_cover(): void
    {
        $map = Map::factory()->create();
        DefaultTerrainLayers::createFor($map);
        $layer = $map->layers()->where('slot', 2)->sole();
        $layer->update(['auto_min_slope' => 18, 'auto_max_slope' => 30]);
        $oak = $this->type('Oak', 'broadleaf');
        $biome = Biome::query()->create([
            'name' => 'Oak wood',
            'look' => ['color' => '#112233', 'color_secondary' => '#445566', 'roughness' => 0.7, 'material_id' => 999],
            'ground_cover' => [
                ['foliage_type_id' => $oak->id, 'density' => 1.2, 'clustering' => 0.6, 'spacing' => 5],
                ['foliage_type_id' => 12345, 'density' => 1],
            ],
        ]);

        $this->postJson("/api/maps/{$map->slug}/layers/{$layer->id}/biome", ['biome_id' => $biome->id])
            ->assertOk()
            ->assertJsonPath('name', 'Oak wood')
            ->assertJsonPath('color', '#112233')
            ->assertJsonPath('material_id', null)
            ->assertJsonPath('slot', 2)
            ->assertJsonPath('auto_min_slope', 18)
            ->assertJsonCount(1, 'ground_cover')
            ->assertJsonPath('ground_cover.0.clustering', 0.6);

        $this->post("/maps/{$map->slug}/layers/{$layer->id}/biome", ['biome_id' => 9999])->assertSessionHasErrors('biome_id');
        $this->post("/maps/{$map->slug}/layers/{$layer->id}/biome", ['biome_id' => $biome->id])->assertRedirect();

        $other = Map::factory()->create();
        DefaultTerrainLayers::createFor($other);
        $this->postJson("/api/maps/{$map->slug}/layers/{$other->layers()->first()->id}/biome", ['biome_id' => $biome->id])->assertNotFound();
    }

    public function test_a_layer_can_be_saved_as_a_biome_and_biomes_reach_the_game_and_studio(): void
    {
        $map = Map::factory()->create();
        DefaultTerrainLayers::createFor($map);
        $layer = $map->layers()->where('slot', 0)->sole();
        $grass = $this->type('Grass', 'grass', 40);
        $layer->update(['ground_cover' => [['foliage_type_id' => $grass->id, 'density' => 0.5, 'clustering' => 0.2]]]);

        $this->postJson('/api/biomes', ['layer_id' => $layer->id, 'name' => 'Lawn'])
            ->assertCreated()
            ->assertJsonPath('name', 'Lawn')
            ->assertJsonPath('ground_cover.0.name', 'Grass');
        $this->postJson('/api/biomes', ['layer_id' => $layer->id])->assertStatus(422);

        $biome = Biome::query()->where('name', 'Lawn')->sole();
        $this->assertSame($layer->color, $biome->look['color']);

        $manifest = app(GameManifest::class)->build($map);
        $this->assertSame('Lawn', $manifest['biomes'][0]['name']);
        $this->assertStringEndsWith('/api/biomes', $manifest['endpoints']['biomes']);

        $this->get("/maps/{$map->slug}/layers")->assertOk()->assertInertia(fn ($page) => $page->where('biomes.0.name', 'Lawn'));

        $this->post('/biomes', ['layer_id' => $layer->id, 'name' => 'Lawn 2'])->assertRedirect();
        $this->delete("/biomes/{$biome->id}")->assertRedirect();
        $this->assertSame(['Lawn 2'], Biome::query()->pluck('name')->all());

        $this->post('/biomes/starters')->assertRedirect();
        $this->assertSame(count(StarterBiomes::BIOMES) + 1, Biome::query()->count());
    }
}
