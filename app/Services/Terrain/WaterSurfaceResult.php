<?php

namespace App\Services\Terrain;

/**
 * Output of WaterSurfaceBuilder: carved terrain, the water surface grid and some stats.
 */
final readonly class WaterSurfaceResult
{
    public function __construct(
        public HeightGrid $terrain,
        public HeightGrid $water,
        public int $waterCells,
        public int $oceanCells,
    ) {}

    public function hasWater(): bool
    {
        return $this->waterCells > 0;
    }

    public function oceanDetected(): bool
    {
        return $this->oceanCells > 0;
    }
}
