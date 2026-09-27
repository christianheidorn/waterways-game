<?php

namespace App\Services\Materials;

use App\Models\Material;
use Illuminate\Support\Str;

/**
 * Creating materials (unique slugs), guessing categories and duplicating.
 */
class MaterialLibrary
{
    /** Keywords per category, used to guess a category from names / tags. Strongest first. */
    public const CATEGORY_KEYWORDS = [
        'snow' => ['snow', 'ice', 'glacier', 'frost'],
        'sand' => ['sand', 'beach', 'dune', 'desert'],
        'mud' => ['mud', 'swamp', 'marsh', 'bog', 'clay', 'wet'],
        'gravel' => ['gravel', 'pebble', 'pebbles', 'scree', 'shingle'],
        'forest' => ['forest', 'forrest', 'leaves', 'leaf', 'litter', 'needles', 'moss', 'bark'],
        'grass' => ['grass', 'lawn', 'meadow', 'turf'],
        'field' => ['field', 'crop', 'farm', 'wheat', 'plough', 'plow'],
        'urban' => ['asphalt', 'concrete', 'road', 'pavement', 'cobblestone', 'brick', 'tiles', 'man made', 'paving'],
        'rock' => ['rock', 'cliff', 'stone', 'granite', 'limestone', 'boulder', 'sandstone', 'marble'],
        'soil' => ['soil', 'dirt', 'ground', 'earth', 'dry'],
    ];

    /**
     * @param  array<string, mixed>  $attributes
     */
    public function create(array $attributes): Material
    {
        $name = Str::limit(trim((string) ($attributes['name'] ?? 'Material')) ?: 'Material', 120, '');

        return Material::query()->create([
            'category' => 'other',
            'status' => 'processing',
            ...$attributes,
            'name' => $name,
            'slug' => $this->uniqueSlug($name),
        ]);
    }

    public function uniqueSlug(string $name): string
    {
        $base = Str::slug($name) ?: 'material';
        $base = Str::limit($base, 80, '');
        $slug = $base;
        $i = 2;

        while (Material::query()->where('slug', $slug)->exists()) {
            $slug = "{$base}-{$i}";
            $i++;
        }

        return $slug;
    }

    /**
     * @param  list<string>  $words
     */
    public static function guessCategory(array $words, string $fallback = 'other'): string
    {
        // Earlier words (id, name) win over later ones (tags, categories).
        foreach ($words as $word) {
            $haystack = ' '.mb_strtolower(str_replace(['_', '-'], ' ', (string) $word)).' ';

            foreach (self::CATEGORY_KEYWORDS as $category => $keywords) {
                foreach ($keywords as $keyword) {
                    // Whole words, allowing plural / adjective endings ("rocks", "mossy").
                    if (preg_match('/\\b'.preg_quote($keyword, '/').'(s|es|y)?\\b/u', $haystack) === 1) {
                        return $category;
                    }
                }
            }
        }

        return $fallback;
    }

    public static function validCategory(?string $category, string $fallback = 'other'): string
    {
        return $category !== null && array_key_exists($category, Material::CATEGORIES) ? $category : $fallback;
    }

    public function duplicate(Material $material, MaterialStorage $storage): Material
    {
        $copy = $this->create([
            ...collect($material->getAttributes())->except([
                'id', 'slug', 'created_at', 'updated_at', 'albedo_path', 'normal_path', 'roughness_path',
                'ao_path', 'height_path', 'thumbnail_path', 'tags', 'name',
            ])->all(),
            'name' => Str::limit($material->name, 110, '').' (copy)',
            'tags' => $material->tags,
        ]);

        $copy->forceFill($storage->copy($material, $copy))->save();

        return $copy;
    }

    /**
     * @return list<array{value: string, label: string}>
     */
    public static function categoryOptions(): array
    {
        return collect(Material::CATEGORIES)->map(fn ($label, $value) => ['value' => $value, 'label' => $label])->values()->all();
    }
}
