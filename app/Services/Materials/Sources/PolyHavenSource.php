<?php

namespace App\Services\Materials\Sources;

use App\Models\Material;
use App\Services\Materials\MaterialBuilder;
use App\Services\Materials\MaterialLibrary;
use App\Services\Materials\TextureProcessor;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use RuntimeException;

/**
 * CC0 textures from Poly Haven (https://polyhaven.com, API docs: https://api.polyhaven.com).
 */
class PolyHavenSource
{
    public const API = 'https://api.polyhaven.com';

    public const PER_PAGE = 24;

    /** Our library categories → Poly Haven words searched in names / tags / categories. */
    private const CATEGORY_TERMS = [
        'grass' => ['grass', 'lawn', 'meadow'],
        'forest' => ['forest', 'forrest', 'leaves', 'leaf', 'moss', 'needles'],
        'soil' => ['soil', 'dirt', 'ground', 'earth'],
        'rock' => ['rock', 'cliff', 'stone', 'boulder'],
        'gravel' => ['gravel', 'pebble', 'pebbles'],
        'sand' => ['sand', 'beach', 'dune'],
        'mud' => ['mud', 'swamp', 'clay'],
        'snow' => ['snow', 'ice'],
        'field' => ['field', 'crop', 'farm', 'dry'],
        'urban' => ['man made', 'asphalt', 'concrete', 'road', 'cobblestone', 'brick'],
    ];

    public function __construct(
        private readonly MaterialBuilder $builder,
        private readonly TextureProcessor $processor,
    ) {}

    /**
     * All texture assets keyed by id (cached for an hour).
     *
     * @return array<string, array<string, mixed>>
     */
    public function assets(?string $phCategory = null): array
    {
        $key = 'polyhaven.textures'.($phCategory ? '.'.Str::slug($phCategory) : '');

        return Cache::remember($key, 3600, function () use ($phCategory) {
            $query = ['t' => 'textures'];
            if ($phCategory) {
                $query['categories'] = $phCategory;
            }

            $json = Http::timeout(30)->acceptJson()->get(self::API.'/assets', $query)->throw()->json();

            return is_array($json) ? $json : [];
        });
    }

    /**
     * @return array{items: list<array<string, mixed>>, page: int, has_more: bool}
     */
    public function search(?string $query, ?string $category, int $page = 1): array
    {
        $page = max(1, $page);
        $terms = [];
        $phCategory = null;

        if ($category !== null && $category !== '') {
            if (isset(self::CATEGORY_TERMS[$category])) {
                $terms = self::CATEGORY_TERMS[$category];
            } else {
                $phCategory = $category;
            }
        }

        $words = array_values(array_filter(preg_split('/\s+/', mb_strtolower(trim((string) $query))) ?: []));

        $assets = collect($this->assets($phCategory))
            ->filter(function ($asset, $ref) use ($words, $terms) {
                if (! is_array($asset)) {
                    return false;
                }

                $haystack = mb_strtolower($ref.' '.($asset['name'] ?? '').' '.implode(' ', $asset['tags'] ?? []).' '.implode(' ', $asset['categories'] ?? []));

                foreach ($words as $word) {
                    if (! str_contains($haystack, $word)) {
                        return false;
                    }
                }

                if ($terms !== []) {
                    foreach ($terms as $term) {
                        if (str_contains($haystack, $term)) {
                            return true;
                        }
                    }

                    return false;
                }

                return true;
            })
            ->sortByDesc(fn ($asset) => (int) ($asset['download_count'] ?? 0));

        $total = $assets->count();
        $slice = $assets->slice(($page - 1) * self::PER_PAGE, self::PER_PAGE);
        $imported = Material::query()->where('source', 'polyhaven')->whereIn('source_ref', $slice->keys()->all())->pluck('id', 'source_ref');

        $items = $slice->map(fn ($asset, $ref) => [
            'ref' => (string) $ref,
            'name' => (string) ($asset['name'] ?? $ref),
            'thumbnail_url' => "https://cdn.polyhaven.com/asset_img/thumbs/{$ref}.png?width=256&height=256",
            'categories' => array_values($asset['categories'] ?? []),
            'tags' => array_values($asset['tags'] ?? []),
            'author' => implode(', ', array_keys($asset['authors'] ?? [])),
            'license' => 'CC0',
            'source_url' => "https://polyhaven.com/a/{$ref}",
            'max_resolution' => $asset['max_resolution'][0] ?? null,
            'tile_size' => $this->tileSize($asset),
            'suggested_category' => MaterialLibrary::guessCategory([(string) $ref, (string) ($asset['name'] ?? ''), ...($asset['tags'] ?? []), ...($asset['categories'] ?? [])]),
            'imported_material_id' => $imported[$ref] ?? null,
        ])->values()->all();

        return ['items' => $items, 'page' => $page, 'has_more' => $page * self::PER_PAGE < $total];
    }

