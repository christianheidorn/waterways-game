<?php

namespace App\Jobs;

use App\Models\Character;
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
 * Generates a playable, rigged and animated character with Meshy:
 *
 *   model (text to 3D preview → refine, or OpenRouter concept image → image to 3D, A-pose)
 *   → rigging (includes walking + running clips) → extra clips from Meshy's animation library
 *     (idle, jump, swim) → download everything to characters/{id}/.
 *
 * The job re-queues itself while Meshy works (state in meta.pipeline); on the sync queue it polls
 * inline. A failing extra animation is skipped (the game falls back to the closest clip).
 */
class GenerateCharacter implements ShouldQueue
{
    use Queueable;

    public const ROUTES = ['text', 'image'];

    public const MODELS = GenerateMeshyAsset::MODELS;

    /** Meshy animation library action ids (https://api.meshy.ai/web/public/animations/resources). */
    public const EXTRA_CLIPS = ['idle' => 0, 'jump' => 466, 'swim' => 569];

    public int $timeout = 600;

    public int $tries = 0;

    public int $maxExceptions = 1;

    private const POLL_SECONDS = 10;

    /**
     * @param  array{route?: string, model?: string|null, extra_clips?: bool}  $options
     */
    public function __construct(public Character $character, public array $options = []) {}

    public function retryUntil(): DateTimeInterface
    {
        return now()->addMinutes(60);
    }

    public function handle(MeshyClient $meshy, OpenRouterClient $openRouter, AiSettings $settings): void
    {
        $inline = $this->job === null || $this->job->getConnectionName() === 'sync';

        for ($polls = 0; ; $polls++) {
            $wait = $this->step($meshy, $openRouter, $settings);
            if ($wait === null) {
                return;
            }
            if (! $inline) {
                $this->release($wait);

                return;
            }
            if ($polls > 400) {
                throw new RuntimeException('Meshy took too long.');
            }
            Sleep::sleep($wait);
        }
    }

    public static function characterPrompt(string $prompt, int $style): string
    {
        $look = match (true) {
            $style <= 35 => 'realistic proportions and materials',
            $style <= 65 => 'semi-stylized game character',
            default => 'stylized game character, clean readable shapes',
        };

        return mb_substr("A full-body game character: {$prompt}. {$look}. Standing in an A-pose, arms away from the body, "
            .'both feet on the ground, whole body visible, humanoid biped, no weapon in hands, no base, no background props.', 0, 600);
    }

    public static function conceptPrompt(string $prompt, int $style): string
    {
        return "Full-body character concept, front view: {$prompt}. ".FoliagePrompts::styleWords($style)
            .'. Standing in a relaxed A-pose with arms slightly away from the body, feet shoulder-width apart, whole figure visible '
            .'from head to feet and centred, neutral soft studio lighting, plain light grey background, no props, no text.';
    }

