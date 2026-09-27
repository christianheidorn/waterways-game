<?php

namespace App\Services\Foliage;

use App\Enums\FoliageKind;
use App\Jobs\GenerateFoliageAsset;
use App\Jobs\ImportFoliageAsset;
use App\Models\FoliageAsset;
use Illuminate\Support\Str;
use Throwable;

/**
 * Creating library assets and queueing their import / generation.
 */
class FoliageAssetQueue
{
    public function __construct(
        private readonly FoliageLibrary $library,
        private readonly PolyHavenModels $polyHaven,
    ) {}

    /**
     * Create (or reuse) a Poly Haven asset and queue its download.
     */
    public function importPolyHaven(string $ref, ?string $kind = null, ?float $targetHeight = null): FoliageAsset
    {
        $existing = FoliageAsset::query()->where('source', 'polyhaven')->where('source_ref', $ref)->first();
        if ($existing && $existing->status !== 'failed') {
            return $existing;
        }

        $summary = null;
        try {
            $catalogue = $this->polyHaven->catalogue();
            $summary = isset($catalogue[$ref]) ? $this->polyHaven->summary($ref, $catalogue[$ref]) : null;
        } catch (Throwable $e) {
            report($e);
        }

        $asset = $existing ?? $this->library->create([
            'name' => $summary['name'] ?? Str::headline($ref),
            'kind' => FoliageLibrary::validKind($kind, FoliageKind::tryFrom((string) ($summary['kind'] ?? '')) ?? FoliageLibrary::guessKind([$ref])),
            'style' => 'realistic',
            'source' => 'polyhaven',
            'source_ref' => $ref,
            'source_url' => "https://polyhaven.com/a/{$ref}",
            'license' => 'CC0',
            'target_height' => $targetHeight,
        ]);
        $asset->forceFill(['status' => 'queued', 'status_message' => 'Queued for download…'])->save();

        $this->dispatch(new ImportFoliageAsset($asset, $ref));

        return $asset->refresh();
    }

    public function generate(string $name, FoliageKind $kind, int $style, float $targetHeight, string $prompt, ?string $model = null): FoliageAsset
    {
        $asset = $this->library->create([
            'name' => $name,
            'kind' => $kind,
            'style' => $style >= 50 ? 'stylized' : 'realistic',
            'source' => 'ai',
            'source_type' => 'card',
            'license' => 'AI generated',
            'target_height' => $targetHeight,
            'status' => 'queued',
            'status_message' => 'Queued for generation…',
            'ai_prompt' => $prompt,
        ]);

        $this->dispatch(new GenerateFoliageAsset($asset, ['prompt' => $prompt, 'style' => $style, 'model' => $model]));

        return $asset->refresh();
    }

    public function dispatch(object $job): void
    {
        try {
            dispatch($job);
        } catch (Throwable $e) {
            // Only reachable with the sync queue: the job already marked the asset as failed.
            report($e);
        }
    }
}
