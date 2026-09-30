<?php

namespace Tests\Feature\Mcp;

use App\Jobs\GenerateMapTerrain;
use App\Mcp\EditorBridge;
use App\Mcp\Servers\WaterwaysServer;
use App\Mcp\Tools\AddTerrainLayer;
use App\Mcp\Tools\ApplyBiome;
use App\Mcp\Tools\ControlEditor;
use App\Mcp\Tools\CreateMap;
use App\Mcp\Tools\DeleteTerrainLayer;
use App\Mcp\Tools\GetMap;
use App\Mcp\Tools\GetProjectOverview;
use App\Mcp\Tools\GetSettings;
use App\Mcp\Tools\ManageSnapshots;
use App\Mcp\Tools\RegenerateTerrain;
use App\Mcp\Tools\SaveFoliageType;
use App\Mcp\Tools\TakeScreenshot;
use App\Mcp\Tools\UpdateEnvironment;
use App\Mcp\Tools\UpdateGameSettings;
use App\Mcp\Tools\UpdateTerrainLayer;
use App\Models\AgentCommand;
use App\Models\AgentSession;
use App\Models\Biome;
use App\Models\FoliageType;
use App\Models\Map;
use App\Models\MapSnapshot;
use App\Services\Terrain\TerrainStorage;
use App\Support\DefaultTerrainLayers;
use App\Support\GameSettingsRepository;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

class WaterwaysMcpTest extends TestCase
{
    use RefreshDatabase;

    private function map(): Map
    {
        $map = Map::factory()->create(['resolution' => 65, 'size' => 256]);
        DefaultTerrainLayers::createFor($map);

        return $map;
    }

    private function grass(): FoliageType
    {
        return FoliageType::query()->create([
            'name' => 'Grass', 'kind' => 'grass', 'color' => '#4f7a2a', 'color_secondary' => '#7a9a3a',
            'min_scale' => 0.8, 'max_scale' => 1.2, 'density' => 40, 'max_slope' => 35, 'cull_distance' => 140,
        ]);
    }

    public function test_the_server_lists_every_tool_on_one_page(): void
    {
        $defaults = (new \ReflectionClass(WaterwaysServer::class))->getDefaultProperties();
        $this->assertCount(22, $defaults['tools']);
        $this->assertGreaterThanOrEqual(count($defaults['tools']), $defaults['defaultPaginationLength']);
        WaterwaysServer::tool(GetProjectOverview::class)->assertOk()->assertSee(['"maps"', '"open_editors"']);
    }

    public function test_get_map_describes_layers_terrain_and_editor_state(): void
    {
        Storage::fake('local');
        $map = $this->map();
        $storage = app(TerrainStorage::class);
        $samples = 65 * 65;
        $storage->write($map, 'heightmap', TerrainStorage::packFloats(array_fill(0, $samples, 12.5)));
        // Every sample fully painted with slot 3.
        $storage->write($map, 'splatmap', str_repeat("\0\0\0\xff\0\0\0\0", $samples));

        WaterwaysServer::tool(GetMap::class, ['map' => $map->slug])
            ->assertOk()
            ->assertSee(['"slot_3": 100', '"min": 12.5', '"open": false', 'x runs west → east']);
    }

    public function test_map_tools_default_to_the_map_open_in_the_editor(): void
    {
        $this->map();
        $open = $this->map();
        app(EditorBridge::class)->poll($open, 's1', 'edit', null);

        WaterwaysServer::tool(GetMap::class)->assertOk()->assertSee("\"slug\": \"{$open->slug}\"");
        WaterwaysServer::tool(GetMap::class, ['map' => 'nope'])->assertHasErrors(['No map "nope"']);
    }

