<?php

namespace App\Services\Terrain;

use App\Models\Map;
use InvalidArgumentException;

/**
 * Converts between a real-world map's grid coordinates and lat/lng using the same
 * equirectangular approximation as Map::bounds().
 *
 * Grid (col, row) sits at world x = -size/2 + col·cell (east), z = -size/2 + row·cell (south).
 */
final class MapProjection
{
    public const METRES_PER_DEGREE = 111_320.0;

    public readonly float $cell;

    private readonly float $metresPerDegreeLng;

    public function __construct(
        public readonly float $centerLat,
        public readonly float $centerLng,
        public readonly float $size,
        public readonly int $resolution,
    ) {
        $this->cell = $size / ($resolution - 1);
        $this->metresPerDegreeLng = self::METRES_PER_DEGREE * cos(deg2rad($centerLat));
    }

    public static function forMap(Map $map): self
    {
        if ($map->center_lat === null || $map->center_lng === null) {
            throw new InvalidArgumentException('Map has no geographic centre.');
        }

        return new self($map->center_lat, $map->center_lng, $map->size, $map->resolution);
    }

    /**
     * @return array{0: float, 1: float} [lat, lng]
     */
    public function toLatLng(float $col, float $row): array
    {
        $x = -$this->size / 2 + $col * $this->cell;
        $z = -$this->size / 2 + $row * $this->cell;

        return [
            $this->centerLat - $z / self::METRES_PER_DEGREE,
            $this->centerLng + $x / $this->metresPerDegreeLng,
        ];
    }

    /**
     * @return array{0: float, 1: float} [col, row] (fractional, may lie outside the grid)
     */
    public function toGrid(float $lat, float $lng): array
    {
        $x = ($lng - $this->centerLng) * $this->metresPerDegreeLng;
        $z = ($this->centerLat - $lat) * self::METRES_PER_DEGREE;

        return [($x + $this->size / 2) / $this->cell, ($z + $this->size / 2) / $this->cell];
    }

    /**
     * @return array{south: float, west: float, north: float, east: float}
     */
    public function bounds(): array
    {
        $latDelta = ($this->size / 2) / self::METRES_PER_DEGREE;
        $lngDelta = ($this->size / 2) / $this->metresPerDegreeLng;

        return [
            'south' => $this->centerLat - $latDelta,
            'west' => $this->centerLng - $lngDelta,
            'north' => $this->centerLat + $latDelta,
            'east' => $this->centerLng + $lngDelta,
        ];
    }
}
