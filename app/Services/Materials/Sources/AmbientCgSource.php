<?php

namespace App\Services\Materials\Sources;

use App\Models\Material;
use App\Services\Materials\MaterialBuilder;
use App\Services\Materials\MaterialLibrary;
use App\Services\Materials\TextureProcessor;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use RuntimeException;
use ZipArchive;

/**
 * CC0 materials from ambientCG (https://ambientcg.com, API v2).
 */
class AmbientCgSource
{
    public const API = 'https://ambientcg.com/api/v2/full_json';

    public const PER_PAGE = 24;

    /** Suffix of each map inside the download zip (e.g. Grass005_1K-JPG_Color.jpg). */
    private const ZIP_MAPS = [
        'albedo' => ['_Color.jpg', '_Color.png'],
        'normal' => ['_NormalGL.jpg', '_NormalGL.png'],
        'normal_dx' => ['_NormalDX.jpg', '_NormalDX.png'],
        'roughness' => ['_Roughness.jpg', '_Roughness.png'],
        'ao' => ['_AmbientOcclusion.jpg', '_AmbientOcclusion.png'],
        'height' => ['_Displacement.jpg', '_Displacement.png'],
    ];

    /** Our library categories → extra search words. */
    private const CATEGORY_QUERY = [
        'grass' => 'grass', 'forest' => 'ground', 'soil' => 'ground', 'rock' => 'rock', 'gravel' => 'gravel',
        'sand' => 'sand', 'mud' => 'mud', 'snow' => 'snow', 'field' => 'ground', 'urban' => 'asphalt',
    ];

    public function __construct(
        private readonly MaterialBuilder $builder,
        private readonly TextureProcessor $processor,
    ) {}

    /**
     * @return array{items: list<array<string, mixed>>, page: int, has_more: bool}
     */
    public function search(?string $query, ?string $category, int $page = 1): array
    {
        $page = max(1, $page);
        $q = trim((string) $query);
        if ($category !== null && $category !== '') {
            $q = trim($q.' '.(self::CATEGORY_QUERY[$category] ?? $category));
        }

        $json = Http::timeout(30)->acceptJson()->get(self::API, [
            'type' => 'Material',
            'q' => $q,
            'limit' => self::PER_PAGE,
            'offset' => ($page - 1) * self::PER_PAGE,
            'sort' => 'Popular',
            'include' => 'downloadData,imageData,tagData',
        ])->throw()->json();

        $assets = array_values(array_filter($json['foundAssets'] ?? [], 'is_array'));
        $ids = array_map(fn ($a) => (string) ($a['assetId'] ?? ''), $assets);
        $imported = Material::query()->where('source', 'ambientcg')->whereIn('source_ref', $ids)->pluck('id', 'source_ref');

        $items = array_map(function (array $a) use ($imported) {
            $id = (string) $a['assetId'];
            $tags = array_values(array_filter($a['tags'] ?? [], 'is_string'));

            return [
                'ref' => $id,
                'name' => (string) ($a['displayName'] ?? $id),
                'thumbnail_url' => $a['previewImage']['256-PNG'] ?? null,
                'categories' => array_values(array_filter([$a['displayCategory'] ?? null])),
                'tags' => $tags,
                'author' => 'ambientCG',
                'license' => 'CC0',
                'source_url' => "https://ambientcg.com/view?id={$id}",
                'max_resolution' => $this->maxResolution($a),
                'tile_size' => $this->tileSize($a),
                'suggested_category' => MaterialLibrary::guessCategory([$id, (string) ($a['displayCategory'] ?? ''), ...$tags]),
                'imported_material_id' => $imported[$id] ?? null,
            ];
        }, $assets);

        $total = (int) ($json['numberOfResults'] ?? 0);

        return ['items' => $items, 'page' => $page, 'has_more' => $page * self::PER_PAGE < $total];
    }