    public function step(MeshyClient $meshy, OpenRouterClient $openRouter, AiSettings $settings): ?int
    {
        $character = $this->character->refresh();
        $state = $character->meta['pipeline'] ?? [];
        $route = in_array($this->options['route'] ?? null, self::ROUTES, true) ? $this->options['route'] : 'text';
        $model = in_array($this->options['model'] ?? null, self::MODELS[$route], true) ? $this->options['model'] : self::MODELS[$route][0];
        $prompt = trim((string) $character->prompt);
        $style = (int) $character->style;

        if ($prompt === '') {
            throw new RuntimeException('The prompt is empty.');
        }

        $common = [
            'ai_model' => $model,
            'topology' => 'triangle',
            'target_polycount' => 30000,
            'should_remesh' => true,
            'symmetry_mode' => 'on',
            'pose_mode' => 'a-pose',
            'target_formats' => ['glb'],
        ];

        switch ($state['stage'] ?? 'start') {
            case 'start':
                if ($route === 'image') {
                    $this->save($character, ['stage' => 'start'], 'Painting a concept image…');
                    $image = $openRouter->generateImage($settings->imageModel(), self::conceptPrompt($prompt, $style), [
                        'aspect_ratio' => '3:4', 'resolution' => '1K', 'output_format' => 'png', 'n' => 1,
                    ]);
                    Storage::disk('public')->put($character->storageDirectory().'/concept.png', $image['bytes']);
                    $id = $meshy->create('image-to-3d', [
                        ...$common,
                        'image_url' => 'data:'.$image['media_type'].';base64,'.base64_encode($image['bytes']),
                        'should_texture' => true,
                        'enable_pbr' => true,
                    ]);
                    $character->forceFill(['ai_model' => "meshy {$model} (image to 3D)"]);
                    $this->save($character, ['stage' => 'model', 'type' => 'image-to-3d', 'task_id' => $id], 'Meshy is building the character…');
                } else {
                    $id = $meshy->create('text-to-3d', [...$common, 'mode' => 'preview', 'prompt' => self::characterPrompt($prompt, $style)]);
                    $character->forceFill(['ai_model' => "meshy {$model} (text to 3D)"]);
                    $this->save($character, ['stage' => 'preview', 'task_id' => $id], 'Meshy is shaping the character…');
                }

                return self::POLL_SECONDS;

            case 'preview':
                $task = $meshy->task('text-to-3d', (string) $state['task_id']);
                if ($wait = $this->pending($character, $task, $state, 'Meshy is shaping the character')) {
                    return $wait;
                }
                $id = $meshy->create('text-to-3d', [
                    'mode' => 'refine', 'preview_task_id' => $state['task_id'], 'ai_model' => $model,
                    'enable_pbr' => true, 'texture_prompt' => mb_substr($prompt, 0, 600),
                ]);
                $this->save($character, [...$state, 'stage' => 'model', 'type' => 'text-to-3d', 'task_id' => $id], 'Meshy is painting the textures…');

                return self::POLL_SECONDS;

            case 'model':
                $task = $meshy->task((string) $state['type'], (string) $state['task_id']);
                if ($wait = $this->pending($character, $task, $state, 'Meshy is finishing the model')) {
                    return $wait;
                }
                if (is_string($task['thumbnail_url'] ?? null)) {
                    $this->download($meshy, $character, $task['thumbnail_url'], 'thumbnail.png');
                    $character->forceFill(['thumbnail_path' => $character->storageDirectory().'/thumbnail.png']);
                }
                $id = $meshy->create('rigging', ['input_task_id' => $state['task_id'], 'height_meters' => round($character->height, 2)]);
                $this->save($character, [...$state, 'stage' => 'rig', 'model_task_id' => $state['task_id'], 'task_id' => $id, 'type' => 'rigging'], 'Rigging the skeleton…');

                return self::POLL_SECONDS;

            case 'rig':
                $task = $meshy->task('rigging', (string) $state['task_id']);
                if ($wait = $this->pending($character, $task, $state, 'Rigging the skeleton')) {
                    return $wait;
                }
                $result = $task['result'] ?? [];
                $rigged = $result['rigged_character_glb_url'] ?? null;
                if (! is_string($rigged)) {
                    throw new MeshyException('Meshy rigging finished without a rigged model.');
                }
                $this->download($meshy, $character, $rigged, 'model.glb');
                $animations = [];
                foreach (['walk' => 'walking_glb_url', 'run' => 'running_glb_url'] as $clip => $key) {
                    $url = $result['basic_animations'][$key] ?? null;
                    if (is_string($url)) {
                        $this->download($meshy, $character, $url, "{$clip}.glb");
                        $animations[$clip] = $character->storageDirectory()."/{$clip}.glb";
                    }
                }
                $character->forceFill([
                    'model_path' => $character->storageDirectory().'/model.glb',
                    'animations' => $animations,
                ]);

                $extra = [];
                if ($this->options['extra_clips'] ?? true) {
                    foreach (self::EXTRA_CLIPS as $clip => $action) {
                        try {
                            $extra[$clip] = $meshy->create('animations', ['rig_task_id' => $state['task_id'], 'action_id' => $action]);
                        } catch (MeshyException $e) {
                            report($e);
                        }
                    }
                }

                if ($extra === []) {
                    return $this->finish($character, $state);
                }

                $this->save($character, [...$state, 'stage' => 'animate', 'rig_task_id' => $state['task_id'], 'clips' => $extra], 'Animating idle, jump and swim…');

                return self::POLL_SECONDS;

            case 'animate':
                $clips = $state['clips'] ?? [];
                $animations = $character->animations ?? [];
                $done = 0;
                foreach ($clips as $clip => $taskId) {
                    if (isset($animations[$clip]) || $taskId === null) {
                        $done++;

                        continue;
                    }
                    $task = $meshy->task('animations', (string) $taskId);
                    $status = (string) ($task['status'] ?? '');
                    if ($status === 'SUCCEEDED' && is_string($task['result']['animation_glb_url'] ?? null)) {
                        $this->download($meshy, $character, $task['result']['animation_glb_url'], "{$clip}.glb");
                        $animations[$clip] = $character->storageDirectory()."/{$clip}.glb";
                        $state['credits'] = (int) ($state['credits'] ?? 0) + (int) ($task['consumed_credits'] ?? 0);
                        $done++;
                    } elseif (in_array($status, ['FAILED', 'CANCELED', 'EXPIRED'], true)) {
                        $clips[$clip] = null; // Skip: the game falls back to the closest clip.
                        $done++;
                    }
                }
                $state['clips'] = $clips;
                $character->forceFill(['animations' => $animations]);

                if ($done < count($clips)) {
                    $this->save($character, $state, sprintf('Animating (%d of %d clips)…', $done, count($clips)));

                    return self::POLL_SECONDS;
                }

                return $this->finish($character, $state);
        }

        return null;
    }

