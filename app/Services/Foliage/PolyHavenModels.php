<?php

namespace App\Services\Foliage;

use App\Models\FoliageAsset;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use RuntimeException;

/**
 * CC0 plant, tree and rock models from Poly Haven (https://polyhaven.com/models, API https://api.polyhaven.com).
 *
 * Imports download the glTF (+ .bin + textures) unchanged; the browser then bakes LODs from it.
 */
class PolyHavenModels
{
    public const API = 'https://api.polyhaven.com';

    public const PER_PAGE = 24;

    /** Poly Haven model categories that contain foliage or rocks. */
    public const CATEGORIES = ['plants', 'trees', 'grass', 'flowers', 'rocks', 'ground cover', 'succulent'];

    /** Never offered: not vegetation / terrain props. */
    public const EXCLUDED_CATEGORIES = ['food', 'collection: moon', 'potted plants', 'wall decoration', 'decorative'];

    /** Models above this polycount are too heavy to bake in a browser (e.g. the 17M-triangle pine tree). */
    public const MAX_POLYCOUNT = 5_000_000;

    /** Refuse geometry downloads larger than this (bytes). */
    public const MAX_BIN_BYTES = 160 * 1024 * 1024;

    /**
     * Foliage / rock models keyed by ref (cached for an hour).
     *
     * @return array<string, array<string, mixed>>
     */
    public function catalogue(): array
    {
        return Cache::remember('polyhaven.foliage-models', 3600, function () {
            $json = Http::timeout(30)->withUserAgent('Waterways Creator Studio')->acceptJson()
                ->get(self::API.'/assets', ['t' => 'models'])->throw()->json();

            if (! is_array($json)) {
                return [];
            }

            return collect($json)->filter(function ($asset) {
                if (! is_array($asset)) {
                    return false;
                }
                $categories = $asset['categories'] ?? [];

                return array_intersect(self::CATEGORIES, $categories) !== []
                    && array_intersect(self::EXCLUDED_CATEGORIES, $categories) === [];
            })->all();
        });
    }

    /**
     * Compact summary of one catalogue entry.
     *
     * @param  array<string, mixed>  $asset
     * @return array<string, mixed>
     */
    public function summary(string $ref, array $asset): array
    {
        $polycount = (int) ($asset['polycount'] ?? 0);

        return [
            'ref' => $ref,
            'name' => (string) ($asset['name'] ?? Str::headline($ref)),
            'thumbnail_url' => "https://cdn.polyhaven.com/asset_img/thumbs/{$ref}.png?width=256&height=256",
            'categories' => array_values(array_filter($asset['categories'] ?? [], fn ($c) => ! str_starts_with((string) $c, 'collection'))),
            'tags' => array_values(array_slice($asset['tags'] ?? [], 0, 8)),
            'author' => implode(', ', array_keys($asset['authors'] ?? [])),
            'license' => 'CC0',
            'source_url' => "https://polyhaven.com/a/{$ref}",
            'polycount' => $polycount,
            'too_heavy' => $polycount > self::MAX_POLYCOUNT,
            'kind' => FoliageLibrary::guessKindFromCatalogue(
                (string) ($asset['name'] ?? $ref),
                array_values(array_filter($asset['categories'] ?? [], fn ($c) => ! str_starts_with((string) $c, 'collection'))),
                array_values($asset['tags'] ?? []),
            )->value,
        ];
    }

    /**
     * @return array{items: list<array<string, mixed>>, page: int, has_more: bool, total: int}
     */
    public function search(?string $query, ?string $kind, int $page = 1): array
    {
        $page = max(1, $page);
        $words = array_values(array_filter(preg_split('/\s+/', mb_strtolower(trim((string) $query))) ?: []));

        $items = collect($this->catalogue())
            ->map(fn ($asset, $ref) => [...$this->summary((string) $ref, $asset), 'downloads' => (int) ($asset['download_count'] ?? 0)])
            ->filter(function (array $item) use ($words, $kind) {
                if ($kind && $item['kind'] !== $kind) {
                    return false;
                }
                $haystack = mb_strtolower($item['ref'].' '.$item['name'].' '.implode(' ', $item['tags']).' '.implode(' ', $item['categories']));
                foreach ($words as $word) {
                    if (! str_contains($haystack, $word)) {
                        return false;
                    }
                }

                return true;
            })
            ->sortBy([fn ($a, $b) => $a['too_heavy'] <=> $b['too_heavy'], fn ($a, $b) => $b['downloads'] <=> $a['downloads']]);

        $total = $items->count();
        $slice = $items->slice(($page - 1) * self::PER_PAGE, self::PER_PAGE)->values();
        $imported = FoliageAsset::query()->where('source', 'polyhaven')->whereIn('source_ref', $slice->pluck('ref'))->pluck('id', 'source_ref');

        return [
            'items' => $slice->map(fn ($item) => [...$item, 'imported_asset_id' => $imported[$item['ref']] ?? null])->all(),
            'page' => $page,
            'has_more' => $page * self::PER_PAGE < $total,
            'total' => $total,
        ];
    }

