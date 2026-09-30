<?php

namespace App\Mcp\Tools;

use App\Jobs\GenerateCharacter;
use App\Mcp\Assets\ModelSource;
use App\Mcp\ToolError;
use App\Models\Character;
use App\Services\Ai\MaterialPrompts;
use App\Support\ActiveCharacter;
use App\Support\AiSettings;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\Storage;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;
use Throwable;

#[Name('manage_character')]
#[Description('Changes the character library (Studio → Characters). action: "activate" makes character `id` the player character (it must be ready); "deactivate" goes back to the default character; "update" sets `name` / `height` (m); "import" adds a rigged .glb (clips named idle / walk / run / jump / swim are used) from `path`, `url` or `base64`, with `name` and `height`; "generate" makes one with Meshy in the background (`prompt`, optional `name`, `style` 0-100 = realistic → stylised, `height`, `route` text / image, `extra_clips`; costs credits, poll list_characters); "retry" re-runs a failed generation. Editors pick up the player character when the map is reloaded. Delete with delete_library_item.')]
class ManageCharacter extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        return [
            'action' => $schema->string()->enum(['activate', 'deactivate', 'update', 'import', 'generate', 'retry'])->required(),
            'id' => $schema->integer()->description('The character (activate, update, retry).'),
            'name' => $schema->string(),
            'height' => $schema->number()->min(0.5)->max(4)->description('Character height in m (default 1.8).'),
            'path' => $schema->string()->description('import: absolute path of a rigged .glb on this computer.'),
            'url' => $schema->string()->description('import: http(s) URL of a .glb.'),
            'base64' => $schema->string()->description('import: the .glb as base64 (≤ 15 MB).'),
            'prompt' => $schema->string()->description('generate: what the character looks like.'),
            'style' => $schema->integer()->min(0)->max(100)->description('generate: 0 realistic … 100 stylised (default 50).'),
            'route' => $schema->string()->enum(GenerateCharacter::ROUTES)->description('generate: "text" (Meshy text to 3D) or "image" (a concept image first, needs OpenRouter). Default text.'),
            'extra_clips' => $schema->boolean()->description('generate: also make idle / jump / swim clips (default true).'),
        ];
    }

    protected function run(Request $request): Response
    {
        $data = $request->validate([
            'action' => ['required', 'in:activate,deactivate,update,import,generate,retry'],
            'id' => ['required_if:action,activate,update,retry', 'integer'],
            'name' => ['required_if:action,import', 'nullable', 'string', 'max:60'],
            'height' => ['sometimes', 'numeric', 'between:0.5,4'],
            'prompt' => ['required_if:action,generate', 'nullable', 'string', 'max:500'],
            'style' => ['sometimes', 'integer', 'between:0,100'],
            'route' => ['sometimes', 'in:'.implode(',', GenerateCharacter::ROUTES)],
            'extra_clips' => ['sometimes', 'boolean'],
        ]);
        $active = app(ActiveCharacter::class);
        $find = fn () => Character::query()->find($data['id']) ?? throw new ToolError("No character {$data['id']}. See list_characters.");

        switch ($data['action']) {
            case 'activate':
                $character = $find();

                if (! $character->isReady()) {
                    throw new ToolError("{$character->name} is not ready yet ({$character->status}).");
                }

                $active->set($character);

                return $this->done($character, "{$character->name} is now the player character. Editors show it after reloading the map.");
            case 'deactivate':
                $active->set(null);

                return $this->json(['active_id' => null, 'message' => 'The player uses the default character again.']);
            case 'update':
                $character = $find();
                $character->update(array_filter([
                    'name' => $data['name'] ?? null,
                    'height' => isset($data['height']) ? (float) $data['height'] : null,
                ], fn ($v) => $v !== null));

                return $this->done($character, "{$character->name} saved.");
            case 'import':
                return $this->import($request, $data);
            case 'generate':
                return $this->generate($data);
            default:
                $character = $find();

                if ($character->status !== 'failed' || $character->source !== 'meshy') {
                    throw new ToolError('Only failed Meshy generations can be retried.');
                }

                $options = $character->meta['options'] ?? [];
                $character->forceFill(['status' => 'queued', 'status_message' => 'Queued for Meshy…', 'meta' => ['options' => $options]])->save();
                $this->dispatchSafely(new GenerateCharacter($character, $options));

                return $this->done($character->refresh(), 'Generation queued again.');
        }
    }

    /**
     * @param  array<string, mixed>  $data
     */
    private function import(Request $request, array $data): Response
    {
        $sources = app(ModelSource::class);

        try {
            $model = $sources->load([
                'path' => $request->get('path'),
                'url' => $request->get('url'),
                'base64' => $request->get('base64'),
                'file_name' => 'character.glb',
            ]);

            if ($model->extension !== 'glb') {
                throw new ToolError('Characters must be a rigged binary glTF (.glb).');
            }

            $character = Character::query()->create([
                'name' => $data['name'], 'source' => 'upload', 'height' => (float) ($data['height'] ?? 1.8), 'status' => 'ready',
            ]);
            $path = $character->storageDirectory().'/model.glb';
            Storage::disk('public')->put($path, (string) file_get_contents($model->path));
            $character->update(['model_path' => $path]);
        } finally {
            $sources->cleanup();
        }

        return $this->done($character, "{$character->name} added. Make it the player character with action \"activate\".");
    }

    /**
     * @param  array<string, mixed>  $data
     */
    private function generate(array $data): Response
    {
        $ai = app(AiSettings::class);
        $route = $data['route'] ?? 'text';

        if (! $ai->meshyConfigured()) {
            throw new ToolError('Meshy is not configured: the user needs to add a Meshy API key under Settings → AI.');
        }

        if ($route === 'image' && ! $ai->configured()) {
            throw new ToolError('OpenRouter is not configured (needed for the concept image). Use route "text".');
        }

        $options = ['route' => $route, 'model' => null, 'extra_clips' => (bool) ($data['extra_clips'] ?? true)];
        $character = Character::query()->create([
            'name' => trim((string) ($data['name'] ?? '')) ?: MaterialPrompts::summary($data['prompt'], 36),
            'source' => 'meshy',
            'prompt' => $data['prompt'],
            'style' => (int) ($data['style'] ?? 50),
            'height' => (float) ($data['height'] ?? 1.8),
            'status' => 'queued',
            'status_message' => 'Queued for Meshy…',
            'meta' => ['options' => $options],
        ]);
        $this->dispatchSafely(new GenerateCharacter($character, $options));

        return $this->done($character->refresh(), 'Generating with Meshy in the background (a few minutes); poll list_characters.');
    }

    private function done(Character $character, string $message): Response
    {
        return $this->json([
            'character' => $character->only('id', 'name', 'source', 'status', 'status_message', 'height'),
            'active_id' => app(ActiveCharacter::class)->id(),
            'message' => $message,
        ]);
    }

    private function dispatchSafely(object $job): void
    {
        try {
            dispatch($job);
        } catch (Throwable $e) {
            report($e);
        }
    }
}
