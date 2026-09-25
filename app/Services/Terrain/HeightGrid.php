<?php

namespace App\Services\Terrain;

use InvalidArgumentException;

/**
 * A square resolution × resolution grid of floats, row-major (row 0 = north, col 0 = west).
 *
 * The samples live in a plain packed PHP array exposed as `$data` so hot loops can index it
 * directly (`$data[$row * $resolution + $col]`) instead of paying for method calls.
 */
final class HeightGrid
{
    /** @var array<int, float> */
    public array $data;

    /**
     * @param  array<int, float>|null  $data
     */
    public function __construct(public readonly int $resolution, ?array $data = null, float $fill = 0.0)
    {
        if ($resolution < 2) {
            throw new InvalidArgumentException('Grid resolution must be at least 2.');
        }

        $count = $resolution * $resolution;

        if ($data !== null && count($data) !== $count) {
            throw new InvalidArgumentException("Expected {$count} samples, got ".count($data).'.');
        }

        $this->data = $data ?? array_fill(0, $count, $fill);
    }

    public static function filled(int $resolution, float $value): self
    {
        return new self($resolution, null, $value);
    }

    public static function fromBinary(int $resolution, string $bytes): self
    {
        return new self($resolution, TerrainStorage::unpackFloats($bytes));
    }

    public function count(): int
    {
        return $this->resolution * $this->resolution;
    }

    public function get(int $col, int $row): float
    {
        return $this->data[$row * $this->resolution + $col];
    }

    public function set(int $col, int $row, float $value): void
    {
        $this->data[$row * $this->resolution + $col] = $value;
    }

    /**
     * Bilinear sample at fractional grid coordinates (clamped to the grid).
     */
    public function sample(float $col, float $row): float
    {
        $max = $this->resolution - 1;
        $col = max(0.0, min((float) $max, $col));
        $row = max(0.0, min((float) $max, $row));
        $c0 = min($max - 1, (int) $col);
        $r0 = min($max - 1, (int) $row);
        $fx = $col - $c0;
        $fy = $row - $r0;
        $i = $r0 * $this->resolution + $c0;
        $d = $this->data;

        $top = $d[$i] + ($d[$i + 1] - $d[$i]) * $fx;
        $bottom = $d[$i + $this->resolution] + ($d[$i + $this->resolution + 1] - $d[$i + $this->resolution]) * $fx;

        return $top + ($bottom - $top) * $fy;
    }

    public function min(): float
    {
        return (float) min($this->data);
    }

    public function max(): float
    {
        return (float) max($this->data);
    }

    /**
     * @return array{0: float, 1: float}
     */
    public function range(): array
    {
        return [$this->min(), $this->max()];
    }

    public function scale(float $factor): self
    {
        if ($factor !== 1.0) {
            foreach ($this->data as $i => $v) {
                $this->data[$i] = $v * $factor;
            }
        }

        return $this;
    }

    public function copy(): self
    {
        return new self($this->resolution, $this->data);
    }

    /**
     * Float32 little-endian payload as stored in heightmap.f32 / water.f32.
     */
    public function toBinary(): string
    {
        return TerrainStorage::packFloats($this->data);
    }
}
