<?php

namespace App\Http\Controllers;

use App\Enums\FoliageKind;
use App\Jobs\GenerateFoliageAsset;
use App\Jobs\GenerateMeshyAsset;
use App\Models\FoliageAsset;
use App\Models\FoliageType;
use App\Services\Ai\MaterialPrompts;
use App\Services\Foliage\FoliageAssetQueue;
use App\Services\Foliage\FoliageTypeDefaults;
use App\Services\Foliage\ModelUploads;
use App\Support\AiSettings;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;
use RuntimeException;

/**
 * The foliage asset library: GLB / glTF / zip uploads, Meshy 3D generation and AI plant cards.
 */
class FoliageAssetController extends Controller
{
    public const ENGINES = ['meshy_text', 'meshy_image', 'card'];

    public function __construct(private readonly FoliageAssetQueue $queue) {}

    public function upload(Request $request, ModelUploads $uploads): RedirectResponse
    {
        $data = $request->validate([
            'files' => ['required', 'array', 'min:1', 'max:20'],
            'files.*' => ['required', 'file', 'max:307200'],
            'kind' => ['nullable', Rule::enum(FoliageKind::class)],
            'style' => ['required', Rule::in(array_keys(FoliageAsset::STYLES))],
            'target_height' => ['nullable', 'numeric', 'between:0.02,150'],
            'license' => ['nullable', 'string', 'max:120'],
        ]);

        $created = [];
        $errors = [];

        /** @var UploadedFile $file */
        foreach ($request->file('files') as $file) {
            try {
                array_push($created, ...$uploads->ingest($file, [
                    'kind' => $data['kind'] ?? null,
                    'style' => $data['style'],
                    'target_height' => $data['target_height'] ?? null,
                    'license' => $data['license'] ?? null,
                ]));
            } catch (RuntimeException $e) {
                $errors[] = $file->getClientOriginalName().': '.$e->getMessage();
            }
        }

        if ($created === []) {
            $this->toast('error', 'Upload failed: '.implode(' ', $errors));

            return back()->withErrors(['files' => implode(' ', $errors)]);
        }

        $count = count($created);
        $this->toast($errors === [] ? 'success' : 'warning', ($count === 1 ? "{$created[0]->name} added" : "{$count} models added")
            .' — optimising them in your browser.'.($errors !== [] ? ' Skipped: '.implode(' ', $errors) : ''));

        return back();
    }

    /**
     * AI generation. Engines: "meshy_text" (Meshy text to 3D), "meshy_image" (OpenRouter concept image →
     * Meshy image to 3D) and "card" (one OpenRouter image baked into crossed cards).
     */
    public function generate(Request $request, AiSettings $ai): RedirectResponse
    {
        $data = $request->validate([
            'engine' => ['required', Rule::in(self::ENGINES)],
            'prompt' => ['required', 'string', 'max:600'],
            'name' => ['nullable', 'string', 'max:80'],
            'kind' => ['required', Rule::enum(FoliageKind::class)],
            'style' => ['required', 'integer', 'between:0,100'],
            'target_height' => ['nullable', 'required_if:engine,card', 'numeric', 'between:0.05,80'],
            'variants' => ['required', 'integer', 'between:1,4'],
            'meshy_model' => ['nullable', 'string', 'max:40'],
            'model' => ['nullable', 'string', 'max:200', 'regex:'.AiSettings::MODEL_PATTERN],
        ]);

        $engine = $data['engine'];
        $error = match (true) {
            $engine === 'card' && $data['kind'] === 'rock' => ['kind', 'Rocks cannot be flat cards — generate them as a Meshy 3D model.'],
            $engine !== 'meshy_text' && ! $ai->configured() => ['ai', 'OpenRouter is not configured: add an OpenRouter API key under Settings → AI.'],
            str_starts_with($engine, 'meshy') && ! $ai->meshyConfigured() => ['ai', 'Meshy is not configured: add a Meshy API key under Settings → AI.'],
            default => null,
        };
        if ($error !== null) {
            $this->toast('error', $error[1]);

            return back()->withErrors([$error[0] => $error[1]]);
        }

        $kind = FoliageKind::from($data['kind']);
        $height = isset($data['target_height']) ? (float) $data['target_height'] : null;
        $name = trim((string) ($data['name'] ?? '')) ?: MaterialPrompts::summary($data['prompt'], 36);

        for ($n = 1; $n <= $data['variants']; $n++) {
            $variant = $name.($data['variants'] > 1 ? " #{$n}" : '');
            $engine === 'card'
                ? $this->queue->generate($variant, $kind, (int) $data['style'], (float) $height, $data['prompt'], $data['model'] ?? null)
                : $this->queue->meshy($variant, $kind, (int) $data['style'], $height, $data['prompt'], $engine === 'meshy_image' ? 'image' : 'text', $data['meshy_model'] ?? null);
        }

        $what = $engine === 'card' ? Str::plural('card', $data['variants']) : Str::plural('3D model', $data['variants']).' with Meshy';
        $this->toast('info', "Generating {$data['variants']} {$what}…");

        return back();
    }

