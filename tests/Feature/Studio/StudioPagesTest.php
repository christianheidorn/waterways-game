<?php

namespace Tests\Feature\Studio;

use App\Models\FoliageType;
use App\Models\Map;
use App\Support\DefaultTerrainLayers;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Inertia\Testing\AssertableInertia as Assert;
use Tests\TestCase;

class StudioPagesTest extends TestCase
{
    use RefreshDatabase;

    public function test_root_redirects_to_the_dashboard_without_authentication(): void
    {
        $this->get('/')->assertRedirect('/dashboard');
        $this->get('/dashboard')->assertOk()->assertInertia(fn (Assert $page) => $page->component('dashboard'));
    }

    public function test_every_studio_page_renders(): void
    {
        $map = Map::factory()->create();
        DefaultTerrainLayers::createFor($map);

        $pages = [
            '/maps' => 'maps/index',
            '/maps/create' => 'maps/create',
            "/maps/{$map->slug}" => 'maps/show',
            "/maps/{$map->slug}/environment" => 'maps/environment',
            "/maps/{$map->slug}/layers" => 'maps/layers',
            "/maps/{$map->slug}/editor" => 'maps/editor',
            '/foliage' => 'foliage/index',
            '/settings/game/player' => 'game-settings/edit',
            '/settings/game/graphics' => 'game-settings/edit',
            '/settings/game/editor' => 'game-settings/edit',
            '/settings/appearance' => 'settings/appearance',
        ];

        foreach ($pages as $url => $component) {
            $this->get($url)->assertOk()->assertInertia(fn (Assert $page) => $page->component($component));
        }
    }

    public function test_editor_page_passes_the_game_url_and_settings(): void
    {
        $map = Map::factory()->create();

        $this->get("/maps/{$map->slug}/editor?mode=play")
            ->assertInertia(fn (Assert $page) => $page
                ->component('maps/editor')
                ->where('mode', 'play')
                ->where('gameUrl', route('game.show', $map))
                ->has('environment.time_of_day')
                ->has('settings.player.walk_speed')
                ->has('settingsGroups', 3));
    }

    public function test_game_page_boots_the_engine_with_its_config(): void
    {
        $map = Map::factory()->create();

        $this->get("/game/{$map->slug}?mode=play&embedded=1")
            ->assertOk()
            ->assertSee('window.__WATERWAYS__', false)
            ->assertSee(str_replace('/', '\\/', route('api.maps.manifest', $map)), false)
            ->assertSee('"mode":"play"', false)
            ->assertSee('"embedded":true', false);
    }

    public function test_studio_launch_opens_the_default_map_or_the_create_page(): void
    {
        $this->get('/studio')->assertRedirect('/maps/create');

        Map::factory()->create();
        $default = Map::factory()->create(['is_default' => true]);

        $this->get('/studio')->assertRedirect("/maps/{$default->slug}/editor");
    }

    public function test_game_settings_are_validated_and_saved(): void
    {
        $this->put('/settings/game/player', ['walk_speed' => 4.5, 'invert_y' => true])->assertRedirect();
        $this->put('/settings/game/player', ['walk_speed' => 999])->assertSessionHasErrors('walk_speed');
        $this->put('/settings/game/graphics', ['shadow_quality' => 'insane'])->assertSessionHasErrors('shadow_quality');
        $this->put('/settings/game/nope', [])->assertNotFound();

        $this->get('/settings/game/player')->assertInertia(fn (Assert $page) => $page
            ->where('values.walk_speed', 4.5)
            ->where('values.invert_y', true)
            ->where('values.run_speed', 7.5));

        $this->delete('/settings/game/player')->assertRedirect();
        $this->get('/settings/game/player')->assertInertia(fn (Assert $page) => $page->where('values.walk_speed', 3.2));
    }

    public function test_foliage_types_can_be_managed(): void
    {
        $payload = [
            'name' => 'Pine', 'kind' => 'conifer', 'color' => '#224422', 'color_secondary' => '#553311',
            'min_scale' => 0.8, 'max_scale' => 1.2, 'density' => 1, 'min_slope' => 0, 'max_slope' => 35,
            'min_height' => null, 'max_height' => null, 'align_to_normal' => false, 'random_yaw' => true,
            'cast_shadows' => true, 'cull_distance' => 800, 'allow_underwater' => false,
        ];

        $this->post('/foliage', $payload)->assertRedirect();
        $type = FoliageType::query()->firstOrFail();
        $this->assertSame('Pine', $type->name);

        $this->put("/foliage/{$type->id}", [...$payload, 'max_scale' => 0.5])->assertSessionHasErrors('max_scale');
        $this->put("/foliage/{$type->id}", [...$payload, 'name' => 'Fir'])->assertRedirect();
        $this->assertSame('Fir', $type->fresh()->name);

        $this->delete("/foliage/{$type->id}")->assertRedirect();
        $this->assertDatabaseCount('foliage_types', 0);
    }
}
