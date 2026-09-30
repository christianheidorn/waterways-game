<?php

namespace Tests\Feature\Studio;

use App\Models\Map;
use App\Models\MapSnapshot;
use App\Models\Material;
use App\Support\DefaultTerrainLayers;
use App\Support\GameSettingsRepository;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

/**
 * The editor's World tab: environment, layer settings, materials, snapshots and templates.
 */
class EditorSettingsApiTest extends TestCase
{
    use RefreshDatabase;

    private function map(): Map
    {
        Storage::fake('local');
        $map = Map::factory()->create(['resolution' => 65, 'size' => 256]);
        DefaultTerrainLayers::createFor($map);

        return $map;
    }

    public function test_environment_is_read_and_patched_field_by_field(): void
    {
        $map = $this->map();

        $this->getJson("/api/maps/{$map->slug}/environment")
            ->assertOk()->assertJsonPath('group.key', 'environment')->assertJsonStructure(['values' => ['time_of_day']]);

        $this->patchJson("/api/maps/{$map->slug}/environment", ['time_of_day' => 6.5, 'weather' => 'fog'])
            ->assertOk()->assertJsonPath('values.time_of_day', 6.5);
        $this->assertSame('fog', $map->refresh()->resolvedEnvironment()['weather']);

        $this->patchJson("/api/maps/{$map->slug}/environment", ['time_of_day' => 30])->assertUnprocessable();
        $this->patchJson("/api/maps/{$map->slug}/environment", ['nope' => 1])->assertUnprocessable();
    }

    public function test_a_layer_is_patched_partially(): void
    {
        $map = $this->map();
        $layer = $map->layers()->where('slot', 3)->sole();
        $material = Material::query()->create(['name' => 'Granite', 'slug' => 'granite', 'category' => 'rock', 'tile_size' => 3.5, 'status' => 'ready', 'albedo_path' => 'materials/1/albedo.jpg']);

        $this->patchJson("/api/maps/{$map->slug}/layers/{$layer->id}", ['auto_min_slope' => 40, 'name' => 'Cliffs'])
            ->assertOk()->assertJsonPath('name', 'Cliffs');
        $this->assertSame(40.0, (float) $layer->refresh()->auto_min_slope);

        $this->patchJson("/api/maps/{$map->slug}/layers/{$layer->id}", ['material_id' => $material->id])
            ->assertOk()->assertJsonPath('material.id', $material->id);
        $this->assertSame(3.5, (float) $layer->refresh()->texture_scale);

        $this->patchJson("/api/maps/{$map->slug}/layers/{$layer->id}", ['color' => 'red'])->assertUnprocessable();
        $this->patchJson("/api/maps/{$map->slug}/layers/{$layer->id}", ['slot' => 2])->assertUnprocessable();

        $this->getJson('/api/materials')->assertOk()->assertJsonPath('0.name', 'Granite');
    }

    public function test_the_editor_takes_automatic_snapshots_after_saves(): void
    {
        $map = $this->map();
        app(GameSettingsRepository::class)->update('editor', ['auto_snapshot_minutes' => 10, 'auto_snapshot_keep' => 2]);

        // The first save of a session always snapshots; later ones at most every 10 minutes.
        $this->postJson("/api/maps/{$map->slug}/snapshots/auto", ['first' => true])
            ->assertOk()->assertJsonPath('snapshot.editing', true);
        $this->postJson("/api/maps/{$map->slug}/snapshots/auto")->assertOk()->assertJsonPath('snapshot', null);

        Carbon::setTestNow(now()->addMinutes(11));
        $this->postJson("/api/maps/{$map->slug}/snapshots/auto")->assertOk()->assertJsonPath('snapshot.auto', true);
        Carbon::setTestNow(now()->addMinutes(11));
        $this->postJson("/api/maps/{$map->slug}/snapshots/auto")->assertOk();

        // Retention: only the last 2 automatic ones stay; manual ones are kept.
        $this->postJson("/api/maps/{$map->slug}/snapshots", ['label' => 'Mine'])->assertCreated();
        $this->assertSame(2, MapSnapshot::query()->where('auto', true)->count());
        $this->getJson("/api/maps/{$map->slug}/snapshots")
            ->assertOk()->assertJsonCount(3, 'snapshots')->assertJsonPath('snapshots.0.label', 'Mine')
            ->assertJsonPath('settings.auto_snapshot_keep', 2);

        app(GameSettingsRepository::class)->update('editor', ['auto_snapshot_minutes' => 0]);
        $this->postJson("/api/maps/{$map->slug}/snapshots/auto", ['first' => true])->assertOk()->assertJsonPath('snapshot', null);
    }

    public function test_a_snapshot_is_restored_from_the_editor(): void
    {
        $map = $this->map();
        $snapshot = $this->postJson("/api/maps/{$map->slug}/snapshots", ['label' => 'Before'])->json('snapshot.id');
        $map->layers()->where('slot', 0)->update(['name' => 'Changed']);
        $revision = $map->refresh()->revision;

        $this->postJson("/api/maps/{$map->slug}/snapshots/{$snapshot}/restore")
            ->assertOk()->assertJsonPath('revision', $revision + 1);
        $this->assertSame('Grass', $map->layers()->where('slot', 0)->value('name'));

        $other = Map::factory()->create();
        $this->postJson("/api/maps/{$other->slug}/snapshots/{$snapshot}/restore")->assertNotFound();
    }

    public function test_templates_are_listed_for_the_editor_and_the_studio(): void
    {
        $this->getJson('/api/map-templates')->assertOk()->assertJsonCount(4)->assertJsonPath('0.key', 'coastal_village');
        $this->get('/maps/create')->assertOk()->assertInertia(fn ($page) => $page->has('templates', 4));
    }
}
