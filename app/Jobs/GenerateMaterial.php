<?php

namespace App\Jobs;

use App\Models\Material;
use App\Services\Ai\MaterialPrompts;
use App\Services\Ai\OpenRouterClient;
use App\Services\Materials\MaterialBuilder;
use App\Services\Materials\MaterialStorage;
use App\Support\AiSettings;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Str;
use RuntimeException;
use Throwable;

/**
 * Generates a material's albedo with an OpenRouter image model, then makes it delit and tileable
 * and derives the remaining PBR maps.
 *
 * Options: prompt (required), category, model, resolution ('1K'|'2K'), enhance (bool),
 * seed (int, sent only if the model supports it). A material with a parent_id is an AI edit of
 * that parent: the parent's albedo is sent as the input reference.
 */
class GenerateMaterial implements ShouldQueue
{
    use Queueable;

    public int $timeout = 600;

    public int $tries = 1;

    /**
     * @param  array<string, mixed>  $options
     */
    public function __construct(public Material $material, public array $options) {}

    public function handle(
        OpenRouterClient $client,
        AiSettings $settings,
        MaterialPrompts $prompts,
        MaterialBuilder $builder,
        MaterialStorage $storage,
    ): void {
        $this->raiseMemoryLimit();

        $material = $this->material;
        $material->forceFill(['status' => 'processing', 'status_message' => 'Generating texture…'])->save();

        $model = (string) ($this->options['model'] ?? '') ?: $settings->imageModel();
        $resolution = in_array($this->options['resolution'] ?? null, AiSettings::RESOLUTIONS, true)
            ? $this->options['resolution']
            : $settings->imageResolution();
        $category = (string) ($this->options['category'] ?? $material->category);
        $userPrompt = trim((string) ($this->options['prompt'] ?? ''));

        if ($userPrompt === '') {
            throw new RuntimeException('The prompt is empty.');
        }

        if (! empty($this->options['enhance'])) {
            $material->forceFill(['status_message' => 'Enhancing prompt…'])->save();
            $userPrompt = $prompts->enhance($userPrompt, $category);
        }

        $references = [];
        $parent = $material->parent_id ? Material::query()->find($material->parent_id) : null;
        if ($parent !== null) {
            $reference = $storage->dataUrl($parent, 'albedo');
            if ($reference === null) {
                throw new RuntimeException('The source material has no albedo map to edit.');
            }
            $references[] = $reference;
        }

        $finalPrompt = $prompts->texturePrompt($userPrompt, $category, edit: $parent !== null);
        $material->forceFill(['ai_prompt' => $finalPrompt, 'ai_model' => $model, 'status_message' => 'Waiting for '.$model.'…'])->save();

        $image = $client->generateImage($model, $finalPrompt, array_filter([
            'resolution' => $resolution,
            'aspect_ratio' => '1:1',
            'output_format' => 'png',
            'n' => 1,
            'seed' => isset($this->options['seed']) ? (int) $this->options['seed'] : null,
        ], fn ($v) => $v !== null), $references);

        $material->forceFill(['status_message' => 'Processing maps…'])->save();

        $builder->build($material, ['albedo' => $image['bytes']], MaterialBuilder::sizeFor($resolution), [
            'delight' => true,
            'seamless' => true,
        ], [
            'source' => 'ai',
            'license' => $material->license ?? 'AI generated',
            'ai_prompt' => $finalPrompt,
            'ai_model' => $model,
        ]);
    }

    public function failed(?Throwable $exception): void
    {
        $this->material->forceFill([
            'status' => 'failed',
            'status_message' => Str::limit('Generation failed: '.($exception?->getMessage() ?? 'unknown error'), 250),
        ])->save();
    }

    private function raiseMemoryLimit(): void
    {
        $limit = ini_get('memory_limit');
        if ($limit !== false && $limit !== '-1' && ini_parse_quantity($limit) < 1024 ** 3) {
            ini_set('memory_limit', '1G');
        }
    }
}
