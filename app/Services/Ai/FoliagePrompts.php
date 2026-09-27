<?php

namespace App\Services\Ai;

use App\Enums\FoliageKind;

/**
 * Prompt templates for AI foliage "cards": one isolated plant, side view, which the browser bakes
 * into crossed alpha-tested quads (the classic game technique for grass, flowers, shrubs and far trees).
 */
class FoliagePrompts
{
    public const KIND_HINTS = [
        'grass' => 'a single dense clump of grass blades',
        'flower' => 'a single small clump of wildflowers with stems and leaves',
        'reed' => 'a single clump of tall reeds / rushes',
        'bush' => 'a single bush / shrub',
        'broadleaf' => 'a single deciduous broadleaf tree with its whole trunk and crown',
        'conifer' => 'a single coniferous tree with its whole trunk and crown',
        'palm' => 'a single palm tree with its whole trunk and fronds',
        'rock' => 'a single rock',
    ];

    /** Aspect ratio of the image per kind (tall subjects get portrait frames). */
    public const ASPECT = [
        'grass' => '1:1', 'flower' => '1:1', 'reed' => '2:3', 'bush' => '1:1',
        'broadleaf' => '3:4', 'conifer' => '2:3', 'palm' => '2:3', 'rock' => '1:1',
    ];

    /**
     * @param  int  $style  0 = photoreal … 100 = stylized
     */
    /** Target triangle budgets for generated 3D models (the browser bake reduces further for LODs). */
    public const MESHY_POLYCOUNT = [
        'conifer' => 30000, 'broadleaf' => 30000, 'palm' => 20000, 'bush' => 12000,
        'grass' => 4000, 'flower' => 4000, 'reed' => 4000, 'rock' => 8000,
    ];

    /**
     * Flat background colour for image models without transparency: magenta, unless the plant itself
     * is pink / purple / red, then cyan. (White leaves bright fringes on thin leaves.)
     */
    public static function keyColor(string $userPrompt): string
    {
        return preg_match('/\b(pink|purple|magenta|violet|lilac|lavender|heather|fuchsia|mauve|red|crimson|rose|orchid|cherry blossom|bougainvillea)\b/i', $userPrompt) === 1
            ? '#00ffff'
            : '#ff00ff';
    }

    public function cardPrompt(string $userPrompt, FoliageKind $kind, int $style, bool $transparent, string $keyColor = '#ff00ff'): string
    {
        $subject = self::KIND_HINTS[$kind->value];
        $look = self::styleWords($style);
        $colour = $keyColor === '#00ffff' ? 'pure cyan (#00FFFF)' : 'pure magenta (#FF00FF)';
        $background = $transparent
            ? 'transparent background'
            : "isolated on a perfectly flat, uniform {$colour} chroma-key background with nothing else in the image; the plant itself contains no {$colour}";

        return trim("{$subject}: {$userPrompt}. {$look}. Game foliage sprite: the complete plant is fully visible and centred, "
            .'standing upright, its base touching the bottom edge of the frame, straight side view at eye level (orthographic, no '
            .'perspective), soft even overcast daylight, no cast shadow, no ground, no soil patch, no pot, no text, no border, '
            ."crisp clean silhouette edges, {$background}.");
    }

    /**
     * Prompt for Meshy text to 3D (max 600 characters).
     */
    public function meshyPrompt(string $userPrompt, FoliageKind $kind, int $style): string
    {
        $subject = self::KIND_HINTS[$kind->value];
        $look = match (true) {
            $style <= 35 => 'realistic, natural proportions and colours',
            $style <= 65 => 'semi-stylized game art',
            default => 'stylized hand-painted game art, simplified shapes',
        };

        return mb_substr("{$subject}: {$userPrompt}. {$look}. A single complete game asset standing upright on its own base point, "
            .'no ground plane, no pot, no pedestal, no other objects.', 0, 600);
    }

    /**
     * Concept image prompt for Meshy image to 3D: one plant, full view, neutral background.
     */
    public function conceptPrompt(string $userPrompt, FoliageKind $kind, int $style): string
    {
        return trim(self::KIND_HINTS[$kind->value].": {$userPrompt}. ".self::styleWords($style).'. A single complete specimen, fully visible and centred, '
            .'three-quarter side view, soft even studio lighting, plain light grey background, no ground, no pot, no text.');
    }

    public static function styleWords(int $style): string
    {
        return match (true) {
            $style <= 20 => 'Photorealistic botanical reference photograph, natural colours, fine leaf detail',
            $style <= 45 => 'Realistic game art, natural colours with slightly cleaner shapes',
            $style <= 70 => 'Semi-stylized hand-painted game art, readable leaf clusters, gently saturated colours',
            default => 'Stylized hand-painted game art in a cozy illustrated style, simplified chunky leaf clusters, vibrant colours',
        };
    }
}
