<?php

namespace App\Services\Materials;

use App\Models\Material;
use GdImage;
use InvalidArgumentException;

/**
 * Turns a (possibly partial) set of source maps into a complete material on disk: every map is
 * cropped/resized to one square resolution, missing maps are derived from the albedo, and the
 * model's *_path / resolution / thumbnail_path / status columns are updated.
 */
class MaterialBuilder
{
    /** Studio storage limit unless 4K is explicitly requested. */
    public const MAX_SIZE = 2048;

    public function __construct(
        private readonly TextureProcessor $processor,
        private readonly MaterialStorage $storage,
    ) {}

    /**
     * '1k' → 1024, '2k' → 2048, '4k' → 4096 (also accepts '1K', '512', …).
     */
    public static function sizeFor(string $resolution): int
    {
        return match (strtolower($resolution)) {
            '512' => 512,
            '2k', '2048' => 2048,
            '4k', '4096' => 4096,
            default => 1024,
        };
    }

    /**
     * Largest power of two ≤ the image's short side, clamped to 256..MAX_SIZE.
     */
    public static function sizeForImage(GdImage $image): int
    {
        $side = min(imagesx($image), imagesy($image));
        $size = 256;
        while ($size * 2 <= min($side, self::MAX_SIZE)) {
            $size *= 2;
        }

        return $size;
    }

    /**
     * @param  array<string, GdImage|string|null>  $maps  albedo (required), normal (OpenGL), roughness, ao, height — images or encoded bytes
     * @param  array{seamless?: bool, delight?: bool, normal_strength?: float}  $options
     * @param  array<string, mixed>  $attributes  extra model attributes saved together with the paths
     */
    public function build(Material $material, array $maps, int $size, array $options = [], array $attributes = []): Material
    {
        $seamless = (bool) ($options['seamless'] ?? false);
        $load = function (string $name) use ($maps, $size, $seamless): ?GdImage {
            $source = $maps[$name] ?? null;
            if ($source === null || $source === '') {
                return null;
            }

            $image = $source instanceof GdImage ? $source : $this->processor->decode($source);
            $image = $this->processor->normalizeSquare($image, $size);

            return $seamless ? $this->processor->makeSeamless($image) : $image;
        };

        $albedoSource = $maps['albedo'] ?? null;
        if ($albedoSource === null || $albedoSource === '') {
            throw new InvalidArgumentException('A material needs at least an albedo (colour) map.');
        }

        // Albedo: delight before making it tile, so the lighting gradient is not smeared into the blend.
        $albedo = $albedoSource instanceof GdImage ? $albedoSource : $this->processor->decode($albedoSource);
        $albedo = $this->processor->normalizeSquare($albedo, $size);
        if ($options['delight'] ?? false) {
            $albedo = $this->processor->delight($albedo);
        }
        if ($seamless) {
            $albedo = $this->processor->makeSeamless($albedo);
        }

        $this->storage->clear($material);
        $paths = ['albedo_path' => $this->storage->put($material, 'albedo', $albedo)];
        $paths['thumbnail_path'] = $this->storage->put($material, 'thumbnail', $this->processor->thumbnail($albedo, 256));

        $height = $load('height');
        $height = $height ? $this->processor->greyscale($height) : $this->processor->deriveHeight($albedo);
        $paths['height_path'] = $this->storage->put($material, 'height', $height);

        $normal = $load('normal') ?? $this->processor->deriveNormal($height, (float) ($options['normal_strength'] ?? 1.0));
        $paths['normal_path'] = $this->storage->put($material, 'normal', $normal);
        unset($normal);

        $roughness = $load('roughness');
        $roughness = $roughness ? $this->processor->greyscale($roughness) : $this->processor->deriveRoughness($albedo, $height);
        $paths['roughness_path'] = $this->storage->put($material, 'roughness', $roughness);
        unset($roughness);

        $ao = $load('ao');
        $ao = $ao ? $this->processor->greyscale($ao) : $this->processor->deriveAo($height);
        $paths['ao_path'] = $this->storage->put($material, 'ao', $ao);

        $material->forceFill([
            ...$attributes,
            ...$paths,
            'resolution' => $size,
            'status' => 'ready',
            'status_message' => null,
        ])->save();

        return $material;
    }
}
