<?php

namespace App\Services\Foliage;

use App\Models\FoliageAsset;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use RuntimeException;
use ZipArchive;

/**
 * Turns uploaded .glb / .gltf files and .zip packs (e.g. Quaternius or Kenney nature kits) into
 * library assets waiting for the browser bake.
 */
class ModelUploads
{
    public const MAX_MODELS_PER_ZIP = 150;

    /** Total uncompressed bytes we are willing to extract from one zip. */
    public const MAX_UNCOMPRESSED = 800 * 1024 * 1024;

    public function __construct(private readonly FoliageLibrary $library) {}

    /**
     * @param  array{kind?: string|null, style?: string|null, target_height?: float|null, name?: string|null}  $defaults
     * @return list<FoliageAsset>
     */
    public function ingest(UploadedFile $file, array $defaults = []): array
    {
        $extension = strtolower($file->getClientOriginalExtension());

        return match ($extension) {
            'glb' => [$this->single($file, 'glb', $defaults)],
            'gltf' => [$this->single($file, 'gltf', $defaults)],
            'zip' => $this->zip($file, $defaults),
            default => throw new RuntimeException('Upload .glb, .gltf (with embedded data) or a .zip of glTF / GLB models.'),
        };
    }

    /**
     * @param  array<string, mixed>  $defaults
     */
    private function single(UploadedFile $file, string $extension, array $defaults): FoliageAsset
    {
        $contents = (string) file_get_contents($file->getRealPath());

        if ($extension === 'glb' && substr($contents, 0, 4) !== 'glTF') {
            throw new RuntimeException('"'.$file->getClientOriginalName().'" is not a binary glTF (.glb) file.');
        }

        if ($extension === 'gltf') {
            $external = array_filter($this->externalUris($contents), fn ($uri) => ! str_starts_with($uri, 'data:'));
            if ($external !== []) {
                throw new RuntimeException('This .gltf references external files ('.implode(', ', array_slice($external, 0, 3)).'). Upload it together with those files as a .zip, or export a .glb.');
            }
        }

        $asset = $this->createAsset($file->getClientOriginalName(), $defaults);
        $path = $asset->storageDirectory().'/source/model.'.$extension;
        Storage::disk('public')->put($path, $contents);
        $this->ready($asset, $path);

        return $asset;
    }

    /**
     * @param  array<string, mixed>  $defaults
     * @return list<FoliageAsset>
     */
    private function zip(UploadedFile $file, array $defaults): array
    {
        $zip = new ZipArchive;
        if ($zip->open($file->getRealPath()) !== true) {
            throw new RuntimeException('Could not open the zip file.');
        }

        try {
            $entries = [];
            $total = 0;
            for ($i = 0; $i < $zip->numFiles; $i++) {
                $stat = $zip->statIndex($i);
                if ($stat === false) {
                    continue;
                }
                $name = PolyHavenModels::safeRelativePath((string) $stat['name']);
                if ($name === null || str_ends_with((string) $stat['name'], '/') || str_starts_with($name, '__MACOSX/') || str_contains($name, '/.')) {
                    continue;
                }
                $entries[$name] = $i;
                $total += (int) $stat['size'];
            }

            if ($total > self::MAX_UNCOMPRESSED) {
                throw new RuntimeException('The zip is too large once extracted ('.(int) round($total / 1048576).' MB).');
            }

            $models = array_values(array_filter(array_keys($entries), fn ($n) => preg_match('/\.(glb|gltf)$/i', $n) === 1));
            if ($models === []) {
                throw new RuntimeException('The zip contains no .glb or .gltf models. (FBX / OBJ are not supported — most free kits also ship glTF.)');
            }

            // Kits often ship the same model as .gltf and .glb: keep one of each.
            $byBase = [];
            foreach ($models as $model) {
                $base = strtolower(preg_replace('/\.(glb|gltf)$/i', '', $model) ?? $model);
                if (! isset($byBase[$base]) || str_ends_with(strtolower($model), '.glb')) {
                    $byBase[$base] = $model;
                }
            }
            $models = array_slice(array_values($byBase), 0, self::MAX_MODELS_PER_ZIP);

            $assets = [];
            $skipped = [];
            foreach ($models as $model) {
                try {
                    $assets[] = $this->fromZipEntry($zip, $entries, $model, $defaults, count($models) === 1);
                } catch (RuntimeException $e) {
                    $skipped[] = basename($model).': '.$e->getMessage();
                }
            }

            if ($assets === []) {
                throw new RuntimeException('No model could be imported. '.implode(' ', array_slice($skipped, 0, 3)));
            }

            return $assets;
        } finally {
            $zip->close();
        }
    }

