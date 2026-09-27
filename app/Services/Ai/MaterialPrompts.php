<?php

namespace App\Services\Ai;

use App\Models\Material;
use App\Support\AiSettings;
use Illuminate\Support\Str;
use Throwable;

/**
 * Prompt templates for AI texture generation (and optional prompt enhancement via the text model).
 */
class MaterialPrompts
{
    public const CATEGORY_HINTS = [
        'grass' => 'dense natural grass seen from directly above, varied blade directions, subtle green and straw tones',
        'forest' => 'forest floor seen from directly above, fallen leaves, pine needles, twigs and moss on dark soil',
        'soil' => 'bare earth and dirt seen from directly above, small clods and grains',
        'rock' => 'natural rock surface seen head-on, cracks and weathered facets, uniform scale',
        'gravel' => 'loose gravel and small pebbles seen from directly above, evenly distributed',
        'sand' => 'fine sand seen from directly above, subtle wind ripples',
        'mud' => 'wet mud seen from directly above, soft glistening surface with shallow puddles',
        'snow' => 'fresh snow surface seen from directly above, soft crystals and gentle undulations',
        'field' => 'farmland soil seen from directly above, crop stubble or furrows',
        'urban' => 'paved ground seen from directly above, uniform wear',
        'other' => 'natural ground surface seen from directly above',
    ];

    public function __construct(
        private readonly OpenRouterClient $client,
        private readonly AiSettings $settings,
    ) {}

    /**
     * The final prompt sent to the image model.
     */
    public function texturePrompt(string $userPrompt, string $category, bool $edit = false): string
    {
        $hint = self::CATEGORY_HINTS[$category] ?? self::CATEGORY_HINTS['other'];
        $userPrompt = trim($userPrompt);

        $rules = 'seamless tileable PBR albedo texture, orthographic top-down, flat even diffuse lighting, no shadows, '
            .'no perspective, no objects, no text, fills the whole frame, photorealistic';

        if ($edit) {
            return "Edit the attached ground texture: {$userPrompt}. Keep it a {$rules}, same scale and viewpoint as the original, {$hint}.";
        }

        return "{$rules}, {$hint}, {$userPrompt}";
    }

    /**
     * Rewrite a short user prompt into a richer texture description (text model). Falls back to the
     * original prompt when the model fails.
     */
    public function enhance(string $prompt, string $category): string
    {
        try {
            $json = $this->client->chatJson(
                $this->settings->textModel(),
                'You write prompts for an image model that generates seamless, tileable, top-down PBR ground textures '
                .'for a realistic open-world game terrain. Rewrite the user\'s idea into one vivid but concise description '
                .'(max 60 words) of the surface material only: composition, colours, grain size, variation and scale. '
                .'Never mention cameras, lighting setups, shadows, objects, people, text or perspective. '
                .'Answer with JSON only: {"prompt": "..."}',
                'Category: '.(Material::CATEGORIES[$category] ?? $category)."\nIdea: ".$prompt,
                400,
            );
        } catch (AiNotConfiguredException $e) {
            throw $e;
        } catch (Throwable $e) {
            report($e);

            return $prompt;
        }

        $enhanced = is_string($json['prompt'] ?? null) ? trim($json['prompt']) : '';

        return $enhanced !== '' ? Str::limit($enhanced, 1000, '') : $prompt;
    }

    /**
     * Short material name from a prompt, e.g. "Mossy forest floor with pine needles".
     */
    public static function summary(string $prompt, int $length = 40): string
    {
        $clean = trim(preg_replace('/\s+/', ' ', $prompt) ?? $prompt);

        return Str::ucfirst(Str::limit($clean, $length, '…')) ?: 'AI material';
    }
}