    /**
     * @param  array<string, mixed>  $state
     */
    private function finish(Character $character, array $state): ?int
    {
        $character->forceFill([
            'status' => 'ready',
            'status_message' => null,
            'meta' => [...($character->meta ?? []), 'pipeline' => [...$state, 'stage' => 'done'], 'meshy_credits' => (int) ($state['credits'] ?? 0)],
        ])->save();
        MeshyClient::forgetBalance();

        return null;
    }

    private function download(MeshyClient $meshy, Character $character, string $url, string $file): void
    {
        $disk = Storage::disk('public');
        $disk->makeDirectory($character->storageDirectory());
        $meshy->download($url, $disk->path($character->storageDirectory().'/'.$file));
    }

    /**
     * @param  array<string, mixed>  $task
     * @param  array<string, mixed>  $state
     */
    private function pending(Character $character, array $task, array &$state, string $label): ?int
    {
        $status = (string) ($task['status'] ?? '');

        if ($status === 'SUCCEEDED') {
            $state['credits'] = (int) ($state['credits'] ?? 0) + (int) ($task['consumed_credits'] ?? 0);

            return null;
        }

        if (in_array($status, ['FAILED', 'CANCELED', 'EXPIRED'], true)) {
            throw new MeshyException('Meshy task '.strtolower($status).': '.($task['task_error']['message'] ?? 'no reason given'));
        }

        $progress = is_numeric($task['progress'] ?? null) ? (int) $task['progress'] : null;
        $this->save($character, $state, $label.($progress !== null ? " — {$progress}%" : '').'…');

        return self::POLL_SECONDS;
    }

    /**
     * @param  array<string, mixed>  $state
     */
    private function save(Character $character, array $state, ?string $message): void
    {
        $character->forceFill([
            'meta' => [...($character->meta ?? []), 'pipeline' => $state],
            'status' => 'processing',
            'status_message' => $message,
        ])->save();
    }

    public function failed(?Throwable $exception): void
    {
        $this->character->forceFill([
            'status' => 'failed',
            'status_message' => Str::limit('Generation failed: '.($exception?->getMessage() ?? 'unknown error'), 250),
        ])->save();
    }
}
