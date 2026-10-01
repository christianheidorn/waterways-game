<?php

namespace Tests\Feature\Mcp;

use App\Mcp\EditorBridge;
use App\Mcp\Servers\WaterwaysServer;
use App\Mcp\Tools\ControlEditor;
use App\Mcp\Tools\GetSettings;
use App\Mcp\Tools\SetDeviceGraphics;
use App\Mcp\Tools\TakeScreenshot;
use App\Mcp\Tools\UpdateEnvironment;
use App\Mcp\Tools\UpdateGameSettings;
use App\Models\AgentCommand;
use App\Models\Map;
use App\Support\GameSettingsRepository;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * Phase 8 (Looks III: bounce light): the map's bounce light strength, the graphics quality of the
 * irradiance probes and the "Bounce light only" view mode, through MCP.
 */
class BounceLightToolsTest extends TestCase
{
    use RefreshDatabase;

    public function test_get_settings_describes_the_bounce_light_fields(): void
    {
        $map = Map::factory()->create();

        WaterwaysServer::tool(GetSettings::class, ['group' => 'environment', 'map' => $map->slug])->assertOk()
            ->assertSee('"key": "bounce_light"')
            ->assertSee('"bounce_light": 1');

        WaterwaysServer::tool(GetSettings::class, ['group' => 'graphics'])->assertOk()
            ->assertSee('"key": "bounce_light_quality"')
            ->assertSee('"bounce_light_quality": "medium"');
    }

    public function test_update_environment_sets_the_bounce_light_strength(): void
    {
        $map = Map::factory()->create();
        app(EditorBridge::class)->poll($map, 's1', 'edit', null);

        WaterwaysServer::tool(UpdateEnvironment::class, ['map' => $map->slug, 'values' => ['bounce_light' => 1.6]])
            ->assertOk()->assertSee('"live": true');

        $this->assertSame(1.6, $map->refresh()->resolvedEnvironment()['bounce_light']);
        $this->assertSame(['parts' => ['environment']], AgentCommand::query()->sole()->payload);

        WaterwaysServer::tool(UpdateEnvironment::class, ['map' => $map->slug, 'values' => ['bounce_light' => 0]])->assertOk();
        $this->assertSame(0.0, $map->refresh()->resolvedEnvironment()['bounce_light']);

        foreach ([2.5, -0.1] as $invalid) {
            WaterwaysServer::tool(UpdateEnvironment::class, ['map' => $map->slug, 'values' => ['bounce_light' => $invalid]])->assertHasErrors();
        }
    }

    public function test_maps_saved_before_bounce_light_get_the_physical_strength(): void
    {
        $map = Map::factory()->create(['environment' => ['time_of_day' => 9]]);

        $this->assertEquals(1, $map->resolvedEnvironment()['bounce_light']);
    }

    public function test_bounce_light_quality_changes_per_device_and_project_wide(): void
    {
        $map = Map::factory()->create();
        $editor = new FakeEditor($map, fn (string $type, array $payload) => ['preset' => 'custom', 'echo' => $payload]);
        $this->app->instance(EditorBridge::class, $editor);

        WaterwaysServer::tool(SetDeviceGraphics::class, ['settings' => ['bounce_light_quality' => 'off']])->assertOk();
        $this->assertEquals(['bounce_light_quality' => 'off'], (array) end($editor->ran)['payload']['settings']);
        WaterwaysServer::tool(SetDeviceGraphics::class, ['settings' => ['bounce_light_quality' => 'ultra']])->assertHasErrors();

        WaterwaysServer::tool(UpdateGameSettings::class, ['group' => 'graphics', 'values' => ['bounce_light_quality' => 'high']])->assertOk();
        $this->assertSame('high', app(GameSettingsRepository::class)->get('graphics')['bounce_light_quality']);
        WaterwaysServer::tool(UpdateGameSettings::class, ['group' => 'graphics', 'values' => ['bounce_light_quality' => true]])->assertHasErrors();
    }

    public function test_the_bounce_view_mode_is_available_in_screenshots_and_control_editor(): void
    {
        $map = Map::factory()->create();
        $editor = new FakeEditor($map, fn (string $type) => $type === 'screenshot'
            ? ['image' => base64_encode('JPEG'), 'mime' => 'image/jpeg', 'view_mode' => 'bounce']
            : ['view_mode' => 'bounce']);
        $this->app->instance(EditorBridge::class, $editor);

        WaterwaysServer::tool(TakeScreenshot::class, ['map' => $map->slug, 'view_mode' => 'bounce'])->assertOk();
        $this->assertSame('bounce', $editor->ran[0]['payload']['view_mode']);

        WaterwaysServer::tool(ControlEditor::class, ['map' => $map->slug, 'action' => 'set_view_mode', 'view_mode' => 'bounce'])->assertOk();
        $this->assertSame('set_view_mode', $editor->ran[1]['type']);
        $this->assertSame('bounce', $editor->ran[1]['payload']['view_mode']);
    }
}
