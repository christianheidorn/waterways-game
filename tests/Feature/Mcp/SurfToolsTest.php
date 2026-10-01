<?php

namespace Tests\Feature\Mcp;

use App\Mcp\EditorBridge;
use App\Mcp\Servers\WaterwaysServer;
use App\Mcp\Tools\EditWaterBody;
use App\Mcp\Tools\PaintSurf;
use App\Models\Map;
use App\Services\Terrain\TerrainStorage;
use App\Support\DefaultTerrainLayers;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

/**
 * Beaches (docs/ROADMAP.md phase 11): paint_surf, the surf settings of edit_water_body and the stored
 * surf.u8 asset.
 */
class SurfToolsTest extends TestCase
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
            'result' => ['echo' => $payload['kind'] ?? $type, 'mode' => $payload['action'] ?? null, 'shoreline_with_surf_m' => 120],
            'unsaved' => [],
        ]);
        $this->app->instance(EditorBridge::class, $this->editor);
    }

    /** @return array{type: string, payload: array<string, mixed>} */
    private function last(): array
    {
        return end($this->editor->ran);
    }

    public function test_paint_surf_runs_a_world_edit_with_the_shape(): void
    {
        $shape = ['type' => 'path', 'points' => [['x' => -40, 'z' => 10], ['x' => 40, 'z' => 12]], 'width' => 16];

        WaterwaysServer::tool(PaintSurf::class, ['shape' => $shape, 'strength' => 0.6])
            ->assertOk()
            ->assertSee('"echo": "surf"')
            ->assertSee('"shoreline_with_surf_m": 120');

        $run = $this->last();
        $this->assertSame('world_edit', $run['type']);
        $this->assertSame('surf', $run['payload']['kind']);
        $this->assertSame('on', $run['payload']['action']);
        $this->assertSame('path', $run['payload']['shape']['type']);
        $this->assertEquals(['strength' => 0.6], $run['payload']['params']);
        $this->assertTrue($run['payload']['save']);

        WaterwaysServer::tool(PaintSurf::class, ['shape' => ['type' => 'circle', 'center' => ['x' => 0, 'z' => 0], 'radius' => 30], 'mode' => 'off', 'save' => false])->assertOk();
        $this->assertSame('off', $this->last()['payload']['action']);
        $this->assertSame([], $this->last()['payload']['params']);
        $this->assertFalse($this->last()['payload']['save']);

        WaterwaysServer::tool(PaintSurf::class, ['shape' => ['type' => 'map'], 'mode' => 'auto'])->assertOk();
        $this->assertSame('auto', $this->last()['payload']['action']);
    }

    public function test_paint_surf_is_validated(): void
    {
        WaterwaysServer::tool(PaintSurf::class, ['mode' => 'on'])->assertHasErrors();
        WaterwaysServer::tool(PaintSurf::class, ['shape' => ['type' => 'map'], 'mode' => 'loud'])->assertHasErrors();
        WaterwaysServer::tool(PaintSurf::class, ['shape' => ['type' => 'map'], 'strength' => 3])->assertHasErrors();
        WaterwaysServer::tool(PaintSurf::class, ['shape' => ['type' => 'path', 'points' => [['x' => 0, 'z' => 0]], 'width' => 5]])->assertHasErrors();
        $this->assertSame([], $this->editor->ran);
    }

    public function test_edit_water_body_passes_the_surf_settings(): void
    {
        WaterwaysServer::tool(EditWaterBody::class, [
            'action' => 'update',
            'id' => 'wb1',
            'settings' => ['surf' => true, 'surf_height' => 1.2, 'surf_period' => 9, 'surf_direction' => null],
        ])->assertOk();

        $this->assertEquals(
            ['surf' => true, 'surf_height' => 1.2, 'surf_period' => 9, 'surf_direction' => null],
            $this->last()['payload']['params'],
        );

        WaterwaysServer::tool(EditWaterBody::class, ['action' => 'update', 'id' => 'wb1', 'settings' => ['surf_height' => 5]])->assertHasErrors();
        WaterwaysServer::tool(EditWaterBody::class, ['action' => 'update', 'id' => 'wb1', 'settings' => ['surf_period' => 0.5]])->assertHasErrors();
        WaterwaysServer::tool(EditWaterBody::class, ['action' => 'update', 'id' => 'wb1', 'settings' => ['surf_direction' => 400]])->assertHasErrors();
    }

    public function test_the_surf_asset_round_trips_and_is_in_the_manifest(): void
    {
        $bytes = str_repeat(chr(0), 65 * 65 - 2).chr(1).chr(255);

        $this->call('PUT', "/api/maps/{$this->map->slug}/assets/surf", [], [], [], ['CONTENT_TYPE' => 'application/octet-stream'], $bytes)->assertOk();
        $this->assertSame($bytes, $this->get("/api/maps/{$this->map->slug}/assets/surf")->getContent());
        $this->call('PUT', "/api/maps/{$this->map->slug}/assets/surf", [], [], [], ['CONTENT_TYPE' => 'application/octet-stream'], 'short')
            ->assertStatus(422);

        $this->getJson("/api/maps/{$this->map->slug}/manifest")
            ->assertOk()
            ->assertJsonPath('endpoints.save_surf', route('api.maps.assets.update', [$this->map, 'surf']))
            ->assertJsonPath('assets.surf', fn ($url) => str_contains((string) $url, '/assets/surf'));
    }
}
