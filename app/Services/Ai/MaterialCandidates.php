<?php

namespace App\Services\Ai;

use App\Models\Material;
use App\Services\Materials\MaterialLibrary;
use App\Services\Materials\Sources\PolyHavenSource;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use Throwable;

/**
 * The materials the layer planner may choose from: the library plus a compact, terrain-relevant
 * shortlist of free CC0 materials that can be imported from Poly Haven and ambientCG.
 *
 * Unreachable sources are simply left out (and reported in {@see self::$unavailable}).
 */
class MaterialCandidates
{
    /** Total number of candidates (library + importable) sent to the model. */
    public const MAX_TOTAL = 120;

    public const MAX_LIBRARY = 60;

    /** Importable candidates are never squeezed below this many. */
    public const MIN_IMPORTS = 40;

    public const AMBIENTCG_PER_QUERY = 6;

    public const AMBIENTCG_QUERIES = ['grass', 'ground', 'forest floor', 'rock', 'cliff', 'gravel', 'sand', 'snow', 'mud', 'moss'];

    /** Words that make a Poly Haven texture relevant for natural terrain. */
    public const TERRAIN_TERMS = [
        'terrain', 'ground', 'grass', 'rock', 'sand', 'snow', 'mud', 'gravel', 'soil', 'forest', 'leaves',
        'moss', 'beach', 'cliff', 'dirt',
    ];

    /** Poly Haven categories that are never terrain. */
    private const EXCLUDED_CATEGORIES = ['man made', 'indoor', 'wall', 'brick', 'fabric', 'metal', 'roofing', 'tiles', 'plaster-concrete', 'wood', 'raw wood'];

    /** Scans at least this wide (metres) are treated as aerial / very large. */
    public const AERIAL_SIZE = 10.0;

    /** @var list<string> sources that could not be reached during the last build */
    public array $unavailable = [];

    /** @var array{library: list<array<string, mixed>>, import: list<array<string, mixed>>}|null */
    private ?array $built = null;

    public function __construct(private readonly PolyHavenSource $polyHaven) {}

    /**
     * @return array{library: list<array<string, mixed>>, import: list<array<string, mixed>>, unavailable: list<string>}
     */
    public function catalogue(): array
    {
        if ($this->built === null) {
            $this->unavailable = [];
            $library = $this->library();
            $imported = collect($library)->filter(fn ($m) => $m['source_ref'] !== null)
                ->map(fn ($m) => $m['source'].':'.$m['source_ref'])->flip();

            $budget = max(self::MIN_IMPORTS, self::MAX_TOTAL - count($library));
            // Already imported materials are offered as library entries only.
            $notImported = fn (array $c) => ! $imported->has($c['source'].':'.$c['ref']);
            // Round-robin over categories so a capped list still offers grass, rock, sand, snow, …
            $polyHaven = self::interleave(array_values(array_filter($this->polyHavenCandidates(), $notImported)));
            $ambientCg = array_values(array_filter($this->ambientCgCandidates(), $notImported));

            // Poly Haven has measured scan sizes, so it gets the larger share.
            $acgShare = min(count($ambientCg), max((int) floor($budget / 3), $budget - count($polyHaven)));
            $import = [...array_slice($polyHaven, 0, $budget - $acgShare), ...array_slice($ambientCg, 0, $acgShare)];

            $this->built = ['library' => $library, 'import' => $import];
        }

        return [...$this->built, 'unavailable' => $this->unavailable];
    }

    /**
     * @return array<string, mixed>|null
     */
    public function findImport(string $source, string $ref): ?array
    {
        foreach ($this->catalogue()['import'] as $candidate) {
            if ($candidate['source'] === $source && $candidate['ref'] === $ref) {
                return $candidate;
            }
        }

        return null;
    }

