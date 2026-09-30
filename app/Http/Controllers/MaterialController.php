<?php

namespace App\Http\Controllers;

use App\Jobs\GenerateMaterial;
use App\Jobs\ImportMaterial;
use App\Models\Material;
use App\Services\Ai\MaterialPrompts;
use App\Services\Materials\MaterialLibrary;
use App\Services\Materials\MaterialStorage;
use App\Services\Materials\Sources\UploadSource;
use App\Support\AiSettings;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;
use Inertia\Inertia;
use Inertia\Response;
use Throwable;

/**
 * The PBR material library: upload, import (Poly Haven / ambientCG), AI generation and editing.
 */
class MaterialController extends Controller
{
    public function __construct(private readonly MaterialLibrary $library) {}

    public function index(AiSettings $ai): Response
    {
        $ai = $ai->toFrontend();

        return Inertia::render('materials/index', [
            'materials' => Material::query()->withCount('layers')->latest()->latest('id')->get()
                ->map(fn (Material $m) => $m->toStudioArray())->values(),
            'categories' => MaterialLibrary::categoryOptions(),
            'ai' => [
                'configured' => $ai['configured'],
                'image_model' => $ai['image_model'],
                'text_model' => $ai['text_model'],
                'image_resolution' => $ai['image_resolution'],
            ],
        ]);
    }

    public function upload(Request $request, UploadSource $uploads): RedirectResponse
    {
        $data = $request->validate([
            'name' => ['required', 'string', 'max:120'],
            'category' => ['required', Rule::in(array_keys(Material::CATEGORIES))],
            'tile_size' => ['required', 'numeric', 'between:0.1,100'],
            'make_seamless' => ['sometimes', 'boolean'],
            'files' => ['required', 'array', 'min:1', 'max:8'],
            'files.*' => ['required', 'file', 'image', 'mimes:jpg,jpeg,png,webp', 'max:20480'],
        ]);

        $material = $this->library->create([
            'name' => $data['name'],
            'category' => $data['category'],
            'tile_size' => (float) $data['tile_size'],
            'source' => 'upload',
            'status' => 'processing',
        ]);

        $files = array_map(fn (UploadedFile $file) => [
            'name' => $file->getClientOriginalName(),
            'bytes' => (string) file_get_contents($file->getRealPath()),
        ], $request->file('files'));

        $this->raiseMemoryLimit();

        try {
            $uploads->import($material, $files, ['make_seamless' => $request->boolean('make_seamless')]);
        } catch (Throwable $e) {
            report($e);
            $material->delete();
            $this->toast('error', 'Upload failed: '.$e->getMessage());

            return back()->withErrors(['files' => $e->getMessage()]);
        }

        $this->toast('success', "{$material->name} added to the library.");

        return back();
    }

    public function import(Request $request): RedirectResponse
    {
        $data = $request->validate([
            'source' => ['required', Rule::in(ImportMaterial::SOURCES)],
            'ref' => ['required', 'string', 'max:120', 'regex:/^[A-Za-z0-9_.-]+$/'],
            'resolution' => ['required', Rule::in(['1k', '2k', '4k'])],
            'name' => ['nullable', 'string', 'max:120'],
            'category' => ['nullable', Rule::in(array_keys(Material::CATEGORIES))],
        ]);

        $material = $this->library->create([
            'name' => $data['name'] ?? Str::headline($data['ref']),
            'category' => $data['category'] ?? 'other',
            'source' => $data['source'],
            'source_ref' => $data['ref'],
            'status' => 'processing',
            'status_message' => 'Queued for download…',
        ]);

        $this->dispatchSafely(new ImportMaterial($material, $data['source'], $data['ref'], $data['resolution'], [
            'name' => $data['name'] ?? null,
            'category' => $data['category'] ?? null,
        ]));

        $this->toast('info', "Importing {$material->name}…");

        return back();
    }