    /**
     * @param  array<string, int>  $entries
     * @param  array<string, mixed>  $defaults
     */
    private function fromZipEntry(ZipArchive $zip, array $entries, string $model, array $defaults, bool $only): FoliageAsset
    {
        $contents = $zip->getFromIndex($entries[$model]);
        if ($contents === false) {
            throw new RuntimeException('unreadable');
        }

        // Keep the zip's folder layout so relative URIs (also "../Textures/…") keep working.
        $files = [$model => $model];
        if (! str_ends_with(strtolower($model), '.glb')) {
            $dir = str_contains($model, '/') ? dirname($model).'/' : '';
            foreach ($this->externalUris($contents) as $uri) {
                if (str_starts_with($uri, 'data:')) {
                    continue;
                }
                $inZip = self::normalise($dir.rawurldecode($uri));
                if ($inZip === null || ! isset($entries[$inZip])) {
                    throw new RuntimeException("missing file {$uri}");
                }
                $files[$inZip] = $inZip;
            }
        }

        $entryName = basename($model);
        $name = $only && ! empty($defaults['name']) ? (string) $defaults['name'] : FoliageLibrary::nameFromFile($entryName);
        $asset = $this->createAsset($entryName, [...$defaults, 'name' => $name]);
        $disk = Storage::disk('public');
        $base = $asset->storageDirectory().'/source/';

        foreach ($files as $inZip) {
            $data = $inZip === $model ? $contents : $zip->getFromIndex($entries[$inZip]);
            if ($data === false) {
                $asset->delete();
                throw new RuntimeException("unreadable file {$inZip}");
            }
            $disk->put($base.$inZip, $data);
        }

        $this->ready($asset, $base.$model);

        return $asset;
    }

    /**
     * @param  array<string, mixed>  $defaults
     */
    private function createAsset(string $fileName, array $defaults): FoliageAsset
    {
        $name = trim((string) ($defaults['name'] ?? '')) ?: FoliageLibrary::nameFromFile($fileName);
        $guess = FoliageLibrary::guessKind([$name, $fileName]);

        return $this->library->create([
            'name' => $name,
            'kind' => FoliageLibrary::validKind($defaults['kind'] ?? null, $guess),
            'style' => FoliageLibrary::validStyle($defaults['style'] ?? null, 'realistic'),
            'source' => 'upload',
            'license' => $defaults['license'] ?? null,
            'source_type' => 'model',
            'target_height' => isset($defaults['target_height']) && is_numeric($defaults['target_height']) ? (float) $defaults['target_height'] : null,
            'status' => 'processing',
        ]);
    }

    private function ready(FoliageAsset $asset, string $path): void
    {
        $asset->forceFill([
            'source_path' => $path,
            'status' => 'awaiting_bake',
            'status_message' => 'Uploaded — waiting to be optimised in the studio.',
        ])->save();
    }

    /**
     * Resolve "." and ".." in a zip path; null when it escapes the zip root.
     */
    private static function normalise(string $path): ?string
    {
        $parts = [];
        foreach (explode('/', str_replace('\\', '/', $path)) as $part) {
            if ($part === '' || $part === '.') {
                continue;
            }
            if ($part === '..') {
                if ($parts === []) {
                    return null;
                }
                array_pop($parts);

                continue;
            }
            if (str_contains($part, ':')) {
                return null;
            }
            $parts[] = $part;
        }

        return $parts === [] ? null : implode('/', $parts);
    }

    /**
     * URIs of buffers and images referenced by a glTF JSON document.
     *
     * @return list<string>
     */
    private function externalUris(string $json): array
    {
        $doc = json_decode($json, true);
        if (! is_array($doc)) {
            throw new RuntimeException('invalid glTF JSON');
        }

        $uris = [];
        foreach (['buffers', 'images'] as $key) {
            foreach (is_array($doc[$key] ?? null) ? $doc[$key] : [] as $item) {
                if (is_array($item) && is_string($item['uri'] ?? null) && $item['uri'] !== '') {
                    $uris[] = $item['uri'];
                }
            }
        }

        return array_values(array_unique($uris));
    }
}
