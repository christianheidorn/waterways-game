<?php

namespace App\Mcp\Tools;

use App\Mcp\Blender\BlenderRunner;
use App\Mcp\ToolError;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\ResponseFactory;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;

#[Name('blender_preview')]
#[Description(<<<'TXT'
Renders a turntable of a model in headless Blender and returns the images so you can see it: a blender_run job's scene (job_id) or a .blend / .glb / .gltf file (path). Views around the model (front three-quarter first) with a 1.8 m figure beside it for scale on a ground disc; one contact sheet by default, or each view separately (separate: true). Engines: eevee (materials and shadows, default), workbench (fast, flat studio light), cycles (CPU, slow).
TXT)]
class BlenderPreview extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        return [
            'job_id' => $schema->string()->description('A blender_run job whose saved scene to render.'),
            'path' => $schema->string()->description('Or: absolute path of a .blend, .glb or .gltf file.'),
            'views' => $schema->integer()->min(1)->max(8)->description('Views around the model (default 6).'),
            'size' => $schema->integer()->min(128)->max(1024)->description('Pixels per view (default 448).'),
            'engine' => $schema->string()->enum(['eevee', 'workbench', 'cycles'])->description('Render engine (default eevee, or WATERWAYS_BLENDER_PREVIEW_ENGINE).'),
            'figure' => $schema->boolean()->description('Show the 1.8 m scale figure (default true).'),
            'elevation' => $schema->number()->min(-10)->max(90)->description('Camera elevation in degrees (default 22; 90 = top view).'),
            'lod' => $schema->integer()->min(0)->max(5)->description('Models with LODs (<name>_LOD0, _LOD1 …): the level to show (default 0).'),
            'separate' => $schema->boolean()->description('Return each view as its own image instead of one contact sheet (default false).'),
        ];
    }

    protected function run(Request $request): Response|ResponseFactory
    {
        $runner = app(BlenderRunner::class);
        $open = BlenderRun::openArgument($runner, $request->get('job_id'), $request->get('path'));
        if ($open === null) {
            throw new ToolError('Pass job_id (a blender_run job) or path (.blend / .glb / .gltf).');
        }

        $views = max(1, min(8, (int) ($request->get('views') ?? 6)));
        $size = max(128, min(1024, (int) ($request->get('size') ?? 448)));
        $engine = (string) ($request->get('engine') ?? BlenderRun::engine());
        if (! in_array($engine, ['eevee', 'workbench', 'cycles'], true)) {
            throw new ToolError('engine must be eevee, workbench or cycles.');
        }
        $figure = $request->get('figure') === false ? 'False' : 'True';
        $elevation = (float) ($request->get('elevation') ?? 22);
        $separate = (bool) $request->get('separate', false);
        $lod = $request->get('lod') !== null ? max(0, min(5, (int) $request->get('lod'))) : null;

        $script = 'wb.preview(views='.$views.', size='.$size.', engine='.json_encode($engine).', figure='.$figure
            .', elevation='.$elevation.', sheet='.($separate ? 'False' : 'True')
            .($lod !== null ? ', lod='.$lod : '').")\n";
        $job = $runner->run($script, $open, false);

        return BlenderRun::respond($job, 'Change the model with blender_run continue_job, or export it with blender_export_prop.', $separate ? $views : 1);
    }
}