    public function generate(Request $request, AiSettings $ai): RedirectResponse
    {
        $data = $request->validate([
            'prompt' => ['required', 'string', 'max:1000'],
            'category' => ['required', Rule::in(array_keys(Material::CATEGORIES))],
            'tile_size' => ['required', 'numeric', 'between:0.1,100'],
            'variants' => ['required', 'integer', 'between:1,4'],
            'model' => ['nullable', 'string', 'max:200', 'regex:'.AiSettings::MODEL_PATTERN],
            'resolution' => ['nullable', Rule::in(AiSettings::RESOLUTIONS)],
            'enhance' => ['sometimes', 'boolean'],
        ]);

        if (! $ai->configured()) {
            return $this->notConfigured();
        }

        $this->queueGeneration($data, $request->boolean('enhance'));

        $this->toast('info', $data['variants'] > 1 ? "Generating {$data['variants']} variants…" : 'Generating material…');

        return back();
    }

    /**
     * Creates the materials of an AI generation (one per variant) and queues their generation. Also
     * used by the MCP tool generate_material.
     *
     * @param  array{prompt: string, category: string, tile_size: float|int|string, variants: int, model?: string|null, resolution?: string|null, name?: string|null}  $data
     * @return list<Material>
     */
    public function queueGeneration(array $data, bool $enhance): array
    {
        $ai = app(AiSettings::class);
        $summary = trim((string) ($data['name'] ?? '')) ?: MaterialPrompts::summary($data['prompt']);
        $seedBase = random_int(1, 1_000_000);
        $materials = [];

        for ($n = 1; $n <= $data['variants']; $n++) {
            $material = $this->library->create([
                'name' => $data['variants'] > 1 || empty($data['name']) ? "{$summary} #{$n}" : $summary,
                'category' => $data['category'],
                'tile_size' => (float) $data['tile_size'],
                'source' => 'ai',
                'license' => 'AI generated',
                'status' => 'processing',
                'status_message' => 'Queued…',
                'ai_prompt' => $data['prompt'],
                'ai_model' => $data['model'] ?? $ai->imageModel(),
            ]);

            $this->dispatchSafely(new GenerateMaterial($material, [
                'prompt' => $data['prompt'],
                'category' => $data['category'],
                'model' => $data['model'] ?? null,
                'resolution' => $data['resolution'] ?? null,
                'enhance' => $enhance,
                'seed' => $seedBase + $n,
            ]));
            $materials[] = $material;
        }

        return $materials;
    }

    public function aiEdit(Request $request, Material $material, AiSettings $ai): RedirectResponse
    {
        $data = $request->validate([
            'prompt' => ['required', 'string', 'max:1000'],
            'variants' => ['required', 'integer', 'between:1,4'],
        ]);

        if (! $ai->configured()) {
            return $this->notConfigured();
        }

        if (! $material->isReady()) {
            $this->toast('error', 'Only ready materials can be edited with AI.');

            return back();
        }

        $seedBase = random_int(1, 1_000_000);

        for ($n = 1; $n <= $data['variants']; $n++) {
            $child = $this->library->create([
                'name' => Str::limit($material->name, 60, '').' — '.MaterialPrompts::summary($data['prompt'], 30).($data['variants'] > 1 ? " #{$n}" : ''),
                'category' => $material->category,
                'tile_size' => $material->tile_size,
                'tags' => $material->tags,
                'source' => 'ai',
                'license' => 'AI generated',
                'parent_id' => $material->id,
                'status' => 'processing',
                'status_message' => 'Queued…',
                'ai_prompt' => $data['prompt'],
                'ai_model' => $ai->imageModel(),
            ]);

            $this->dispatchSafely(new GenerateMaterial($child, [
                'prompt' => $data['prompt'],
                'category' => $material->category,
                'seed' => $seedBase + $n,
            ]));
        }

        $this->toast('info', 'Generating AI edit of '.$material->name.'…');

        return back();
    }

