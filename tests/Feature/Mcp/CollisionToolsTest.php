<?php

namespace Tests\Feature\Mcp;

use App\Mcp\EditorBridge;
use App\Mcp\Servers\WaterwaysServer;
use App\Mcp\Tools\ControlEditor;
use App\Mcp\Tools\SampleCollision;
use App\Mcp\Tools\SaveFoliageType;
use App\Mcp\Tools\TakeScreenshot;
use App\Mcp\Tools\UpdatePropModel;
use App\Models\AgentCommand;
use App\Models\FoliageType;
use App\Models\Map;
use App\Models\PropModel;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

class CollisionToolsTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('public');
    }

    public function test_foliage_types_default_to_auto_collision_and_save_the_settings(): void
    {
        WaterwaysServer::tool(SaveFoliageType::class, ['values' => ['name' => 'Oak', 'kind' => 'broadleaf']])
            ->assertOk()
            ->assertSee(['"collision": "auto"', '"collision_radius": null']);

        $type = FoliageType::query()->sole();

        WaterwaysServer::tool(SaveFoliageType::class, ['id' => $type->id, 'values' => ['collision' => 'bounds', 'collision_radius' => 0.6]])
            ->assertOk()
            ->assertSee(['"collision": "bounds"', '"collision_radius": 0.6']);

        $this->assertSame('bounds', $type->refresh()->collision);
        $this->assertSame(0.6, $type->collision_radius);
        $this->assertSame('bounds', $type->toGameArray()['collision']);

        WaterwaysServer::tool(SaveFoliageType::class, ['id' => $type->id, 'values' => ['collision' => 'wall']])
            ->assertHasErrors(['collision']);
        WaterwaysServer::tool(SaveFoliageType::class, ['id' => $type->id, 'values' => ['collision_radius' => 50]])
            ->assertHasErrors(['collision radius']);
    }

    public function test_the_in_game_editor_updates_collision_settings(): void
    {
        $type = FoliageType::query()->create([
            'name' => 'Pine', 'kind' => 'conifer', 'color' => '#335522', 'color_secondary' => '#553322', 'min_scale' => 1, 'max_scale' => 1,
            'density' => 1, 'min_slope' => 0, 'max_slope' => 30, 'align_to_normal' => false, 'random_yaw' => true,
            'cast_shadows' => true, 'cull_distance' => 400, 'allow_underwater' => false,
        ]);

        $this->patchJson("/api/foliage-types/{$type->id}", ['collision' => 'none'])
            ->assertOk()
            ->assertJsonPath('collision', 'none');
    }

    public function test_update_prop_model_edits_name_size_and_collision(): void
    {
        $prop = PropModel::factory()->create(['name' => 'Hut']);
        $this->assertSame('auto', $prop->refresh()->toGameArray()['collision']);
        $map = Map::factory()->create();
        app(EditorBridge::class)->poll($map, 'session', 'edit', []);

        WaterwaysServer::tool(UpdatePropModel::class, ['model' => 'hut', 'collision' => 'mesh', 'name' => 'Fishing hut', 'target_height' => null])
            ->assertOk()
            ->assertSee(['"collision": "mesh"', 'Fishing hut']);

        $prop->refresh();
        $this->assertSame('mesh', $prop->collision);
        $this->assertNull($prop->target_height);
        $this->assertSame('Fishing hut', $prop->name);
        $this->assertSame(['parts' => ['prop_models']], AgentCommand::query()->where('type', 'refresh')->sole()->payload);

        WaterwaysServer::tool(UpdatePropModel::class, ['model' => (string) $prop->id, 'collision' => 'hull'])->assertHasErrors(['collision']);
        WaterwaysServer::tool(UpdatePropModel::class, ['model' => (string) $prop->id])->assertHasErrors(['Nothing to change']);
        WaterwaysServer::tool(UpdatePropModel::class, ['model' => 'Castle', 'collision' => 'box'])->assertHasErrors(['No prop model']);
    }

    public function test_sample_collision_asks_the_open_editor(): void
    {
        $map = Map::factory()->create();
        $editor = new FakeEditor($map, fn (string $type, array $payload) => [
            'clear' => false,
            'first_blocked' => ['distance' => 4.5, 'x' => 4.5, 'z' => 0],
            'blockers' => [['source' => 'foliage', 'name' => 'Pine', 'foliage_type_id' => 3, 'distance' => 4.5]],
        ]);
        $this->app->instance(EditorBridge::class, $editor);

        WaterwaysServer::tool(SampleCollision::class, ['map' => $map->slug, 'from' => ['x' => 0, 'z' => 0], 'to' => ['x' => 20, 'z' => 0], 'radius' => 0.4])
            ->assertOk()
            ->assertSee(['"first_blocked"', 'Pine']);

        $this->assertSame('sample_collision', $editor->ran[0]['type']);
        $this->assertEquals(['from' => ['x' => 0, 'z' => 0], 'to' => ['x' => 20, 'z' => 0], 'radius' => 0.4], $editor->ran[0]['payload']);

        WaterwaysServer::tool(SampleCollision::class, ['map' => $map->slug, 'points' => [['x' => 1, 'z' => 2]]])->assertOk();
        $this->assertEquals(['points' => [['x' => 1, 'z' => 2]]], $editor->ran[1]['payload']);

        WaterwaysServer::tool(SampleCollision::class, ['map' => $map->slug, 'from' => ['x' => 0, 'z' => 0]])->assertHasErrors(['to']);
    }

    public function test_the_collision_view_mode_is_available_in_screenshots_and_control_editor(): void
    {
        $map = Map::factory()->create();
        $editor = new FakeEditor($map, fn (string $type) => $type === 'screenshot'
            ? ['image' => base64_encode('JPEG'), 'mime' => 'image/jpeg', 'view_mode' => 'collision']
            : ['view_mode' => 'collision']);
        $this->app->instance(EditorBridge::class, $editor);

        WaterwaysServer::tool(TakeScreenshot::class, ['map' => $map->slug, 'view_mode' => 'collision'])->assertOk();
        $this->assertSame('collision', $editor->ran[0]['payload']['view_mode']);

        WaterwaysServer::tool(ControlEditor::class, ['map' => $map->slug, 'action' => 'set_view_mode', 'view_mode' => 'collision'])->assertOk();
        $this->assertSame('set_view_mode', $editor->ran[1]['type']);
    }
}
