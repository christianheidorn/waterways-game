<?php

namespace App\Mcp\Assets;

use App\Mcp\ToolError;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use ZipArchive;

/**
 * Brings a model an agent names (a local file, a URL or base64 data) into a temporary file after
 * checking it: .glb / .gltf only, at most MAX_BYTES, and real glTF content. A .gltf on disk that
 * references external buffers / textures is packed together with them into a zip (the format the
 * foliage upload flow understands).
 */
class ModelSource
{
    public const MAX_BYTES = 100 * 1024 * 1024;

    /** base64 travels inside one MCP message: keep it small. */
    public const MAX_BASE64_BYTES = 15 * 1024 * 1024;

    /** @var list<string> */
    private array $temporary = [];

    /**
     * @param  array{path?: string|null, url?: string|null, base64?: string|null, file_name?: string|null}  $source
     */
    public function load(array $source): LoadedModel
    {
        $given = array_filter([
            'path' => $source['path'] ?? null,
            'url' => $source['url'] ?? null,
            'base64' => $source['base64'] ?? null,
        ], fn ($v) => is_string($v) && trim($v) !== '');

        if (count($given) !== 1) {
            throw new ToolError('Pass exactly one of path (a local file), url or base64.');
        }

        return match (array_key_first($given)) {
            'path' => $this->fromPath(trim($given['path'])),
            'url' => $this->fromUrl(trim($given['url'])),
            default => $this->fromBase64($given['base64'], (string) ($source['file_name'] ?? 'model.glb')),
        };
    }

    /** Deletes the temporary files of loaded models. */
    public function cleanup(): void
    {
        foreach ($this->temporary as $file) {
            @unlink($file);
        }
        $this->temporary = [];
    }

    private function fromPath(string $path): LoadedModel
    {
        if (str_starts_with($path, '~/')) {
            $home = getenv('HOME') ?: ($_SERVER['HOME'] ?? null);
            $path = $home ? rtrim((string) $home, '/').substr($path, 1) : $path;
        }

        $extension = $this->extension($path);
        $real = realpath($path);
        if ($real === false || ! is_file($real)) {
            throw new ToolError("No file at {$path}. Pass an absolute path to a .glb (e.g. exported from Blender) on this computer.");
        }
        if (! is_readable($real)) {
            throw new ToolError("{$path} is not readable.");
        }
        $this->checkSize((int) filesize($real), $path);

        $contents = (string) file_get_contents($real);
        $doc = $this->validate($contents, $extension, basename($real));

        if ($extension === 'gltf') {
            $external = $this->externalUris($doc);
            if ($external !== []) {
                return new LoadedModel($this->zipWithResources($real, $external), basename($real), 'zip', $doc);
            }
        }

        return new LoadedModel($real, basename($real), $extension, $doc);
    }

    private function fromUrl(string $url): LoadedModel
    {
        if (! preg_match('#^https?://#i', $url)) {
            throw new ToolError('Only http(s) URLs can be downloaded.');
        }

        $name = basename((string) parse_url($url, PHP_URL_PATH)) ?: 'model.glb';
        $extension = $this->extension($name);

        try {
            $response = Http::timeout(180)->connectTimeout(15)->get($url);
        } catch (ConnectionException $e) {
            throw new ToolError('Could not download the model: '.$e->getMessage());
        }
        if (! $response->successful()) {
            throw new ToolError("Downloading the model failed (HTTP {$response->status()}).");
        }

        $contents = $response->body();
        $this->checkSize(strlen($contents), $url);
        $doc = $this->validate($contents, $extension, $name);
        if ($extension === 'gltf' && array_filter($this->externalUris($doc), fn ($u) => ! str_starts_with($u, 'data:')) !== []) {
            throw new ToolError('This .gltf references external files, which cannot be fetched from a URL. Use a .glb instead.');
        }

        return new LoadedModel($this->temp($contents, $extension), $name, $extension, $doc);
    }