    /**
     * One line per candidate to keep the prompt small.
     */
    public function promptText(): string
    {
        $catalogue = $this->catalogue();
        $lines = ['LIBRARY (use with {"type":"library","material_id":ID}):'];

        foreach ($catalogue['library'] as $m) {
            $lines[] = sprintf(
                'id=%d | %s | %s | %sm%s | %s%s | tags: %s',
                $m['id'], $m['name'], $m['category'], self::num($m['tile_size']),
                $m['resolution'] ? ' | '.$m['resolution'].'px' : '', $m['source'],
                $m['status'] === 'ready' ? '' : ' | '.$m['status'], implode(',', array_slice($m['tags'], 0, 6)),
            );
        }
        if ($catalogue['library'] === []) {
            $lines[] = '(empty)';
        }

        $lines[] = '';
        $lines[] = 'IMPORTABLE, free CC0 (use with {"type":"import","source":SOURCE,"ref":REF,"resolution":"1k"|"2k"}):';
        foreach ($catalogue['import'] as $c) {
            $lines[] = sprintf(
                '%s:%s | %s | %s | %s%s | tags: %s',
                $c['source'], $c['ref'], $c['name'], $c['category'],
                $c['tile_size'] !== null ? self::num($c['tile_size']).'m' : 'size unknown',
                $c['aerial'] ? ' | AERIAL/very large scan' : '', implode(',', $c['tags']),
            );
        }
        if ($catalogue['import'] === []) {
            $lines[] = '(none available)';
        }
        if ($catalogue['unavailable'] !== []) {
            $lines[] = '(unreachable right now: '.implode(', ', $catalogue['unavailable']).')';
        }

        return implode("\n", $lines);
    }

    /**
     * @return list<array<string, mixed>>
     */
    public function library(): array
    {
        return Material::query()->where('status', '!=', 'failed')->latest('id')->limit(self::MAX_LIBRARY)->get()
            ->map(fn (Material $m) => [
                'id' => $m->id,
                'name' => $m->name,
                'category' => $m->category,
                'tags' => array_values(array_slice($m->tags ?? [], 0, 6)),
                'tile_size' => $m->tile_size,
                'resolution' => $m->resolution,
                'source' => $m->source,
                'source_ref' => $m->source_ref,
                'status' => $m->status,
                'thumbnail_url' => $m->toGameArray()['thumbnail_url'],
            ])->sortBy([['category', 'asc'], ['name', 'asc']])->values()->all();
    }

    /**
     * @return list<array<string, mixed>>
     */
    public function polyHavenCandidates(): array
    {
        try {
            $assets = $this->polyHaven->assets();
        } catch (Throwable $e) {
            report($e);
            $this->unavailable[] = 'Poly Haven';

            return [];
        }

        $out = [];
        foreach ($assets as $ref => $asset) {
            if (! is_array($asset)) {
                continue;
            }

            $categories = array_values(array_filter($asset['categories'] ?? [], 'is_string'));
            $tags = array_values(array_filter($asset['tags'] ?? [], 'is_string'));
            if (array_intersect($categories, self::EXCLUDED_CATEGORIES) !== []) {
                continue;
            }

            $haystack = mb_strtolower(str_replace(['_', '-'], ' ', $ref.' '.($asset['name'] ?? '').' '.implode(' ', $tags).' '.implode(' ', $categories)));
            if (! self::mentionsAny($haystack, self::TERRAIN_TERMS)) {
                continue;
            }

            $mm = $asset['dimensions'][0] ?? null;
            $size = is_numeric($mm) && $mm > 0 ? $mm / 1000 : null;
            $aerial = in_array('aerial', $categories, true) || ($asset['attributes']['aerial'] ?? false) === true
                || ($size !== null && $size >= self::AERIAL_SIZE);

            $out[] = [
                'source' => 'polyhaven',
                'ref' => (string) $ref,
                'name' => (string) ($asset['name'] ?? Str::headline((string) $ref)),
                'category' => MaterialLibrary::guessCategory([(string) $ref, (string) ($asset['name'] ?? ''), ...$tags, ...$categories]),
                'categories' => array_slice($categories, 0, 4),
                'tags' => array_slice($tags, 0, 6),
                'tile_size' => $size !== null ? round(max(0.5, min(30, $size)), 2) : null,
                'aerial' => $aerial,
                'thumbnail_url' => "https://cdn.polyhaven.com/asset_img/thumbs/{$ref}.png?width=256&height=256",
                'source_url' => "https://polyhaven.com/a/{$ref}",
                'license' => 'CC0',
                'downloads' => (int) ($asset['download_count'] ?? 0),
            ];
        }

        usort($out, fn ($a, $b) => $b['downloads'] <=> $a['downloads']);

        return array_map(fn ($c) => collect($c)->except('downloads')->all(), $out);
    }

