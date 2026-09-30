<?php

namespace Tests\Feature\Mcp;

use App\Mcp\EditorBridge;
use App\Mcp\PerformanceFindings;
use App\Mcp\Servers\WaterwaysServer;
use App\Mcp\Tools\ProfilePerformance;
use App\Models\Map;
use App\Models\PropModel;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class PerformanceToolsTest extends TestCase
{
    use RefreshDatabase;

    /**
     * A profile as the editor reports it (editor/agent/profilePerformance.ts): heavy tree props.
     *
     * @return array<string, mixed>
     */
    private function profile(int $pineModel, int $hutModel): array
    {
        return [
            'mode' => 'edit',
            'backend' => 'webgpu',
            'gpu_timers' => true,
            'resolution' => ['output' => '1600×900', 'render' => '960×540', 'render_scale' => 0.6, 'configured_render_scale' => 1, 'dynamic_resolution' => true],
            'frame' => ['frames' => 40, 'fps' => 28, 'frame_interval_ms' => 35.7, 'cpu_ms' => 9.5, 'gpu_ms' => 34.2, 'frame_ms' => 34.2, 'draw_calls' => 4210, 'triangles' => 81000000],
            'frame_after' => ['frames' => 40, 'fps' => 28, 'frame_interval_ms' => 35.9, 'cpu_ms' => 9.6, 'gpu_ms' => 34.5, 'frame_ms' => 34.5, 'draw_calls' => 4210, 'triangles' => 81000000],
            'noise_ms' => 0.3,
            'passes' => [
                ['name' => 'Scene', 'gpu_ms' => 18.1, 'cpu_ms' => null],
                ['name' => 'Shadows', 'gpu_ms' => 11.3, 'cpu_ms' => null],
                ['name' => 'Bloom', 'gpu_ms' => 0.4, 'cpu_ms' => null],
            ],
            'costs' => [
                ['system' => 'foliage', 'cost_ms' => 2.1, 'gpu_ms' => 2.1, 'cpu_ms' => 0.1, 'draw_calls' => 30, 'triangles' => 2000000, 'fps_without' => 30, 'frames' => 40],
                ['system' => 'props', 'cost_ms' => 24.8, 'gpu_ms' => 24.8, 'cpu_ms' => 5.2, 'draw_calls' => 3600, 'triangles' => 75000000, 'fps_without' => 60, 'frames' => 40],
                ['system' => 'water', 'cost_ms' => 0.1, 'gpu_ms' => 0.1, 'cpu_ms' => 0, 'draw_calls' => 2, 'triangles' => 1000, 'fps_without' => 28, 'frames' => 40],
                ['system' => 'ground_cover', 'skipped' => 'nothing to measure here'],
            ],
            'systems' => [
                'props' => [
                    'instances' => 401,
                    'models' => [
                        ['model_id' => $pineModel, 'name' => 'Pine', 'instances' => 400, 'in_view' => 250, 'triangles_per_instance' => 180000, 'meshes_per_instance' => 3, 'materials_per_instance' => 2, 'casts_shadow' => true, 'triangles_total' => 72000000, 'draw_calls_per_pass' => 1200],
                        // Not loaded in the editor: the library fills in its numbers.
                        ['model_id' => $hutModel, 'name' => 'Hut', 'instances' => 1, 'in_view' => 0, 'triangles_per_instance' => null, 'meshes_per_instance' => null, 'materials_per_instance' => null, 'casts_shadow' => null, 'triangles_total' => null, 'draw_calls_per_pass' => null],
                    ],
                ],
                'foliage' => ['instances' => 900, 'types' => [
                    ['name' => 'Oak', 'kind' => 'broadleaf', 'instances' => 900, 'drawn' => 500, 'lod_triangles' => [12000, 3000, 2], 'lod_instances' => [30, 200, 270], 'warnings' => ['No far LOD (impostor): rebake the asset.']],
                ]],
                'ground_cover' => ['instances' => 0, 'types' => [], 'layers' => []],
            ],
        ];
    }

    public function test_profile_performance_measures_in_the_open_editor_and_explains_the_result(): void
    {
        $map = Map::factory()->create();
        $pine = PropModel::factory()->create(['name' => 'Pine', 'triangles' => 180000, 'meshes' => 3, 'materials' => 2]);
        $hut = PropModel::factory()->create(['name' => 'Hut', 'triangles' => 3000, 'meshes' => 1, 'materials' => 1]);
        $editor = new FakeEditor($map, fn (string $type, array $payload) => $type === 'profile' ? $this->profile($pine->id, $hut->id) : []);
        $this->app->instance(EditorBridge::class, $editor);

        $response = WaterwaysServer::tool(ProfilePerformance::class, [
            'map' => $map->slug,
            'position' => ['x' => 10, 'z' => -20],
            'look_at' => ['x' => 0, 'z' => 0],
            'sample_frames' => 30,
            'systems' => ['props', 'foliage'],
        ]);

        $response->assertOk()->assertSee([
            '"findings"',
            'Props cost 25 ms',
            '73% of the frame',
            'Prop model \"Pine\" has 180k triangles × 400 placed = 72M triangles',
            'Vegetation belongs in foliage',
            'Negligible here',
            'Most GPU time goes to: Scene 18 ms, Shadows 11 ms',
            'Dynamic resolution has lowered the render scale to 0.6',
            'Foliage type \"Oak\": No far LOD',
            '"triangles_per_instance": 3000',
        ]);
        $this->assertSame('profile', $editor->ran[0]['type']);
        $this->assertSame([
            'position' => ['x' => 10, 'z' => -20],
            'look_at' => ['x' => 0, 'z' => 0],
            'sample_frames' => 30,
            'systems' => ['props', 'foliage'],
            'keep_camera' => false,
            'budget_ms' => 15000,
        ], $editor->ran[0]['payload']);

        WaterwaysServer::tool(ProfilePerformance::class, ['map' => $map->slug, 'systems' => ['terrain']])->assertHasErrors();
        WaterwaysServer::tool(ProfilePerformance::class, ['map' => $map->slug, 'sample_frames' => 5000])->assertHasErrors();
    }

    public function test_profile_performance_needs_an_open_editor(): void
    {
        $map = Map::factory()->create();

        WaterwaysServer::tool(ProfilePerformance::class, ['map' => $map->slug])->assertHasErrors(['not open']);
    }

    public function test_findings_stay_quiet_for_a_light_scene(): void
    {
        $findings = PerformanceFindings::analyse([
            'frame' => ['fps' => 60, 'frame_interval_ms' => 16.7, 'cpu_ms' => 3.1, 'gpu_ms' => 6.2, 'frame_ms' => 6.2, 'draw_calls' => 420, 'triangles' => 1500000],
            'noise_ms' => 0.2,
            'costs' => [['system' => 'props', 'cost_ms' => 0.1], ['system' => 'water', 'cost_ms' => 0.2]],
            'systems' => ['props' => ['models' => [['name' => 'Hut', 'instances' => 3, 'triangles_per_instance' => 4000]]]],
        ]);

        $this->assertStringContainsString('limited by the GPU', $findings[0]);
        $this->assertStringContainsString('Negligible here', $findings[1]);
        $this->assertStringContainsString('capped', $findings[2]);
        $this->assertCount(3, $findings);
    }

    public function test_a_profile_without_rendered_frames_says_nothing_could_be_measured(): void
    {
        $findings = PerformanceFindings::analyse([
            'frame' => ['frames' => 0, 'fps' => 0, 'cpu_ms' => 0, 'gpu_ms' => null, 'frame_ms' => 0, 'draw_calls' => 0, 'triangles' => 0],
            'noise_ms' => 0,
            'costs' => [['system' => 'props', 'unmeasured' => 'no frames rendered in time', 'frames' => 0]],
        ]);

        $this->assertStringContainsString('No frame finished during the measurement', $findings[0]);
        $this->assertStringNotContainsString('Negligible', implode(' ', $findings));
    }
}