    /**
     * Download {id}_{1K|2K|4K}-JPG.zip and build the material from the maps inside.
     *
     * @param  array{name?: string|null, category?: string|null}  $overrides
     */
    public function import(Material $material, string $ref, string $resolution = '1k', array $overrides = []): Material
    {
        if (preg_match('/^[A-Za-z0-9_-]+$/', $ref) !== 1) {
            throw new RuntimeException('Invalid ambientCG asset id.');
        }

        $res = strtoupper($resolution);
        $meta = Http::timeout(30)->acceptJson()->get(self::API, ['id' => $ref, 'include' => 'tagData,displayData,dimensionsData'])->json();
        $asset = $meta['foundAssets'][0] ?? [];

        $tmp = tempnam(sys_get_temp_dir(), 'acg');
        try {
            $response = Http::timeout(300)->withOptions(['sink' => $tmp, 'allow_redirects' => ['max' => 5]])
                ->get('https://ambientcg.com/get', ['file' => "{$ref}_{$res}-JPG.zip"]);

            if (! $response->successful()) {
                throw new RuntimeException("ambientCG download failed (HTTP {$response->status()}) for {$ref} {$res}.");
            }

            // Faked / non-streaming handlers ignore the sink.
            clearstatcache(true, $tmp);
            if (filesize($tmp) === 0) {
                file_put_contents($tmp, $response->body());
            }

            $maps = $this->extract($tmp);
        } finally {
            @unlink($tmp);
        }

        if (! isset($maps['albedo'])) {
            throw new RuntimeException("The ambientCG download for {$ref} contains no colour map.");
        }

        if (! isset($maps['normal']) && isset($maps['normal_dx'])) {
            $maps['normal'] = $this->processor->flipNormalGreen($this->processor->decode($maps['normal_dx']));
        }
        unset($maps['normal_dx']);

        $tags = array_values(array_filter($asset['tags'] ?? [], 'is_string'));
        $name = trim((string) ($overrides['name'] ?? '')) ?: (string) ($asset['displayName'] ?? Str::headline($ref));

        return $this->builder->build($material, $maps, MaterialBuilder::sizeFor($resolution), [], [
            'name' => $name,
            'category' => MaterialLibrary::validCategory($overrides['category'] ?? null, MaterialLibrary::guessCategory([$ref, $name, ...$tags])),
            'source' => 'ambientcg',
            'source_ref' => $ref,
            'source_url' => "https://ambientcg.com/view?id={$ref}",
            'author' => 'ambientCG',
            'license' => 'CC0',
            'tags' => array_slice($tags, 0, 20),
            'tile_size' => $this->tileSize($asset),
        ]);
    }

    /**
     * @return array<string, string> map → file bytes
     */
    public function extract(string $zipPath): array
    {
        $zip = new ZipArchive;
        if ($zip->open($zipPath) !== true) {
            throw new RuntimeException('The ambientCG download is not a valid zip file.');
        }

        $maps = [];
        try {
            for ($i = 0; $i < $zip->numFiles; $i++) {
                $name = (string) $zip->getNameIndex($i);
                foreach (self::ZIP_MAPS as $map => $suffixes) {
                    foreach ($suffixes as $suffix) {
                        if (! isset($maps[$map]) && str_ends_with(strtolower($name), strtolower($suffix))) {
                            $maps[$map] = (string) $zip->getFromIndex($i);
                        }
                    }
                }
            }
        } finally {
            $zip->close();
        }

        return $maps;
    }

    /**
     * @param  array<string, mixed>  $asset
     */
    private function tileSize(array $asset): float
    {
        // ambientCG dimensions are centimetres; 0 when unknown.
        $cm = $asset['dimensionX'] ?? 0;

        return is_numeric($cm) && $cm > 0 ? round(min(100, max(0.1, $cm / 100)), 2) : 2.0;
    }

    /**
     * @param  array<string, mixed>  $asset
     */
    private function maxResolution(array $asset): ?int
    {
        $max = null;
        foreach ($asset['downloadFolders']['default']['downloadFiletypeCategories']['zip']['downloads'] ?? [] as $download) {
            if (preg_match('/^(\d+)K-/', (string) ($download['attribute'] ?? ''), $m) === 1) {
                $max = max($max ?? 0, (int) $m[1] * 1024);
            }
        }

        return $max;
    }
}
