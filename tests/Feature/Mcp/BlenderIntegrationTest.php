<?php

namespace Tests\Feature\Mcp;

use App\Mcp\Blender\BlenderLocator;
use App\Mcp\Blender\BlenderRunner;
use App\Mcp\Servers\WaterwaysServer;
use App\Mcp\Tools\BlenderExportProp;
use App\Mcp\Tools\BlenderRun;
use App\Models\PropModel;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

/**
 * Runs the example scripts in a real Blender. Opt-in (slow): WATERWAYS_BLENDER_TESTS=1, with Blender
 * found as for the tools (WATERWAYS_BLENDER_PATH, the macOS app, PATH). Skipped otherwise.
 */
class BlenderIntegrationTest extends TestCase
{
    use RefreshDatabase;

    private string $dir;

    protected function setUp(): void
    {
        parent::setUp();

        if (! getenv('WATERWAYS_BLENDER_TESTS')) {
            $this->markTestSkipped('Set WATERWAYS_BLENDER_TESTS=1 to run the examples in a real Blender.');
        }
        if (getenv('WATERWAYS_BLENDER_PATH')) {
            config(['services.blender.path' => getenv('WATERWAYS_BLENDER_PATH')]);
        }
        if (app(BlenderLocator::class)->find() === null) {
            $this->markTestSkipped('Blender is not installed.');
        }

        Storage::fake('public');
        $this->dir = sys_get_temp_dir().'/ww-blender-real-'.uniqid();
        $this->app->useStoragePath($this->dir);
        config(['services.blender.preview_engine' => getenv('WATERWAYS_BLENDER_PREVIEW_ENGINE') ?: 'workbench']);
    }

    protected function tearDown(): void
    {
        if (isset($this->dir) && ! getenv('WATERWAYS_BLENDER_KEEP')) {
            File::deleteDirectory($this->dir);
        }
        parent::tearDown();
    }

    public function test_the_fence_example_is_modelled_previewed_exported_and_imported(): void
    {
        $script = (string) file_get_contents(resource_path('blender/examples/fence_segment.py'));

        $run = WaterwaysServer::tool(BlenderRun::class, ['script' => $script, 'preview_views' => 2]);
        $run->assertOk()->assertSee(['"ok": true', 'Fence wood']);
        $job = basename((string) collect(glob(BlenderRunner::jobsRoot().'/*', GLOB_ONLYDIR))->first());
        $this->assertFileExists(BlenderRunner::jobsRoot()."/{$job}/preview/sheet.png");

        WaterwaysServer::tool(BlenderExportProp::class, ['job_id' => $job, 'name' => 'Picket fence', 'category' => 'structure'])
            ->assertOk()->assertSee(['"prop_model"', 'Picket fence']);

        $prop = PropModel::query()->sole();
        $this->assertSame(1, $prop->meshes);
        $this->assertSame(1, $prop->materials);
        $this->assertGreaterThan(100, $prop->triangles);
        $this->assertEqualsWithDelta(2.4, $prop->dimensions['x'], 0.05);
        $this->assertEqualsWithDelta(1.2, $prop->dimensions['y'], 0.05, 'Exported +Y up');
    }

    public function test_script_errors_come_back_with_the_traceback(): void
    {
        WaterwaysServer::tool(BlenderRun::class, ['script' => "wb.box()\nwb.no_such_helper()", 'preview' => false])
            ->assertHasErrors(['Traceback', 'script.py', 'no_such_helper']);
    }
}