    private function fromBase64(string $data, string $name): LoadedModel
    {
        $data = preg_replace('/^data:[^,]*,/', '', trim($data)) ?? '';
        $contents = base64_decode($data, true);
        if ($contents === false) {
            throw new ToolError('base64 is not valid base64 data.');
        }
        if (strlen($contents) > self::MAX_BASE64_BYTES) {
            throw new ToolError('base64 models are limited to 15 MB. Save the file and pass its path instead.');
        }

        $extension = $this->extension($name);
        $doc = $this->validate($contents, $extension, $name);
        if ($extension === 'gltf' && array_filter($this->externalUris($doc), fn ($u) => ! str_starts_with($u, 'data:')) !== []) {
            throw new ToolError('This .gltf references external files. Send a .glb instead.');
        }

        return new LoadedModel($this->temp($contents, $extension), $name, $extension, $doc);
    }

    /**
     * @return 'glb'|'gltf'
     */
    private function extension(string $name): string
    {
        $extension = strtolower(pathinfo($name, PATHINFO_EXTENSION));

        return match ($extension) {
            'glb', 'gltf' => $extension,
            default => throw new ToolError('Only .glb and .gltf models can be imported (got "'.($extension ?: 'no extension').'"). In Blender, export as glTF 2.0 binary (.glb).'),
        };
    }

    private function checkSize(int $bytes, string $what): void
    {
        if ($bytes > self::MAX_BYTES) {
            throw new ToolError(sprintf('%s is %d MB; models are limited to 100 MB. Reduce the polygon count or texture sizes.', $what, (int) round($bytes / 1048576)));
        }
        if ($bytes === 0) {
            throw new ToolError("{$what} is empty.");
        }
    }

    /**
     * @return array<string, mixed>
     */
    private function validate(string $contents, string $extension, string $name): array
    {
        if ($extension === 'glb' && ! str_starts_with($contents, 'glTF')) {
            throw new ToolError("\"{$name}\" is not a binary glTF file (the file does not start with the glTF magic bytes).");
        }

        $doc = GltfInspector::document($contents);
        if ($doc === null) {
            throw new ToolError("\"{$name}\" is not a valid glTF 2.0 model.");
        }
        if (! str_starts_with((string) ($doc['asset']['version'] ?? ''), '2')) {
            throw new ToolError("\"{$name}\" is glTF {$doc['asset']['version']}; only glTF 2.0 is supported.");
        }

        return $doc;
    }

    /**
     * @param  array<string, mixed>  $doc
     * @return list<string>
     */
    private function externalUris(array $doc): array
    {
        $uris = [];
        foreach (['buffers', 'images'] as $key) {
            foreach (is_array($doc[$key] ?? null) ? $doc[$key] : [] as $item) {
                $uri = is_array($item) ? ($item['uri'] ?? null) : null;
                if (is_string($uri) && $uri !== '' && ! str_starts_with($uri, 'data:')) {
                    $uris[] = $uri;
                }
            }
        }

        return array_values(array_unique($uris));
    }

    /**
     * Packs a .gltf and the files it references (relative to its folder) into a zip.
     *
     * @param  list<string>  $uris
     */
    private function zipWithResources(string $gltf, array $uris): string
    {
        $dir = dirname($gltf);
        $zipPath = $this->temp('', 'zip');
        $zip = new ZipArchive;
        if ($zip->open($zipPath, ZipArchive::OVERWRITE) !== true) {
            throw new ToolError('Could not pack the .gltf with its files.');
        }

        $total = (int) filesize($gltf);
        $zip->addFile($gltf, basename($gltf));
        foreach ($uris as $uri) {
            $relative = rawurldecode($uri);
            $file = realpath($dir.'/'.$relative);
            if (str_contains($relative, '..') || str_contains($relative, ':') || $file === false || ! is_file($file) || ! is_readable($file)) {
                $zip->close();
                throw new ToolError("The .gltf references \"{$uri}\", which is missing next to it (or outside its folder). Export a .glb instead.");
            }
            $total += (int) filesize($file);
            $this->checkSize($total, basename($gltf).' with its files');
            $zip->addFile($file, $relative);
        }
        $zip->close();

        return $zipPath;
    }

    private function temp(string $contents, string $extension): string
    {
        $path = sys_get_temp_dir().'/waterways-model-'.Str::random(12).'.'.$extension;
        file_put_contents($path, $contents);
        $this->temporary[] = $path;

        return $path;
    }
}
