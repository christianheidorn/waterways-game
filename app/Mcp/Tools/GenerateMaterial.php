<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\MaterialController;
use App\Mcp\Assets\AgentImages;
use App\Mcp\ToolError;
use App\Models\Material;
use App\Services\Materials\MaterialLibrary;
use App\Services\Materials\Sources\UploadSource;
use App\Support\AiSettings;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Str;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;
use Laravel\Mcp\Server\Tools\Annotations\IsOpenWorld;
use Throwable;

#[Name('generate_material')]
#[Description(<<<'TXT'
Creates a PBR terrain material (albedo made tileable and delit, plus normal, roughness, AO and height maps), like the studio's material library:
- from `prompt`: the project's OpenRouter image model paints the texture (costs credits). Runs in the background (about 30–90 s): poll get_asset_status (type material) until "ready".
- from `image_path`: an image from generate_image (agent-images/…) or a local photo / texture file; made seamless and processed right away.
Then assign it to a layer with update_terrain_layer material_id. tile_size is the metres one texture repeat covers (grass 2–3, rock 4–8).
TXT)]
#[IsOpenWorld]
class GenerateMaterial extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        return [
            'prompt' => $schema->string()->description('What the ground looks like, e.g. "mossy forest floor with pine needles".'),
            'image_path' => $schema->string()->description('Instead of prompt: a stored agent image path or a local image file to turn into a material.'),
            'name' => $schema->string()->description('Library name (default: from the prompt / file).'),
            'category' => $schema->string()->enum(array_keys(Material::CATEGORIES))->description('Library category (default "other"); also guides the texture prompt.'),
            'tile_size' => $schema->number()->min(0.1)->max(100)->description('Metres per texture repeat (default 2).'),
            'variants' => $schema->integer()->min(1)->max(4)->description('prompt: how many variants to generate (default 1).'),
            'enhance' => $schema->boolean()->description('prompt: let the text model elaborate the prompt first (default false).'),
            'resolution' => $schema->string()->enum(AiSettings::RESOLUTIONS)->description('prompt: texture resolution (default: the studio setting).'),
            'make_seamless' => $schema->boolean()->description('image_path: make the image tile seamlessly (default true).'),
        ];
    }

    protected function run(Request $request): Response
    {
        $prompt = trim((string) $request->get('prompt', ''));
        $image = trim((string) $request->get('image_path', ''));
        if (($prompt === '') === ($image === '')) {
            throw new ToolError('Pass either prompt (AI generation) or image_path (an existing image).');
        }

        $category = (string) ($request->get('category') ?? 'other');
        if (! array_key_exists($category, Material::CATEGORIES)) {
            throw new ToolError('Unknown category "'.$category.'". Use one of: '.implode(', ', array_keys(Material::CATEGORIES)).'.');
        }
        $tileSize = $request->get('tile_size') ?? 2;
        if (! is_numeric($tileSize) || $tileSize < 0.1 || $tileSize > 100) {
            throw new ToolError('tile_size must be between 0.1 and 100 metres.');
        }

        return $image !== ''
            ? $this->fromImage($image, $request, $category, (float) $tileSize)
            : $this->fromPrompt($prompt, $request, $category, (float) $tileSize);
    }

    private function fromPrompt(string $prompt, Request $request, string $category, float $tileSize): Response
    {
        if (! app(AiSettings::class)->configured()) {
            throw new ToolError('OpenRouter is not configured: ask the user to add an OpenRouter API key in the studio under Settings → AI. (A material can also be made from an existing image with image_path.)');
        }
        if (mb_strlen($prompt) > 1000) {
            throw new ToolError('prompt is limited to 1000 characters.');
        }

        $materials = app(MaterialController::class)->queueGeneration([
            'prompt' => $prompt,
            'name' => $request->get('name') ? Str::limit((string) $request->get('name'), 100, '') : null,
            'category' => $category,
            'tile_size' => $tileSize,
            'variants' => max(1, min(4, (int) ($request->get('variants') ?? 1))),
            'resolution' => in_array($request->get('resolution'), AiSettings::RESOLUTIONS, true) ? $request->get('resolution') : null,
        ], (bool) $request->get('enhance'));

        return $this->json([
            'materials' => array_map(fn (Material $m) => GetAssetStatus::materialSummary($m->refresh()), $materials),
            'next' => 'Generation runs in the background (it needs the queue worker, which `composer dev` starts). Poll get_asset_status (type material) every 15–30 s until "ready", then assign it with update_terrain_layer material_id.',
        ]);
    }

    private function fromImage(string $ref, Request $request, string $category, float $tileSize): Response
    {
        $image = app(AgentImages::class)->read($ref);
        $name = trim((string) $request->get('name', '')) ?: Str::headline(pathinfo($image['name'], PATHINFO_FILENAME));
        $material = app(MaterialLibrary::class)->create([
            'name' => Str::limit($name, 100, ''),
            'category' => $category,
            'tile_size' => $tileSize,
            'source' => 'upload',
            'status' => 'processing',
        ]);

        $limit = ini_get('memory_limit');
        if ($limit !== false && $limit !== '-1' && ini_parse_quantity($limit) < 1024 ** 3) {
            ini_set('memory_limit', '1G');
        }

        try {
            app(UploadSource::class)->import($material, [['name' => 'albedo.'.pathinfo($image['name'], PATHINFO_EXTENSION), 'bytes' => $image['bytes']]], [
                'make_seamless' => $request->get('make_seamless') !== false,
            ]);
        } catch (Throwable $e) {
            report($e);
            $material->delete();
            throw new ToolError('Creating the material failed: '.$e->getMessage());
        }

        return $this->json(['material' => GetAssetStatus::materialSummary($material->refresh())]);
    }
}
