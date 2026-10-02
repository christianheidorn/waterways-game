<?php

namespace Tests\Feature\Mcp;

use App\Mcp\Blender\BlenderJob;
use App\Mcp\Blender\BlenderLocator;
use App\Mcp\Blender\BlenderRunner;
use App\Mcp\Servers\WaterwaysServer;
use App\Mcp\Tools\BlenderExportProp;
use App\Mcp\Tools\BlenderPreview;
use App\Mcp\Tools\BlenderRun;
use App\Mcp\Tools\BlenderStatus;
use App\Models\FoliageAsset;
use App\Models\PropModel;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Process\PendingProcess;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Process;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Tests\TestCase;

class BlenderToolsTest extends TestCase
{
    use RefreshDatabase;

    private string $dir;

    private string $blender;

    /** @var list<array<int, string>> */
    private array $commands = [];

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('public');
        $this->dir = sys_get_temp_dir().'/ww-blender-test-'.uniqid();
        File::ensureDirectoryExists($this->dir.'/bin');
        $this->app->useStoragePath($this->dir.'/storage');
        $this->blender = $this->dir.'/bin/blender';
        file_put_contents($this->blender, "#!/bin/sh\nexit 0\n");
        chmod($this->blender, 0755);
        config(['services.blender.path' => $this->blender, 'services.blender.timeout' => 120]);
    }

    protected function tearDown(): void
    {
        File::deleteDirectory($this->dir);
        parent::tearDown();
    }

    /**
     * Stands in for Blender: answers --version, and for a job writes what the helper library would
     * (result.json, scene.blend, preview images, model.glb for an export) or fails with a traceback.
     */
    private function fakeBlender(?string $traceback = null): void
    {
        Process::fake(function (PendingProcess $process) use ($traceback) {
            $command = $process->command;
            $this->commands[] = $command;

            if (in_array('--version', $command, true)) {
                return Process::result("Blender 4.2.3 LTS\n\tbuild date: 2024-10-14\n");
            }

            $dir = $command[array_search('--job-dir', $command, true) + 1];
            $script = (string) file_get_contents($dir.'/script.py');

            if ($traceback !== null) {
                return Process::result("Fra:1 rendering\n", "Traceback (most recent call last):\n  File \"script.py\", line 3, in <module>\n{$traceback}\n", 1);
            }

            if (str_contains($script, 'wb.preview(')) {
                File::ensureDirectoryExists($dir.'/preview');
                file_put_contents($dir.'/preview/sheet.png', $this->png());
                file_put_contents($dir.'/preview/view_0.png', $this->png());
                file_put_contents($dir.'/preview/view_1.png', $this->png());
            }
            if (str_contains($script, 'wb.export_glb(')) {
                file_put_contents($dir.'/model.glb', $this->glb());
            }
            if (! str_contains((string) file_get_contents($dir.'/job.py'), 'False)')) {
                file_put_contents($dir.'/scene.blend', 'BLENDER-v402');
            }
            file_put_contents($dir.'/result.json', json_encode(['blender' => '4.2.3 LTS', 'stats' => [
                'triangles' => 412, 'vertices' => 230, 'meshes' => 1, 'materials' => 2,
                'dimensions' => ['width' => 3.6, 'depth' => 3, 'height' => 3.3],
            ]]));

            return Process::result("{'triangles': 412}\nFra:1 Mem:9M | Sample 8/8\n@@WB_RESULT {}\n");
        });
    }

    private function png(): string
    {
        $image = imagecreatetruecolor(8, 8);
        ob_start();
        imagepng($image);

        return (string) ob_get_clean();
    }

    /** A tiny valid GLB: one triangle 1 × 2 × 0.5 m. */
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

    public function test_the_locator_prefers_the_configured_path_and_searches_common_places(): void
    {
        $this->assertSame($this->blender, (new BlenderLocator)->find());

        config(['services.blender.path' => $this->dir.'/nowhere/blender']);
        $this->assertNull((new BlenderLocator)->find(), 'A configured path that does not exist is not replaced by a search');
        $this->assertStringContainsString('WATERWAYS_BLENDER_PATH is set to', (new BlenderLocator)->installHelp());

        config(['services.blender.path' => null]);
        $this->assertSame($this->blender, (new BlenderLocator([$this->dir.'/missing', $this->blender]))->find());
        $this->assertNull((new BlenderLocator([$this->dir.'/missing']))->find());
        $this->assertContains('/Applications/Blender.app/Contents/MacOS/Blender', (new BlenderLocator)->candidates());
    }

    public function test_blender_status_reports_the_version_or_how_to_install_it(): void
    {
        $this->fakeBlender();

        WaterwaysServer::tool(BlenderStatus::class, [])
            ->assertOk()
            ->assertSee(['"found": true', '"version": "4.2.3 LTS"', 'waterways_blender.py', 'wooden_hut.py']);

        config(['services.blender.path' => null]);
        $this->app->instance(BlenderLocator::class, new BlenderLocator([]));
        WaterwaysServer::tool(BlenderStatus::class, [])
            ->assertOk()
            ->assertSee(['"found": false', 'brew install --cask blender']);
        WaterwaysServer::tool(BlenderRun::class, ['script' => 'wb.box()'])
            ->assertHasErrors(['Blender is not installed']);
    }

    public function test_blender_run_runs_the_script_headless_and_returns_stats_and_the_preview(): void
    {
        $this->fakeBlender();

        $response = WaterwaysServer::tool(BlenderRun::class, ['script' => "hut = wb.box((3, 2.5, 2.2))\nprint(wb.stats())"]);

        $response->assertOk()->assertSee(['"ok": true', '"triangles": 412', "{'triangles': 412}", 'blender_export_prop']);
        $response->assertDontSee(['Fra:1', '@@WB_RESULT']);

        $command = collect($this->commands)->last();
        $this->assertSame([$this->blender, '--background', '--factory-startup', '--python-exit-code', '1', '--python'], array_slice($command, 0, 6));
        $dir = $command[array_search('--job-dir', $command, true) + 1];
        $this->assertStringStartsWith(BlenderRunner::jobsRoot().'/', $dir);
        $this->assertStringContainsString('wb.preview(views=4', (string) file_get_contents($dir.'/script.py'));
        $bootstrap = (string) file_get_contents($dir.'/job.py');
        $this->assertStringContainsString('sys.path.insert(0, "'.resource_path('blender').'")', $bootstrap);
        $this->assertStringContainsString('wb._run_job("'.$dir.'", None, "script.py", True)', $bootstrap);
        $this->assertFileExists($dir.'/scene.blend');
    }

    public function test_continue_job_starts_from_the_saved_scene_and_errors_show_the_traceback(): void
    {
        $this->fakeBlender();
        WaterwaysServer::tool(BlenderRun::class, ['script' => 'wb.box()', 'preview' => false])->assertOk();
        $first = basename(dirname($this->commands[0][6]));

        WaterwaysServer::tool(BlenderRun::class, ['script' => 'wb.bevel(bpy.data.objects[0])', 'continue_job' => $first, 'preview' => false])->assertOk();
        $bootstrap = (string) file_get_contents(dirname($this->commands[1][6]).'/job.py');
        $this->assertStringContainsString(BlenderRunner::jobsRoot().'/'.$first.'/scene.blend', $bootstrap);

        WaterwaysServer::tool(BlenderRun::class, ['script' => 'x', 'continue_job' => Str::uuid()->toString()])
            ->assertHasErrors(['No Blender job']);

        $this->fakeBlender("NameError: name 'wb.boxx' is not defined");
        WaterwaysServer::tool(BlenderRun::class, ['script' => 'wb.boxx()'])
            ->assertHasErrors(['failed', 'Traceback', "NameError: name 'wb.boxx' is not defined", 'line 3']);
    }

    public function test_a_job_without_a_result_or_over_time_explains_itself(): void
    {
        $job = new BlenderJob('id', $this->dir, 134, false, '', "Segmentation fault\n", null);
        $this->assertFalse($job->ok());
        $this->assertSame('Segmentation fault', $job->error());

        $late = new BlenderJob('id', $this->dir, null, true, '', '', null);
        $this->assertStringContainsString('time limit', (string) $late->error());
    }

    public function test_blender_preview_renders_a_job_or_a_file(): void
    {
        $this->fakeBlender();
        WaterwaysServer::tool(BlenderRun::class, ['script' => 'wb.box()', 'preview' => false])->assertOk();
        $job = basename(dirname($this->commands[0][6]));

        WaterwaysServer::tool(BlenderPreview::class, ['job_id' => $job, 'views' => 8, 'engine' => 'workbench', 'elevation' => 90])
            ->assertOk()->assertSee(['preview/sheet.png']);
        $script = (string) file_get_contents(dirname($this->commands[1][6]).'/script.py');
        $this->assertStringContainsString('wb.preview(views=8, size=448, engine="workbench", figure=True, elevation=90, sheet=True)', $script);
        $this->assertStringContainsString(', False)', (string) file_get_contents(dirname($this->commands[1][6]).'/job.py'), 'Previews do not save the scene');

        $glb = $this->dir.'/boat.glb';
        file_put_contents($glb, $this->glb());
        WaterwaysServer::tool(BlenderPreview::class, ['path' => $glb, 'separate' => true])->assertOk();
        WaterwaysServer::tool(BlenderPreview::class, ['path' => $this->dir.'/nope.glb'])->assertHasErrors(['No file']);
        WaterwaysServer::tool(BlenderPreview::class, [])->assertHasErrors(['Pass job_id']);
    }

    public function test_blender_export_prop_exports_the_job_and_imports_a_prop(): void
    {
        $this->fakeBlender();
        WaterwaysServer::tool(BlenderRun::class, ['script' => 'wb.box()', 'preview' => false])->assertOk();
        $job = basename(dirname($this->commands[0][6]));

        WaterwaysServer::tool(BlenderExportProp::class, [
            'job_id' => $job, 'name' => 'Fishing hut', 'category' => 'building', 'collision' => 'mesh',
            'max_triangles' => 5000, 'lods' => [1, 0.5],
        ])->assertOk()->assertSee(['"prop_model"', '"name": "Fishing hut"', '"glb"', 'lods were ignored', 'place_props']);

        $script = (string) file_get_contents(dirname($this->commands[1][6]).'/script.py');
        $this->assertStringContainsString('wb.export_glb(wb.out("model.glb"), name="Fishing hut", max_triangles=5000, lods=None, join_parts=True)', $script);

        $prop = PropModel::query()->sole();
        $this->assertSame('building', $prop->category);
        $this->assertSame('mesh', $prop->collision);
        $this->assertSame('ready', $prop->status);
        Storage::disk('public')->assertExists($prop->model_path);
    }

    public function test_blender_export_prop_imports_foliage_with_lods_and_checks_arguments(): void
    {
        $this->fakeBlender();
        WaterwaysServer::tool(BlenderRun::class, ['script' => 'wb.sphere()', 'preview' => false])->assertOk();
        $job = basename(dirname($this->commands[0][6]));

        WaterwaysServer::tool(BlenderExportProp::class, ['job_id' => $job, 'name' => 'Granite boulder', 'kind' => 'foliage', 'foliage_kind' => 'rock', 'lods' => [1, 0.4, 0.15], 'bake' => false])
            ->assertOk()->assertSee(['"foliage_asset"', 'Granite boulder']);
        $this->assertStringContainsString('lods=[1,0.4,0.15]', (string) file_get_contents(dirname($this->commands[1][6]).'/script.py'));
        $this->assertSame('rock', FoliageAsset::query()->sole()->kind->value);

        WaterwaysServer::tool(BlenderExportProp::class, ['job_id' => $job, 'name' => 'X', 'lods' => [1, 2]])->assertHasErrors(['between 0 and 1']);
        WaterwaysServer::tool(BlenderExportProp::class, ['job_id' => 'nope', 'name' => 'X'])->assertHasErrors(['No Blender job']);
        WaterwaysServer::tool(BlenderExportProp::class, ['job_id' => $job, 'name' => 'X', 'category' => 'spaceship'])->assertHasErrors(['Unknown category']);
    }

    public function test_old_jobs_are_pruned(): void
    {
        $root = BlenderRunner::jobsRoot();
        File::ensureDirectoryExists($root.'/old');
        File::ensureDirectoryExists($root.'/new');
        touch($root.'/old', time() - 8 * 86400);

        app(BlenderRunner::class)->prune();

        $this->assertDirectoryDoesNotExist($root.'/old');
        $this->assertDirectoryExists($root.'/new');
    }
}
