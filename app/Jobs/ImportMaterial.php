<?php

namespace App\Jobs;

use App\Models\Material;
use App\Services\Materials\Sources\AmbientCgSource;
use App\Services\Materials\Sources\PolyHavenSource;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Str;
use InvalidArgumentException;
use Throwable;

/**
 * Downloads a CC0 material from Poly Haven or ambientCG into the library.
 */
class ImportMaterial implements ShouldQueue
{
    use Queueable;

    public const SOURCES = ['polyhaven', 'ambientcg'];

    public int $timeout = 600;

    public int $tries = 1;

    /**
     * @param  'polyhaven'|'ambientcg'  $source
     * @param  '1k'|'2k'|'4k'  $resolution
     * @param  array{name?: string|null, category?: string|null}  $overrides
     */
    public function __construct(
        public Material $material,
        public string $source,
        public string $ref,
        public string $resolution = '1k',
        public array $overrides = [],
    ) {}

    public function handle(PolyHavenSource $polyHaven, AmbientCgSource $ambientCg): void
    {
        $limit = ini_get('memory_limit');
        $needed = strtolower($this->resolution) === '4k' ? 2 * 1024 ** 3 : 1024 ** 3;
        if ($limit !== false && $limit !== '-1' && ini_parse_quantity($limit) < $needed) {
            ini_set('memory_limit', $needed === 1024 ** 3 ? '1G' : '2G');
        }

        $this->material->forceFill(['status' => 'processing', 'status_message' => 'Downloading from '.$this->sourceLabel().'…'])->save();

        match ($this->source) {
            'polyhaven' => $polyHaven->import($this->material, $this->ref, $this->resolution, $this->overrides),
            'ambientcg' => $ambientCg->import($this->material, $this->ref, $this->resolution, $this->overrides),
            default => throw new InvalidArgumentException("Unknown material source [{$this->source}]."),
        };
    }

    public function failed(?Throwable $exception): void
    {
        $this->material->forceFill([
            'status' => 'failed',
            'status_message' => Str::limit('Import failed: '.($exception?->getMessage() ?? 'unknown error'), 250),
        ])->save();
    }

    private function sourceLabel(): string
    {
        return $this->source === 'ambientcg' ? 'ambientCG' : 'Poly Haven';
    }
}
