<?php

namespace Tests\Feature\Mcp;

use App\Mcp\EditorBridge;
use App\Mcp\Servers\WaterwaysServer;
use App\Mcp\Tools\AddTerrainLayer;
use App\Mcp\Tools\GetSettings;
use App\Mcp\Tools\SetDeviceGraphics;
use App\Mcp\Tools\UpdateEnvironment;
use App\Mcp\Tools\UpdateGameSettings;
use App\Mcp\Tools\UpdateTerrainLayer;
use App\Models\AgentCommand;
use App\Models\Biome;
use App\Models\Map;
use App\Support\DefaultTerrainLayers;
use App\Support\GameSettingsRepository;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

/**
 * Phase 7 (Looks II: surfaces and water): large-scale colour variation per terrain layer, shoreline
 * foam breakup, caustics, puddles and footprints in snow per map, and the caustics / snow footprint
 * graphics switches, through MCP.
 */
class SurfaceLooksToolsTest extends TestCase
{
    use RefreshDatabase;

    private const ENV_FIELDS = [
        'foam_breakup' => 0.6,
        'caustics_intensity' => 0.8,
        'caustics_scale' => 2.5,
        'caustics_depth' => 4,
        'puddles' => 0.6,
        'puddle_dry_time' => 240,
        'footprint_depth' => 0.7,
        'footprint_fade_time' => 300,
    ];

    private Map $map;

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('local');
        Storage::fake('public');
        $this->map = Map::factory()->create(['resolution' => 65, 'size' => 256]);
        DefaultTerrainLayers::createFor($this->map);
    }

    public function test_get_settings_describes_the_surface_and_water_fields(): void
    {
        $response = WaterwaysServer::tool(GetSettings::class, ['group' => 'environment', 'map' => $this->map->slug])->assertOk();

        foreach (self::ENV_FIELDS as $key => $default) {
            $response->assertSee("\"key\": \"{$key}\"")->assertSee("\"{$key}\": {$default}");
        }

        $graphics = WaterwaysServer::tool(GetSettings::class, ['group' => 'graphics'])->assertOk();

        foreach (['caustics', 'snow_footprints'] as $key) {
            $graphics->assertSee("\"key\": \"{$key}\"")->assertSee("\"{$key}\": true");
        }
    }

    public function test_update_environment_sets_foam_caustics_puddles_and_footprints(): void
    {
        app(EditorBridge::class)->poll($this->map, 's1', 'edit', null);

        WaterwaysServer::tool(UpdateEnvironment::class, ['map' => $this->map->slug, 'values' => [
            'foam_breakup' => 0.9,
            'caustics_intensity' => 1.5,
            'caustics_scale' => 4,
            'caustics_depth' => 8,
            'puddles' => 1,
            'puddle_dry_time' => 600,
            'footprint_depth' => 0.4,
            'footprint_fade_time' => 90,
        ]])->assertOk()->assertSee('"live": true');

        $env = $this->map->refresh()->resolvedEnvironment();
        $this->assertSame(0.9, $env['foam_breakup']);
        $this->assertSame(1.5, $env['caustics_intensity']);
        $this->assertSame(4.0, $env['caustics_scale']);
        $this->assertSame(8.0, $env['caustics_depth']);
        $this->assertSame(1.0, $env['puddles']);
        $this->assertSame(600.0, $env['puddle_dry_time']);
        $this->assertSame(0.4, $env['footprint_depth']);
        $this->assertSame(90.0, $env['footprint_fade_time']);
        $this->assertSame(['parts' => ['environment']], AgentCommand::query()->sole()->payload);

        foreach ([
            ['foam_breakup' => 1.5],
            ['caustics_intensity' => 3],
            ['caustics_scale' => 0.1],
            ['caustics_depth' => 50],
            ['puddles' => -0.2],
            ['puddle_dry_time' => 5],
            ['footprint_depth' => 2],
            ['footprint_fade_time' => 4000],
        ] as $invalid) {
            WaterwaysServer::tool(UpdateEnvironment::class, ['map' => $this->map->slug, 'values' => $invalid])->assertHasErrors();
        }
    }

    public function test_maps_saved_before_the_surface_fields_get_their_defaults(): void
    {
        $map = Map::factory()->create(['environment' => ['time_of_day' => 9]]);
        $env = $map->resolvedEnvironment();

        foreach (self::ENV_FIELDS as $key => $default) {
            $this->assertEquals($default, $env[$key], $key);
        }
    }

    public function test_terrain_layers_have_a_large_scale_variation_strength(): void
    {
        $layer = $this->map->layers()->where('slot', 1)->sole();
        $this->assertSame(1.0, $layer->refresh()->toGameArray()['macro_variation']);

        WaterwaysServer::tool(UpdateTerrainLayer::class, ['map' => $this->map->slug, 'slot' => 1, 'values' => ['macro_variation' => 1.6]])
            ->assertOk()->assertSee('"macro_variation": 1.6');
        $this->assertSame(1.6, $layer->refresh()->macro_variation);

        WaterwaysServer::tool(UpdateTerrainLayer::class, ['map' => $this->map->slug, 'slot' => 1, 'values' => ['macro_variation' => 2.5]])->assertHasErrors();
        WaterwaysServer::tool(UpdateTerrainLayer::class, ['map' => $this->map->slug, 'slot' => 1, 'values' => ['macro_variation' => -1]])->assertHasErrors();

        // Biomes carry it with the rest of the look.
        $this->assertSame(1.6, Biome::attributesFromLayer($layer)['look']['macro_variation']);

        // New layers start at the default strength.
        $this->map->layers()->where('slot', 7)->delete();
        WaterwaysServer::tool(AddTerrainLayer::class, ['map' => $this->map->slug, 'values' => ['name' => 'Moss']])->assertOk();
        $this->assertSame(1.0, $this->map->layers()->where('slot', 7)->sole()->macro_variation);
    }

    public function test_graphics_switches_change_per_device_and_project_wide(): void
    {
        $editor = new FakeEditor($this->map, fn (string $type, array $payload) => ['preset' => 'custom', 'echo' => $payload]);
        $this->app->instance(EditorBridge::class, $editor);

        WaterwaysServer::tool(SetDeviceGraphics::class, ['settings' => ['caustics' => false, 'snow_footprints' => false]])->assertOk();
        $payload = end($editor->ran)['payload'];
        $this->assertEquals(['caustics' => false, 'snow_footprints' => false], (array) $payload['settings']);
        WaterwaysServer::tool(SetDeviceGraphics::class, ['settings' => ['caustics' => 'bright']])->assertHasErrors();

        WaterwaysServer::tool(UpdateGameSettings::class, ['group' => 'graphics', 'values' => ['caustics' => false]])->assertOk();
        $graphics = app(GameSettingsRepository::class)->get('graphics');
        $this->assertFalse($graphics['caustics']);
        $this->assertTrue($graphics['snow_footprints']);
    }
}
