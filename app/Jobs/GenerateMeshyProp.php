<?php

namespace App\Jobs;

use App\Mcp\Assets\AgentImages;
use App\Mcp\Assets\GltfInspector;
use App\Mcp\EditorBridge;
use App\Models\PropModel;
use App\Services\Ai\MeshyClient;
use App\Services\Ai\MeshyException;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Sleep;
use Illuminate\Support\Str;
use RuntimeException;
use Throwable;

/**
 * Generates a prop model with Meshy (like GenerateMeshyAsset does for foliage) and stores the GLB as
 * props/{id}/model.glb, measured and ready to place.
 *
 * Routes:
 * - "text":  text to 3D preview (mesh) → refine (PBR textures)
 * - "image": image to 3D from a stored image (e.g. a reference drawn with generate_image)
 *
 * Between polls the job queues a fresh copy of itself carrying the task state; on the sync queue it
 * polls inline instead.
 */
class GenerateMeshyProp implements ShouldQueue
{
    use Queueable;

    public const MODELS = [
        'text' => ['meshy-6', 'meshy-5'],
        'image' => ['latest', 'meshy-6', 'meshy-5'],
    ];

    public int $timeout = 600;

    public int $tries = 1;

    private const POLL_SECONDS = 10;

    private const POLYCOUNT = 30000;

    /**
     * @param  array{route?: string, prompt?: string, style?: int, image_path?: string|null, model?: string|null}  $options
     * @param  array<string, mixed>  $state  Meshy task state between polls
     */
    public function __construct(public PropModel $prop, public array $options, public array $state = []) {}

    public function handle(MeshyClient $meshy, AgentImages $images): void
    {
        $inline = $this->job === null || $this->job->getConnectionName() === 'sync';
        $this->state['started_at'] ??= time();

        for ($polls = 0; ; $polls++) {
            $wait = $this->step($meshy, $images);
            if ($wait === null) {
                return;
            }
            if (time() - (int) $this->state['started_at'] > 45 * 60) {
                throw new MeshyException('Meshy took too long.');
            }
            if (! $inline) {
                dispatch(new self($this->prop, $this->options, $this->state))->delay($wait);

                return;
            }
            Sleep::sleep($wait);
        }
    }

