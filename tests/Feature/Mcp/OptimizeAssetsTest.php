<?php

namespace Tests\Feature\Mcp;

use App\Mcp\Assets\AssetOptimizer;
use App\Mcp\Servers\WaterwaysServer;
use App\Mcp\Tools\OptimizeAssets;
use App\Models\FoliageAsset;
use App\Models\PropModel;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Process\PendingProcess;
use Illuminate\Support\Facades\Process;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

class OptimizeAssetsTest extends TestCase
{
    use RefreshDatabase;

    /** Stands in for resources/node/optimize-glb.mjs: writes the copy and prints its result line. */
    private function fakeOptimizer(): void
    {
        Process::fake(function (PendingProcess $process) {
            $out = $process->command[3];
            file_put_contents($out, 'glTF-optimized');

            return Process::result("encoding…\n@@RESULT ".json_encode([
                'ok' => true,
                'bytes_before' => 4000,
                'bytes_after' => 1000,
                'textures' => 2,
                'textures_converted' => 2,
                'texture_bytes_before' => 3000,
                'texture_bytes_after' => 800,
                'texture_memory_before' => 8000,
                'texture_memory_after' => 2000,
                'meshopt' => ! in_array('--no-meshes', $process->command, true),
            ]));
        });
    }

    /** @return array{FoliageAsset, FoliageAsset, PropModel, PropModel} */
    private function library(): array
    {
        Storage::fake('public');
        Storage::disk('public')->put('foliage/1/model.glb', str_repeat('x', 4000));
        Storage::disk('public')->put('foliage/2/model.glb', str_repeat('x', 4000));
        Storage::disk('public')->put('props/1/model.glb', str_repeat('x', 4000));

        $oak = FoliageAsset::query()->create(['name' => 'Oak', 'kind' => 'broadleaf', 'source' => 'upload', 'source_type' => 'model', 'status' => 'ready', 'model_path' => 'foliage/1/model.glb', 'meta' => ['impostor' => 'octahedral']]);
        $fir = FoliageAsset::query()->create(['name' => 'Fir', 'kind' => 'conifer', 'source' => 'upload', 'source_type' => 'model', 'status' => 'ready', 'model_path' => 'foliage/2/model.glb', 'meta' => []]);
        $hut = PropModel::factory()->create(['name' => 'Hut', 'status' => 'ready', 'model_path' => 'props/1/model.glb']);
        $lost = PropModel::factory()->create(['name' => 'Lost', 'status' => 'ready', 'model_path' => 'props/9/model.glb']);

        return [$oak, $fir, $hut, $lost];
    }

    public function test_dry_run_reports_pending_models_missing_files_and_old_impostors(): void
    {
        [$oak, $fir] = $this->library();
        Process::fake();

        $response = WaterwaysServer::tool(OptimizeAssets::class, ['dry_run' => true]);

        $response->assertOk()->assertSee([
            '"pending": 3',
            '"missing": 1',
            '"impostor": "octahedral"',
            '"impostor": "billboard"',
            '"status": "missing"',
        ]);
        Process::assertNothingRan();
        $this->assertSame('octahedral', AssetOptimizer::impostorKind($oak));
        $this->assertSame('billboard', AssetOptimizer::impostorKind($fir));
    }

    public function test_optimize_assets_compresses_up_to_the_limit_and_the_game_gets_the_copies(): void
    {
        [$oak, $fir, $hut] = $this->library();
        $this->fakeOptimizer();

        $response = WaterwaysServer::tool(OptimizeAssets::class, ['limit' => 2, 'textures' => false]);

        $response->assertOk()->assertSee([
            '"optimized": 2',
            '"pending": 1',
            '"file_saving_percent": 75',
            '"texture_memory_saving_percent": 75',
            'still pending: call optimize_assets again',
        ]);
        Process::assertRanTimes(fn (PendingProcess $p) => in_array('--no-textures', $p->command, true), 2);
        Storage::disk('public')->assertExists(['foliage/1/model.opt.glb', 'foliage/2/model.opt.glb']);
        Storage::disk('public')->assertMissing('props/1/model.opt.glb');

        // The game loads the compressed copy, the original stays the fallback.
        $this->assertStringStartsWith('/storage/foliage/1/model.opt.glb?v=', $oak->refresh()->toGameArray()['optimized_url']);
        $this->assertNull($hut->refresh()->toGameArray()['optimized_url']);

        // The next call picks up the rest; copies that are up to date are left alone.
        WaterwaysServer::tool(OptimizeAssets::class, [])->assertOk()->assertSee(['"optimized": 1', '"up_to_date": 2', 'Done.']);
        Process::assertRanTimes(fn () => true, 3);
        $this->assertNotNull($hut->refresh()->toGameArray()['optimized_url']);
    }

    public function test_a_copy_older_than_its_model_is_stale(): void
    {
        [$oak] = $this->library();
        Storage::disk('public')->put('foliage/1/model.opt.glb', 'old');
        touch(Storage::disk('public')->path('foliage/1/model.opt.glb'), time() - 60);

        $this->assertNull(AssetOptimizer::optimizedUrl($oak->model_path, '1'));
        $this->assertSame('foliage/1/model.opt.glb', AssetOptimizer::optimizedPath('foliage/1/model.glb?v=3'));
    }

    public function test_optimize_assets_validates_and_reports_failures(): void
    {
        $this->library();
        Process::fake(fn () => Process::result("@@RESULT {\"ok\":false,\"error\":\"bad texture\"}\n", '', 1));

        WaterwaysServer::tool(OptimizeAssets::class, ['ids' => [1]])->assertHasErrors(['Pass kind']);
        WaterwaysServer::tool(OptimizeAssets::class, ['kind' => 'trees'])->assertHasErrors();

        WaterwaysServer::tool(OptimizeAssets::class, ['kind' => 'foliage', 'ids' => [1]])
            ->assertOk()->assertSee(['"failed": 1', 'bad texture']);
        Storage::disk('public')->assertMissing('foliage/1/model.opt.glb');
    }

    public function test_the_artisan_command_reports_the_savings(): void
    {
        $this->library();
        $this->fakeOptimizer();

        $this->artisan('waterways:optimize-assets', ['--kind' => 'foliage', '--dry-run' => true])
            ->expectsOutputToContain('2 pending')
            ->assertSuccessful();

        $this->artisan('waterways:optimize-assets', ['--kind' => 'props'])
            ->expectsOutputToContain('1 optimised, 0 up to date, 0 failed, 1 without a model file')
            ->assertSuccessful();

        $this->artisan('waterways:optimize-assets', ['--kind' => 'plants'])->assertFailed();
    }
}