    public function retry(Material $material, AiSettings $ai): RedirectResponse
    {
        if ($material->status !== 'failed') {
            $this->toast('warning', 'Only failed materials can be retried.');

            return back();
        }

        if ($material->source === 'ai') {
            if (! $ai->configured()) {
                return $this->notConfigured();
            }

            $material->forceFill(['status' => 'processing', 'status_message' => 'Queued…'])->save();
            $this->dispatchSafely(new GenerateMaterial($material, [
                // Retry from the user's words when the final prompt was not built yet.
                'prompt' => $this->userPrompt($material),
                'category' => $material->category,
                'model' => $material->ai_model,
            ]));
        } elseif (in_array($material->source, ImportMaterial::SOURCES, true) && $material->source_ref) {
            $material->forceFill(['status' => 'processing', 'status_message' => 'Queued for download…'])->save();
            $resolution = match ($material->resolution) {
                2048 => '2k',
                4096 => '4k',
                default => '1k',
            };
            $this->dispatchSafely(new ImportMaterial($material, $material->source, $material->source_ref, $resolution, [
                'name' => $material->name,
                'category' => $material->category,
            ]));
        } else {
            $this->toast('error', 'This material cannot be retried — upload the files again.');

            return back();
        }

        $this->toast('info', "Retrying {$material->name}…");

        return back();
    }

    public function update(Request $request, Material $material): RedirectResponse
    {
        $data = $request->validate([
            'name' => ['sometimes', 'required', 'string', 'max:120'],
            'category' => ['sometimes', 'required', Rule::in(array_keys(Material::CATEGORIES))],
            'tile_size' => ['sometimes', 'required', 'numeric', 'between:0.1,100'],
            'tint' => ['sometimes', 'required', 'string', 'regex:/^#[0-9a-fA-F]{6}$/'],
            'roughness_scale' => ['sometimes', 'required', 'numeric', 'between:0,3'],
            'normal_strength' => ['sometimes', 'required', 'numeric', 'between:0,3'],
            'height_contrast' => ['sometimes', 'required', 'numeric', 'between:0,3'],
            'tags' => ['sometimes', 'nullable', 'array', 'max:30'],
            'tags.*' => ['nullable', 'string', 'max:40'],
        ]);

        if (array_key_exists('tags', $data)) {
            $data['tags'] = array_values(array_unique(array_filter(array_map(fn ($t) => trim((string) $t), $data['tags'] ?? []))));
        }

        $material->update($data);

        $this->toast('success', "{$material->name} saved.");

        return back();
    }

    public function duplicate(Material $material, MaterialStorage $storage): RedirectResponse
    {
        $copy = $this->library->duplicate($material, $storage);

        $this->toast('success', "Duplicated as {$copy->name}.");

        return back();
    }

    public function destroy(Material $material): RedirectResponse
    {
        $layers = $material->layers()->count();
        $material->delete();

        $this->toast('success', $layers > 0
            ? "Material deleted. {$layers} layer(s) fell back to procedural colours."
            : 'Material deleted.');

        return back();
    }

    private function notConfigured(): RedirectResponse
    {
        $message = 'AI is not configured: add an OpenRouter API key under Settings → AI.';
        $this->toast('error', $message);

        return back()->withErrors(['ai' => $message]);
    }

    /**
     * The prompt the user typed (ai_prompt holds it until the job replaces it with the final prompt).
     */
    private function userPrompt(Material $material): string
    {
        $prompt = (string) $material->ai_prompt;

        // AI edit: "Edit the attached ground texture: {user prompt}. Keep it a …"
        if (preg_match('/^Edit the attached ground texture: (.*)\. Keep it a /s', $prompt, $m) === 1) {
            return $m[1];
        }

        $marker = 'fills the whole frame, photorealistic, ';

        if (str_contains($prompt, $marker)) {
            // "{rules}, {category hint}, {user prompt}"
            $rest = substr($prompt, strpos($prompt, $marker) + strlen($marker));
            $hint = MaterialPrompts::CATEGORY_HINTS[$material->category] ?? MaterialPrompts::CATEGORY_HINTS['other'];

            return str_starts_with($rest, $hint.', ') ? substr($rest, strlen($hint) + 2) : $rest;
        }

        return $prompt !== '' ? $prompt : $material->name;
    }

    private function dispatchSafely(object $job): void
    {
        try {
            dispatch($job);
        } catch (Throwable $e) {
            // Only reachable with the sync queue: the job already marked the material as failed.
            report($e);
        }
    }

    private function raiseMemoryLimit(): void
    {
        $limit = ini_get('memory_limit');
        if ($limit !== false && $limit !== '-1' && ini_parse_quantity($limit) < 1024 ** 3) {
            ini_set('memory_limit', '1G');
        }
    }
}