    public function test_environment_changes_are_validated_saved_snapshotted_and_pushed_live(): void
    {
        $map = $this->map();
        app(EditorBridge::class)->poll($map, 's1', 'edit', null);

        WaterwaysServer::tool(UpdateEnvironment::class, ['map' => $map->slug, 'values' => ['bogus' => 1]])
            ->assertHasErrors(['Unknown environment fields: bogus']);
        WaterwaysServer::tool(UpdateEnvironment::class, ['map' => $map->slug, 'values' => ['time_of_day' => 99]])
            ->assertHasErrors();
        WaterwaysServer::tool(UpdateEnvironment::class, ['map' => $map->slug, 'values' => ['time_of_day' => 18.5, 'weather' => 'rain']])
            ->assertOk()->assertSee('"live": true');

        $this->assertSame(18.5, $map->refresh()->resolvedEnvironment()['time_of_day']);
        $this->assertSame(1, MapSnapshot::query()->where('map_id', $map->id)->where('auto', true)->count());
        $this->assertSame(['type' => 'refresh', 'payload' => ['parts' => ['environment']]], AgentCommand::query()->sole()->only('type', 'payload'));

        // A second change within the interval takes no new automatic snapshot.
        WaterwaysServer::tool(UpdateEnvironment::class, ['map' => $map->slug, 'values' => ['time_of_day' => 12]])->assertOk();
        $this->assertSame(1, MapSnapshot::query()->count());
    }

    public function test_game_settings_are_validated_and_saved(): void
    {
        WaterwaysServer::tool(UpdateGameSettings::class, ['group' => 'player', 'values' => ['walk_speed' => 4.2]])->assertOk();
        $this->assertSame(4.2, app(GameSettingsRepository::class)->get('player')['walk_speed']);

        WaterwaysServer::tool(UpdateGameSettings::class, ['group' => 'player', 'values' => ['walk_speed' => 999]])->assertHasErrors();
        WaterwaysServer::tool(GetSettings::class, ['group' => 'graphics'])->assertOk()->assertSee('quality_preset');
    }

    public function test_terrain_layers_can_be_edited_added_deleted_and_given_a_biome(): void
    {
        $map = $this->map();
        $grass = $this->grass();

        WaterwaysServer::tool(UpdateTerrainLayer::class, ['map' => $map->slug, 'slot' => 1, 'values' => [
            'tint' => '#ffeedd', 'auto_max_slope' => 12,
            'ground_cover' => [['foliage_type_id' => $grass->id, 'density' => 1.5, 'clustering' => 0.4]],
        ]])->assertOk();

        $layer = $map->layers()->where('slot', 1)->sole();
        $this->assertSame(['#ffeedd', 12.0], [$layer->tint, $layer->auto_max_slope]);
        $this->assertSame(1.5, $layer->groundCover()[0]['density']);
        $this->assertSame('Meadow', $layer->name, 'Unchanged fields stay');

        WaterwaysServer::tool(UpdateTerrainLayer::class, ['map' => $map->slug, 'slot' => 1, 'values' => ['tint' => 'red']])->assertHasErrors();
        WaterwaysServer::tool(UpdateTerrainLayer::class, ['map' => $map->slug, 'slot' => 1, 'values' => ['colour' => '#000000']])->assertHasErrors(['Unknown layer fields: colour']);

        WaterwaysServer::tool(AddTerrainLayer::class, ['map' => $map->slug])->assertHasErrors(['All 8 layer slots are in use']);
        WaterwaysServer::tool(DeleteTerrainLayer::class, ['map' => $map->slug, 'slot' => 7])->assertOk();
        WaterwaysServer::tool(AddTerrainLayer::class, ['map' => $map->slug, 'values' => ['name' => 'Lava']])->assertOk();
        $this->assertSame('Lava', $map->layers()->where('slot', 7)->value('name'));

        $biome = Biome::query()->create(['name' => 'Lawn', 'look' => ['color' => '#224411'], 'ground_cover' => [['foliage_type_id' => $grass->id, 'density' => 2]]]);
        WaterwaysServer::tool(ApplyBiome::class, ['map' => $map->slug, 'slot' => 7, 'biome' => 'Lawn'])->assertOk();
        $this->assertSame(['Lawn', '#224411'], array_values($map->layers()->where('slot', 7)->sole()->only('name', 'color')));
        WaterwaysServer::tool(ApplyBiome::class, ['map' => $map->slug, 'slot' => 7, 'biome' => (string) $biome->id])->assertOk();
    }

