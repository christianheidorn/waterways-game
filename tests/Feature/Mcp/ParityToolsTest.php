<?php

namespace Tests\Feature\Mcp;

use App\Mcp\EditorBridge;
use App\Mcp\Servers\WaterwaysServer;
use App\Mcp\Tools\ControlPlayer;
use App\Mcp\Tools\CreateRequest;
use App\Mcp\Tools\DeleteLibraryItem;
use App\Mcp\Tools\ListCharacters;
use App\Mcp\Tools\ManageCharacter;
use App\Mcp\Tools\SetDeviceGraphics;
use App\Mcp\Tools\SetMapThumbnail;
use App\Mcp\Tools\TakePhoto;
use App\Mcp\Tools\UpdateGameSettings;
use App\Mcp\Tools\UpdateLibraryItem;
use App\Mcp\Tools\UpdateMap;
use App\Mcp\Tools\UpdateProps;
use App\Mcp\Tools\UpdateRequest;
use App\Models\AgentCommand;
use App\Models\AgentRequest;
use App\Models\Biome;
use App\Models\Character;
use App\Models\FoliageAsset;
use App\Models\FoliageType;
use App\Models\Map;
use App\Models\Material;
use App\Models\PropModel;
use App\Support\ActiveCharacter;
use App\Support\DefaultTerrainLayers;
use App\Support\GameSettingsRepository;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Bus;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

/**
 * The tools that give agents the rest of what the UI offers (docs/MCP.md, "UI ↔ MCP parity").
 */
