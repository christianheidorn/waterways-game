<?php

namespace Tests\Feature\Mcp;

use App\Mcp\EditorBridge;
use App\Mcp\Servers\WaterwaysServer;
use App\Mcp\Tools\ControlPlayer;
use App\Mcp\Tools\ImportModel;
use App\Mcp\Tools\ListPropModels;
use App\Mcp\Tools\SetDeviceGraphics;
use App\Mcp\Tools\TakeScreenshot;
use App\Mcp\Tools\UpdatePropModel;
use App\Models\Map;
use App\Models\PropModel;
use App\Support\GameSettingsSchema;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

/**
 * Swimming, the view under water and floating props (docs/ROADMAP.md phase 13): control_player swim /
 * dive / surface and their state, buoyancy on prop models (update_prop_model, import_model,
 * list_prop_models, the in-game editor's API), underwater screenshots and the underwater_effects setting.
 */
class SwimmingFloatingToolsTest extends TestCase
{
    use RefreshDatabase;

    private FakeEditor $editor;

    private Map $map;

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('public');
        $this->map = Map::factory()->create();
        $this->editor = new FakeEditor($this->map, fn (string $type, array $payload) => match ($type) {
            'player' => [
                'mode' => 'play',
                'swimming' => true,
                'swim' => ['diving' => ($payload['action'] ?? null) === 'dive', 'head_under' => ($payload['action'] ?? null) === 'dive', 'breath' => 0.92, 'head_depth_m' => ($payload['action'] ?? null) === 'dive' ? 2.1 : 0, 'climbing' => false],
                'water' => ['wading' => false, 'swimming' => true, 'underwater' => ($payload['action'] ?? null) === 'dive', 'water_depth_m' => 1.15],
                'floating_props' => [['id' => 'p1', 'model' => 7, 'x' => 3.1, 'y' => 9.7, 'z' => 4.2, 'pitch_deg' => 2.5, 'roll_deg' => -1, 'drifted_m' => 0.4, 'grounded' => false, 'drift' => 'return']],
                ...(in_array($payload['action'] ?? null, ['dive', 'surface'], true) ? ['outcome' => $payload['action'] === 'dive' ? 'reached' : 'surfaced'] : []),
            ],
            'screenshot' => ['mime' => 'image/jpeg', 'image' => base64_encode('jpeg'), 'width' => 4, 'height' => 4],
            default => [],
        });
        $this->app->instance(EditorBridge::class, $this->editor);
    }

    public function test_swim_dive_and_surface_are_passed_to_the_editor(): void
    {
        WaterwaysServer::tool(ControlPlayer::class, ['action' => 'swim', 'x' => 12, 'z' => -4, 'dive' => true, 'run' => true])
            ->assertOk()
            ->assertSee(['"swimming": true', '"breath": 0.92', '"floating_props"', '"drift": "return"']);
        $this->assertEquals(['action' => 'swim', 'x' => 12.0, 'z' => -4.0, 'dive' => true, 'run' => true], end($this->editor->ran)['payload']);

        WaterwaysServer::tool(ControlPlayer::class, ['action' => 'dive', 'depth' => 2, 'forward' => true])
            ->assertOk()
            ->assertSee(['"outcome": "reached"', '"head_under": true', '"underwater": true', '"head_depth_m": 2.1']);
        $this->assertEquals(['action' => 'dive', 'depth' => 2.0, 'forward' => true], end($this->editor->ran)['payload']);

        WaterwaysServer::tool(ControlPlayer::class, ['action' => 'surface'])
            ->assertOk()
            ->assertSee('"outcome": "surfaced"');

        $count = count($this->editor->ran);
        // swim needs a target; depth is bounded.
        WaterwaysServer::tool(ControlPlayer::class, ['action' => 'swim'])->assertHasErrors();
        WaterwaysServer::tool(ControlPlayer::class, ['action' => 'dive', 'depth' => 100])->assertHasErrors();
        $this->assertCount($count, $this->editor->ran);
    }

    public function test_screenshots_can_be_taken_under_water(): void
    {
        WaterwaysServer::tool(TakeScreenshot::class, ['position' => ['x' => 10, 'y' => -3.5, 'z' => 4], 'look_at' => ['x' => 10, 'y' => 2, 'z' => 8]])
            ->assertOk();
        $run = end($this->editor->ran);
        $this->assertSame('screenshot', $run['type']);
        $this->assertEquals(-3.5, $run['payload']['position']['y']);
    }

    public function test_update_prop_model_sets_and_clears_buoyancy(): void
    {
        $prop = PropModel::factory()->create(['name' => 'Log']);
        $this->assertNull($prop->toGameArray()['buoyancy']);

        WaterwaysServer::tool(UpdatePropModel::class, ['model' => 'log', 'buoyancy' => ['mode' => 'float', 'density' => 0.6, 'drift' => 'return']])
            ->assertOk()
            ->assertSee(['"mode": "float"', '"density": 0.6', '"drift": "return"']);
        $this->assertSame(['mode' => 'float', 'density' => 0.6, 'drift' => 'return'], $prop->refresh()->toGameArray()['buoyancy']);

        // Partial changes keep the rest; defaults fill in.
        WaterwaysServer::tool(UpdatePropModel::class, ['model' => 'log', 'buoyancy' => ['drift' => 'stay']])->assertOk();
        $this->assertSame(['mode' => 'float', 'density' => 0.6, 'drift' => 'stay'], $prop->refresh()->buoyancy);

        WaterwaysServer::tool(ListPropModels::class, [])->assertOk()->assertSee('"drift": "stay"');

        WaterwaysServer::tool(UpdatePropModel::class, ['model' => 'log', 'buoyancy' => ['density' => 2]])->assertHasErrors(['density']);
        WaterwaysServer::tool(UpdatePropModel::class, ['model' => 'log', 'buoyancy' => ['mode' => 'sink']])->assertHasErrors(['mode']);
        WaterwaysServer::tool(UpdatePropModel::class, ['model' => 'log', 'buoyancy' => ['drift' => 'away']])->assertHasErrors(['drift']);

        WaterwaysServer::tool(UpdatePropModel::class, ['model' => 'log', 'buoyancy' => ['mode' => 'none']])->assertOk();
        $this->assertNull($prop->refresh()->buoyancy);
        $this->assertNull($prop->toGameArray()['buoyancy']);
    }

    public function test_import_model_can_make_a_floating_prop(): void
    {
        $dir = sys_get_temp_dir().'/ww-float-test-'.uniqid();
        mkdir($dir);
        file_put_contents($dir.'/boat.glb', $this->glb());

        try {
            WaterwaysServer::tool(ImportModel::class, ['kind' => 'prop', 'path' => $dir.'/boat.glb', 'buoyancy' => ['mode' => 'float', 'density' => 0.25]])
                ->assertOk()
                ->assertSee(['"buoyancy"', '"density": 0.25', '"drift": "none"']);
        } finally {
            @unlink($dir.'/boat.glb');
            @rmdir($dir);
        }

        $this->assertSame(['mode' => 'float', 'density' => 0.25, 'drift' => 'none'], PropModel::query()->sole()->buoyancy);
    }

    public function test_the_in_game_editor_updates_buoyancy(): void
    {
        $prop = PropModel::factory()->create(['name' => 'Raft']);

        $this->patchJson("/api/prop-models/{$prop->id}", ['buoyancy' => ['mode' => 'float', 'density' => 0.2, 'drift' => 'none']])
            ->assertOk()
            ->assertJsonPath('buoyancy.mode', 'float')
            ->assertJsonPath('buoyancy.density', 0.2);

        $this->patchJson("/api/prop-models/{$prop->id}", ['buoyancy' => ['density' => 1.5]])->assertUnprocessable();
        $this->patchJson("/api/prop-models/{$prop->id}", [])->assertUnprocessable();

        $this->patchJson("/api/prop-models/{$prop->id}", ['buoyancy' => null])
            ->assertOk()
            ->assertJsonPath('buoyancy', null);

        $manifest = $this->getJson("/api/maps/{$this->map->slug}/manifest")->assertOk()->json();
        $this->assertStringEndsWith('/api/prop-models', $manifest['endpoints']['update_prop_model']);
    }

    public function test_underwater_effects_setting(): void
    {
        $graphics = GameSettingsSchema::group('graphics')->defaults();
        $this->assertSame('high', $graphics['underwater_effects']);

        WaterwaysServer::tool(SetDeviceGraphics::class, ['settings' => ['underwater_effects' => 'low']])->assertOk();
        $this->assertEquals(['underwater_effects' => 'low'], (array) end($this->editor->ran)['payload']['settings']);
        WaterwaysServer::tool(SetDeviceGraphics::class, ['settings' => ['underwater_effects' => 'ultra']])->assertHasErrors();
    }

    private function glb(): string
    {
        $bin = pack('g*', 0, 0, 0, 1, 0, 0, 0, 2, 0.5);
        $json = json_encode([
            'asset' => ['version' => '2.0', 'generator' => 'test'],
            'scene' => 0,
            'scenes' => [['nodes' => [0]]],
            'nodes' => [['mesh' => 0]],
            'meshes' => [['primitives' => [['attributes' => ['POSITION' => 0]]]]],
            'accessors' => [['bufferView' => 0, 'componentType' => 5126, 'count' => 3, 'type' => 'VEC3', 'min' => [0, 0, 0], 'max' => [1, 2, 0.5]]],
            'bufferViews' => [['buffer' => 0, 'byteLength' => strlen($bin)]],
            'buffers' => [['byteLength' => strlen($bin)]],
        ]);
        $json .= str_repeat(' ', (4 - strlen($json) % 4) % 4);
        $body = pack('V2', strlen($json), 0x4E4F534A).$json.pack('V2', strlen($bin), 0x004E4942).$bin;

        return 'glTF'.pack('V2', 2, 12 + strlen($body)).$body;
    }
}
