<?php

namespace App\Jobs;

use App\Models\FoliageAsset;
use App\Services\Ai\FoliagePrompts;
use App\Services\Ai\MeshyClient;
use App\Services\Ai\MeshyException;
use App\Services\Ai\OpenRouterClient;
use App\Support\AiSettings;
use DateTimeInterface;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Sleep;
use Illuminate\Support\Str;
use RuntimeException;
use Throwable;

/**
 * Generates a textured 3D foliage model with Meshy and downloads the GLB; the browser then bakes it
 * (LODs, impostor) like any other model.
 *
 * Routes:
 * - "text":  text to 3D preview (mesh) → refine (PBR textures)
 * - "image": an OpenRouter concept image → Meshy image to 3D (textured in one task)
 *
 * The job re-queues itself while Meshy works (state in bake_options.meshy); on the sync queue it
 * polls inline instead.
 */
class GenerateMeshyAsset implements ShouldQueue
{
    use Queueable;

    public const ROUTES = ['text', 'image'];

    /** Meshy models per route (text to 3D does not accept meshy-7). */
    public const MODELS = [
        'text' => ['meshy-6', 'meshy-5'],
        'image' => ['latest', 'meshy-6', 'meshy-5'],
    ];

    public int $timeout = 600;

    /** Released attempts are polls, not failures. */
    public int $tries = 0;

    public int $maxExceptions = 1;

    private const POLL_SECONDS = 10;

    /**
     * @param  array{route?: string, prompt?: string, style?: int, model?: string|null}  $options
     */
    public function __construct(public FoliageAsset $asset, public array $options) {}

    public function retryUntil(): DateTimeInterface
    {
        return now()->addMinutes(45);
    }

    public function handle(MeshyClient $meshy, OpenRouterClient $openRouter, AiSettings $settings, FoliagePrompts $prompts): void
    {
        $inline = $this->job === null || $this->job->getConnectionName() === 'sync';

        for ($polls = 0; ; $polls++) {
            $wait = $this->step($meshy, $openRouter, $settings, $prompts);
            if ($wait === null) {
                return;
            }
            if (! $inline) {
                $this->release($wait);

                return;
            }
            if ($polls > 300) {
                throw new RuntimeException('Meshy took too long.');
            }
            Sleep::sleep($wait);
        }
    }

