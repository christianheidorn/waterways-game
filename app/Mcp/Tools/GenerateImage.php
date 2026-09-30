<?php

namespace App\Mcp\Tools;

use App\Mcp\Assets\AgentImages;
use App\Mcp\ToolError;
use App\Services\Ai\AiNotConfiguredException;
use App\Services\Ai\MaterialPrompts;
use App\Services\Ai\OpenRouterClient;
use App\Services\Ai\OpenRouterException;
use App\Support\AiSettings;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\ResponseFactory;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;
use Laravel\Mcp\Server\Tools\Annotations\IsOpenWorld;

#[Name('generate_image')]
#[Description(<<<'TXT'
Generates an image with the project's OpenRouter image model (costs credits; uses the key configured in the studio). Returns the image and where it is stored (`path` agent-images/…, `url`, and `file`: the absolute path on this computer, e.g. for Blender MCP).
purpose adds suitable instructions: "free" (default: your prompt as is), "reference" (a concept / reference view of one object for 3D modelling), "texture" (a seamless top-down ground texture; for terrain use generate_material, which also builds the PBR maps), "sprite" (one isolated object on a plain or transparent background).
reference_images (up to 4: stored paths from earlier calls or local image files) guide or edit the result, when the model supports it.
TXT)]
#[IsOpenWorld]
class GenerateImage extends WaterwaysTool
{
    public const PURPOSES = ['free', 'reference', 'texture', 'sprite'];

    public const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'];

    /** Longest side of the copy returned to the agent (the stored file keeps the full size). */
    private const PREVIEW_SIZE = 1024;

    public function schema(JsonSchema $schema): array
    {
        return [
            'prompt' => $schema->string()->description('What to draw.')->required(),
            'purpose' => $schema->string()->enum(self::PURPOSES)->description('Default "free".'),
            'aspect_ratio' => $schema->string()->enum(self::ASPECT_RATIOS)->description('Default 1:1 (sent when the model supports it).'),
            'resolution' => $schema->string()->enum(AiSettings::RESOLUTIONS)->description('Default: the studio setting.'),
            'reference_images' => $schema->array()->items($schema->string())->description('Stored paths (agent-images/…) or local image files that guide / are edited.'),
            'model' => $schema->string()->description('OpenRouter image model id (default: the studio setting).'),
        ];
    }

    protected function run(Request $request): Response|ResponseFactory
    {
        $settings = app(AiSettings::class);
        if (! $settings->configured()) {
            throw new ToolError('OpenRouter is not configured: ask the user to add an OpenRouter API key in the studio under Settings → AI.');
        }

        $prompt = trim((string) $request->get('prompt', ''));
        if ($prompt === '' || mb_strlen($prompt) > 2000) {
            throw new ToolError('prompt is required (at most 2000 characters).');
        }
        $purpose = (string) ($request->get('purpose') ?? 'free');
        if (! in_array($purpose, self::PURPOSES, true)) {
            throw new ToolError('purpose must be one of: '.implode(', ', self::PURPOSES).'.');
        }
        $model = (string) ($request->get('model') ?? '') ?: $settings->imageModel();
        if (preg_match(AiSettings::MODEL_PATTERN, $model) !== 1) {
            throw new ToolError("\"{$model}\" is not an OpenRouter model id (like google/gemini-3.1-flash-image).");
        }

        $images = app(AgentImages::class);
        $references = array_map(function (string $ref) use ($images) {
            $image = $images->read($ref);

            return 'data:'.$image['media_type'].';base64,'.base64_encode($image['bytes']);
        }, array_slice(array_values(array_filter(array_map('strval', (array) $request->get('reference_images', [])))), 0, 4));

        $finalPrompt = $this->prompt($prompt, $purpose, $references !== []);

        try {
            $image = app(OpenRouterClient::class)->generateImage($model, $finalPrompt, [
                'aspect_ratio' => in_array($request->get('aspect_ratio'), self::ASPECT_RATIOS, true) ? $request->get('aspect_ratio') : '1:1',
                'resolution' => in_array($request->get('resolution'), AiSettings::RESOLUTIONS, true) ? $request->get('resolution') : $settings->imageResolution(),
                'output_format' => 'png',
                'background' => $purpose === 'sprite' ? 'transparent' : null,
                'n' => 1,
            ], $references);
        } catch (AiNotConfiguredException) {
            throw new ToolError('OpenRouter is not configured: ask the user to add an OpenRouter API key in the studio under Settings → AI.');
        } catch (OpenRouterException $e) {
            throw new ToolError('Image generation failed: '.$e->getMessage());
        }

        $stored = $images->store($image['bytes'], $image['media_type']);
        [$preview, $previewType] = $this->preview($image['bytes'], $image['media_type']);

        return Response::make([
            Response::image($preview, $previewType),
            Response::text(json_encode([
                ...$stored,
                'media_type' => $image['media_type'],
                'model' => $model,
                'cost_usd' => $image['cost'],
                'prompt_used' => $finalPrompt,
                'reuse' => 'Pass `path` as reference_images to refine it, or as image_path to generate_material to make a terrain material from it.',
            ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)),
        ]);
    }

    private function prompt(string $prompt, string $purpose, bool $hasReferences): string
    {
        return match ($purpose) {
            'reference' => "Reference image for 3D modelling: {$prompt}. One complete object, fully visible and centred, three-quarter view, soft even studio lighting, plain light grey background, no text.",
            'texture' => app(MaterialPrompts::class)->texturePrompt($prompt, 'other', edit: $hasReferences),
            'sprite' => "{$prompt}. A single isolated subject, fully visible and centred, on a transparent (or plain flat white) background, no ground shadow, no text.",
            default => $prompt,
        };
    }

    /**
     * A smaller JPEG copy for the agent when GD is available (keeps the MCP message small).
     *
     * @return array{string, string}
     */
    private function preview(string $bytes, string $mediaType): array
    {
        if (! function_exists('imagecreatefromstring') || ! function_exists('imagejpeg')) {
            return [$bytes, $mediaType];
        }

        $image = @imagecreatefromstring($bytes);
        if ($image === false) {
            return [$bytes, $mediaType];
        }

        $width = imagesx($image);
        $height = imagesy($image);
        $scale = min(1, self::PREVIEW_SIZE / max($width, $height));
        if ($scale >= 1 && strlen($bytes) < 1_500_000) {
            return [$bytes, $mediaType];
        }

        $w = max(1, (int) round($width * $scale));
        $h = max(1, (int) round($height * $scale));
        $small = imagecreatetruecolor($w, $h);
        // Transparent areas show as white, like the studio's previews.
        imagefill($small, 0, 0, (int) imagecolorallocate($small, 255, 255, 255));
        imagecopyresampled($small, $image, 0, 0, 0, 0, $w, $h, $width, $height);
        ob_start();
        imagejpeg($small, null, 85);

        return [(string) ob_get_clean(), 'image/jpeg'];
    }
}