class ParityToolsTest extends TestCase
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

    /**
     * @param  (\Closure(string, array<string, mixed>): array<string, mixed>)|null  $handler
     */
    private function editor(?\Closure $handler = null): FakeEditor
    {
        $editor = new FakeEditor($this->map, $handler ?? fn () => ['result' => ['updated' => 1], 'unsaved' => []]);
        $this->app->instance(EditorBridge::class, $editor);

        return $editor;
    }

    private function jpeg(): string
    {
        $image = imagecreatetruecolor(8, 8);
        ob_start();
        imagejpeg($image);

        return base64_encode((string) ob_get_clean());
    }

    public function test_update_props_edits_placed_props_by_id_or_selection(): void
    {
        $editor = $this->editor();
        $hut = PropModel::factory()->create(['name' => 'Hut']);

        WaterwaysServer::tool(UpdateProps::class, ['updates' => [['id' => 'a', 'x' => 3, 'rotation' => 45, 'scale' => 2]]])->assertOk();
        $this->assertEquals([
            'kind' => 'props', 'action' => 'update', 'save' => true,
            'updates' => [['id' => 'a', 'x' => 3.0, 'rotation' => 45.0, 'scale' => 2.0]],
        ], end($editor->ran)['payload']);

        WaterwaysServer::tool(UpdateProps::class, [
            'shape' => ['type' => 'circle', 'center' => ['x' => 0, 'z' => 0], 'radius' => 30],
            'models' => ['hut'],
            'change' => ['random_rotation' => true, 'scale_min' => 0.8, 'scale_max' => 1.2, 'offset' => -0.3],
        ])->assertOk();
        $payload = end($editor->ran)['payload'];
        $this->assertSame([$hut->id], $payload['models']);
        $this->assertSame(['random_rotation' => true, 'scale_min' => 0.8, 'scale_max' => 1.2, 'offset' => -0.3], $payload['change']);
        $this->assertSame('circle', $payload['shape']['type']);

        WaterwaysServer::tool(UpdateProps::class, ['change' => ['rotate_by' => 90]])->assertHasErrors(['prop ids or a shape']);
        WaterwaysServer::tool(UpdateProps::class, ['ids' => ['a']])->assertHasErrors(['what to change']);
        WaterwaysServer::tool(UpdateProps::class, ['ids' => ['a'], 'change' => ['colour' => 'red']])->assertHasErrors(['The change is empty']);
    }

    public function test_take_photo_stores_the_full_image_and_returns_a_preview(): void
    {
        $jpeg = $this->jpeg();
        $editor = $this->editor(fn () => ['mime' => 'image/jpeg', 'image' => $jpeg, 'full' => $jpeg, 'width' => 8, 'height' => 8, 'full_width' => 8, 'full_height' => 8, 'cinematic' => true]);

        $response = WaterwaysServer::tool(TakePhoto::class, ['view' => 'spawn', 'look' => ['color_grade' => 'golden_hour', 'exposure_compensation' => 0.5], 'fov' => 40, 'scale' => 2]);
        $response->assertOk()->assertSee(['"stored"', 'agent-images/']);
        $payload = end($editor->ran)['payload'];
        $this->assertSame('photo', end($editor->ran)['type']);
        $this->assertSame(['color_grade' => 'golden_hour', 'exposure_compensation' => 0.5], (array) $payload['look']);
        $this->assertSame(2, $payload['scale']);
        $this->assertCount(1, Storage::disk('public')->files('agent-images'));

        WaterwaysServer::tool(TakePhoto::class, ['look' => ['sparkle' => 1]])->assertHasErrors(['Unknown environment fields']);
    }

    public function test_set_device_graphics_reads_and_changes_the_graphics_menu(): void
    {
        $editor = $this->editor(fn (string $type, array $payload) => ['preset' => 'custom', 'echo' => $payload]);

        WaterwaysServer::tool(SetDeviceGraphics::class, [])->assertOk()->assertSee('"changed": false');
        $this->assertSame(['read' => true], end($editor->ran)['payload']);

        WaterwaysServer::tool(SetDeviceGraphics::class, ['preset' => 'low', 'groups' => ['shadows' => 'epic'], 'settings' => ['render_scale' => 0.75]])->assertOk();
        $payload = end($editor->ran)['payload'];
        $this->assertSame('graphics', end($editor->ran)['type']);
        $this->assertSame('low', $payload['preset']);
        $this->assertSame(['shadows' => 'epic'], (array) $payload['groups']);

        WaterwaysServer::tool(SetDeviceGraphics::class, ['groups' => ['sparkles' => 'low']])->assertHasErrors(['Unknown scalability groups']);
        WaterwaysServer::tool(SetDeviceGraphics::class, ['settings' => ['warp' => 9]])->assertHasErrors(['Unknown graphics fields']);
        WaterwaysServer::tool(SetDeviceGraphics::class, ['settings' => ['render_scale' => 9]])->assertHasErrors();

        // High-DPI scene resolution (share of the native pixels, upscaled temporally).
        WaterwaysServer::tool(SetDeviceGraphics::class, ['settings' => ['retina_render_scale' => 0.7]])->assertOk();
        $this->assertEquals(0.7, ((array) end($editor->ran)['payload']['settings'])['retina_render_scale']);
        WaterwaysServer::tool(SetDeviceGraphics::class, ['settings' => ['retina_render_scale' => 0.1]])->assertHasErrors();
    }

    public function test_control_player_walks_teleports_and_looks(): void
    {
        $editor = $this->editor(fn (string $type, array $payload) => ['outcome' => 'reached', 'mode' => 'play']);

        WaterwaysServer::tool(ControlPlayer::class, ['action' => 'walk_to', 'x' => 10, 'z' => -20, 'run' => true])
            ->assertOk()->assertSee('"outcome": "reached"');
        $this->assertSame('player', end($editor->ran)['type']);
        $this->assertEquals(['action' => 'walk_to', 'x' => 10.0, 'z' => -20.0, 'run' => true], end($editor->ran)['payload']);

        WaterwaysServer::tool(ControlPlayer::class, ['action' => 'look', 'look_at' => ['x' => 0, 'z' => 0], 'pitch' => -10])->assertOk();
        WaterwaysServer::tool(ControlPlayer::class, ['action' => 'teleport', 'x' => 1])->assertHasErrors();
    }

    public function test_set_map_thumbnail_stores_a_rendered_view(): void
    {
        $this->editor(fn () => ['image' => $this->jpeg(), 'width' => 8, 'height' => 8]);

        WaterwaysServer::tool(SetMapThumbnail::class, ['view' => 'overview'])->assertOk()->assertSee('thumbnail_url');
        Storage::disk('public')->assertExists($this->map->thumbnailPath());
    }

    public function test_update_map_sets_the_spawn_direction_in_degrees_or_towards_a_point(): void
    {
        WaterwaysServer::tool(UpdateMap::class, ['spawn' => ['x' => 0, 'z' => 0, 'facing' => 90]])->assertOk();
        $this->assertEqualsWithDelta(M_PI / 2, $this->map->refresh()->spawn_yaw, 1e-6);

        // Looking east (+x) is −90°.
        WaterwaysServer::tool(UpdateMap::class, ['spawn' => ['x' => 0, 'z' => 0, 'look_at' => ['x' => 50, 'z' => 0]]])->assertOk();
        $this->assertEqualsWithDelta(-M_PI / 2, $this->map->refresh()->spawn_yaw, 1e-6);
    }

    public function test_update_game_settings_resets_a_group(): void
    {
        $settings = app(GameSettingsRepository::class);
        $default = $settings->get('player')['walk_speed'] ?? null;
        $this->assertNotNull($default);
        WaterwaysServer::tool(UpdateGameSettings::class, ['group' => 'player', 'values' => ['walk_speed' => $default + 1]])->assertOk();

        WaterwaysServer::tool(UpdateGameSettings::class, ['group' => 'player', 'reset' => true])->assertOk()->assertSee('"reset": "player"');
        $this->assertEquals($default, $settings->get('player')['walk_speed']);
        WaterwaysServer::tool(UpdateGameSettings::class, ['group' => 'player'])->assertHasErrors(['values']);
    }

    public function test_characters_are_listed_imported_activated_and_updated(): void
    {
        $bin = pack('g*', 0, 0, 0, 1, 0, 0, 0, 1, 0);
        $json = json_encode([
            'asset' => ['version' => '2.0'], 'scene' => 0, 'scenes' => [['nodes' => [0]]], 'nodes' => [['mesh' => 0]],
            'meshes' => [['primitives' => [['attributes' => ['POSITION' => 0]]]]],
            'accessors' => [['bufferView' => 0, 'componentType' => 5126, 'count' => 3, 'type' => 'VEC3', 'min' => [0, 0, 0], 'max' => [1, 1, 0]]],
            'bufferViews' => [['buffer' => 0, 'byteLength' => strlen($bin)]], 'buffers' => [['byteLength' => strlen($bin)]],
        ]);
        $json .= str_repeat(' ', (4 - strlen($json) % 4) % 4);
        $body = pack('V2', strlen($json), 0x4E4F534A).$json.pack('V2', strlen($bin), 0x004E4942).$bin;
        $glb = 'glTF'.pack('V2', 2, 12 + strlen($body)).$body;

        WaterwaysServer::tool(ManageCharacter::class, ['action' => 'import', 'name' => 'Ranger', 'height' => 1.7, 'base64' => base64_encode($glb)])->assertOk();
        $ranger = Character::query()->sole();
        Storage::disk('public')->assertExists($ranger->model_path);

        WaterwaysServer::tool(ManageCharacter::class, ['action' => 'activate', 'id' => $ranger->id])->assertOk();
        $this->assertSame($ranger->id, app(ActiveCharacter::class)->id());
        WaterwaysServer::tool(ListCharacters::class)->assertOk()->assertSee(['"active_id": '.$ranger->id, 'Ranger']);

        WaterwaysServer::tool(ManageCharacter::class, ['action' => 'update', 'id' => $ranger->id, 'name' => 'Scout'])->assertOk();
        $this->assertSame('Scout', $ranger->refresh()->name);

        $pending = Character::query()->create(['name' => 'Knight', 'status' => 'processing']);
        WaterwaysServer::tool(ManageCharacter::class, ['action' => 'activate', 'id' => $pending->id])->assertHasErrors(['not ready']);
        WaterwaysServer::tool(ManageCharacter::class, ['action' => 'generate', 'prompt' => 'A knight'])->assertHasErrors(['Meshy is not configured']);

        WaterwaysServer::tool(ManageCharacter::class, ['action' => 'deactivate'])->assertOk();
        $this->assertNull(app(ActiveCharacter::class)->id());
    }

    public function test_library_items_are_updated_and_duplicated(): void
    {
        Bus::fake();
        $material = Material::query()->create(['name' => 'Mud', 'slug' => 'mud', 'category' => 'mud', 'tile_size' => 2, 'status' => 'ready']);

        WaterwaysServer::tool(UpdateLibraryItem::class, ['kind' => 'material', 'action' => 'update', 'id' => $material->id, 'values' => ['tile_size' => 4, 'tint' => '#aabbcc', 'tags' => [' wet ', 'wet']]])->assertOk();
        $this->assertEquals(4, $material->refresh()->tile_size);
        $this->assertSame(['wet'], $material->tags);
        WaterwaysServer::tool(UpdateLibraryItem::class, ['kind' => 'material', 'action' => 'update', 'id' => $material->id, 'values' => ['shine' => 1]])->assertHasErrors(['Unknown fields']);
        WaterwaysServer::tool(UpdateLibraryItem::class, ['kind' => 'material', 'action' => 'rebake', 'id' => $material->id])->assertHasErrors(['does not apply']);

        $asset = FoliageAsset::query()->create(['name' => 'Reed', 'kind' => 'reed', 'source' => 'upload', 'source_type' => 'model', 'source_path' => 'foliage/1/source/model.glb', 'status' => 'ready']);
        WaterwaysServer::tool(UpdateLibraryItem::class, ['kind' => 'foliage_asset', 'action' => 'update', 'id' => $asset->id, 'values' => ['name' => 'Tall reed', 'author' => 'Me']])->assertOk();
        $this->assertSame('Tall reed', $asset->refresh()->name);
        WaterwaysServer::tool(UpdateLibraryItem::class, ['kind' => 'foliage_asset', 'action' => 'create_type', 'id' => $asset->id])->assertOk();
        $this->assertSame($asset->id, FoliageType::query()->where('name', 'Tall reed')->sole()->foliage_asset_id);

        WaterwaysServer::tool(UpdateLibraryItem::class, ['kind' => 'biome', 'action' => 'install_starters'])->assertOk()->assertSee('installed');
        $this->assertGreaterThan(0, Biome::query()->count());
    }

    public function test_delete_library_item_deletes_with_safety_checks(): void
    {
        $material = Material::query()->create(['name' => 'Mud', 'slug' => 'mud', 'category' => 'mud', 'tile_size' => 2, 'status' => 'ready']);
        WaterwaysServer::tool(DeleteLibraryItem::class, ['kind' => 'material', 'id' => (string) $material->id])->assertOk();
        $this->assertNull(Material::query()->find($material->id));

        $character = Character::query()->create(['name' => 'Guide', 'status' => 'ready', 'model_path' => 'characters/1/model.glb']);
        app(ActiveCharacter::class)->set($character);
        WaterwaysServer::tool(DeleteLibraryItem::class, ['kind' => 'character', 'id' => (string) $character->id])->assertOk()->assertSee('"was_player_character": true');
        $this->assertNull(app(ActiveCharacter::class)->id());

        WaterwaysServer::tool(DeleteLibraryItem::class, ['kind' => 'biome', 'id' => '999'])->assertHasErrors(['No biome']);

        $other = Map::factory()->create();
        WaterwaysServer::tool(DeleteLibraryItem::class, ['kind' => 'map', 'id' => $other->slug])->assertHasErrors(['confirm']);
        $this->editor();
        WaterwaysServer::tool(DeleteLibraryItem::class, ['kind' => 'map', 'id' => $this->map->slug, 'confirm' => $this->map->slug])->assertHasErrors(['open in an editor']);
        WaterwaysServer::tool(DeleteLibraryItem::class, ['kind' => 'map', 'id' => $other->slug, 'confirm' => $other->slug])->assertOk();
        $this->assertNull(Map::query()->find($other->id));
    }

    public function test_agents_create_dismiss_and_delete_requests(): void
    {
        $editor = $this->editor(fn () => ['image' => $this->jpeg(), 'camera' => ['position' => ['x' => 0, 'y' => 50, 'z' => 80]]]);

        WaterwaysServer::tool(CreateRequest::class, [
            'note' => 'Road to the lake',
            'message' => 'Should the road follow the river or go straight?',
            'center' => ['x' => 10, 'z' => 10], 'radius' => 20,
            'attach_screenshot' => true,
        ])->assertOk()->assertSee('"status": "needs_input"');
        $request = AgentRequest::query()->sole();
        $this->assertCount(16, $request->area);
        $this->assertSame('Should the road follow the river or go straight?', $request->agent_message);
        Storage::disk('public')->assertExists($request->screenshot_path);
        $this->assertContains('refresh', AgentCommand::query()->pluck('type')->all());
        $this->assertSame('overview', collect($editor->ran)->firstWhere('type', 'screenshot')['payload']['view']);

        WaterwaysServer::tool(CreateRequest::class, ['note' => 'x', 'area' => [['x' => 0, 'z' => 0]]])->assertHasErrors();

        WaterwaysServer::tool(UpdateRequest::class, ['id' => $request->id, 'status' => 'dismissed'])->assertOk();
        $this->assertSame('dismissed', $request->refresh()->status);

        WaterwaysServer::tool(DeleteLibraryItem::class, ['kind' => 'request', 'id' => (string) $request->id])->assertOk();
        $this->assertSame(0, AgentRequest::query()->count());
    }
}
