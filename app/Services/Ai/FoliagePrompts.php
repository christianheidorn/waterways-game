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
    public function cardPrompt(string $userPrompt, FoliageKind $kind, int $style, bool $transparent): string
    {
        $subject = self::KIND_HINTS[$kind->value];
        $look = self::styleWords($style);
        $background = $transparent
            ? 'transparent background'
            : 'isolated on a perfectly flat, uniform pure white (#FFFFFF) background with nothing else in the image';

        return trim("{$subject}: {$userPrompt}. {$look}. Game foliage sprite: the complete plant is fully visible and centred, "
            .'standing upright, its base touching the bottom edge of the frame, straight side view at eye level (orthographic, no '
            .'perspective), soft even overcast daylight, no cast shadow, no ground, no soil patch, no pot, no text, no border, '
            ."crisp clean silhouette edges, {$background}.");
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
