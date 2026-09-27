<?php

namespace App\Services\Materials;

use App\Models\Material;
use GdImage;
use Illuminate\Contracts\Filesystem\Filesystem;
use Illuminate\Support\Facades\Storage;

/**
 * Reads and writes a material's map files on the public disk (materials/{id}/{map}.jpg).
 */
class MaterialStorage
{
    public const QUALITY = 90;

    public const NORMAL_QUALITY = 95;

    public function __construct(private readonly TextureProcessor $processor) {}

    public function disk(): Filesystem
    {
        return Storage::disk('public');
    }

    public function path(Material $material, string $map): string
    {
        return $material->storageDirectory().'/'.($map === 'thumbnail' ? 'thumb' : $map).'.jpg';
    }

    /**
     * Write one map (albedo|normal|roughness|ao|height|thumbnail) and return its path.
     * The caller persists the returned path on the model (see MaterialBuilder).
     */
    public function put(Material $material, string $map, GdImage $image): string
    {
        $path = $this->path($material, $map);
        $quality = $map === 'normal' ? self::NORMAL_QUALITY : self::QUALITY;
        $this->disk()->put($path, $this->processor->encodeJpeg($image, $quality));

        return $path;
    }

    public function read(Material $material, string $map): ?string
    {
        $path = $map === 'thumbnail' ? $material->thumbnail_path : $material->{$map.'_path'};

        return $path && $this->disk()->exists($path) ? $this->disk()->get($path) : null;
    }

    public function clear(Material $material): void
    {
        $this->disk()->deleteDirectory($material->storageDirectory());
    }

    /**
     * A JPEG data URL of one map, down-scaled to at most $maxSize (for AI input references).
     */
    public function dataUrl(Material $material, string $map = 'albedo', int $maxSize = 1024): ?string
    {
        $bytes = $this->read($material, $map);
        if ($bytes === null) {
            return null;
        }

        $image = $this->processor->decode($bytes);
        if (imagesx($image) > $maxSize) {
            $image = $this->processor->normalizeSquare($image, $maxSize);
        }

        return 'data:image/jpeg;base64,'.base64_encode($this->processor->encodeJpeg($image, 90));
    }

    /**
     * Copy every map file of $from to $to and return the path attributes for $to.
     *
     * @return array<string, string|null>
     */
    public function copy(Material $from, Material $to): array
    {
        $attributes = [];

        foreach ([...Material::MAPS, 'thumbnail'] as $map) {
            $source = $map === 'thumbnail' ? $from->thumbnail_path : $from->{$map.'_path'};
            $column = $map === 'thumbnail' ? 'thumbnail_path' : $map.'_path';

            if ($source && $this->disk()->exists($source)) {
                $target = $this->path($to, $map);
                $this->disk()->copy($source, $target);
                $attributes[$column] = $target;
            } else {
                $attributes[$column] = null;
            }
        }

        return $attributes;
    }
}
