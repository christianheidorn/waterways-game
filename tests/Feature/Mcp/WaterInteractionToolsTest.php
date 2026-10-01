<?php

namespace Tests\Feature\Mcp;

use App\Mcp\EditorBridge;
use App\Mcp\Servers\WaterwaysServer;
use App\Mcp\Tools\ControlPlayer;
use App\Mcp\Tools\GetEditorState;
use App\Mcp\Tools\SetDeviceGraphics;
use App\Models\Map;
use App\Support\GameSettingsSchema;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * Water interaction (docs/ROADMAP.md phase 12): control_player "splash", the wading / wet state the editor
 * reports, and the ripple / splash graphics settings.
 */
class WaterInteractionToolsTest extends TestCase
{
    use RefreshDatabase;

    private FakeEditor $editor;

    protected function setUp(): void
    {
        parent::setUp();
        $map = Map::factory()->create();
        $this->editor = new FakeEditor($map, fn (string $type, array $payload) => match ($type) {
            'player' => [
                'mode' => 'play',
                'swimming' => false,
                'water' => ['wading' => true, 'water_depth_m' => 0.6, 'wet' => 0.9, 'wet_line_m' => 0.72],
                ...(($payload['action'] ?? null) === 'splash' ? ['splash' => ['strength' => $payload['strength'] ?? 1]] : []),
            ],
            'state' => [
                'mode' => 'play',
                'water_interaction' => ['wading' => true, 'wet' => 0.9, 'ripples' => ['mode' => 'gpu', 'resolution' => 192]],
            ],
            default => [],
        });
        $this->app->instance(EditorBridge::class, $this->editor);
    }

    public function test_splash_is_passed_to_the_editor_and_validated(): void
    {
        WaterwaysServer::tool(ControlPlayer::class, ['action' => 'splash', 'x' => 4, 'z' => -2, 'strength' => 1.5, 'size' => 1])
            ->assertOk()
            ->assertSee('"wading": true')
            ->assertSee('"strength": 1.5');
        $run = end($this->editor->ran);
        $this->assertSame('player', $run['type']);
        $this->assertEquals(['action' => 'splash', 'x' => 4.0, 'z' => -2.0, 'strength' => 1.5, 'size' => 1.0], $run['payload']);

        // Without a position: in front of the character.
        WaterwaysServer::tool(ControlPlayer::class, ['action' => 'splash'])->assertOk();
        $this->assertEquals(['action' => 'splash'], end($this->editor->ran)['payload']);

        $count = count($this->editor->ran);
        WaterwaysServer::tool(ControlPlayer::class, ['action' => 'splash', 'strength' => 3])->assertHasErrors();
        WaterwaysServer::tool(ControlPlayer::class, ['action' => 'splash', 'size' => 0])->assertHasErrors();
        WaterwaysServer::tool(ControlPlayer::class, ['action' => 'fly'])->assertHasErrors();
        $this->assertCount($count, $this->editor->ran);
    }

    public function test_player_and_editor_state_report_wading_and_wetness(): void
    {
        WaterwaysServer::tool(ControlPlayer::class, ['action' => 'state'])
            ->assertOk()
            ->assertSee('"water_depth_m": 0.6')
            ->assertSee('"wet_line_m": 0.72');

        WaterwaysServer::tool(GetEditorState::class, [])
            ->assertOk()
            ->assertSee('"water_interaction"')
            ->assertSee('"resolution": 192');
    }

    public function test_ripple_and_splash_graphics_settings(): void
    {
        $graphics = GameSettingsSchema::group('graphics')->defaults();
        $this->assertSame('medium', $graphics['water_ripples']);
        $this->assertTrue($graphics['water_splashes']);

        WaterwaysServer::tool(SetDeviceGraphics::class, ['settings' => ['water_ripples' => 'high', 'water_splashes' => false]])->assertOk();
        $this->assertEquals(['water_ripples' => 'high', 'water_splashes' => false], (array) end($this->editor->ran)['payload']['settings']);
        WaterwaysServer::tool(SetDeviceGraphics::class, ['settings' => ['water_ripples' => 'ultra']])->assertHasErrors();
    }
}
