<?php

namespace App\Services\Foliage;

use App\Enums\FoliageKind;
use App\Jobs\GenerateFoliageAsset;
use App\Jobs\GenerateMeshyAsset;
use App\Models\FoliageAsset;
use Throwable;

/**
 * Creating library assets and queueing their generation (Meshy 3D models, OpenRouter cards).
 */
class FoliageAssetQueue
{
    public function __construct(
        private readonly FoliageLibrary $library,
    ) {}

    /**
     * A textured 3D model from Meshy (text or concept-image route).
     */
    public function meshy(string $name, FoliageKind $kind, int $style, ?float $targetHeight, string $prompt, string $route = 'text', ?string $model = null): FoliageAsset
    {
        $asset = $this->library->create([
            'name' => $name,
            'kind' => $kind,
            'style' => $style >= 50 ? 'stylized' : 'realistic',
            'source' => 'ai',
            'source_type' => 'model',
            'license' => 'Meshy (AI generated)',
            'target_height' => $targetHeight,
            'status' => 'queued',
            'status_message' => 'Queued for Meshy…',
            'ai_prompt' => $prompt,
            'bake_options' => ['generator' => 'meshy', 'route' => $route, 'prompt' => $prompt, 'style' => $style, 'meshy_model' => $model],
        ]);

        $this->dispatch(new GenerateMeshyAsset($asset, ['route' => $route, 'prompt' => $prompt, 'style' => $style, 'model' => $model]));

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
