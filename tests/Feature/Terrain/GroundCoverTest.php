<?php

namespace Tests\Feature\Terrain;

use App\Models\FoliageType;
use App\Models\Map;
use App\Support\DefaultTerrainLayers;
use App\Support\GameManifest;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class GroundCoverTest extends TestCase
{
    use RefreshDatabase;

    private function grass(): FoliageType
    {
        return FoliageType::query()->create([
            'name' => 'Meadow grass', 'kind' => 'grass', 'color' => '#4f7a2a', 'color_secondary' => '#7a9a3a',
            'min_scale' => 0.8, 'max_scale' => 1.2, 'density' => 40, 'max_slope' => 35, 'cull_distance' => 140,
        ]);
    }

    public function test_the_editor_saves_a_layers_ground_cover(): void
    {
        $map = Map::factory()->create();
        DefaultTerrainLayers::createFor($map);
        $layer = $map->layers()->where('slot', 0)->sole();
        $grass = $this->grass();

        $this->patchJson("/api/maps/{$map->slug}/layers/{$layer->id}/ground-cover", [
            'ground_cover' => [['foliage_type_id' => $grass->id, 'density' => 1.5]],
        ])
            ->assertOk()
            ->assertJsonPath('ground_cover.0.foliage_type_id', $grass->id)
            ->assertJsonPath('ground_cover.0.density', 1.5);

        $manifest = app(GameManifest::class)->build($map->refresh());
        $slot0 = collect($manifest['layers'])->firstWhere('slot', 0);
        $this->assertSame([['foliage_type_id' => $grass->id, 'density' => 1.5]], $slot0['ground_cover']);
        $this->assertStringEndsWith("/api/maps/{$map->slug}/layers", $manifest['endpoints']['update_layers']);

        // Clearing it.
        $this->patchJson("/api/maps/{$map->slug}/layers/{$layer->id}/ground-cover", ['ground_cover' => []])
            ->assertOk()
            ->assertJsonPath('ground_cover', []);
    }

    public function test_ground_cover_is_validated(): void
    {
        $map = Map::factory()->create();
        DefaultTerrainLayers::createFor($map);
        $layer = $map->layers()->where('slot', 0)->sole();
        $grass = $this->grass();
        $url = "/api/maps/{$map->slug}/layers/{$layer->id}/ground-cover";

        $this->patchJson($url, ['ground_cover' => [['foliage_type_id' => 9999, 'density' => 1]]])
            ->assertStatus(422)->assertJsonValidationErrors('ground_cover.0.foliage_type_id');
        $this->patchJson($url, ['ground_cover' => [['foliage_type_id' => $grass->id, 'density' => 9]]])
            ->assertStatus(422)->assertJsonValidationErrors('ground_cover.0.density');
        $this->patchJson($url, ['ground_cover' => [
            ['foliage_type_id' => $grass->id, 'density' => 1],
            ['foliage_type_id' => $grass->id, 'density' => 2],
        ]])->assertStatus(422);
        $this->patchJson($url, [])->assertStatus(422);

        // A layer of another map.
        $other = Map::factory()->create();
        DefaultTerrainLayers::createFor($other);
        $foreign = $other->layers()->where('slot', 0)->sole();
        $this->patchJson("/api/maps/{$map->slug}/layers/{$foreign->id}/ground-cover", ['ground_cover' => []])->assertNotFound();
    }

    public function test_the_studio_layer_form_saves_ground_cover(): void
    {
        $map = Map::factory()->create();
        DefaultTerrainLayers::createFor($map);
        $layer = $map->layers()->where('slot', 1)->sole();
        $grass = $this->grass();

        $this->put("/maps/{$map->slug}/layers/{$layer->id}", [
            'name' => 'Meadow', 'color' => '#4f6b2a', 'color_secondary' => '#6f8a34', 'roughness' => 0.9, 'noise_scale' => 6,
            'variation' => 0.5, 'bump' => 0.3, 'auto_priority' => 0,
            'ground_cover' => [['foliage_type_id' => $grass->id, 'density' => 0.5]],
        ])->assertSessionHasNoErrors();

        $this->assertSame([['foliage_type_id' => $grass->id, 'density' => 0.5]], $layer->refresh()->groundCover());

        $this->get("/maps/{$map->slug}/layers")
            ->assertOk()
            ->assertInertia(fn ($page) => $page
                ->where('foliageTypes.0.name', 'Meadow grass')
                ->where('layers.1.ground_cover.0.foliage_type_id', $grass->id));
    }
}