    public function exists(string $ref): bool
    {
        return array_key_exists($ref, $this->assets());
    }

    /**
     * Download the maps of $ref at $resolution ('1k'|'2k'|'4k') and build the material.
     *
     * @param  array{name?: string|null, category?: string|null}  $overrides
     */
    public function import(Material $material, string $ref, string $resolution = '1k', array $overrides = []): Material
    {
        $resolution = strtolower($resolution);
        $info = Http::timeout(30)->acceptJson()->get(self::API.'/info/'.rawurlencode($ref));
        if ($info->notFound()) {
            throw new RuntimeException("Poly Haven has no asset \"{$ref}\".");
        }
        $info = $info->throw()->json();

        $files = Http::timeout(30)->acceptJson()->get(self::API.'/files/'.rawurlencode($ref))->throw()->json();

        if (! is_array($info) || ! is_array($files)) {
            throw new RuntimeException("Poly Haven returned no data for \"{$ref}\".");
        }

        $url = function (string $key) use ($files, $resolution): ?string {
            $variants = $files[$key][$resolution] ?? null;
            if (! is_array($variants)) {
                // Fall back to the nearest smaller resolution.
                foreach (['4k', '2k', '1k'] as $res) {
                    if (MaterialBuilder::sizeFor($res) <= MaterialBuilder::sizeFor($resolution) && isset($files[$key][$res])) {
                        $variants = $files[$key][$res];
                        break;
                    }
                }
            }

            return $variants['jpg']['url'] ?? $variants['png']['url'] ?? null;
        };

        $diffuse = $url('Diffuse') ?? throw new RuntimeException("Poly Haven asset \"{$ref}\" has no colour map at {$resolution}.");

        $maps = ['albedo' => $this->download($diffuse)];

        if ($normal = $url('nor_gl')) {
            $maps['normal'] = $this->download($normal);
        } elseif ($normal = $url('nor_dx')) {
            $maps['normal'] = $this->processor->flipNormalGreen($this->processor->decode($this->download($normal)));
        }

        foreach (['roughness' => 'Rough', 'ao' => 'AO', 'height' => 'Displacement'] as $map => $key) {
            if ($u = $url($key)) {
                $maps[$map] = $this->download($u);
            }
        }

        if ((! isset($maps['ao']) || ! isset($maps['roughness'])) && ($arm = $url('arm'))) {
            [$ao, $rough] = $this->processor->splitChannels($this->processor->decode($this->download($arm)));
            $maps['ao'] ??= $ao;
            $maps['roughness'] ??= $rough;
        }

        $tags = array_values(array_unique([...($info['tags'] ?? []), ...($info['categories'] ?? [])]));
        $name = trim((string) ($overrides['name'] ?? '')) ?: (string) ($info['name'] ?? Str::headline($ref));

        return $this->builder->build($material, $maps, MaterialBuilder::sizeFor($resolution), [], [
            'name' => $name,
            'category' => MaterialLibrary::validCategory($overrides['category'] ?? null, MaterialLibrary::guessCategory([$ref, $name, ...$tags])),
            'source' => 'polyhaven',
            'source_ref' => $ref,
            'source_url' => "https://polyhaven.com/a/{$ref}",
            'author' => implode(', ', array_keys($info['authors'] ?? [])) ?: null,
            'license' => 'CC0',
            'tags' => array_slice($tags, 0, 20),
            'tile_size' => $this->tileSize($info),
        ]);
    }

    /**
     * Real-world width of one repeat in metres (Poly Haven "dimensions" are millimetres).
     *
     * @param  array<string, mixed>  $asset
     */
    public function tileSize(array $asset): float
    {
        $mm = $asset['dimensions'][0] ?? null;

        return is_numeric($mm) && $mm > 0 ? round(min(100, max(0.1, $mm / 1000)), 2) : 2.0;
    }

    private function download(string $url): string
    {
        $response = Http::timeout(180)->get($url);

        if (! $response->successful()) {
            throw new RuntimeException("Download failed (HTTP {$response->status()}): {$url}");
        }

        return $response->body();
    }
}
