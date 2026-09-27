<?php

namespace Tests\Feature\Materials;

use App\Models\Map;
use App\Models\Material;
use App\Services\Materials\MaterialLibrary;
use App\Support\DefaultTerrainLayers;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Storage;
use Tests\Concerns\CreatesTestImages;
use Tests\Concerns\FakesOpenRouter;
use Tests\TestCase;

class MapAiTest extends TestCase
{
    use CreatesTestImages;
    use FakesOpenRouter;
    use RefreshDatabase;

    private Map $map;

    private Material $grass;

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('public');
        Storage::fake('local');
        // The layer planner also browses Poly Haven / ambientCG: unfaked requests fail (→ omitted).
        Http::preventStrayRequests();

        $this->map = Map::factory()->create(['min_height' => 100, 'max_height' => 900, 'center_lat' => 46.36, 'center_lng' => 14.09]);
        DefaultTerrainLayers::createFor($this->map);
        $this->grass = app(MaterialLibrary::class)->create(['name' => 'Lush grass', 'category' => 'grass', 'tile_size' => 2.5, 'status' => 'ready', 'albedo_path' => 'materials/x/albedo.jpg']);
    }

    public function test_ai_endpoints_report_missing_configuration_and_upstream_errors(): void
    {
        $this->postJson("/api/maps/{$this->map->slug}/ai/suggest-materials")->assertStatus(422)->assertJsonPath('configured', false);

        $this->configureAi();
        $this->fakeOpenRouter(chat: 'I cannot help with that.');
        $this->postJson("/api/maps/{$this->map->slug}/ai/suggest-materials")->assertStatus(502)->assertJsonPath('message', fn ($m) => str_contains($m, 'did not return valid JSON'));
    }

    public function test_screenshot_review_is_validated_against_the_environment_schema(): void
    {
        $this->configureAi();
        $this->fakeOpenRouter(chat: [
            'summary' => 'Looks flat and over-exposed.',
            'score' => 42,
            'suggestions' => [
                ['title' => 'Warmer light', 'detail' => 'Late afternoon sun.', 'changes' => [
                    'environment' => ['time_of_day' => 17.25, 'fog_density' => 0.5, 'water_deep_color' => 'blue', 'water_shallow_color' => '#3399AA', 'shore_foam' => 'false', 'bogus_key' => 1],
                    'layers' => [
                        ['slot' => 0, 'tint' => '#ddeecc', 'roughness_scale' => 9, 'normal_strength' => -1, 'texture_scale' => 0.001, 'material_id' => 999, 'color' => '#000000'],
                        ['slot' => 99, 'tint' => '#ffffff'],
                    ],
                ]],
                ['detail' => 'No title → dropped'],
                ['title' => 'Nothing applicable', 'changes' => ['environment' => ['unknown' => 1]]],
            ],
        ]);

        $jpeg = 'data:image/jpeg;base64,'.base64_encode($this->jpeg($this->noiseImage(64, 48)));

        $this->postJson("/api/maps/{$this->map->slug}/ai/review", [
            'image' => $jpeg, 'mode' => 'play', 'camera' => ['x' => 1, 'y' => 2, 'z' => 3, 'yaw' => 0.5, 'pitch' => -0.2],
        ])->assertOk()
            ->assertJsonPath('score', 10)
            ->assertJsonPath('summary', 'Looks flat and over-exposed.')
            ->assertJsonCount(2, 'suggestions')
            ->assertJsonPath('suggestions.0.changes.environment', ['time_of_day' => 17.25, 'fog_density' => 0.004, 'water_shallow_color' => '#3399aa', 'shore_foam' => false])
            ->assertJsonPath('suggestions.0.changes.layers', [['slot' => 0, 'tint' => '#ddeecc', 'roughness_scale' => 3, 'normal_strength' => 0, 'texture_scale' => 0.1]])
            ->assertJsonPath('suggestions.1.changes', []);

        $chat = Http::recorded(fn (Request $r) => str_ends_with($r->url(), '/chat/completions'))->first()[0]->data();
        $content = $chat['messages'][1]['content'];
        $this->assertSame('image_url', $content[1]['type']);
        $this->assertSame($jpeg, $content[1]['image_url']['url']);
        $this->assertStringContainsString('"key": "fog_density"', $content[0]['text']);
        $this->assertStringContainsString('"pitch": -0.2', $content[0]['text']);

        $this->postJson("/api/maps/{$this->map->slug}/ai/review", ['image' => 'data:text/plain;base64,aGVsbG8='])->assertStatus(422)->assertJsonValidationErrors('image');
        $this->postJson("/api/maps/{$this->map->slug}/ai/review", ['image' => 'data:image/jpeg;base64,'.base64_encode('not an image')])->assertStatus(422);
    }

    public function test_applying_review_changes_returns_game_shapes(): void
    {
        $this->postJson("/api/maps/{$this->map->slug}/ai/apply-changes", ['changes' => [
            'environment' => ['exposure' => 0.8, 'fog_density' => 1, 'nope' => 3],
            'layers' => [
                ['slot' => 0, 'tint' => '#ccddee', 'material_id' => $this->grass->id],
                ['slot' => 3, 'normal_strength' => 1.7, 'texture_scale' => 12],
            ],
        ]])->assertOk()
            ->assertJsonPath('environment.exposure', 0.8)
            ->assertJsonPath('environment.fog_density', 0.004)
            ->assertJsonMissingPath('environment.nope')
            ->assertJsonPath('layers.0.tint', '#ccddee')
            ->assertJsonPath('layers.0.material_id', $this->grass->id)
            ->assertJsonPath('layers.0.texture_scale', 2.5)
            ->assertJsonPath('layers.3.normal_strength', 1.7)
            ->assertJsonPath('layers.3.texture_scale', 12)
            ->assertJsonCount(8, 'layers');

        $this->assertSame(0.8, $this->map->refresh()->resolvedEnvironment()['exposure']);

        $this->postJson("/api/maps/{$this->map->slug}/ai/apply-changes", ['changes' => ['layers' => [['slot' => 12]]]])->assertStatus(422);
    }
}
