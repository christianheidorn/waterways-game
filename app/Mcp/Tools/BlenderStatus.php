<?php

namespace App\Mcp\Tools;

use App\Mcp\Blender\BlenderLocator;
use App\Mcp\Blender\BlenderRunner;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\IsReadOnly;
use Laravel\Mcp\Server\Attributes\Name;

#[Name('blender_status')]
#[IsReadOnly]
#[Description('Checks the headless Blender used by blender_run / blender_preview / blender_export_prop: whether it is found, its version and path (WATERWAYS_BLENDER_PATH, the macOS app, PATH), the time limit, the helper library and example scripts, and how to install Blender when it is missing.')]
class BlenderStatus extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        return [];
    }

    protected function run(Request $request): Response
    {
        $locator = app(BlenderLocator::class);
        $status = $locator->status();
        $examples = glob(BlenderRunner::libraryPath().'/examples/*.py') ?: [];

        return $this->json([
            ...$status,
            'timeout_seconds' => (int) config('services.blender.timeout', 300),
            'preview_engine' => BlenderRun::engine(),
            'helper_library' => BlenderRunner::libraryPath().'/waterways_blender.py',
            'examples' => $examples,
            'guide' => base_path('docs/BLENDER.md'),
            'jobs' => BlenderRunner::jobsRoot(),
            ...($status['found'] ? [] : ['install' => $locator->installHelp()]),
            'next' => $status['found']
                ? 'Model with blender_run (read the guide and an example first), look with blender_preview, import with blender_export_prop.'
                : 'Blender is needed for the blender_* tools; the other asset tools (import_model, generate_model) work without it.',
        ]);
    }
}
