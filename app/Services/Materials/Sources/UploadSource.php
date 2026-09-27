<?php

namespace App\Services\Materials\Sources;

use App\Models\Material;
use App\Services\Materials\MaterialBuilder;
use App\Services\Materials\TextureProcessor;
use GdImage;
use RuntimeException;

/**
 * Materials from uploaded files: a full PBR set (maps detected by file name) or a single photo
 * from which the other maps are derived.
 */
class UploadSource
{
    /** Filename tokens per map, checked in this order. */
    private const TOKENS = [
        'arm' => ['arm', 'orm'],
        'normal' => ['normal', 'normals', 'nor', 'nrm', 'norm', 'normalgl', 'normaldx', 'norgl', 'nordx'],
        'roughness' => ['rough', 'roughness', 'rgh'],
        'ao' => ['ao', 'occlusion', 'ambientocclusion', 'occ'],
        'height' => ['height', 'disp', 'displacement', 'bump', 'heightmap'],
        'albedo' => ['albedo', 'basecolor', 'base', 'diffuse', 'diff', 'color', 'colour', 'col'],
    ];

    public function __construct(
        private readonly MaterialBuilder $builder,
        private readonly TextureProcessor $processor,
    ) {}

    /**
     * Which map a file name holds: albedo|normal|normal_dx|roughness|ao|height|arm, or null.
     */
    public static function detectMap(string $filename): ?string
    {
        $base = pathinfo($filename, PATHINFO_FILENAME);
        // Split camelCase ("NormalDX", "BaseColor") and any separators into lowercase tokens.
        $spaced = preg_replace('/([a-z])([A-Z])/', '$1 $2', $base) ?? $base;
        $tokens = array_values(array_filter(preg_split('/[^a-z0-9]+/', strtolower($spaced)) ?: []));
        $joined = implode('', $tokens);

        foreach (self::TOKENS as $map => $words) {
            $hit = array_intersect($tokens, $words) !== []
                // Joined forms such as "ambientocclusion", "basecolor", "normalgl".
                || ($map !== 'arm' && $map !== 'ao' && collect($words)->contains(fn ($w) => strlen($w) >= 6 && str_contains($joined, $w)))
                || ($map === 'ao' && str_contains($joined, 'ambientocclusion'));

            if ($hit) {
                if ($map === 'normal') {
                    $isDx = in_array('dx', $tokens, true) || in_array('directx', $tokens, true)
                        || str_contains($joined, 'normaldx') || str_contains($joined, 'nordx') || str_contains($joined, 'directx');

                    return $isDx ? 'normal_dx' : 'normal';
                }

                return $map;
            }
        }

        return null;
    }

    /**
     * @param  list<array{name: string, bytes: string}>  $files
     * @param  array{make_seamless?: bool, name?: string, category?: string, tile_size?: float}  $options
     */
    public function import(Material $material, array $files, array $options = []): Material
    {
        if ($files === []) {
            throw new RuntimeException('Upload at least one image.');
        }

        $maps = [];
        $unassigned = [];

        foreach ($files as $file) {
            $kind = count($files) === 1 ? 'albedo' : self::detectMap($file['name']);

            if ($kind === null || isset($maps[$kind])) {
                $unassigned[] = $file;

                continue;
            }

            $maps[$kind] = $file['bytes'];
        }

        // An unrecognised file becomes the albedo when none was named as such.
        if (! isset($maps['albedo']) && $unassigned !== []) {
            $maps['albedo'] = array_shift($unassigned)['bytes'];
        }

        if (! isset($maps['albedo'])) {
            throw new RuntimeException('No colour (albedo / base colour / diffuse) image found among the uploaded files.');
        }

        $decoded = [];
        foreach ($maps as $kind => $bytes) {
            $decoded[$kind] = $this->processor->decode($bytes);
        }

        if (isset($decoded['normal_dx'])) {
            $decoded['normal'] ??= $this->processor->flipNormalGreen($decoded['normal_dx']);
            unset($decoded['normal_dx']);
        }

        if (isset($decoded['arm'])) {
            [$ao, $rough] = $this->processor->splitChannels($decoded['arm']);
            $decoded['ao'] ??= $ao;
            $decoded['roughness'] ??= $rough;
            unset($decoded['arm']);
        }

        /** @var GdImage $albedo */
        $albedo = $decoded['albedo'];
        $size = MaterialBuilder::sizeForImage($albedo);

        return $this->builder->build($material, $decoded, $size, [
            'seamless' => (bool) ($options['make_seamless'] ?? false),
        ], [
            'source' => 'upload',
        ]);
    }
}
