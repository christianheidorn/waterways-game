<?php

namespace App\Services\Foliage;

use App\Enums\FoliageKind;
use App\Models\FoliageAsset;
use Illuminate\Support\Str;

/**
 * Creating foliage assets and guessing their kind / real-world size.
 */
class FoliageLibrary
{
    /** Keywords per kind, strongest first. */
    public const KIND_KEYWORDS = [
        // Dead wood never sways in the wind: treat it like rocks (static props).
        'rock' => ['rock', 'boulder', 'stone', 'cliff', 'pebble', 'mountainside', 'coast line', 'coastline', 'stump', 'log', 'trunk', 'debris', 'branch', 'root'],
        'palm' => ['palm', 'coconut', 'date palm'],
        'conifer' => ['pine', 'fir', 'spruce', 'conifer', 'cedar', 'larch', 'cypress', 'juniper', 'needles', 'coniferous', 'evergreen'],
        'reed' => ['reed', 'cattail', 'bulrush', 'rush', 'sedge', 'papyrus', 'bamboo'],
        'grass' => ['grass', 'lawn', 'meadow', 'bermuda', 'weed', 'clover', 'moss'],
        'flower' => ['flower', 'floral', 'blossom', 'daisy', 'dandelion', 'tulip', 'poppy', 'wildflower', 'lavender', 'celandine', 'periwinkle'],
        'broadleaf' => ['tree', 'oak', 'birch', 'maple', 'beech', 'willow', 'jacaranda', 'trunk', 'stump', 'quiver'],
        'bush' => ['bush', 'shrub', 'fern', 'plant', 'succulent', 'nettle', 'branch', 'root', 'sapling', 'hedge'],
    ];

    /** Typical real-world height (m) of each kind; also the natural size of the procedural meshes. */
    public const KIND_HEIGHT = [
        'conifer' => 14.0, 'broadleaf' => 11.0, 'palm' => 9.0, 'bush' => 1.5,
        'grass' => 0.6, 'flower' => 0.5, 'reed' => 1.6, 'rock' => 1.0,
    ];

    /** Natural height of the built-in procedural meshes per kind (scale 1). */
    public const PROCEDURAL_HEIGHT = [
        'conifer' => 13.0, 'broadleaf' => 11.5, 'palm' => 9.0, 'bush' => 1.7,
        'grass' => 0.5, 'flower' => 0.4, 'reed' => 1.4, 'rock' => 0.9,
    ];

    /**
     * @param  array<string, mixed>  $attributes
     */
    public function create(array $attributes): FoliageAsset
    {
        $name = Str::limit(trim((string) ($attributes['name'] ?? 'Foliage')) ?: 'Foliage', 80, '');

        return FoliageAsset::query()->create([
            'kind' => FoliageKind::Bush,
            'style' => 'realistic',
            'status' => 'queued',
            ...$attributes,
            'name' => $name,
        ]);
    }

    /**
     * @param  list<string>  $words
     */
    public static function guessKind(array $words): FoliageKind
    {
        return self::matchKind($words) ?? FoliageKind::Bush;
    }

    /**
     * @param  list<string>  $words
     */
    public static function matchKind(array $words): ?FoliageKind
    {
        $haystack = ' '.mb_strtolower(implode(' ', array_map(fn ($w) => str_replace(['_', '-'], ' ', (string) $w), $words))).' ';

        foreach (self::KIND_KEYWORDS as $kind => $keywords) {
            foreach ($keywords as $keyword) {
                if (preg_match('/\b'.preg_quote($keyword, '/').'s?\b/', $haystack)) {
                    return FoliageKind::from($kind);
                }
            }
        }

        return null;
    }

    /**
     * Kind of a catalogue model: its name decides first, then its categories, then its tags.
     *
     * @param  list<string>  $categories
     * @param  list<string>  $tags
     */
    public static function guessKindFromCatalogue(string $name, array $categories, array $tags): FoliageKind
    {
        if ($kind = self::matchKind([$name])) {
            return $kind;
        }

        $categories = array_map('strtolower', $categories);
        $tagKind = self::matchKind($tags);

        return match (true) {
            in_array('rocks', $categories, true) => FoliageKind::Rock,
            in_array('trees', $categories, true) => in_array($tagKind, [FoliageKind::Conifer, FoliageKind::Palm], true) ? $tagKind : FoliageKind::Broadleaf,
            in_array('flowers', $categories, true) => FoliageKind::Flower,
            in_array('grass', $categories, true) => FoliageKind::Grass,
            default => $tagKind === FoliageKind::Rock || $tagKind === FoliageKind::Reed ? $tagKind : FoliageKind::Bush,
        };
    }

    public static function validKind(mixed $value, FoliageKind $fallback): FoliageKind
    {
        return is_string($value) ? (FoliageKind::tryFrom($value) ?? $fallback) : $fallback;
    }

    public static function validStyle(mixed $value, string $fallback = 'realistic'): string
    {
        return is_string($value) && array_key_exists($value, FoliageAsset::STYLES) ? $value : $fallback;
    }

    /** Turn a file name like "Tree_Birch-02.glb" into "Tree Birch 02". */
    public static function nameFromFile(string $file): string
    {
        $name = pathinfo($file, PATHINFO_FILENAME);

        return Str::limit(Str::headline(preg_replace('/[_\-.]+/', ' ', $name) ?? $name) ?: 'Model', 80, '');
    }

    /** A relative path without traversal, or null. */
    public static function safeRelativePath(string $path): ?string
    {
        $parts = [];
        foreach (explode('/', str_replace('\\', '/', $path)) as $part) {
            if ($part === '' || $part === '.') {
                continue;
            }
            if ($part === '..' || str_contains($part, ':')) {
                return null;
            }
            $parts[] = $part;
        }

        return $parts === [] ? null : implode('/', $parts);
    }
}
