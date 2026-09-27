<?php

namespace App\Http\Controllers;

use App\Jobs\GenerateCharacter;
use App\Models\Character;
use App\Services\Ai\MaterialPrompts;
use App\Support\ActiveCharacter;
use App\Support\AiSettings;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;
use Inertia\Inertia;
use Inertia\Response;
use Throwable;

/**
 * The character library: Meshy-generated (rigged + animated) or uploaded player characters.
 */
class CharacterController extends Controller
{
    public function index(AiSettings $ai, ActiveCharacter $active): Response
    {
        $activeId = $active->id();
        $frontend = $ai->toFrontend();

        return Inertia::render('characters/index', [
            'characters' => Character::query()->latest()->latest('id')->get()
                ->map(fn (Character $c) => $c->toStudioArray($c->id === $activeId))->values(),
            'ai' => [
                'configured' => $frontend['configured'],
                'meshy_configured' => $frontend['meshy']['configured'],
                'image_model' => $frontend['image_model'],
            ],
            'extraClips' => array_keys(GenerateCharacter::EXTRA_CLIPS),
        ]);
    }

    public function generate(Request $request, AiSettings $ai): RedirectResponse
    {
        $data = $request->validate([
            'prompt' => ['required', 'string', 'max:500'],
            'name' => ['nullable', 'string', 'max:60'],
            'style' => ['required', 'integer', 'between:0,100'],
            'height' => ['required', 'numeric', 'between:0.5,4'],
            'route' => ['required', Rule::in(GenerateCharacter::ROUTES)],
            'model' => ['nullable', 'string', 'max:40'],
            'extra_clips' => ['sometimes', 'boolean'],
        ]);

        $missing = match (true) {
            ! $ai->meshyConfigured() => 'Meshy is not configured: add a Meshy API key under Settings → AI.',
            $data['route'] === 'image' && ! $ai->configured() => 'OpenRouter is not configured (needed for the concept image).',
            default => null,
        };
        if ($missing !== null) {
            $this->toast('error', $missing);

            return back()->withErrors(['ai' => $missing]);
        }

        $options = ['route' => $data['route'], 'model' => $data['model'] ?? null, 'extra_clips' => $request->boolean('extra_clips', true)];
        $character = Character::query()->create([
            'name' => trim((string) ($data['name'] ?? '')) ?: MaterialPrompts::summary($data['prompt'], 36),
            'source' => 'meshy',
            'prompt' => $data['prompt'],
            'style' => (int) $data['style'],
            'height' => (float) $data['height'],
            'status' => 'queued',
            'status_message' => 'Queued for Meshy…',
            'meta' => ['options' => $options],
        ]);

        $this->dispatchSafely(new GenerateCharacter($character, $options));
        $this->toast('info', "Generating {$character->name} with Meshy — this takes a few minutes.");

        return back();
    }

    public function upload(Request $request): RedirectResponse
    {
        $data = $request->validate([
            'model' => ['required', 'file', 'max:102400'],
            'name' => ['required', 'string', 'max:60'],
            'height' => ['required', 'numeric', 'between:0.5,4'],
        ]);

        $file = $request->file('model');
        $handle = fopen($file->getRealPath(), 'rb');
        $magic = $handle ? fread($handle, 4) : '';
        if ($handle) {
            fclose($handle);
        }
        if ($magic !== 'glTF') {
            return back()->withErrors(['model' => 'Upload a rigged binary glTF (.glb). Clips named idle / walk / run / jump / swim are used.']);
        }

        $character = Character::query()->create([
            'name' => $data['name'], 'source' => 'upload', 'height' => (float) $data['height'], 'status' => 'ready',
        ]);
        $character->update(['model_path' => $file->storeAs($character->storageDirectory(), 'model.glb', 'public')]);

        $this->toast('success', "{$character->name} added.");

        return back();
    }

    public function update(Request $request, Character $character): RedirectResponse
    {
        $character->update($request->validate([
            'name' => ['required', 'string', 'max:60'],
            'height' => ['required', 'numeric', 'between:0.5,4'],
        ]));

        $this->toast('success', "{$character->name} saved.");

        return back();
    }

    public function activate(Character $character, ActiveCharacter $active): RedirectResponse
    {
        if (! $character->isReady()) {
            return back()->withErrors(['character' => 'This character is not ready yet.']);
        }

        $active->set($character);
        $this->toast('success', "{$character->name} is now the player character. Reload a map (or press Play) to see it.");

        return back();
    }

    public function deactivate(ActiveCharacter $active): RedirectResponse
    {
        $active->set(null);
        $this->toast('success', 'The player uses the default character again.');

        return back();
    }

    public function retry(Character $character): RedirectResponse
    {
        if ($character->status !== 'failed' || $character->source !== 'meshy') {
            return back();
        }

        $options = $character->meta['options'] ?? [];
        $character->forceFill([
            'status' => 'queued', 'status_message' => 'Queued for Meshy…', 'meta' => ['options' => $options],
        ])->save();
        $this->dispatchSafely(new GenerateCharacter($character, $options));

        return back();
    }

    public function destroy(Character $character, ActiveCharacter $active): RedirectResponse
    {
        if ($active->id() === $character->id) {
            $active->set(null);
        }
        $character->delete();
        $this->toast('success', 'Character deleted.');

        return back();
    }

    private function dispatchSafely(object $job): void
    {
        try {
            dispatch($job);
        } catch (Throwable $e) {
            report($e); // Sync queue: the job already marked the character as failed.
        }
    }
}
