<?php

namespace App\Mcp;

use App\Models\Map;
use App\Services\Terrain\TerrainStorage;

/**
 * A map's saved terrain grids (heights, paint, water) with world-space lookups, for agent tools that
 * work without the live editor (map images, terrain samples). World x runs west → east and z north →
 * south, from -size/2 to +size/2; grid sample (col, row) sits at x = -size/2 + col·cell.
 */
class TerrainData
{
    public readonly int $res;

    public readonly float $size;

    public readonly float $cell;

    /** @var array<int, float> heights, row-major (0-based) */
    private array $heights;

    /** @var array<int, float>|null water surface per sample (NO_WATER = dry) */
    private ?array $water;

    /** Eight weight bytes per sample (one per layer slot). */
    private ?string $splat;

    public function __construct(public readonly Map $map, TerrainStorage $storage)
    {
        $heights = $storage->read($map, 'heightmap');

        if ($heights === null) {
            throw new ToolError("Map \"{$map->slug}\" has no terrain yet (status: {$map->terrain_status->value}).");
        }

        $this->res = $map->resolution;
        $this->size = (float) $map->size;
        $this->cell = $this->size / max(1, $this->res - 1);
        $this->heights = array_values(unpack('g*', $heights));
        $water = $storage->read($map, 'water');
        $this->water = $water !== null ? array_values(unpack('g*', $water)) : null;
        $this->splat = $storage->read($map, 'splatmap');
    }

    public static function load(Map $map): self
    {
        return new self($map, app(TerrainStorage::class));
    }

    /** Fractional grid coordinates of a world position. */
    public function toGrid(float $x, float $z): array
    {
        return [($x + $this->size / 2) / $this->cell, ($z + $this->size / 2) / $this->cell];
    }

    public function contains(float $x, float $z): bool
    {
        return abs($x) <= $this->size / 2 && abs($z) <= $this->size / 2;
    }

    public function heightAt(int $col, int $row): float
    {
        $col = max(0, min($this->res - 1, $col));
        $row = max(0, min($this->res - 1, $row));

        return $this->heights[$row * $this->res + $col];
    }

    /** Ground height (bilinear) at a world position. */
    public function height(float $x, float $z): float
    {
        [$gx, $gz] = $this->toGrid($x, $z);
        $c = (int) floor($gx);
        $r = (int) floor($gz);
        $fx = $gx - $c;
        $fz = $gz - $r;
        $top = $this->heightAt($c, $r) * (1 - $fx) + $this->heightAt($c + 1, $r) * $fx;
        $bottom = $this->heightAt($c, $r + 1) * (1 - $fx) + $this->heightAt($c + 1, $r + 1) * $fx;

        return $top * (1 - $fz) + $bottom * $fz;
    }

    /** Slope in degrees at a grid sample (central differences). */
    public function slopeAt(int $col, int $row): float
    {
        $dx = ($this->heightAt($col + 1, $row) - $this->heightAt($col - 1, $row)) / (2 * $this->cell);
        $dz = ($this->heightAt($col, $row + 1) - $this->heightAt($col, $row - 1)) / (2 * $this->cell);

        return rad2deg(atan(sqrt($dx * $dx + $dz * $dz)));
    }

    /** Water surface height at a grid sample, or null when dry. */
    public function waterAt(int $col, int $row): ?float
    {
        if ($this->water === null) {
            return null;
        }

        $col = max(0, min($this->res - 1, $col));
        $row = max(0, min($this->res - 1, $row));
        $level = $this->water[$row * $this->res + $col];

        return $level > TerrainStorage::NO_WATER + 1 ? $level : null;
    }

    /**
     * Paint weights (0-255) of the eight layer slots at a grid sample.
     *
     * @return array<int, int> slot => weight
     */
    public function weightsAt(int $col, int $row): array
    {
        if ($this->splat === null) {
            return [0 => 255, 1 => 0, 2 => 0, 3 => 0, 4 => 0, 5 => 0, 6 => 0, 7 => 0];
        }

        $col = max(0, min($this->res - 1, $col));
        $row = max(0, min($this->res - 1, $row));

        return array_values(unpack('C8', $this->splat, ($row * $this->res + $col) * TerrainStorage::SPLAT_CHANNELS));
    }

    public function hasPaint(): bool
    {
        return $this->splat !== null;
    }

    /** Lowest and highest ground height. */
    public function range(): array
    {
        return [min($this->heights), max($this->heights)];
    }
}
