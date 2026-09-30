<?php

namespace App\Mcp\Assets;

use App\Mcp\ToolError;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;

/**
 * Images generated for agents (generate_image), kept on the public disk under agent-images/ so they
 * can be reused: as references for further images, as material sources or, through their local file
 * path, in other tools such as Blender.
 */
class AgentImages
{
    public const DIRECTORY = 'agent-images';

    public const MAX_BYTES = 20 * 1024 * 1024;

    private const TYPES = ['image/png' => 'png', 'image/jpeg' => 'jpg', 'image/webp' => 'webp'];

    /**
     * @return array{path: string, url: string, file: string}
     */
    public function store(string $bytes, string $mediaType): array
    {
        $path = self::DIRECTORY.'/'.Str::uuid().'.'.(self::TYPES[$mediaType] ?? 'png');
        Storage::disk('public')->put($path, $bytes);

        return $this->describe($path);
    }

    /**
     * @return array{path: string, url: string, file: string}
     */
    public function describe(string $path): array
    {
        return ['path' => $path, 'url' => '/storage/'.$path, 'file' => Storage::disk('public')->path($path)];
    }

    /**
     * Reads an image an agent refers to: a stored agent image (path "agent-images/…", or its /storage
     * URL) or a PNG / JPEG / WebP file on this computer.
     *
     * @return array{bytes: string, media_type: string, name: string}
     */
    public function read(string $ref): array
    {
        $ref = trim($ref);
        $stored = preg_replace('#^(https?://[^/]+)?/storage/#', '', strtok($ref, '?') ?: $ref) ?? $ref;

        if (preg_match('#^'.self::DIRECTORY.'/[A-Za-z0-9-]+\.(png|jpg|webp)$#', $stored) === 1) {
            $bytes = Storage::disk('public')->get($stored) ?? throw new ToolError("No stored image {$stored}.");
        } else {
            if (str_starts_with($ref, '~/')) {
                $ref = rtrim((string) (getenv('HOME') ?: ''), '/').substr($ref, 1);
            }
            $real = realpath($ref);
            if ($real === false || ! is_file($real) || ! is_readable($real)) {
                throw new ToolError("No image at {$ref}. Pass a path returned by generate_image (agent-images/…) or an absolute path to a PNG / JPEG / WebP file.");
            }
            if (! in_array(strtolower(pathinfo($real, PATHINFO_EXTENSION)), ['png', 'jpg', 'jpeg', 'webp'], true)) {
                throw new ToolError("{$ref} is not a PNG, JPEG or WebP image.");
            }
            if ((int) filesize($real) > self::MAX_BYTES) {
                throw new ToolError("{$ref} is larger than 20 MB.");
            }
            $bytes = (string) file_get_contents($real);
        }

        $mediaType = (new \finfo(FILEINFO_MIME_TYPE))->buffer($bytes) ?: '';
        if (! isset(self::TYPES[$mediaType])) {
            throw new ToolError("{$ref} is not a PNG, JPEG or WebP image.");
        }

        return ['bytes' => $bytes, 'media_type' => $mediaType, 'name' => basename($stored)];
    }
}
