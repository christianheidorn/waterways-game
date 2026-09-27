<?php

namespace Tests\Feature\Foliage;

use App\Models\FoliageType;
use App\Models\Map;
use App\Support\GameManifest;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class FoliageTypeApiTest extends TestCase
{
    use RefreshDatabase;

    private function type(): FoliageType
    {
        return FoliageType::query()->create([
            'name' => 'Oak', 'kind' => 'broadleaf', 'color' => '#335522', 'color_secondary' => '#443322',
            'min_scale' => 0.8, 'max_scale' => 1.2, 'density' => 1, 'max_slope' => 30, 'cull_distance' => 1500,
        ]);
    }

    public function test_the_in_game_editor_can_patch_settings(): void
    {
        $type = $this->type();

        $this->patchJson("/api/foliage-types/{$type->id}", ['density' => 3.5, 'cast_shadows' => false, 'min_height' => null, 'max_height' => 900, 'kind' => 'rock'])
            ->assertOk()
            ->assertJsonPath('density', 3.5)
            ->assertJsonPath('cast_shadows', false)
            ->assertJsonPath('max_height', 900)
            ->assertJsonPath('kind', 'broadleaf');

        $type->refresh();
        $this->assertSame(3.5, $type->density);
        $this->assertSame('broadleaf', $type->kind->value, 'Kind is not editable in-game');
    }

    public function test_patches_are_validated_against_the_merged_values(): void
    {
        $type = $this->type();

        $this->patchJson("/api/foliage-types/{$type->id}", ['min_scale' => 2])->assertStatus(422)->assertJsonValidationErrors('max_scale');
        $this->patchJson("/api/foliage-types/{$type->id}", ['density' => 9999])->assertStatus(422);
        $this->patchJson("/api/foliage-types/{$type->id}", ['unknown' => 1])->assertStatus(422);
        $this->patchJson("/api/foliage-types/{$type->id}", ['min_scale' => 2, 'max_scale' => 3])->assertOk();
    }

    public function test_the_manifest_advertises_the_endpoint(): void
    {
        $manifest = app(GameManifest::class)->build(Map::factory()->create());

        $this->assertStringEndsWith('/api/foliage-types', $manifest['endpoints']['update_foliage_type']);
    }
}