    public function test_foliage_types_can_be_created_and_updated(): void
    {
        WaterwaysServer::tool(SaveFoliageType::class, ['values' => ['name' => 'Fern', 'kind' => 'bush']])->assertOk()->assertSee('"name": "Fern"');
        $fern = FoliageType::query()->where('name', 'Fern')->sole();

        WaterwaysServer::tool(SaveFoliageType::class, ['id' => $fern->id, 'values' => ['density' => 12]])->assertOk();
        $this->assertSame([12.0, 'bush'], [$fern->refresh()->density, $fern->kind->value]);

        WaterwaysServer::tool(SaveFoliageType::class, ['id' => $fern->id, 'values' => ['min_scale' => 5]])->assertHasErrors();
        WaterwaysServer::tool(SaveFoliageType::class, ['id' => 999, 'values' => []])->assertHasErrors(['No foliage type 999']);
    }

    public function test_maps_can_be_created_and_regenerated(): void
    {
        Queue::fake();

        WaterwaysServer::tool(CreateMap::class, ['name' => 'Alpine lake', 'source' => 'procedural', 'size' => 2048, 'resolution' => 513, 'seed' => 42])
            ->assertOk()->assertSee('"slug": "alpine-lake"');
        WaterwaysServer::tool(CreateMap::class, ['name' => 'Somewhere', 'source' => 'real_world', 'size' => 2048, 'resolution' => 513])
            ->assertHasErrors();
        Queue::assertPushed(GenerateMapTerrain::class, 1);

        $map = Map::query()->where('slug', 'alpine-lake')->sole();
        WaterwaysServer::tool(RegenerateTerrain::class, ['map' => $map->slug, 'seed' => 7])->assertOk();
        $this->assertSame(7, $map->refresh()->seed);
        $this->assertSame(1, $map->snapshots()->count());
        Queue::assertPushed(GenerateMapTerrain::class, 2);
    }

    public function test_live_tools_explain_when_no_editor_is_open(): void
    {
        $map = $this->map();

        WaterwaysServer::tool(TakeScreenshot::class, ['map' => $map->slug])
            ->assertHasErrors(["Map \"{$map->slug}\" is not open in an editor"]);

        // A session that stopped polling counts as closed.
        AgentSession::query()->create(['id' => 'old', 'map_id' => $map->id, 'last_seen_at' => Carbon::now()->subMinutes(2)]);
        WaterwaysServer::tool(ControlEditor::class, ['map' => $map->slug, 'action' => 'save'])->assertHasErrors(['is not open']);
    }

    public function test_screenshots_and_editor_commands_run_in_the_open_editor(): void
    {
        $map = $this->map();
        $editor = new FakeEditor($map, fn (string $type, array $payload) => match ($type) {
            'screenshot' => ['mime' => 'image/jpeg', 'image' => base64_encode('JPEGDATA'), 'width' => 640, 'height' => 360, 'view_mode' => $payload['view_mode'] ?? 'lit'],
            'save' => ['saved' => ['heightmap'], 'still_unsaved' => []],
            default => [],
        });
        $this->app->instance(EditorBridge::class, $editor);

        WaterwaysServer::tool(TakeScreenshot::class, ['map' => $map->slug, 'view' => 'top_down', 'view_mode' => 'slope'])
            ->assertOk()
            ->assertSee('"width":640');
        $this->assertSame(['view' => 'top_down', 'view_mode' => 'slope', 'keep_camera' => false, 'max_width' => 1280], $editor->ran[0]['payload']);

        WaterwaysServer::tool(ControlEditor::class, ['map' => $map->slug, 'action' => 'save'])->assertOk()->assertSee('heightmap');
        WaterwaysServer::tool(ControlEditor::class, ['map' => $map->slug, 'action' => 'set_view_mode'])->assertHasErrors();
        $this->assertSame(0, AgentCommand::query()->count(), 'Answered commands are removed');
    }

