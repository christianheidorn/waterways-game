<?php

namespace App\Mcp\Blender;

use Illuminate\Support\Str;

/** The outcome of one headless Blender job: exit, output tails, the error, files and model stats. */
class BlenderJob
{
    /** Files of the job folder that are not results. */
    private const INTERNAL = ['job.py', 'script.py', 'result.json', 'scene.blend1'];

    /**
     * @param  array<string, mixed>|null  $result  result.json written by the helper library
     */
    public function __construct(
        public readonly string $id,
        public readonly string $directory,
        public readonly ?int $exitCode,
        public readonly bool $timedOut,
        public readonly string $output,
        public readonly string $errorOutput,
        public readonly ?array $result,
        public readonly float $seconds = 0.0,
    ) {}

    public function ok(): bool
    {
        return ! $this->timedOut && $this->exitCode === 0 && $this->result !== null;
    }

    /** @return array<string, mixed>|null */
    public function stats(): ?array
    {
        $stats = $this->result['stats'] ?? null;

        return is_array($stats) ? $stats : null;
    }

    public function blend(): ?string
    {
        $path = $this->directory.'/scene.blend';

        return is_file($path) ? $path : null;
    }

    public function path(string $relative): string
    {
        return $this->directory.'/'.ltrim($relative, '/');
    }

    /** @return list<string> absolute paths of the files the job produced (renders, exports, scene.blend) */
    public function files(): array
    {
        if (! is_dir($this->directory)) {
            return [];
        }

        $files = [];
        $iterator = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($this->directory, \FilesystemIterator::SKIP_DOTS));
        foreach ($iterator as $file) {
            /** @var \SplFileInfo $file */
            $relative = ltrim(Str::after($file->getPathname(), $this->directory), '/');
            if ($file->isFile() && ! in_array($relative, self::INTERNAL, true)) {
                $files[] = $file->getPathname();
            }
        }
        sort($files);

        return $files;
    }

    /** @return list<string> preview images of the job (sheet first) */
    public function previews(string $folder = 'preview'): array
    {
        $dir = $this->directory.'/'.$folder;
        $views = glob($dir.'/view_*.png') ?: [];
        natsort($views);
        $sheet = is_file($dir.'/sheet.png') ? [$dir.'/sheet.png'] : [];

        return [...$sheet, ...array_values($views)];
    }

    /** The Python error: the last traceback on stderr (or stdout), else the stderr tail. */
    public function error(): ?string
    {
        if ($this->ok()) {
            return null;
        }

        if ($this->timedOut) {
            return 'Blender did not finish within the time limit (WATERWAYS_BLENDER_TIMEOUT, or `timeout`). Simplify the script (fewer booleans / subdivisions, smaller renders) or raise the limit.';
        }

        foreach ([$this->errorOutput, $this->output] as $stream) {
            $at = strrpos($stream, 'Traceback (most recent call last)');
            if ($at !== false) {
                return Str::limit(trim(self::clean(substr($stream, $at))), 3000);
            }
        }

        $tail = self::tail($this->errorOutput, 20);

        return $tail !== '' ? $tail : 'Blender exited with code '.($this->exitCode ?? '?').' and wrote no result. Run blender_status to check the installation.';
    }

    /** The last lines of stdout without render progress and the helper's machine lines. */
    public function outputTail(int $lines = 40): string
    {
        return self::tail($this->output, $lines);
    }

    /** @return array<string, mixed> */
    public function toArray(): array
    {
        return [
            'job_id' => $this->id,
            'ok' => $this->ok(),
            'seconds' => round($this->seconds, 1),
            'stats' => $this->stats(),
            'files' => $this->files(),
            'output' => $this->outputTail() ?: null,
            'error' => $this->error(),
        ];
    }

    public static function tail(string $text, int $lines): string
    {
        $kept = array_filter(
            explode("\n", self::clean($text)),
            fn (string $line) => trim($line) !== ''
                && ! str_starts_with($line, 'Fra:')
                && ! str_starts_with($line, '@@WB_')
                && ! str_contains($line, 'EGL Error')
                && ! preg_match('/^(Saved: |Time: |Info: Saved as|Blender quit|Read blend:|Blender \d)/', $line),
        );

        return Str::limit(implode("\n", array_slice(array_values($kept), -$lines)), 4000);
    }

    private static function clean(string $text): string
    {
        return str_replace("\r", '', (string) preg_replace('/\e\[[0-9;]*m/', '', $text));
    }
}
