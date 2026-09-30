<?php

namespace Tests\Feature\Mcp;

use App\Mcp\EditorBridge;
use App\Mcp\Servers\WaterwaysServer;
use App\Mcp\Tools\EditFoliage;
use App\Mcp\Tools\EditWater;
use App\Mcp\Tools\GetMapImage;
use App\Mcp\Tools\ListProps;
use App\Mcp\Tools\PaintTerrain;
use App\Mcp\Tools\PlaceProps;
use App\Mcp\Tools\RemoveProps;
use App\Mcp\Tools\SampleTerrain;
use App\Mcp\Tools\SculptTerrain;
use App\Models\FoliageType;
use App\Models\Map;
use App\Models\PropModel;
use App\Services\Terrain\TerrainStorage;
use App\Support\DefaultTerrainLayers;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

class WorldBuildingToolsTest extends TestCase
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
        $storage = app(TerrainStorage::class);
        $heights = [];
        $water = [];
        $splat = '';

        // Ground rising west → east (10 → 42 m), a pond in the north-west corner, east half painted slot 3.
        for ($row = 0; $row < 65; $row++) {
            for ($col = 0; $col < 65; $col++) {
                $heights[] = 10 + $col * 0.5;
                $water[] = $col < 8 && $row < 8 ? 15.0 : TerrainStorage::NO_WATER;
                $splat .= $col >= 32 ? "\0\0\0\xff\0\0\0\0" : "\xff\0\0\0\0\0\0\0";
            }
        }

        $storage->write($this->map, 'heightmap', TerrainStorage::packFloats($heights));
        $storage->write($this->map, 'water', TerrainStorage::packFloats($water));
        $storage->write($this->map, 'splatmap', $splat);

        $this->editor = new FakeEditor($this->map, fn (string $type, array $payload) => ['result' => ['echo' => $payload['kind'] ?? null], 'unsaved' => []]);
        $this->app->instance(EditorBridge::class, $this->editor);
    }

    private function lastEdit(): array
    {
        $edit = end($this->editor->ran);
        $this->assertSame('world_edit', $edit['type']);

        return $edit['payload'];
    }

    public function test_placing_many_heavy_or_vegetation_props_warns_about_performance(): void
    {
        $pine = PropModel::factory()->create(['name' => 'Pine', 'triangles' => 180000, 'meshes' => 2, 'materials' => 2]);
        $hut = PropModel::factory()->create(['name' => 'Hut', 'triangles' => 4000, 'meshes' => 1, 'materials' => 1]);
        app(TerrainStorage::class)->write($this->map, 'props', json_encode(['version' => 1, 'props' => array_map(
            fn ($i) => ['id' => "p{$i}", 'model' => $pine->id, 'x' => $i, 'z' => 0, 'yaw' => 0, 'scale' => 1, 'offset' => 0],
            range(1, 40),
        )]));

        WaterwaysServer::tool(PlaceProps::class, [
            'shape' => ['type' => 'circle', 'center' => ['x' => 0, 'z' => 0], 'radius' => 50],
            'models' => ['Pine'], 'count' => 20,
        ])->assertOk()->assertSee(['performance_warnings', '40 copies of prop \"Pine\"', 'foliage', 'profile_performance']);

        WaterwaysServer::tool(PlaceProps::class, ['placements' => [['model' => 'Hut', 'x' => 5, 'z' => 6]]])
            ->assertOk()->assertDontSee('performance_warnings');
    }

    public function test_sculpt_sends_a_normalised_shape_and_operation_to_the_editor(): void
    {
        WaterwaysServer::tool(SculptTerrain::class, [
            'shape' => ['type' => 'circle', 'center' => ['x' => 10, 'z' => '-20'], 'radius' => 40, 'falloff' => 15],
            'operation' => 'hill', 'height' => 30, 'profile' => 'plateau',
        ])->assertOk()->assertSee('"echo": "sculpt"');

        $this->assertEquals([
            'kind' => 'sculpt',
            'shape' => ['type' => 'circle', 'center' => ['x' => 10.0, 'z' => -20.0], 'radius' => 40.0, 'falloff' => 15.0],
            'params' => ['op' => 'hill', 'height' => 30.0, 'profile' => 'plateau'],
            'save' => true,
        ], $this->lastEdit());
        $this->assertSame(1, $this->map->snapshots()->count(), 'Snapshot before the first edit');

        WaterwaysServer::tool(SculptTerrain::class, [
            'shape' => ['type' => 'map'], 'operation' => 'lower', 'amount' => 5, 'save' => false,
        ])->assertOk();
        $this->assertEquals(['op' => 'raise', 'amount' => -5.0], $this->lastEdit()['params']);
        $this->assertFalse($this->lastEdit()['save']);
    }

    public function test_shapes_and_operations_are_validated(): void
    {
        $cases = [
            [['type' => 'polygon', 'points' => [['x' => 0, 'z' => 0], ['x' => 1, 'z' => 1]]], 'raise', 'at least 3 points'],
            [['type' => 'path', 'points' => [['x' => 0, 'z' => 0], ['x' => 50, 'z' => 0]]], 'raise', 'shape.width'],
            [['type' => 'rect', 'min' => ['x' => 10, 'z' => 10], 'max' => ['x' => 5, 'z' => 20]], 'raise', 'shape.max.x'],
            [['type' => 'blob'], 'raise', 'shape.type'],
            [['type' => 'circle', 'center' => ['x' => 0, 'z' => 0], 'radius' => 10], 'grade', 'grade needs a path'],
        ];

        foreach ($cases as [$shape, $operation, $message]) {
            WaterwaysServer::tool(SculptTerrain::class, ['shape' => $shape, 'operation' => $operation, 'amount' => 1])
                ->assertHasErrors([$message]);
        }

        WaterwaysServer::tool(SculptTerrain::class, ['shape' => ['type' => 'map'], 'operation' => 'terrace'])->assertHasErrors(['step']);
        $this->assertSame([], array_filter($this->editor->ran, fn ($c) => $c['type'] === 'world_edit'));
    }

    public function test_paint_resolves_layers_by_slot_or_name(): void
    {
        $shape = ['type' => 'rect', 'min' => ['x' => -50, 'z' => -50], 'max' => ['x' => 50, 'z' => 50], 'falloff' => 10];

        WaterwaysServer::tool(PaintTerrain::class, ['shape' => $shape, 'layer' => 'rock', 'min_slope' => 30, 'breakup' => 0.4])->assertOk();
        $this->assertEquals(['slot' => 3, 'min_slope' => 30.0, 'breakup' => 0.4, 'mode' => 'paint'], $this->lastEdit()['params']);

        WaterwaysServer::tool(PaintTerrain::class, ['shape' => $shape, 'layer' => 4, 'mode' => 'erase'])->assertOk();
        $this->assertSame(['slot' => 4, 'mode' => 'erase'], $this->lastEdit()['params']);

        WaterwaysServer::tool(PaintTerrain::class, ['shape' => $shape, 'layer' => 'lava'])->assertHasErrors(['No layer "lava"']);
    }

    public function test_water_actions(): void
    {
        WaterwaysServer::tool(EditWater::class, ['action' => 'lake', 'point' => ['x' => 0, 'z' => 0], 'level' => 25])->assertOk();
        $this->assertEquals(['kind' => 'water', 'action' => 'lake', 'params' => ['point' => ['x' => 0.0, 'z' => 0.0], 'level' => 25.0], 'save' => true], $this->lastEdit());

        $path = ['type' => 'path', 'points' => [['x' => 100, 'z' => 0], ['x' => -100, 'z' => 10]], 'width' => 8, 'falloff' => 6];
        WaterwaysServer::tool(EditWater::class, ['action' => 'river', 'shape' => $path, 'depth' => 3])->assertOk();
        $this->assertEquals(['depth' => 3.0], $this->lastEdit()['params']);

        WaterwaysServer::tool(EditWater::class, ['action' => 'lake'])->assertHasErrors(['point']);
        WaterwaysServer::tool(EditWater::class, ['action' => 'river', 'shape' => ['type' => 'circle', 'center' => ['x' => 0, 'z' => 0], 'radius' => 5]])
            ->assertHasErrors(['needs a path']);
    }

    public function test_foliage_types_are_resolved_by_name(): void
    {
        $oak = FoliageType::query()->create([
            'name' => 'Oak', 'kind' => 'broadleaf', 'color' => '#335522', 'color_secondary' => '#443322',
            'min_scale' => 0.8, 'max_scale' => 1.2, 'density' => 0.4, 'max_slope' => 30, 'cull_distance' => 1500,
        ]);
        $shape = ['type' => 'circle', 'center' => ['x' => 0, 'z' => 0], 'radius' => 60];

        WaterwaysServer::tool(EditFoliage::class, ['action' => 'scatter', 'shape' => $shape, 'types' => ['oak'], 'clustering' => 0.6])->assertOk();
        $this->assertEquals(['type_ids' => [$oak->id], 'clustering' => 0.6], $this->lastEdit()['params']);

        WaterwaysServer::tool(EditFoliage::class, ['action' => 'clear', 'shape' => $shape])->assertOk();
        $this->assertSame([], $this->lastEdit()['params']);

        WaterwaysServer::tool(EditFoliage::class, ['action' => 'scatter', 'shape' => $shape, 'types' => ['Baobab']])->assertHasErrors(['No foliage type "Baobab"']);
        WaterwaysServer::tool(EditFoliage::class, ['action' => 'scatter', 'shape' => $shape])->assertHasErrors(['types']);
    }

    public function test_map_images_render_the_saved_terrain_with_a_coordinate_grid(): void
    {
        if (! function_exists('imagecreatetruecolor')) {
            $this->markTestSkipped('GD is not installed.');
        }

        foreach (['map', 'height', 'slope', 'layers', 'water'] as $kind) {
            WaterwaysServer::tool(GetMapImage::class, ['map' => $this->map->slug, 'kind' => $kind, 'size' => 256])
                ->assertOk()
                ->assertSee(['"grid_lines_every_m"', '"pixels":[256,256]']);
        }

        WaterwaysServer::tool(GetMapImage::class, ['map' => $this->map->slug, 'kind' => 'layers', 'area' => ['min' => ['x' => 0, 'z' => -64], 'max' => ['x' => 128, 'z' => 0]], 'size' => 400])
            ->assertOk()
            ->assertSee(['"pixels":[400,200]', 'slot 3: Rock']);

        WaterwaysServer::tool(GetMapImage::class, ['map' => $this->map->slug, 'area' => ['min' => ['x' => 10, 'z' => 0], 'max' => ['x' => 0, 'z' => 5]]])
            ->assertHasErrors();
    }

    public function test_sample_terrain_reads_heights_water_and_layers(): void
    {
        WaterwaysServer::tool(SampleTerrain::class, ['map' => $this->map->slug, 'points' => [['x' => -128, 'z' => -128], ['x' => 64, 'z' => 0], ['x' => 500, 'z' => 0]]])
            ->assertOk()
            ->assertSee(['"height": 10', '"water_level": 15', '"Rock": "100%"', '"outside_map": true', '"slope_deg": 7.1']);

        WaterwaysServer::tool(SampleTerrain::class, ['map' => $this->map->slug, 'path' => [['x' => -100, 'z' => 0], ['x' => 100, 'z' => 0]], 'spacing' => 50])
            ->assertOk()
            ->assertSee(['"distance_m": 200', '"height": 38.5']);

        WaterwaysServer::tool(SampleTerrain::class, ['map' => $this->map->slug, 'path' => [['x' => -1000, 'z' => 0], ['x' => 1000, 'z' => 0]], 'spacing' => 1])
            ->assertHasErrors(['Too many samples']);
    }

    public function test_world_edits_need_an_open_editor(): void
    {
        $this->app->instance(EditorBridge::class, new EditorBridge);
        $other = Map::factory()->create();
        DefaultTerrainLayers::createFor($other);

        WaterwaysServer::tool(SculptTerrain::class, ['map' => $other->slug, 'shape' => ['type' => 'map'], 'operation' => 'smooth'])
            ->assertHasErrors(['is not open in an editor']);
    }

    public function test_props_are_placed_scattered_removed_and_listed(): void
    {
        $hut = PropModel::factory()->create(['name' => 'Hut']);
        $rock = PropModel::factory()->create(['name' => 'Rock']);
        $pending = PropModel::factory()->create(['name' => 'Tower', 'status' => 'processing']);

        WaterwaysServer::tool(PlaceProps::class, [
            'placements' => [['model' => 'hut', 'x' => 5, 'z' => 6, 'rotation' => 90], ['model' => (string) $rock->id, 'x' => 0, 'z' => 0, 'scale' => 2]],
        ])->assertOk();
        $this->assertSame([$hut->id, $rock->id], array_column($this->lastEdit()['prop_models'], 'id'), 'Model refs for editors that loaded before the import');
        $this->assertEquals([
            'kind' => 'props',
            'action' => 'place',
            'prop_models' => [$hut->toGameArray(), $rock->toGameArray()],
            'placements' => [
                ['model' => $hut->id, 'x' => 5.0, 'z' => 6.0, 'rotation' => 90.0],
                ['model' => $rock->id, 'x' => 0.0, 'z' => 0.0, 'scale' => 2.0],
            ],
            'save' => true,
        ], $this->lastEdit());

        WaterwaysServer::tool(PlaceProps::class, [
            'shape' => ['type' => 'circle', 'center' => ['x' => 0, 'z' => 0], 'radius' => 50],
            'models' => ['Hut', 'Rock'], 'count' => 12, 'max_slope' => 20,
        ])->assertOk();
        $this->assertSame('scatter', $this->lastEdit()['action']);
        $this->assertEquals(['models' => [$hut->id, $rock->id], 'count' => 12, 'max_slope' => 20.0], $this->lastEdit()['params']);

        WaterwaysServer::tool(PlaceProps::class, ['placements' => [['model' => 'Tower', 'x' => 0, 'z' => 0]]])->assertHasErrors(['not ready']);
        WaterwaysServer::tool(PlaceProps::class, ['placements' => [['model' => 'Castle', 'x' => 0, 'z' => 0]]])->assertHasErrors(['No prop model']);
        WaterwaysServer::tool(PlaceProps::class, ['models' => ['Hut'], 'count' => 3])->assertHasErrors();
        $this->assertNotNull($pending);

        WaterwaysServer::tool(RemoveProps::class, [])->assertHasErrors(['prop ids or a shape']);
        WaterwaysServer::tool(RemoveProps::class, [
            'shape' => ['type' => 'rect', 'min' => ['x' => -10, 'z' => -10], 'max' => ['x' => 10, 'z' => 10]], 'models' => ['rock'],
        ])->assertOk();
        $this->assertSame('remove', $this->lastEdit()['action']);
        $this->assertSame([$rock->id], $this->lastEdit()['models']);

        app(TerrainStorage::class)->write($this->map, 'props', json_encode(['version' => 1, 'props' => [
            ['id' => 'a', 'model' => $hut->id, 'x' => 5, 'z' => 6, 'yaw' => M_PI / 2, 'scale' => 1, 'offset' => 0],
            ['id' => 'b', 'model' => $rock->id, 'x' => 100, 'z' => 100, 'yaw' => 0, 'scale' => 2, 'offset' => 0],
        ]]));
        WaterwaysServer::tool(ListProps::class, [])->assertOk()->assertSee(['"count": 2', 'Hut ('.$hut->id.')', '"rotation": 90']);
        WaterwaysServer::tool(ListProps::class, ['x' => 0, 'z' => 0, 'radius' => 20])->assertOk()->assertSee('"count": 1');
    }
}
