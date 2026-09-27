<?php

namespace App\Services\LandCover;

use InvalidArgumentException;

/**
 * A resolution × resolution grid of WorldCover class codes (one byte per sample, row 0 = north,
 * col 0 = west), stored as-is in landcover.u8.
 */
final class LandCoverGrid
{
    public function __construct(public readonly int $resolution, public string $data)
    {
        if (strlen($data) !== $resolution * $resolution) {
            throw new InvalidArgumentException(sprintf(
                'Expected %d land cover samples, got %d.', $resolution * $resolution, strlen($data),
            ));
        }
    }

    public static function filled(int $resolution, int $class = WorldCoverClasses::NO_DATA): self
    {
        return new self($resolution, str_repeat(chr($class), $resolution * $resolution));
    }

    public static function fromBinary(int $resolution, string $bytes): self
    {
        return new self($resolution, $bytes);
    }

    public function toBinary(): string
    {
        return $this->data;
    }

    public function get(int $col, int $row): int
    {
        return ord($this->data[$row * $this->resolution + $col]);
    }

    /**
     * Share of each class in percent (one decimal), largest first.
     *
     * @return array<int, float>
     */
    public function stats(): array
    {
        $total = strlen($this->data);
        $stats = [];

        foreach (count_chars($this->data, 1) as $code => $count) {
            $stats[$code] = round(100 * $count / $total, 1);
        }

        arsort($stats);

        return $stats;
    }

    /**
     * e.g. "Land cover: 62% forest, 20% grassland, 9% water."
     */
    public function summary(int $limit = 4): string
    {
        $parts = [];

        foreach ($this->stats() as $code => $percent) {
            if (count($parts) >= $limit || $percent < 1) {
                break;
            }
            $parts[] = round($percent).'% '.(WorldCoverClasses::SHORT[$code] ?? "class {$code}");
        }

        return $parts === [] ? 'Land cover: no data.' : 'Land cover: '.implode(', ', $parts).'.';
    }
}
