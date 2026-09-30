<?php

namespace App\Mcp\Tools;

use App\Enums\FoliageKind;
use App\Jobs\GenerateMeshyProp;
use App\Mcp\Assets\AgentImages;
use App\Mcp\ToolError;
use App\Models\PropModel;
use App\Services\Ai\MaterialPrompts;
use App\Services\Foliage\FoliageAssetQueue;
use App\Support\AiSettings;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Str;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;
use Laravel\Mcp\Server\Tools\Annotations\IsOpenWorld;
use Throwable;

#[Name('generate_model')]
#[Description(<<<'TXT'
Generates a textured 3D model with Meshy (uses the project's Meshy key and credits; a model takes about 2–6 minutes), as a prop (kind "prop") or a foliage asset (kind "foliage"). Runs in the background (needs the queue worker that `composer dev` starts): returns the id at once; poll get_asset_status every 30 s.
Engines: "meshy_text" (default: from the prompt), "meshy_image" (props: from image_path, e.g. a reference drawn with generate_image purpose "reference"; foliage: the OpenRouter image model paints a concept first), "card" (foliage only, not rocks: one OpenRouter image baked into crossed cards; cheap, good for grass, flowers, small plants; needs target_height).
Trees, bushes and plants should be kind "foliage" (LODs, impostors, GPU culling, ground cover); props are for buildings, structures and unique objects and are remeshed to about 15k triangles.
Finished props are ready to place. Finished foliage assets are "awaiting_bake": call bake_foliage_asset (needs an open editor) to make them usable.
For full control over a model's shape, build it in Blender (Blender MCP) and use import_model instead.
TXT)]
#[IsOpenWorld]
class GenerateModel extends WaterwaysTool
{
    public const ENGINES = ['meshy_text', 'meshy_image', 'card'];

    public function schema(JsonSchema $schema): array
    {
        return [
            'kind' => $schema->string()->enum(['prop', 'foliage'])->required(),
            'prompt' => $schema->string()->description('What to model, e.g. "small wooden fishing hut on stilts".')->required(),
            'name' => $schema->string()->description('Library name (default: from the prompt).'),
            'engine' => $schema->string()->enum(self::ENGINES)->description('Default "meshy_text".'),
            'image_path' => $schema->string()->description('Props with meshy_image: the image to model from (agent-images/… path or a local image file).'),
            'style' => $schema->string()->enum(['realistic', 'stylized'])->description('Default realistic.'),
            'target_height' => $schema->number()->min(0.05)->max(80)->description('Real-world height in metres (the game scales the model to it).'),
            'category' => $schema->string()->enum(array_keys(PropModel::CATEGORIES))->description('Props: library category (default "other").'),
            'foliage_kind' => $schema->string()->enum(array_column(FoliageKind::cases(), 'value'))->description('Foliage: plant kind (required for foliage).'),
        ];
    }

    protected function run(Request $request): Response
    {
        $prompt = trim((string) $request->get('prompt', ''));
        if ($prompt === '' || mb_strlen($prompt) > 600) {
            throw new ToolError('prompt is required (at most 600 characters).');
        }
        $engine = (string) ($request->get('engine') ?? 'meshy_text');
        if (! in_array($engine, self::ENGINES, true)) {
            throw new ToolError('engine must be one of: '.implode(', ', self::ENGINES).'.');
        }
        $height = $request->get('target_height');
        if ($height !== null && (! is_numeric($height) || $height < 0.05 || $height > 80)) {
            throw new ToolError('target_height must be between 0.05 and 80 metres.');
        }
        $height = $height !== null ? (float) $height : null;
        $style = $request->get('style') === 'stylized' ? 80 : 20;
        $name = Str::limit(trim((string) $request->get('name', '')) ?: MaterialPrompts::summary($prompt, 36), 80, '');

        return $request->get('kind') === 'foliage'
            ? $this->foliage($request, $engine, $prompt, $name, $style, $height)
            : $this->prop($request, $engine, $prompt, $name, $style, $height);
    }

    private function prop(Request $request, string $engine, string $prompt, string $name, int $style, ?float $height): Response
    {
        if ($engine === 'card') {
            throw new ToolError('Props are 3D models: use engine meshy_text or meshy_image.');
        }
        $this->requireMeshy();
        $category = (string) ($request->get('category') ?? 'other');
        if (! array_key_exists($category, PropModel::CATEGORIES)) {
            throw new ToolError('Unknown category "'.$category.'".');
        }

        $imagePath = null;
        if ($engine === 'meshy_image') {
            $ref = trim((string) $request->get('image_path', ''));
            if ($ref === '') {
                throw new ToolError('meshy_image needs image_path: draw one with generate_image (purpose "reference") first.');
            }
            // Checked now, so a bad path fails here instead of in the background.
            app(AgentImages::class)->read($ref);
            $imagePath = $ref;
        }

        $prop = PropModel::query()->create([
            'name' => $name,
            'category' => $category,
            'source' => 'meshy',
            'status' => 'processing',
            'status_message' => 'Queued for Meshy…',
            'target_height' => $height,
            'prompt' => $prompt,
        ]);

        $this->dispatch(new GenerateMeshyProp($prop, [
            'route' => $engine === 'meshy_image' ? 'image' : 'text',
            'prompt' => $prompt,
            'style' => $style,
            'image_path' => $imagePath,
        ]));

        return $this->json([
            'prop_model' => GetAssetStatus::propSummary($prop->refresh()),
            'next' => 'Poll get_asset_status (type prop_model, id '.$prop->id.') every 30 s until "ready", then place it with place_props.',
        ]);
    }

    private function foliage(Request $request, string $engine, string $prompt, string $name, int $style, ?float $height): Response
    {
        $kind = FoliageKind::tryFrom((string) $request->get('foliage_kind'))
            ?? throw new ToolError('foliage_kind is required for foliage: one of '.implode(', ', array_column(FoliageKind::cases(), 'value')).'.');
        $ai = app(AiSettings::class);

        if ($engine === 'card') {
            if ($kind === FoliageKind::Rock) {
                throw new ToolError('Rocks cannot be flat cards: use engine meshy_text.');
            }
            if ($height === null) {
                throw new ToolError('Cards need target_height (metres).');
            }
        }
        if ($engine !== 'meshy_text' && ! $ai->configured()) {
            throw new ToolError('OpenRouter is not configured: ask the user to add an OpenRouter API key in the studio under Settings → AI.');
        }
        if ($engine !== 'card') {
            $this->requireMeshy();
        }

        $queue = app(FoliageAssetQueue::class);
        $asset = $engine === 'card'
            ? $queue->generate($name, $kind, $style, (float) $height, $prompt)
            : $queue->meshy($name, $kind, $style, $height, $prompt, $engine === 'meshy_image' ? 'image' : 'text');

        return $this->json([
            'foliage_asset' => GetAssetStatus::foliageSummary($asset),
            'next' => 'Poll get_asset_status (type foliage_asset, id '.$asset->id.') every 30 s. When it is "awaiting_bake", call bake_foliage_asset; when "ready", use it with save_foliage_type foliage_asset_id '.$asset->id.'.',
        ]);
    }

    private function requireMeshy(): void
    {
        if (! app(AiSettings::class)->meshyConfigured()) {
            throw new ToolError('Meshy is not configured: ask the user to add a Meshy API key in the studio under Settings → AI. (Or build the model in Blender and bring it in with import_model.)');
        }
    }

    private function dispatch(object $job): void
    {
        try {
            dispatch($job);
        } catch (Throwable $e) {
            // Only reachable with the sync queue: the job already marked the model as failed.
            report($e);
        }
    }
}
