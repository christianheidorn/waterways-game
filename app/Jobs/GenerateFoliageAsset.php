<?php

namespace App\Jobs;

use App\Models\FoliageAsset;
use App\Services\Ai\FoliagePrompts;
use App\Services\Ai\OpenRouterClient;
use App\Support\AiSettings;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use RuntimeException;
use Throwable;

/**
 * Generates a foliage "card" image with an OpenRouter image model. Models that support a transparent
 * background get one; for the others the browser keys out the plain white background while baking.
 *
 * Options: prompt (required), style (0 photoreal … 100 stylized), model.
 */
class GenerateFoliageAsset implements ShouldQueue
{
    use Queueable;

    public int $timeout = 600;

    public int $tries = 1;

    /**
     * @param  array<string, mixed>  $options
     */
    public function __construct(public FoliageAsset $asset, public array $options) {}

    public function handle(OpenRouterClient $client, AiSettings $settings, FoliagePrompts $prompts): void
    {
        $asset = $this->asset;
        $userPrompt = trim((string) ($this->options['prompt'] ?? ''));
        if ($userPrompt === '') {
            throw new RuntimeException('The prompt is empty.');
        }

        $model = (string) ($this->options['model'] ?? '') ?: $settings->imageModel();
        $style = max(0, min(100, (int) ($this->options['style'] ?? ($asset->style === 'stylized' ? 80 : 10))));
        $transparent = $client->imageModelSupports($model, 'background', 'transparent');
        $finalPrompt = $prompts->cardPrompt($userPrompt, $asset->kind, $style, $transparent);

        $asset->forceFill([
            'status' => 'processing',
            'status_message' => 'Waiting for '.$model.'…',
            'ai_prompt' => $finalPrompt,
            'ai_model' => $model,
        ])->save();

        $image = $client->generateImage($model, $finalPrompt, [
            'aspect_ratio' => FoliagePrompts::ASPECT[$asset->kind->value] ?? '1:1',
            'resolution' => '1K',
            'quality' => 'high',
            'output_format' => 'png',
            'background' => $transparent ? 'transparent' : null,
            'n' => 1,
        ]);

        $extension = match ($image['media_type']) {
            'image/jpeg', 'image/jpg' => 'jpg',
            'image/webp' => 'webp',
            default => 'png',
        };

        $disk = Storage::disk('public');
        $dir = $asset->storageDirectory().'/source';
        $disk->deleteDirectory($dir);
        $path = "{$dir}/card.{$extension}";
        $disk->put($path, $image['bytes']);

        $asset->forceFill([
            'source' => 'ai',
            'license' => $asset->license ?? 'AI generated',
            'source_type' => 'card',
            'source_path' => $path,
            // Always let the baker key the background if the image turns out to have no alpha.
            'bake_options' => ['key_background' => ! $transparent || $extension === 'jpg'],
            'status' => 'awaiting_bake',
            'status_message' => 'Image generated — waiting to be baked in the studio.',
        ])->save();
    }

    public function failed(?Throwable $exception): void
    {
        $this->asset->forceFill([
            'status' => 'failed',
            'status_message' => Str::limit('Generation failed: '.($exception?->getMessage() ?? 'unknown error'), 250),
        ])->save();
    }
}