    public function update(Request $request, FoliageAsset $asset): RedirectResponse
    {
        $data = $request->validate([
            'name' => ['required', 'string', 'max:80'],
            'kind' => ['required', Rule::enum(FoliageKind::class)],
            'style' => ['required', Rule::in(array_keys(FoliageAsset::STYLES))],
            'target_height' => ['nullable', 'numeric', 'between:0.02,150'],
            'license' => ['nullable', 'string', 'max:120'],
            'author' => ['nullable', 'string', 'max:120'],
        ]);

        $heightChanged = ($data['target_height'] ?? null) !== null
            ? abs((float) $data['target_height'] - (float) ($asset->meta['height'] ?? 0)) > 0.005
            : $asset->target_height !== null;
        $kindChanged = $asset->kind->value !== $data['kind'];

        $asset->fill($data);

        // Size and kind are baked into the model (LOD budgets, card layout): re-bake when they change.
        if (($heightChanged || $kindChanged) && $asset->canBake() && in_array($asset->status, ['ready', 'failed'], true)) {
            $asset->forceFill(['status' => 'awaiting_bake', 'status_message' => 'Re-optimising with the new settings…']);
        }

        $asset->save();
        $this->toast('success', "{$asset->name} saved.");

        return back();
    }

    public function rebake(FoliageAsset $asset): RedirectResponse
    {
        if (! $asset->canBake()) {
            return $this->retry($asset);
        }

        $asset->forceFill(['status' => 'awaiting_bake', 'status_message' => 'Waiting to be optimised in the studio.'])->save();

        return back();
    }

    public function retry(FoliageAsset $asset): RedirectResponse
    {
        if ($asset->canBake()) {
            return $this->rebake($asset);
        }

        $options = $asset->bake_options ?? [];
        if (($options['generator'] ?? null) === 'meshy' && ! empty($options['prompt'])) {
            $asset->forceFill(['status' => 'queued', 'status_message' => 'Queued for Meshy…', 'bake_options' => [...$options, 'meshy' => []]])->save();
            $this->queue->dispatch(new GenerateMeshyAsset($asset, [
                'route' => $options['route'] ?? 'text', 'prompt' => $options['prompt'], 'style' => (int) ($options['style'] ?? 20), 'model' => $options['meshy_model'] ?? null,
            ]));
        } elseif ($asset->source === 'ai' && $asset->ai_prompt) {
            $asset->forceFill(['status' => 'queued', 'status_message' => 'Queued for generation…'])->save();
            $this->queue->dispatch(new GenerateFoliageAsset($asset, ['prompt' => $this->userPrompt($asset), 'model' => $asset->ai_model]));
        } else {
            $this->toast('error', 'The source file is gone — upload or generate the model again.');
        }

        return back();
    }

    public function createType(FoliageAsset $asset, FoliageTypeDefaults $defaults): RedirectResponse
    {
        $type = FoliageType::query()->create([
            ...$defaults->forKind($asset->kind),
            'name' => Str::limit($asset->name, 60, ''),
            'foliage_asset_id' => $asset->id,
        ]);

        $this->toast('success', "Foliage type \"{$type->name}\" created from the asset.");

        return redirect()->route('foliage.index', ['type' => $type->id]);
    }

    public function destroy(FoliageAsset $asset): RedirectResponse
    {
        $count = $asset->types()->count();
        $asset->delete();

        $this->toast('success', $count > 0
            ? "Asset deleted. {$count} foliage ".Str::plural('type', $count).' fell back to procedural meshes.'
            : 'Asset deleted.');

        return back();
    }

    /**
     * The prompt the user typed (ai_prompt holds the final prompt after generation).
     */
    private function userPrompt(FoliageAsset $asset): string
    {
        $prompt = (string) $asset->ai_prompt;

        if (preg_match('/^[^:]+: (.*?)\. [A-Z][^.]*\. Game foliage sprite:/s', $prompt, $m) === 1) {
            return $m[1];
        }

        return $prompt;
    }
}
