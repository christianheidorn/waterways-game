<?php

namespace Tests\Feature\Mcp;

use App\Mcp\EditorBridge;
use App\Mcp\MapSnapshots;
use App\Mcp\Servers\WaterwaysServer;
use App\Mcp\Tools\ApplyStamp;
use App\Mcp\Tools\ControlEditor;
use App\Mcp\Tools\ControlPlayer;
use App\Mcp\Tools\EditRoad;
use App\Mcp\Tools\EditWater;
use App\Mcp\Tools\PlaceProps;
use App\Mcp\Tools\UpdateProps;
use App\Models\Map;
use App\Models\PropModel;
use App\Services\Terrain\TerrainStorage;
use App\Support\DefaultTerrainLayers;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

/**
 * Building I (docs/ROADMAP.md phase 3): roads and rivers as editable splines, landscape stamps, prop
 * snapping and walk mode over MCP.
 */
class BuildingToolsTest extends TestCase
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
        $this->editor = new FakeEditor($this->map, fn (string $type, array $payload) => ['result' => ['echo' => $payload['kind'] ?? $type], 'unsaved' => []]);
        $this->app->instance(EditorBridge::class, $this->editor);
    }

    /** @return array{type: string, payload: array<string, mixed>} */
    private function last(): array
    {
        return end($this->editor->ran);
    }

    private function saveSplines(): void
    {
        app(TerrainStorage::class)->write($this->map, 'splines', json_encode([
            'version' => 1,
            'roads' => [[
                'id' => 'rabc', 'name' => 'Road 1', 'points' => [['x' => 0, 'z' => 0], ['x' => 30, 'z' => 40]],
                'width' => 8, 'profile' => 'road', 'layer' => 6, 'shoulder' => 6, 'bank' => 0.4, 'smoothing' => 60,
                'clear_foliage' => true, 'footprint' => ['cells' => 'AAAA', 'heights' => 'AAAA'],
            ]],
            'rivers' => [[
                'id' => 'wxyz', 'name' => 'River 1', 'points' => [['x' => -50, 'z' => 0], ['x' => 50, 'z' => 0]],
                'width' => 10, 'depth' => 2, 'bank' => 8, 'footprint' => null,
            ]],
        ]));
    }

    public function test_edit_road_creates_a_road_with_a_named_layer(): void
    {
        WaterwaysServer::tool(EditRoad::class, [
            'action' => 'create',
            'points' => [['x' => -40, 'z' => 10], ['x' => 0, 'z' => 0], ['x' => 40, 'z' => 20]],
            'profile' => 'track',
            'width' => 5,
            'layer' => 'Gravel',
        ])->assertOk()->assertSee('"echo": "road"');

        $run = $this->last();
        $this->assertEquals('world_edit', $run['type']);
        $this->assertEquals('road', $run['payload']['kind']);
        $this->assertEquals('create', $run['payload']['action']);
        $this->assertEquals(6, $run['payload']['road']['layer']);
        $this->assertEquals('track', $run['payload']['road']['profile']);
        $this->assertEquals(5.0, $run['payload']['road']['width']);
        $this->assertCount(3, $run['payload']['road']['points']);
    }

    public function test_edit_road_updates_deletes_and_validates(): void
    {
        WaterwaysServer::tool(EditRoad::class, ['action' => 'update', 'id' => 'rabc', 'width' => 12, 'layer' => 'none'])->assertOk();
        $this->assertEquals(['width' => 12.0, 'layer' => null], $this->last()['payload']['road']);
        $this->assertEquals('rabc', $this->last()['payload']['id']);

        WaterwaysServer::tool(EditRoad::class, ['action' => 'delete', 'id' => 'rabc'])->assertOk();
        $this->assertEquals('delete', $this->last()['payload']['action']);

        $count = count($this->editor->ran);
        WaterwaysServer::tool(EditRoad::class, ['action' => 'update', 'id' => 'rabc'])->assertHasErrors(['Nothing to change']);
        WaterwaysServer::tool(EditRoad::class, ['action' => 'create', 'points' => [['x' => 0, 'z' => 0], ['x' => 5, 'z' => 5]], 'layer' => 'Lava'])->assertHasErrors(['No layer "Lava"']);
        WaterwaysServer::tool(EditRoad::class, ['action' => 'create', 'points' => [['x' => 0, 'z' => 0]]])->assertHasErrors();
        $this->assertCount($count, $this->editor->ran, 'Invalid calls never reach the editor.');
    }

    public function test_roads_and_rivers_are_listed_from_the_saved_map_without_an_editor(): void
    {
        $this->saveSplines();
        $count = count($this->editor->ran);

        WaterwaysServer::tool(EditRoad::class, ['action' => 'list'])
            ->assertOk()
            ->assertSee(['"id": "rabc"', '"profile": "road"', '"length_m": 50'])
            ->assertDontSee('footprint');
        WaterwaysServer::tool(EditWater::class, ['action' => 'list_rivers'])
            ->assertOk()
            ->assertSee(['"id": "wxyz"', '"depth": 2', '"length_m": 100']);
        $this->assertCount($count, $this->editor->ran);
    }

    public function test_rivers_are_created_and_edited_as_splines(): void
    {
        WaterwaysServer::tool(EditWater::class, [
            'action' => 'river',
            'shape' => ['type' => 'path', 'points' => [['x' => -60, 'z' => 0], ['x' => 60, 'z' => 10]], 'width' => 12, 'falloff' => 6],
            'depth' => 3,
            'name' => 'Brook',
        ])->assertOk();
        $this->assertEquals(['depth' => 3.0, 'name' => 'Brook'], $this->last()['payload']['params']);

        WaterwaysServer::tool(EditWater::class, ['action' => 'update_river', 'id' => 'wxyz', 'width' => 20, 'depth' => 4])->assertOk();
        $payload = $this->last()['payload'];
        $this->assertEquals('update_river', $payload['action']);
        $this->assertEquals('wxyz', $payload['id']);
        $this->assertEquals(['width' => 20.0, 'depth' => 4.0], $payload['params']);
        $this->assertArrayNotHasKey('shape', $payload);

        WaterwaysServer::tool(EditWater::class, [
            'action' => 'update_river', 'id' => 'wxyz',
            'shape' => ['type' => 'path', 'points' => [['x' => 0, 'z' => 0], ['x' => 10, 'z' => 50]], 'width' => 8],
        ])->assertOk();
        $this->assertEquals('path', $this->last()['payload']['shape']['type']);

        WaterwaysServer::tool(EditWater::class, ['action' => 'delete_river', 'id' => 'wxyz'])->assertOk();
        $this->assertEquals('delete_river', $this->last()['payload']['action']);

        WaterwaysServer::tool(EditWater::class, ['action' => 'update_river', 'id' => 'wxyz'])->assertHasErrors(['Nothing to change']);
    }

    public function test_apply_stamp_sends_the_landform(): void
    {
        WaterwaysServer::tool(ApplyStamp::class, [
            'shape' => 'volcano', 'x' => 10, 'z' => -20, 'radius' => 90, 'height' => 60,
            'rotation' => 30, 'blend' => 'max', 'seed' => 7,
        ])->assertOk();

        $this->assertEquals([
            'shape' => 'volcano', 'x' => 10.0, 'z' => -20.0, 'radius' => 90.0, 'height' => 60.0,
            'rotation' => 30.0, 'blend' => 'max', 'seed' => 7,
        ], $this->last()['payload']['params']);
        $this->assertEquals('stamp', $this->last()['payload']['kind']);

        WaterwaysServer::tool(ApplyStamp::class, ['shape' => 'pyramid', 'x' => 0, 'z' => 0, 'radius' => 50, 'height' => 10])->assertHasErrors();
    }

    public function test_place_props_snaps_and_places_rows_along_a_path(): void
    {
        $fence = PropModel::factory()->create(['name' => 'Fence']);

        WaterwaysServer::tool(PlaceProps::class, [
            'placements' => [['model' => 'Fence', 'x' => 1.2, 'z' => 3.9, 'align' => true]],
            'snap' => ['grid' => 2, 'edges' => true],
        ])->assertOk();
        $payload = $this->last()['payload'];
        $this->assertEquals(['grid' => 2.0, 'edges' => true], $payload['snap']);
        $this->assertTrue($payload['placements'][0]['align']);

        WaterwaysServer::tool(PlaceProps::class, [
            'along' => ['model' => 'Fence', 'points' => [['x' => 0, 'z' => 0], ['x' => 20, 'z' => 0], ['x' => 20, 'z' => 15]], 'spacing' => 2.5, 'align' => true],
        ])->assertOk();
        $payload = $this->last()['payload'];
        $this->assertEquals('along', $payload['action']);
        $this->assertEquals($fence->id, $payload['along']['model']);
        $this->assertEquals(2.5, $payload['along']['spacing']);
        $this->assertCount(3, $payload['along']['points']);
        $this->assertEquals($fence->id, $payload['prop_models'][0]['id']);
    }

    public function test_update_props_tilts_and_snaps_to_a_grid(): void
    {
        WaterwaysServer::tool(UpdateProps::class, ['updates' => [['id' => 'a', 'align' => true]]])->assertOk();
        $this->assertEquals([['id' => 'a', 'align' => true]], $this->last()['payload']['updates']);

        WaterwaysServer::tool(UpdateProps::class, ['ids' => ['a', 'b'], 'change' => ['align' => false, 'snap_grid' => 1]])->assertOk();
        $this->assertEquals(['align' => false, 'snap_grid' => 1], $this->last()['payload']['change']);
    }

    public function test_walk_mode_is_driven_through_control_editor(): void
    {
        WaterwaysServer::tool(ControlEditor::class, ['action' => 'walk', 'x' => 12, 'z' => -4, 'facing' => 90])->assertOk();
        $run = $this->last();
        $this->assertEquals('walk', $run['type']);
        $this->assertEquals(['x' => 12.0, 'z' => -4.0, 'facing' => 90.0], $run['payload']);

        WaterwaysServer::tool(ControlEditor::class, ['action' => 'walk', 'walk' => false])->assertOk();
        $this->assertEquals(['walk' => false], $this->last()['payload']);

        // control_player then drives the walking character.
        WaterwaysServer::tool(ControlPlayer::class, ['action' => 'walk_to', 'x' => 20, 'z' => 5])->assertOk();
        $this->assertEquals('player', $this->last()['type']);
    }

    public function test_splines_are_a_map_asset_saved_by_the_game_and_kept_in_snapshots(): void
    {
        $this->getJson("/api/maps/{$this->map->slug}/manifest")
            ->assertOk()
            ->assertJsonPath('assets.splines', null)
            ->assertJsonStructure(['endpoints' => ['save_splines']]);

        $body = '{"version":1,"roads":[],"rivers":[]}';
        $this->call('PUT', "/api/maps/{$this->map->slug}/assets/splines", [], [], [], ['CONTENT_TYPE' => 'application/json'], $body)->assertOk();
        $this->assertEquals($body, $this->get("/api/maps/{$this->map->slug}/assets/splines")->assertHeader('Content-Type', 'application/json')->getContent());
        $this->call('PUT', "/api/maps/{$this->map->slug}/assets/splines", [], [], [], ['CONTENT_TYPE' => 'application/json'], '{"roads":[]}')->assertStatus(422);

        $snapshot = app(MapSnapshots::class)->create($this->map->fresh(), 'test');
        $this->assertContains('splines', $snapshot->data['assets']);
    }
}
