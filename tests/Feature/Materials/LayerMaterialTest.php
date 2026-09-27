<?php

namespace Tests\Feature\Materials;

use App\Models\Map;
use App\Models\Material;
use App\Services\Materials\MaterialLibrary;
use App\Support\DefaultTerrainLayers;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class LayerMaterialTest extends TestCase
{
    use RefreshDatabase;

    private function material(float $tileSize = 3.5): Material
    {
        return app(MaterialLibrary::class)->create([
            'name' => 'Rock', 'category' => 'rock', 'tile_size' => $tileSize, 'status' => 'ready', 'albedo_path' => 'materials/1/albedo.jpg',
        ]);
    }

    public function test_quick_assignment_defaults_the_texture_scale(): void
    {
        $map = Map::factory()->create();
        DefaultTerrainLayers::createFor($map);
        $layer = $map->layers()->where('slot', 3)->sole();
        $material = $this->material();

        $this->put("/maps/{$map->slug}/layers/{$layer->id}/material", ['material_id' => $material->id])->assertRedirect();
        $layer->refresh();
        $this->assertSame([$material->id, 3.5], [$layer->material_id, $layer->texture_scale]);
        $this->assertSame($material->id, $layer->toGameArray()['material']['id']);

        $this->put("/maps/{$map->slug}/layers/{$layer->id}/material", ['material_id' => null])->assertRedirect();
        $this->assertNull($layer->refresh()->material_id);

        $this->put("/maps/{$map->slug}/layers/{$layer->id}/material", ['material_id' => 9999])->assertSessionHasErrors('material_id');
    }

    public function test_layer_form_accepts_material_fields(): void
    {
        $map = Map::factory()->create();
        DefaultTerrainLayers::createFor($map);
        $layer = $map->layers()->where('slot', 0)->sole();
        $material = $this->material(1.8);

        $base = [
            'name' => 'Grass', 'color' => '#4f6b2a', 'color_secondary' => '#6f8a34', 'roughness' => 0.9, 'noise_scale' => 6,
            'variation' => 0.5, 'bump' => 0.3, 'auto_priority' => 0,
        ];

        // No texture_scale sent → the material's tile size.
        $this->put("/maps/{$map->slug}/layers/{$layer->id}", [...$base, 'material_id' => $material->id, 'tint' => '#eeddcc', 'roughness_scale' => 1.4, 'normal_strength' => 0.6])
            ->assertSessionHasNoErrors();
        $layer->refresh();
        $this->assertSame([$material->id, 1.8, '#eeddcc', 1.4, 0.6], [$layer->material_id, $layer->texture_scale, $layer->tint, $layer->roughness_scale, $layer->normal_strength]);

        // Explicit texture_scale wins.
        $this->put("/maps/{$map->slug}/layers/{$layer->id}", [...$base, 'material_id' => null, 'texture_scale' => 9])->assertSessionHasNoErrors();
        $this->put("/maps/{$map->slug}/layers/{$layer->id}", [...$base, 'material_id' => $material->id, 'texture_scale' => 7])->assertSessionHasNoErrors();
        $this->assertSame([$material->id, 7.0], [$layer->refresh()->material_id, $layer->texture_scale]);

        $this->put("/maps/{$map->slug}/layers/{$layer->id}", [...$base, 'tint' => 'white', 'roughness_scale' => 4, 'normal_strength' => -1, 'material_id' => 123])
            ->assertSessionHasErrors(['tint', 'roughness_scale', 'normal_strength', 'material_id']);

        // Materials that are not ready are not sent to the game.
        $material->update(['status' => 'processing']);
        $this->assertNull($layer->refresh()->toGameArray()['material']);
    }
}