    public function test_the_editor_polls_claims_and_completes_commands_over_http(): void
    {
        $map = $this->map();
        $command = AgentCommand::query()->create(['map_id' => $map->id, 'type' => 'state', 'payload' => []]);

        $this->postJson("/api/maps/{$map->slug}/agent/poll", ['session' => 'a', 'mode' => 'edit', 'state' => ['unsaved' => ['splatmap']]])
            ->assertOk()->assertJsonPath('commands.0.type', 'state');
        // Claimed once: a second tab gets nothing.
        $this->postJson("/api/maps/{$map->slug}/agent/poll", ['session' => 'b', 'mode' => 'edit'])->assertJsonCount(0, 'commands');

        $this->postJson("/api/maps/{$map->slug}/agent/commands/{$command->id}", ['ok' => true, 'result' => ['fps' => 60]])->assertOk();
        $this->assertSame(['done', '{"fps":60}'], array_values($command->refresh()->only('status', 'result')));
        $this->assertSame(['splatmap'], app(EditorBridge::class)->session($map)?->state['unsaved'] ?? null);

        $other = $this->map();
        $this->postJson("/api/maps/{$other->slug}/agent/commands/{$command->id}", ['ok' => true])->assertNotFound();
    }

    public function test_snapshots_restore_assets_layers_and_settings(): void
    {
        Storage::fake('local');
        $map = $this->map();
        $storage = app(TerrainStorage::class);
        $samples = 65 * 65;
        $storage->write($map, 'heightmap', TerrainStorage::packFloats(array_fill(0, $samples, 5.0)));
        $grass = $this->grass();
        $map->layers()->where('slot', 0)->sole()->update(['ground_cover' => [['foliage_type_id' => $grass->id, 'density' => 1]]]);

        WaterwaysServer::tool(ManageSnapshots::class, ['map' => $map->slug, 'action' => 'create', 'label' => 'Before'])->assertOk();
        $snapshot = $map->snapshots()->sole();

        $storage->write($map, 'heightmap', TerrainStorage::packFloats(array_fill(0, $samples, 50.0)));
        $storage->write($map, 'water', TerrainStorage::packFloats(array_fill(0, $samples, 1.0)));
        $map->layers()->where('slot', 0)->sole()->update(['name' => 'Changed', 'ground_cover' => []]);
        $map->update(['environment' => ['time_of_day' => 3]]);

        // An editor with unsaved edits blocks the restore unless they may be dropped.
        app(EditorBridge::class)->poll($map, 's1', 'edit', ['unsaved' => ['foliage']]);
        WaterwaysServer::tool(ManageSnapshots::class, ['map' => $map->slug, 'action' => 'restore', 'snapshot_id' => $snapshot->id])
            ->assertHasErrors(['unsaved changes (foliage)']);
        WaterwaysServer::tool(ManageSnapshots::class, ['map' => $map->slug, 'action' => 'restore', 'snapshot_id' => $snapshot->id, 'discard_unsaved' => true])
            ->assertOk()->assertSee('"editor_reloaded": true');

        $this->assertSame(5.0, TerrainStorage::unpackFloats($storage->read($map, 'heightmap'))[0]);
        $this->assertFalse($storage->exists($map, 'water'));
        $layer = $map->layers()->where('slot', 0)->sole();
        $this->assertSame('Grass', $layer->name);
        $this->assertSame($grass->id, $layer->groundCover()[0]['foliage_type_id']);
        $this->assertSame(15.5, $map->refresh()->resolvedEnvironment()['time_of_day']);
        // The state before the restore was kept as a restore point too.
        $this->assertSame(2, $map->snapshots()->count());
    }

    public function test_the_http_endpoint_requires_the_token(): void
    {
        $this->postJson('/mcp', ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'ping'])->assertNotFound();
    }
}
