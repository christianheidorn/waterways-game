<?php

namespace Tests\Feature\Mcp;

use App\Mcp\EditorBridge;
use App\Mcp\Servers\WaterwaysServer;
use App\Mcp\Tools\EditWaterBody;
use App\Mcp\Tools\GetMap;
use App\Models\Map;
use App\Services\Terrain\TerrainStorage;
use App\Support\DefaultTerrainLayers;
use App\Support\EnvironmentDefaults;
use App\Support\GameSettingsSchema;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

/**
 * Water bodies and waves (docs/ROADMAP.md phase 10): per-body settings over MCP (edit_water_body), the
 * stored water_bodies.json asset, the get_map summary and the wave settings.
 */
class WaterBodyToolsTest extends TestCase
{
    use RefreshDatabase;

    private Map $map;

    private FakeEditor $editor;

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('local');
        $this->map = Map::factory()->create(['resolution' => 65, 'size' => 256]);
        DefaultTerrainLayers::createFor($this->map);
        app(TerrainStorage::class)->write($this->map, 'heightmap', TerrainStorage::packFloats(array_fill(0, 65 * 65, 10.0)));
        $this->editor = new FakeEditor($this->map, fn (string $type, array $payload) => [
            'result' => ['echo' => $payload['kind'] ?? $type, 'action' => $payload['action'] ?? null, 'bodies' => [['id' => 'wb1']]],
            'unsaved' => [],
        ]);
        $this->app->instance(EditorBridge::class, $this->editor);
    }

    /** @return array{type: string, payload: array<string, mixed>} */
    private function last(): array
    {
        return end($this->editor->ran);
    }

    private function saveBodies(Map $map): void
    {
        app(TerrainStorage::class)->write($map, 'water_bodies', json_encode([
            'version' => 1,
            'bodies' => [
                ['id' => 'wb1', 'seed' => [10, 20], 'centroid' => [12, 18], 'kind_auto' => 'lake', 'area' => 52000, 'level' => 4.5,
                    'name' => '', 'kind' => null, 'wind_exposure' => 1, 'fetch' => null, 'wave_height' => 1.5, 'choppiness' => 1,
                    'shallow_color' => null, 'deep_color' => null, 'clarity' => null, 'surf' => false],
                ['id' => 'wb2', 'seed' => [-80, 60], 'centroid' => [-80, 60], 'kind_auto' => 'pond', 'area' => 900, 'level' => 7,
                    'name' => 'Mill pond', 'kind' => null, 'wind_exposure' => 0.4, 'fetch' => null, 'wave_height' => 1, 'choppiness' => 1,
                    'shallow_color' => '#335544', 'deep_color' => null, 'clarity' => 2, 'surf' => false],
            ],
        ]));
    }

    public function test_update_runs_a_world_edit_in_the_editor(): void
    {
        WaterwaysServer::tool(EditWaterBody::class, [
            'action' => 'update',
            'id' => 'wb1',
            'settings' => ['wave_height' => 2.5, 'choppiness' => 1.4, 'deep_color' => '#102030', 'clarity' => null, 'kind' => 'lake', 'bogus' => 1],
        ])->assertOk()->assertSee('"echo": "water_body"');

        $run = $this->last();
        $this->assertSame('world_edit', $run['type']);
        $this->assertSame('water_body', $run['payload']['kind']);
        $this->assertSame('update', $run['payload']['action']);
        $this->assertSame('wb1', $run['payload']['id']);
        $this->assertTrue($run['payload']['save']);
        $this->assertEquals(['wave_height' => 2.5, 'choppiness' => 1.4, 'deep_color' => '#102030', 'clarity' => null, 'kind' => 'lake'], $run['payload']['params']);

        // By point, without saving.
        WaterwaysServer::tool(EditWaterBody::class, ['action' => 'update', 'point' => ['x' => 5, 'z' => -3], 'settings' => ['surf' => true], 'save' => false])->assertOk();
        $this->assertEquals(['x' => 5, 'z' => -3], $this->last()['payload']['point']);
        $this->assertFalse($this->last()['payload']['save']);
    }

    public function test_update_is_validated(): void
    {
        WaterwaysServer::tool(EditWaterBody::class, ['action' => 'update', 'id' => 'wb1', 'settings' => ['wave_height' => 9]])->assertHasErrors();
        WaterwaysServer::tool(EditWaterBody::class, ['action' => 'update', 'id' => 'wb1', 'settings' => ['shallow_color' => 'blue']])->assertHasErrors();
        WaterwaysServer::tool(EditWaterBody::class, ['action' => 'update', 'id' => 'wb1', 'settings' => ['kind' => 'swamp']])->assertHasErrors();
        WaterwaysServer::tool(EditWaterBody::class, ['action' => 'update', 'settings' => ['surf' => true]])->assertHasErrors(['Give the body id']);
        WaterwaysServer::tool(EditWaterBody::class, ['action' => 'update', 'id' => 'wb1', 'settings' => ['nope' => 1]])->assertHasErrors(['Nothing to change']);
        $this->assertSame([], $this->editor->ran);
    }

    public function test_list_and_get_read_the_open_editor_without_saving(): void
    {
        WaterwaysServer::tool(EditWaterBody::class, ['action' => 'list'])
            ->assertOk()
            ->assertSee('"source": "editor"')
            ->assertSee('"id": "wb1"');

        $run = $this->last();
        $this->assertSame('world_edit', $run['type']);
        $this->assertSame('list', $run['payload']['action']);
        $this->assertFalse($run['payload']['save']);

        WaterwaysServer::tool(EditWaterBody::class, ['action' => 'get', 'id' => 'wb2'])->assertOk();
        $this->assertSame('wb2', $this->last()['payload']['id']);
    }

    public function test_list_and_get_read_the_saved_bodies_without_an_editor(): void
    {
        $other = Map::factory()->create(['resolution' => 65, 'size' => 256]);
        $this->saveBodies($other);

        WaterwaysServer::tool(EditWaterBody::class, ['map' => $other->slug, 'action' => 'list'])
            ->assertOk()
            ->assertSee('"source": "saved"')
            ->assertSee('"count": 2')
            ->assertSee('"name": "Mill pond"')
            ->assertSee('"name": "Lake wb1"')
            ->assertSee('"wave_height": 1.5');

        WaterwaysServer::tool(EditWaterBody::class, ['map' => $other->slug, 'action' => 'get', 'id' => 'wb2'])
            ->assertOk()
            ->assertSee('"kind": "pond"')
            ->assertSee('"shallow_color": "#335544"');
        WaterwaysServer::tool(EditWaterBody::class, ['map' => $other->slug, 'action' => 'get', 'point' => ['x' => -70, 'z' => 55]])
            ->assertOk()
            ->assertSee('"id": "wb2"');
        WaterwaysServer::tool(EditWaterBody::class, ['map' => $other->slug, 'action' => 'get', 'id' => 'wb9'])->assertHasErrors(['no water body "wb9"']);
        $this->assertSame([], $this->editor->ran);
    }

    public function test_get_map_summarises_the_saved_water_bodies(): void
    {
        $this->saveBodies($this->map);

        WaterwaysServer::tool(GetMap::class, ['map' => $this->map->slug])
            ->assertOk()
            ->assertSee('"water_bodies"')
            ->assertSee('"lake": 1')
            ->assertSee('"pond": 1')
            ->assertSee('"name": "Mill pond"');
    }

    public function test_the_water_bodies_asset_round_trips_and_is_in_the_manifest(): void
    {
        $this->map->update(['terrain_status' => 'ready']);
        $json = json_encode(['version' => 1, 'bodies' => [['id' => 'wb1', 'seed' => [0, 0], 'wave_height' => 2]]]);

        $this->call('PUT', "/api/maps/{$this->map->slug}/assets/water_bodies", [], [], [], ['CONTENT_TYPE' => 'application/json'], $json)->assertOk();
        $this->assertSame($json, $this->get("/api/maps/{$this->map->slug}/assets/water_bodies")->getContent());
        $this->call('PUT', "/api/maps/{$this->map->slug}/assets/water_bodies", [], [], [], ['CONTENT_TYPE' => 'application/json'], '{"nope":1}')
            ->assertStatus(422);

        $this->getJson("/api/maps/{$this->map->slug}/manifest")
            ->assertOk()
            ->assertJsonPath('endpoints.save_water_bodies', route('api.maps.assets.update', [$this->map, 'water_bodies']))
            ->assertJsonPath('assets.water_bodies', fn ($url) => str_contains((string) $url, '/assets/water_bodies'));
    }

    public function test_wave_settings_exist_with_presets(): void
    {
        $graphics = GameSettingsSchema::group('graphics')->defaults();
        $this->assertSame('fft', $graphics['water_waves']);

        $env = EnvironmentDefaults::group()->defaults();
        $this->assertEquals(1, $env['whitecaps']);
        $this->assertEquals(1, $env['water_subsurface']);
        $this->assertEquals(0.15, $env['wave_height']);
    }

    public function test_the_tool_is_registered_and_documented(): void
    {
        $this->assertContains(EditWaterBody::class, (new \ReflectionClass(\App\Mcp\Servers\WaterwaysServer::class))->getDefaultProperties()['tools']);
        $this->assertStringContainsString('edit_water_body', (string) file_get_contents(base_path('docs/MCP.md')));
    }
}
