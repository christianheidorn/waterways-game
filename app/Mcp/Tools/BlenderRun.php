<?php

namespace App\Mcp\Tools;

use App\Mcp\Blender\BlenderJob;
use App\Mcp\Blender\BlenderRunner;
use App\Mcp\ToolError;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\ResponseFactory;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;

#[Name('blender_run')]
#[Description(<<<'TXT'
Runs a Python script in headless Blender on this computer (no UI) to model a 3D asset, with the Waterways helper library imported as `wb` (resources/blender/waterways_blender.py; guide: docs/BLENDER.md, examples: resources/blender/examples/). Blender is Z-up, metres, ground at z = 0, front facing -y.
Typical script: materials (wb.material / wb.textured_material: planks, wood, stone, bricks, thatch, metal, noise), parts (wb.box / cylinder / cone / sphere / beam / prism / gable_roof / mesh from bmesh), modifiers (wb.bevel / array / mirror / solidify / boolean / decimate / jitter), print(wb.stats()). Plain bpy works too.
Each run is a job (job_id) whose scene is saved: continue_job runs the next script on top of that scene (iterate in small steps); open_path starts from a .blend / .glb. The result has the job's stats (triangles, materials, dimensions, budget warnings), printed output, the Python traceback on errors and, with preview (default true), a turntable contact sheet with a 1.8 m figure for scale. Look at it, fix, run again; then blender_export_prop brings the model into the game.
TXT)]
class BlenderRun extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        return [
            'script' => $schema->string()->description('Python code. `wb` (helper library), `bpy`-importable; the scene starts empty (or as continue_job / open_path left it).')->required(),
            'continue_job' => $schema->string()->description('job_id of an earlier blender_run: start from its saved scene.'),
            'open_path' => $schema->string()->description('Absolute path of a .blend, .glb or .gltf to start from (~ is expanded).'),
            'preview' => $schema->boolean()->description('Render a turntable contact sheet afterwards (default true).'),
            'preview_views' => $schema->integer()->min(1)->max(8)->description('Views around the model in the preview (default 4).'),
            'timeout' => $schema->integer()->min(10)->max(3600)->description('Seconds before Blender is stopped (default WATERWAYS_BLENDER_TIMEOUT, 300).'),
        ];
    }

    protected function run(Request $request): Response|ResponseFactory
    {
        $script = (string) $request->get('script', '');
        if (trim($script) === '') {
            throw new ToolError('Pass the Python `script` to run.');
        }

        $runner = app(BlenderRunner::class);
        $open = self::openArgument($runner, $request->get('continue_job'), $request->get('open_path'));

        if ($request->get('preview') !== false) {
            $views = max(1, min(8, (int) ($request->get('preview_views') ?? 4)));
            $script = rtrim($script)."\n\n# Added by blender_run: preview of the result.\nif wb._meshes():\n    wb.preview(views={$views}, size=384, engine=".json_encode(self::engine()).")\n";
        }

        $job = $runner->run($script, $open, true, $request->get('timeout') !== null ? (int) $request->get('timeout') : null);

        return self::respond($job, $job->ok()
            ? 'Look at the preview. Iterate with blender_run continue_job "'.$job->id.'" (or a fresh script), check other angles with blender_preview, then bring it into the game with blender_export_prop job_id "'.$job->id.'".'
            : 'Fix the script (the traceback names the line in script.py) and run it again.');
    }

    /** The scene a job starts from: an earlier job's scene.blend or a file. */
    public static function openArgument(BlenderRunner $runner, mixed $job, mixed $path): ?string
    {
        if (is_string($job) && trim($job) !== '') {
            return $runner->jobScene($job);
        }

        if (is_string($path) && trim($path) !== '') {
            $path = trim($path);
            if (str_starts_with($path, '~/')) {
                $path = rtrim((string) (getenv('HOME') ?: ''), '/').substr($path, 1);
            }
            if (! is_file($path)) {
                throw new ToolError("No file at {$path}.");
            }
            if (! preg_match('/\.(blend|glb|gltf)$/i', $path)) {
                throw new ToolError('open_path must be a .blend, .glb or .gltf file.');
            }

            return $path;
        }

        return null;
    }

    public static function engine(): string
    {
        $engine = (string) config('services.blender.preview_engine', 'eevee');

        return in_array($engine, ['eevee', 'workbench', 'cycles'], true) ? $engine : 'eevee';
    }

    /** The job as a tool result: preview images first, then the JSON; failures as errors. */
    public static function respond(BlenderJob $job, string $next, int $images = 1): Response|ResponseFactory
    {
        $data = $job->toArray();
        $json = json_encode([...$data, 'next' => $next], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

        if (! $job->ok()) {
            return Response::error('Blender job '.$job->id." failed.\n".$json);
        }

        $responses = [];
        foreach (array_slice($job->previews(), 0, $images) as $image) {
            $responses[] = Response::image((string) file_get_contents($image), 'image/png');
        }
        $responses[] = Response::text((string) $json);

        return Response::make($responses);
    }
}
