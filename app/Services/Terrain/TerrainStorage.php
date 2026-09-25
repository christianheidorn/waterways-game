<?php

namespace App\Services\Terrain;

use App\Models\Map;
use Illuminate\Contracts\Filesystem\Filesystem;
use Illuminate\Support\Facades\Storage;
use RuntimeException;

/**
 * Reads and writes a map's binary world data (see resources/game/shared/types.ts for formats):
 *
 * - heightmap.f32  Float32 LE, resolution² samples, metres
 * - water.f32      Float32 LE, resolution² water surface heights (NO_WATER where dry)
 * - splat.u8       Uint8, resolution² × 8 channel weights (two RGBA textures, interleaved per texel)
 * - foliage.json   {"version":1,"instances":{"<typeId>":[x,y,z,yaw,scale,tiltX,tiltZ,...]}}
 */
class TerrainStorage
{
    public const NO_WATER = -100000.0;

    public const SPLAT_CHANNELS = 8;

    public const FILES = [
        'heightmap' => 'heightmap.f32',
        'water' => 'water.f32',
        'splatmap' => 'splat.u8',
        'foliage' => 'foliage.json',
    ];

    public function disk(): Filesystem
    {
        return Storage::disk('local');
    }

    public function path(Map $map, string $asset): string
    {
        $file = self::FILES[$asset] ?? throw new RuntimeException("Unknown terrain asset [{$asset}].");

        return $map->storageDirectory().'/'.$file;
    }

    public function exists(Map $map, string $asset): bool
    {
        return $this->disk()->exists($this->path($map, $asset));
    }

    public function read(Map $map, string $asset): ?string
    {
        return $this->exists($map, $asset) ? $this->disk()->get($this->path($map, $asset)) : null;
    }

    public function write(Map $map, string $asset, string $contents): void
    {
        $this->assertValidSize($map, $asset, $contents);
        $this->disk()->put($this->path($map, $asset), $contents);
    }

    public function delete(Map $map, string $asset): void
    {
        $this->disk()->delete($this->path($map, $asset));
    }

    public function expectedBytes(Map $map, string $asset): ?int
    {
        $samples = $map->resolution * $map->resolution;

        return match ($asset) {
            'heightmap', 'water' => $samples * 4,
            'splatmap' => $samples * self::SPLAT_CHANNELS,
            default => null,
        };
    }

    public function assertValidSize(Map $map, string $asset, string $contents): void
    {
        $expected = $this->expectedBytes($map, $asset);

        if ($expected !== null && strlen($contents) !== $expected) {
            throw new RuntimeException(sprintf(
                'Invalid %s payload: expected %d bytes, got %d.', $asset, $expected, strlen($contents),
            ));
        }
    }

    /**
     * @param  array<int, float>|\SplFixedArray<float>  $values
     */
    public static function packFloats(array|\SplFixedArray $values): string
    {
        $values = $values instanceof \SplFixedArray ? $values->toArray() : $values;
        $out = '';

        foreach (array_chunk($values, 8192) as $chunk) {
            $out .= pack('g*', ...$chunk);
        }

        return $out;
    }

    /**
     * @return list<float>
     */
    public static function unpackFloats(string $bytes): array
    {
        /** @var list<float> */
        return array_values(unpack('g*', $bytes) ?: []);
    }

    /**
     * Height range of a packed heightmap.
     *
     * @return array{0: float, 1: float}
     */
    public static function range(string $heightmap): array
    {
        $values = self::unpackFloats($heightmap);

        return [min($values), max($values)];
    }
}
