<?php

namespace App\Mcp\Blender;

use App\Mcp\ToolError;
use Illuminate\Process\Exceptions\ProcessTimedOutException;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Process;
use Illuminate\Support\Str;

/**
 * Runs Python scripts in headless Blender, one folder per job (storage/app/blender/jobs/{uuid}):
 * the agent's script is written to script.py, job.py puts the helper library
 * (resources/blender/waterways_blender.py, imported as `wb`) on sys.path and runs it, and Blender is
 * started as `blender --background --factory-startup --python-exit-code 1 --python job.py -- --job-dir …`.
 * Afterwards the scene is saved as scene.blend (so a later job can continue from it) and result.json
 * holds the model stats.
 */
class BlenderRunner
{
    public const KEEP_DAYS = 7;

    public const KEEP_JOBS = 60;

    public function __construct(private BlenderLocator $locator) {}

    public static function jobsRoot(): string
    {
        return storage_path('app/blender/jobs');
    }

    public static function libraryPath(): string
    {
        return resource_path('blender');
    }

    /** Blender, or a ToolError that says how to install it. */
    public function blender(): string
    {
        return $this->locator->find() ?? throw new ToolError($this->locator->installHelp());
    }

    /**
     * @param  string|null  $open  a .blend to continue from, or a .glb / .gltf to import first
     * @param  bool  $save  save scene.blend after the script (for later jobs)
     */
    public function run(string $script, ?string $open = null, bool $save = true, ?int $timeout = null): BlenderJob
    {
        $blender = $this->blender();
        $this->prune();

        $id = (string) Str::uuid();
        $dir = self::jobsRoot().'/'.$id;
        File::ensureDirectoryExists($dir);
        File::put($dir.'/script.py', $script);
        File::put($dir.'/job.py', $this->bootstrap($dir, $open, $save));

        $timeout ??= (int) config('services.blender.timeout', 300);
        $command = [
            $blender, '--background', '--factory-startup', '--python-exit-code', '1',
            '--python', $dir.'/job.py', '--', '--job-dir', $dir,
        ];

        $started = microtime(true);
        $timedOut = false;
        $exitCode = null;
        $output = '';
        $errorOutput = '';

        try {
            $result = Process::path($dir)->timeout(max(10, $timeout))->env(['PYTHONDONTWRITEBYTECODE' => '1'])->run($command);
            $exitCode = $result->exitCode();
            $output = $result->output();
            $errorOutput = $result->errorOutput();
        } catch (ProcessTimedOutException $e) {
            $timedOut = true;
            $output = (string) $e->result->output();
            $errorOutput = (string) $e->result->errorOutput();
        }

        $resultFile = $dir.'/result.json';
        $data = is_file($resultFile) ? json_decode((string) file_get_contents($resultFile), true) : null;

        return new BlenderJob($id, $dir, $exitCode, $timedOut, $output, $errorOutput, is_array($data) ? $data : null, microtime(true) - $started);
    }

    /** Folder of an earlier job, or a ToolError. */
    public function jobDirectory(string $id): string
    {
        $id = trim($id);
        if (! Str::isUuid($id) || ! is_dir(self::jobsRoot().'/'.$id)) {
            throw new ToolError("No Blender job \"{$id}\" (jobs are kept ".self::KEEP_DAYS.' days). Run blender_run again.');
        }

        return self::jobsRoot().'/'.$id;
    }

    /** scene.blend of an earlier job, or a ToolError. */
    public function jobScene(string $id): string
    {
        $path = $this->jobDirectory($id).'/scene.blend';
        if (! is_file($path)) {
            throw new ToolError("Blender job \"{$id}\" saved no scene (it failed): fix the script and run blender_run again.");
        }

        return $path;
    }

    /** Deletes jobs older than KEEP_DAYS and all but the newest KEEP_JOBS. */
    public function prune(): void
    {
        $root = self::jobsRoot();
        if (! is_dir($root)) {
            return;
        }

        $dirs = glob($root.'/*', GLOB_ONLYDIR) ?: [];
        usort($dirs, fn (string $a, string $b) => filemtime($b) <=> filemtime($a));
        $cutoff = time() - self::KEEP_DAYS * 86400;

        foreach ($dirs as $index => $dir) {
            if ($index >= self::KEEP_JOBS || filemtime($dir) < $cutoff) {
                File::deleteDirectory($dir);
            }
        }
    }

    private function bootstrap(string $dir, ?string $open, bool $save): string
    {
        $literal = fn (?string $value) => $value === null ? 'None' : json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

        return implode("\n", [
            '# Written by Waterways (App\\Mcp\\Blender\\BlenderRunner): runs script.py with the helper library.',
            'import sys',
            'sys.path.insert(0, '.$literal(self::libraryPath()).')',
            'import waterways_blender as wb',
            'wb._run_job('.$literal($dir).', '.$literal($open).', "script.py", '.($save ? 'True' : 'False').')',
            '',
        ]);
    }
}