    /**
     * Advances one stage. Returns seconds to wait before the next poll, or null when done.
     */
    public function step(MeshyClient $meshy, AgentImages $images): ?int
    {
        $prop = $this->prop->refresh();
        $route = ($this->options['route'] ?? 'text') === 'image' ? 'image' : 'text';
        $model = in_array($this->options['model'] ?? null, self::MODELS[$route], true) ? $this->options['model'] : self::MODELS[$route][0];
        $userPrompt = trim((string) ($this->options['prompt'] ?? ''));

        $common = [
            'ai_model' => $model,
            'topology' => 'triangle',
            'target_polycount' => self::POLYCOUNT,
            'should_remesh' => true,
            'symmetry_mode' => 'auto',
            'target_formats' => ['glb'],
            'auto_size' => true,
            'origin_at' => 'bottom',
        ];

        switch ($this->state['stage'] ?? 'start') {
            case 'start':
                if ($route === 'image') {
                    $image = $images->read((string) ($this->options['image_path'] ?? ''));
                    $id = $meshy->create('image-to-3d', [
                        ...$common,
                        'image_url' => 'data:'.$image['media_type'].';base64,'.base64_encode($image['bytes']),
                        'should_texture' => true,
                        'enable_pbr' => true,
                        ...($userPrompt !== '' ? ['texture_prompt' => mb_substr($userPrompt, 0, 600)] : []),
                    ]);
                    $this->state = [...$this->state, 'stage' => 'final', 'type' => 'image-to-3d', 'task_id' => $id];
                    $this->message($prop, 'Meshy is building the model…');
                } else {
                    if ($userPrompt === '') {
                        throw new RuntimeException('The prompt is empty.');
                    }
                    $id = $meshy->create('text-to-3d', [...$common, 'mode' => 'preview', 'prompt' => self::meshyPrompt($userPrompt, (int) ($this->options['style'] ?? 20))]);
                    $this->state = [...$this->state, 'stage' => 'preview', 'type' => 'text-to-3d', 'task_id' => $id];
                    $this->message($prop, 'Meshy is shaping the mesh…');
                }

                return self::POLL_SECONDS;

            case 'preview':
                $task = $meshy->task('text-to-3d', (string) $this->state['task_id']);
                if ($wait = $this->pending($prop, $task, 'Meshy is shaping the mesh')) {
                    return $wait;
                }
                $id = $meshy->create('text-to-3d', [
                    'mode' => 'refine',
                    'preview_task_id' => $this->state['task_id'],
                    'ai_model' => $model,
                    'enable_pbr' => true,
                    'texture_prompt' => mb_substr($userPrompt, 0, 600),
                ]);
                $this->state = [...$this->state, 'stage' => 'final', 'task_id' => $id];
                $this->message($prop, 'Meshy is painting the textures…');

                return self::POLL_SECONDS;

            case 'final':
                $task = $meshy->task((string) $this->state['type'], (string) $this->state['task_id']);
                if ($wait = $this->pending($prop, $task, 'Meshy is finishing the model')) {
                    return $wait;
                }
                $glb = $task['model_urls']['glb'] ?? null;
                if (! is_string($glb)) {
                    throw new MeshyException('Meshy finished without a GLB model.');
                }

                $disk = Storage::disk('public');
                $path = "props/{$prop->id}/model.glb";
                $disk->makeDirectory(dirname($path));
                $meshy->download($glb, $disk->path($path));
                $document = GltfInspector::document((string) $disk->get($path));
                if ($document === null) {
                    throw new MeshyException('Meshy returned a file that is not a GLB model.');
                }

                $prop->forceFill([
                    'model_path' => $path,
                    'dimensions' => GltfInspector::dimensions($document),
                    'status' => 'ready',
                    'status_message' => null,
                ])->save();
                MeshyClient::forgetBalance();
                // Open editors show the new model in their Place → Props palette.
                app(EditorBridge::class)->notifyAll('refresh', ['parts' => ['prop_models']]);

                return null;
        }

        return null;
    }

    /** The prompt sent to Meshy text to 3D (at most 600 characters). */
    public static function meshyPrompt(string $userPrompt, int $style): string
    {
        $look = match (true) {
            $style <= 30 => 'realistic',
            $style <= 70 => 'semi-realistic, slightly stylized',
            default => 'stylized, clean shapes',
        };

        return mb_substr("{$userPrompt}. A single game-ready 3D prop, {$look}, real-world proportions, standing upright on flat ground, no base plate, no ground, no background.", 0, 600);
    }

    /**
     * Seconds to wait while a task is still running; null once it succeeded. Throws on failure.
     *
     * @param  array<string, mixed>  $task
     */
    private function pending(PropModel $prop, array $task, string $label): ?int
    {
        $status = (string) ($task['status'] ?? '');

        if ($status === 'SUCCEEDED') {
            return null;
        }
        if (in_array($status, ['FAILED', 'CANCELED', 'EXPIRED'], true)) {
            throw new MeshyException('Meshy task '.strtolower($status).': '.($task['task_error']['message'] ?? 'no reason given'));
        }

        $progress = is_numeric($task['progress'] ?? null) ? (int) $task['progress'] : null;
        $this->message($prop, $label.($progress !== null ? " — {$progress}%" : '').'…');

        return self::POLL_SECONDS;
    }

    private function message(PropModel $prop, string $message): void
    {
        $prop->forceFill(['status' => 'processing', 'status_message' => $message])->save();
    }

    public function failed(?Throwable $exception): void
    {
        $this->prop->forceFill([
            'status' => 'failed',
            'status_message' => Str::limit('Generation failed: '.($exception?->getMessage() ?? 'unknown error'), 250),
        ])->save();
    }
}