    /**
     * Advance one stage. Returns seconds to wait before the next poll, or null when done.
     */
    public function step(MeshyClient $meshy, OpenRouterClient $openRouter, AiSettings $settings, FoliagePrompts $prompts): ?int
    {
        $asset = $this->asset->refresh();
        $state = $asset->bake_options['meshy'] ?? [];
        $route = in_array($this->options['route'] ?? null, self::ROUTES, true) ? $this->options['route'] : 'text';
        $model = in_array($this->options['model'] ?? null, self::MODELS[$route], true) ? $this->options['model'] : self::MODELS[$route][0];
        $style = max(0, min(100, (int) ($this->options['style'] ?? 20)));
        $userPrompt = trim((string) ($this->options['prompt'] ?? ''));
        $kind = $asset->kind->value;

        if ($userPrompt === '') {
            throw new RuntimeException('The prompt is empty.');
        }

        $common = [
            'ai_model' => $model,
            'topology' => 'triangle',
            'target_polycount' => FoliagePrompts::MESHY_POLYCOUNT[$kind] ?? 20000,
            'should_remesh' => true,
            'symmetry_mode' => 'auto',
            'target_formats' => ['glb'],
            'auto_size' => true,
            'origin_at' => 'bottom',
        ];

        switch ($state['stage'] ?? 'start') {
            case 'start':
                if ($route === 'image') {
                    $this->save($asset, ['stage' => 'start'], 'Painting a concept image…');
                    $image = $openRouter->generateImage($settings->imageModel(), $prompts->conceptPrompt($userPrompt, $asset->kind, $style), [
                        'aspect_ratio' => '1:1', 'resolution' => '1K', 'output_format' => 'png', 'n' => 1,
                    ]);
                    $ext = $image['media_type'] === 'image/jpeg' ? 'jpg' : 'png';
                    Storage::disk('public')->put($asset->storageDirectory()."/source/concept.{$ext}", $image['bytes']);
                    $id = $meshy->create('image-to-3d', [
                        ...$common,
                        'image_url' => 'data:'.$image['media_type'].';base64,'.base64_encode($image['bytes']),
                        'should_texture' => true,
                        'enable_pbr' => true,
                        'texture_prompt' => mb_substr($userPrompt, 0, 600),
                    ]);
                    $asset->forceFill(['ai_prompt' => $prompts->conceptPrompt($userPrompt, $asset->kind, $style), 'ai_model' => "meshy {$model} (image to 3D)"]);
                    $this->save($asset, ['stage' => 'final', 'type' => 'image-to-3d', 'task_id' => $id], 'Meshy is building the model…');
                } else {
                    $prompt = $prompts->meshyPrompt($userPrompt, $asset->kind, $style);
                    $id = $meshy->create('text-to-3d', [...$common, 'mode' => 'preview', 'prompt' => $prompt]);
                    $asset->forceFill(['ai_prompt' => $prompt, 'ai_model' => "meshy {$model} (text to 3D)"]);
                    $this->save($asset, ['stage' => 'preview', 'type' => 'text-to-3d', 'task_id' => $id], 'Meshy is shaping the mesh…');
                }

                return self::POLL_SECONDS;

            case 'preview':
                $task = $meshy->task('text-to-3d', (string) $state['task_id']);
                if ($wait = $this->pending($asset, $task, $state, 'Meshy is shaping the mesh')) {
                    return $wait;
                }
                $id = $meshy->create('text-to-3d', [
                    'mode' => 'refine',
                    'preview_task_id' => $state['task_id'],
                    'ai_model' => $model,
                    'enable_pbr' => true,
                    'texture_prompt' => mb_substr($userPrompt, 0, 600),
                ]);
                $this->save($asset, ['stage' => 'final', 'type' => 'text-to-3d', 'task_id' => $id, 'preview_task_id' => $state['task_id'], 'credits' => $state['credits'] ?? 0], 'Meshy is painting the textures…');

                return self::POLL_SECONDS;

            case 'final':
                $task = $meshy->task((string) $state['type'], (string) $state['task_id']);
                if ($wait = $this->pending($asset, $task, $state, 'Meshy is finishing the model')) {
                    return $wait;
                }
                $glb = $task['model_urls']['glb'] ?? null;
                if (! is_string($glb)) {
                    throw new MeshyException('Meshy finished without a GLB model.');
                }

                $disk = Storage::disk('public');
                $path = $asset->storageDirectory().'/source/model.glb';
                $disk->makeDirectory(dirname($path));
                $meshy->download($glb, $disk->path($path));

                $asset->forceFill([
                    'source' => 'ai',
                    'source_type' => 'model',
                    'source_path' => $path,
                    'license' => $asset->license ?? 'Meshy (AI generated)',
                    'meta' => array_filter([
                        ...($asset->meta ?? []),
                        'source_polycount' => isset($task['face_count']) ? (int) $task['face_count'] : null,
                        'meshy_credits' => isset($state['credits']) ? (int) $state['credits'] : null,
                    ], fn ($v) => $v !== null),
                    'status' => 'awaiting_bake',
                    'status_message' => 'Model generated — waiting to be optimised in the studio.',
                ]);
                $this->save($asset, [...$state, 'stage' => 'done'], null, keepStatus: true);
                MeshyClient::forgetBalance();

                return null;
        }

        return null;
    }

    /**
     * Seconds to wait while a task is still running; null once it succeeded. Throws on failure.
     *
     * @param  array<string, mixed>  $task
     * @param  array<string, mixed>  $state
     */
    private function pending(FoliageAsset $asset, array $task, array &$state, string $label): ?int
    {
        $status = (string) ($task['status'] ?? '');

        if ($status === 'SUCCEEDED') {
            if (isset($task['consumed_credits'])) {
                $state['credits'] = (int) ($state['credits'] ?? 0) + (int) $task['consumed_credits'];
                $this->save($asset, $state, $asset->status_message);
            }

            return null;
        }

        if (in_array($status, ['FAILED', 'CANCELED', 'EXPIRED'], true)) {
            throw new MeshyException('Meshy task '.strtolower($status).': '.($task['task_error']['message'] ?? 'no reason given'));
        }

        $progress = is_numeric($task['progress'] ?? null) ? (int) $task['progress'] : null;
        $queued = is_numeric($task['preceding_tasks'] ?? null) && $status === 'PENDING' ? (int) $task['preceding_tasks'] : null;
        $this->save($asset, $state, $label.($queued ? " (queued behind {$queued})" : '').($progress !== null ? " — {$progress}%" : '').'…');

        return self::POLL_SECONDS;
    }

    /**
     * @param  array<string, mixed>  $state
     */
    private function save(FoliageAsset $asset, array $state, ?string $message, bool $keepStatus = false): void
    {
        $asset->forceFill([
            'bake_options' => [...($asset->bake_options ?? []), 'meshy' => $state],
            ...($keepStatus ? [] : ['status' => 'processing', 'status_message' => $message]),
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