    /**
     * A few targeted ambientCG searches (cached for a day each).
     *
     * @return list<array<string, mixed>>
     */
    public function ambientCgCandidates(): array
    {
        $out = [];
        $failed = false;

        foreach (self::AMBIENTCG_QUERIES as $query) {
            try {
                $assets = Cache::remember('ai.candidates.ambientcg.'.Str::slug($query), 86400, function () use ($query) {
                    $json = Http::timeout(15)->acceptJson()->get('https://ambientcg.com/api/v2/full_json', [
                        'type' => 'Material',
                        'q' => $query,
                        'limit' => self::AMBIENTCG_PER_QUERY,
                        'sort' => 'Popular',
                        'include' => 'imageData,tagData,displayData',
                    ])->throw()->json();

                    return array_values(array_map(fn (array $a) => [
                        'id' => (string) ($a['assetId'] ?? ''),
                        'name' => (string) ($a['displayName'] ?? ''),
                        'category' => (string) ($a['displayCategory'] ?? ''),
                        'tags' => array_values(array_filter($a['tags'] ?? [], 'is_string')),
                        'thumbnail' => $a['previewImage']['256-PNG'] ?? null,
                    ], array_filter($json['foundAssets'] ?? [], 'is_array')));
                });
            } catch (Throwable $e) {
                report($e);
                $failed = true;

                continue;
            }

            foreach ($assets as $a) {
                $id = $a['id'];
                if ($id === '' || isset($out[$id]) || preg_match('/^[A-Za-z0-9_-]+$/', $id) !== 1) {
                    continue;
                }

                $tags = array_values(array_filter($a['tags'], fn ($t) => ! is_numeric($t)));
                $out[$id] = [
                    'source' => 'ambientcg',
                    'ref' => $id,
                    'name' => $a['name'] !== '' ? $a['name'] : Str::headline($id),
                    'category' => MaterialLibrary::guessCategory([$id, $a['category'], ...$tags]),
                    'categories' => array_values(array_filter([$a['category']])),
                    'tags' => array_slice($tags, 0, 6),
                    // ambientCG publishes no reliable real-world size: the model chooses one.
                    'tile_size' => null,
                    'aerial' => false,
                    'thumbnail_url' => is_string($a['thumbnail']) ? $a['thumbnail'] : null,
                    'source_url' => "https://ambientcg.com/view?id={$id}",
                    'license' => 'CC0',
                ];
            }
        }

        if ($failed && $out === []) {
            $this->unavailable[] = 'ambientCG';
        }

        return array_values($out);
    }

    /**
     * Most popular of each category first, then the second of each, …
     *
     * @param  list<array<string, mixed>>  $candidates  sorted by popularity
     * @return list<array<string, mixed>>
     */
    private static function interleave(array $candidates): array
    {
        $groups = collect($candidates)->groupBy('category')->map->values();
        $out = [];

        for ($i = 0; count($out) < count($candidates); $i++) {
            foreach ($groups as $group) {
                if (isset($group[$i])) {
                    $out[] = $group[$i];
                }
            }
        }

        return $out;
    }

    /**
     * @param  list<string>  $terms
     */
    private static function mentionsAny(string $haystack, array $terms): bool
    {
        foreach ($terms as $term) {
            if (preg_match('/\b'.preg_quote($term, '/').'/u', $haystack) === 1) {
                return true;
            }
        }

        return false;
    }

    private static function num(float|int|null $value): string
    {
        return rtrim(rtrim(number_format((float) $value, 2, '.', ''), '0'), '.');
    }
}
