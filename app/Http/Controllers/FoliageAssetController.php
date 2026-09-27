<?php

namespace App\Http\Controllers;

use App\Enums\FoliageKind;
use App\Jobs\GenerateFoliageAsset;
use App\Jobs\ImportFoliageAsset;
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
 * The foliage asset library: Poly Haven imports, GLB / glTF / zip uploads and AI generated cards.
 */
class FoliageAssetController extends Controller
{
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

    public function import(Request $request): RedirectResponse
    {
        $data = $request->validate([
            'refs' => ['required', 'array', 'min:1', 'max:30'],
            'refs.*' => ['required', 'string', 'max:120', 'regex:/^[A-Za-z0-9_.-]+$/'],
            'kind' => ['nullable', Rule::enum(FoliageKind::class)],
        ]);

        $imported = [];
        foreach (array_unique($data['refs']) as $ref) {
            $imported[] = $this->queue->importPolyHaven($ref, $data['kind'] ?? null)->name;
        }

        $this->toast('info', 'Importing '.implode(', ', array_slice($imported, 0, 4)).(count($imported) > 4 ? ' and '.(count($imported) - 4).' more' : '').'…');

        return back();
    }

    public function generate(Request $request, AiSettings $ai): RedirectResponse
    {
        $data = $request->validate([
            'prompt' => ['required', 'string', 'max:1000'],
            'name' => ['nullable', 'string', 'max:80'],
            'kind' => ['required', Rule::enum(FoliageKind::class), Rule::notIn(['rock'])],
            'style' => ['required', 'integer', 'between:0,100'],
            'target_height' => ['required', 'numeric', 'between:0.05,80'],
            'variants' => ['required', 'integer', 'between:1,4'],
            'model' => ['nullable', 'string', 'max:200', 'regex:'.AiSettings::MODEL_PATTERN],
        ], [
            'kind.not_in' => 'Rocks cannot be generated as flat cards — import a rock model from Poly Haven instead.',
        ]);

        if (! $ai->configured()) {
            $message = 'AI is not configured: add an OpenRouter API key under Settings → AI.';
            $this->toast('error', $message);

            return back()->withErrors(['ai' => $message]);
        }

        $name = trim((string) ($data['name'] ?? '')) ?: MaterialPrompts::summary($data['prompt'], 36);
        for ($n = 1; $n <= $data['variants']; $n++) {
            $this->queue->generate($name.($data['variants'] > 1 ? " #{$n}" : ''), FoliageKind::from($data['kind']), (int) $data['style'], (float) $data['target_height'], $data['prompt'], $data['model'] ?? null);
        }

        $this->toast('info', 'Generating '.$data['variants'].' foliage '.Str::plural('card', $data['variants']).'…');

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

        if ($asset->source === 'polyhaven' && $asset->source_ref) {
            $asset->forceFill(['status' => 'queued', 'status_message' => 'Queued for download…'])->save();
            $this->queue->dispatch(new ImportFoliageAsset($asset, $asset->source_ref));
        } elseif ($asset->source === 'ai' && $asset->ai_prompt) {
            $asset->forceFill(['status' => 'queued', 'status_message' => 'Queued for generation…'])->save();
            $this->queue->dispatch(new GenerateFoliageAsset($asset, ['prompt' => $this->userPrompt($asset), 'model' => $asset->ai_model]));
        } else {
            $this->toast('error', 'The uploaded source file is gone — upload the model again.');
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
