<?php

namespace Tests\Feature\Mcp;

use App\Enums\MapSource;
use App\Enums\TerrainStatus;
use App\Jobs\GenerateMapTerrain;
use App\Mcp\EditorBridge;
use App\Mcp\Servers\WaterwaysServer;
use App\Mcp\Tools\ControlEditor;
use App\Mcp\Tools\CreateMap;
use App\Mcp\Tools\ListMapTemplates;
use App\Mcp\Tools\ManageSnapshots;
use App\Models\AgentRequest;
use App\Models\Biome;
use App\Models\FoliageType;
use App\Models\Map;
use App\Support\DefaultTerrainLayers;
use App\Support\GameSettingsRepository;
use App\Support\MapTemplates;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

/**
 * Building II: map templates, editor history and automatic snapshots over MCP.
 */
class BuildingToolsTest extends TestCase
{
    use RefreshDatabase;

    private function map(): Map
    {
        $map = Map::factory()->create(['resolution' => 65, 'size' => 256]);
        DefaultTerrainLayers::createFor($map);

        return $map;
    }

    public function test_map_templates_are_listed(): void
    {
        WaterwaysServer::tool(ListMapTemplates::class)
            ->assertOk()
            ->assertSee('"key": "coastal_village"')
            ->assertSee('"key": "alpine_lake"')
            ->assertSee('"key": "river_valley"')
            ->assertSee('"key": "desert_canyon"');
    }

    public function test_create_map_from_a_template_uses_its_defaults_and_environment(): void
    {
        Queue::fake();

        WaterwaysServer::tool(CreateMap::class, ['name' => 'Harbour', 'template' => 'coastal_village', 'description' => 'Fishing harbour'])
            ->assertOk()->assertSee('"template": "coastal_village"');

        $map = Map::query()->where('slug', 'harbour')->sole();
        $this->assertSame(MapSource::Procedural, $map->source);
        $this->assertSame(513, $map->resolution);
        $this->assertSame(2048.0, (float) $map->size);
        $this->assertTrue($map->resolvedEnvironment()['ocean_enabled']);
        $this->assertSame('golden_hour', $map->resolvedEnvironment()['color_grade']);
        Queue::assertPushed(GenerateMapTerrain::class, 1);

        // Explicit values win over the template's.
        WaterwaysServer::tool(CreateMap::class, ['name' => 'Big lake', 'template' => 'alpine_lake', 'resolution' => 257])->assertOk();
        $this->assertSame(257, Map::query()->where('slug', 'big-lake')->sole()->resolution);

        WaterwaysServer::tool(CreateMap::class, ['name' => 'Nope', 'template' => 'moon_base'])->assertHasErrors();
        WaterwaysServer::tool(CreateMap::class, ['name' => 'No size'])->assertHasErrors();
    }

    public function test_a_template_shapes_the_terrain_and_sets_up_biomes_and_foliage(): void
    {
        Storage::fake('local');
        FoliageType::query()->create([
            'name' => 'Palm', 'kind' => 'palm', 'color' => '#4f7a2a', 'color_secondary' => '#7a9a3a',
            'min_scale' => 0.8, 'max_scale' => 1.2, 'density' => 4, 'max_slope' => 35, 'cull_distance' => 400,
        ]);
        $conifer = FoliageType::query()->create([
            'name' => 'Pine', 'kind' => 'conifer', 'color' => '#4f7a2a', 'color_secondary' => '#7a9a3a',
            'min_scale' => 0.8, 'max_scale' => 1.2, 'density' => 4, 'max_slope' => 35, 'cull_distance' => 400,
        ]);
        $map = Map::query()->create([
            'name' => 'Coast', 'slug' => 'coast', 'source' => MapSource::Procedural, 'resolution' => 65, 'size' => 2048,
            'seed' => 11, 'height_scale' => 1, 'import_water' => true, 'use_landcover' => false,
            'terrain_status' => TerrainStatus::Queued, 'template' => 'coastal_village',
        ]);

        GenerateMapTerrain::dispatch($map);

        $map->refresh();
        $this->assertSame(TerrainStatus::Ready, $map->terrain_status);
        // The coast runs below sea level.
        $this->assertLessThan(0, $map->min_height);
        $this->assertSame('Beach', $map->layers()->where('slot', 4)->value('name'));
        $this->assertSame(3.0, (float) $map->layers()->where('slot', 4)->value('auto_max_height'));
        $this->assertTrue(Biome::query()->where('starter_key', 'beach')->exists());
        $ids = MapTemplates::initialFoliage($map);
        $this->assertNotContains($conifer->id, $ids);
        $this->assertCount(1, $ids);
        $this->getJson("/api/maps/{$map->slug}/manifest")->assertJsonPath('initial_foliage', $ids);
    }

    public function test_a_map_from_a_description_carries_a_request_for_the_agent(): void
    {
        Queue::fake();

        $this->postJson('/api/maps', ['name' => 'Fjord', 'brief' => 'A foggy fjord with a fishing village'])
            ->assertCreated()->assertJsonPath('slug', 'fjord');

        $request = AgentRequest::query()->sole();
        $this->assertStringContainsString('foggy fjord', $request->note);
        $this->assertSame('open', $request->status);
        $this->assertCount(4, $request->area);
        $this->assertSame(1024.0, (float) $request->area[1]['x']);
    }

    public function test_control_editor_lists_and_jumps_the_history(): void
    {
        $map = $this->map();
        $editor = new FakeEditor($map, fn (string $type, array $payload) => match ($type) {
            'history' => ['position' => 2, 'steps' => [['label' => 'Sculpt'], ['label' => 'Paint'], ['label' => 'Water']]],
            'history_jump' => ['position' => $payload['position'], 'moved' => 2],
            default => [],
        });
        $this->app->instance(EditorBridge::class, $editor);

        WaterwaysServer::tool(ControlEditor::class, ['map' => $map->slug, 'action' => 'history'])
            ->assertOk()->assertSee('Paint');
        WaterwaysServer::tool(ControlEditor::class, ['map' => $map->slug, 'action' => 'history_jump', 'position' => 0])
            ->assertOk()->assertSee('"moved": 2');
        $this->assertSame(['position' => 0], $editor->ran[1]['payload']);

        WaterwaysServer::tool(ControlEditor::class, ['map' => $map->slug, 'action' => 'history_jump'])->assertHasErrors();
    }

    public function test_snapshot_listing_includes_the_automatic_snapshot_settings(): void
    {
        $map = $this->map();
        app(GameSettingsRepository::class)->update('editor', ['auto_snapshot_minutes' => 12, 'auto_snapshot_keep' => 3]);

        WaterwaysServer::tool(ManageSnapshots::class, ['map' => $map->slug, 'action' => 'list'])
            ->assertOk()
            ->assertSee('"auto_snapshot_minutes": 12')
            ->assertSee('"auto_snapshot_keep": 3');
    }
}
