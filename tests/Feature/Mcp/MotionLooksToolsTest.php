<?php

namespace Tests\Feature\Mcp;

use App\Mcp\EditorBridge;
use App\Mcp\Servers\WaterwaysServer;
use App\Mcp\Tools\GetSettings;
use App\Mcp\Tools\SetDeviceGraphics;
use App\Mcp\Tools\UpdateEnvironment;
use App\Mcp\Tools\UpdateGameSettings;
use App\Models\AgentCommand;
use App\Models\Map;
use App\Support\DefaultTerrainLayers;
use App\Support\GameSettingsRepository;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

/**
 * Phase 6 (Looks I: motion): travelling gusts, cloud shadows and light shafts in fog per map, and the
 * LOD cross-fade / grass interaction / cloud shadow graphics switches, through MCP.
 */
class MotionLooksToolsTest extends TestCase
{
    use RefreshDatabase;

    private Map $map;

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('local');
        Storage::fake('public');
        $this->map = Map::factory()->create(['resolution' => 65, 'size' => 256]);
        DefaultTerrainLayers::createFor($this->map);
    }

    public function test_get_settings_describes_the_motion_fields(): void
    {
        $response = WaterwaysServer::tool(GetSettings::class, ['group' => 'environment', 'map' => $this->map->slug])->assertOk();

        foreach (['gust_strength', 'gust_scale', 'gust_speed', 'cloud_shadow_strength', 'fog_shaft_intensity'] as $key) {
            $response->assertSee("\"key\": \"{$key}\"");
        }

        $response->assertSee('"gust_strength": 0.5')->assertSee('"cloud_shadow_strength": 0.6')->assertSee('"fog_shaft_intensity": 0.8');

        $graphics = WaterwaysServer::tool(GetSettings::class, ['group' => 'graphics'])->assertOk();

        foreach (['lod_crossfade', 'grass_interaction', 'cloud_shadows'] as $key) {
            $graphics->assertSee("\"key\": \"{$key}\"")->assertSee("\"{$key}\": true");
        }
    }

    public function test_update_environment_sets_gusts_cloud_shadows_and_fog_shafts(): void
    {
        app(EditorBridge::class)->poll($this->map, 's1', 'edit', null);

        WaterwaysServer::tool(UpdateEnvironment::class, ['map' => $this->map->slug, 'values' => [
            'gust_strength' => 1.4,
            'gust_scale' => 80,
            'gust_speed' => 2,
            'cloud_shadow_strength' => 0.9,
            'fog_shaft_intensity' => 1.5,
        ]])->assertOk()->assertSee('"live": true');

        $env = $this->map->refresh()->resolvedEnvironment();
        $this->assertSame(1.4, $env['gust_strength']);
        $this->assertSame(80.0, $env['gust_scale']);
        $this->assertSame(2.0, $env['gust_speed']);
        $this->assertSame(0.9, $env['cloud_shadow_strength']);
        $this->assertSame(1.5, $env['fog_shaft_intensity']);
        $this->assertSame(['parts' => ['environment']], AgentCommand::query()->sole()->payload);

        foreach ([
            ['gust_strength' => 3],
            ['gust_scale' => 1],
            ['gust_speed' => -1],
            ['cloud_shadow_strength' => 1.5],
            ['fog_shaft_intensity' => 5],
        ] as $invalid) {
            WaterwaysServer::tool(UpdateEnvironment::class, ['map' => $this->map->slug, 'values' => $invalid])->assertHasErrors();
        }
    }

    public function test_maps_saved_before_the_motion_fields_get_their_defaults(): void
    {
        $map = Map::factory()->create(['environment' => ['time_of_day' => 9]]);
        $env = $map->resolvedEnvironment();

        $this->assertSame(0.5, $env['gust_strength']);
        $this->assertSame(40.0, $env['gust_scale']);
        $this->assertSame(1.0, $env['gust_speed']);
        $this->assertSame(0.6, $env['cloud_shadow_strength']);
        $this->assertSame(0.8, $env['fog_shaft_intensity']);
    }

    public function test_graphics_switches_change_per_device_and_project_wide(): void
    {
        $editor = new FakeEditor($this->map, fn (string $type, array $payload) => ['preset' => 'custom', 'echo' => $payload]);
        $this->app->instance(EditorBridge::class, $editor);

        WaterwaysServer::tool(SetDeviceGraphics::class, ['settings' => ['lod_crossfade' => false, 'grass_interaction' => false, 'cloud_shadows' => false]])->assertOk();
        $payload = end($editor->ran)['payload'];
        $this->assertEquals(['lod_crossfade' => false, 'grass_interaction' => false, 'cloud_shadows' => false], (array) $payload['settings']);
        WaterwaysServer::tool(SetDeviceGraphics::class, ['settings' => ['lod_crossfade' => 'sometimes']])->assertHasErrors();

        WaterwaysServer::tool(UpdateGameSettings::class, ['group' => 'graphics', 'values' => ['cloud_shadows' => false, 'lod_crossfade' => false]])->assertOk();
        $graphics = app(GameSettingsRepository::class)->get('graphics');
        $this->assertFalse($graphics['cloud_shadows']);
        $this->assertFalse($graphics['lod_crossfade']);
        $this->assertTrue($graphics['grass_interaction']);
    }
}