    public function exists(string $ref): bool
    {
        return array_key_exists($ref, $this->catalogue());
    }

    /**
     * Download the glTF of $ref (1k textures) into the asset's source folder.
     */
    public function import(FoliageAsset $asset, string $ref, string $resolution = '1k'): FoliageAsset
    {
        $http = fn (int $timeout) => Http::timeout($timeout)->withUserAgent('Waterways Creator Studio');

        $info = $http(30)->acceptJson()->get(self::API.'/info/'.rawurlencode($ref));
        if ($info->notFound()) {
            throw new RuntimeException("Poly Haven has no model \"{$ref}\".");
        }
        $info = $info->throw()->json();
        $files = $http(30)->acceptJson()->get(self::API.'/files/'.rawurlencode($ref))->throw()->json();

        $variant = $files['gltf'][$resolution]['gltf'] ?? $files['gltf']['1k']['gltf'] ?? null;
        if (! is_array($info) || ! is_array($variant) || empty($variant['url'])) {
            throw new RuntimeException("Poly Haven offers no glTF download for \"{$ref}\".");
        }

        $include = is_array($variant['include'] ?? null) ? $variant['include'] : [];
        $binBytes = collect($include)->filter(fn ($f, $path) => str_ends_with((string) $path, '.bin'))->sum(fn ($f) => (int) ($f['size'] ?? 0));
        if ($binBytes > self::MAX_BIN_BYTES) {
            throw new RuntimeException(sprintf(
                '"%s" is too heavy for real-time foliage (%d MB of geometry, %s triangles). Pick a lighter model.',
                $info['name'] ?? $ref, (int) round($binBytes / 1048576), number_format((int) ($info['polycount'] ?? 0)),
            ));
        }

        $disk = Storage::disk('public');
        $dir = $asset->storageDirectory().'/source';
        $disk->deleteDirectory($dir);
        $disk->makeDirectory($dir);

        $entry = basename(parse_url((string) $variant['url'], PHP_URL_PATH) ?: "{$ref}.gltf");
        $downloads = [$entry => (string) $variant['url']];
        foreach ($include as $path => $file) {
            $path = self::safeRelativePath((string) $path);
            if ($path !== null && ! empty($file['url'])) {
                $downloads[$path] = (string) $file['url'];
            }
        }

        $done = 0;
        foreach ($downloads as $path => $url) {
            $asset->forceFill(['status_message' => sprintf('Downloading from Poly Haven (%d/%d)…', ++$done, count($downloads))])->save();
            $target = $disk->path($dir.'/'.$path);
            if (! is_dir(dirname($target))) {
                mkdir(dirname($target), 0775, true);
            }
            $response = $http(600)->sink($target)->get($url);
            if (! $response->successful()) {
                throw new RuntimeException("Download failed (HTTP {$response->status()}): {$url}");
            }
        }

        $tags = array_values(array_unique(array_filter([...($info['tags'] ?? []), ...($info['categories'] ?? [])], fn ($t) => ! str_starts_with((string) $t, 'collection'))));

        $asset->forceFill([
            'source' => 'polyhaven',
            'source_ref' => $ref,
            'source_url' => "https://polyhaven.com/a/{$ref}",
            'author' => implode(', ', array_keys($info['authors'] ?? [])) ?: null,
            'license' => 'CC0',
            'tags' => array_slice($tags, 0, 20),
            'source_type' => 'model',
            'source_path' => $dir.'/'.$entry,
            'meta' => [...($asset->meta ?? []), 'source_polycount' => (int) ($info['polycount'] ?? 0)],
            'status' => 'awaiting_bake',
            'status_message' => 'Downloaded — waiting to be optimised in the studio.',
        ])->save();

        return $asset;
    }

    /** A relative path without traversal, or null. */
    public static function safeRelativePath(string $path): ?string
    {
        $path = str_replace('\\', '/', $path);
        $parts = [];
        foreach (explode('/', $path) as $part) {
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
