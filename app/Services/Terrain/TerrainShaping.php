<?php

namespace App\Services\Terrain;

use App\Models\Map;

/**
 * Per-map water depth and terrain shaping settings used by the generators.
 */
final readonly class TerrainShaping
{
    public const DEFAULTS = [
        'lake_depth' => 6.0,
        'river_depth' => 2.0,
        'shore_angle' => 15.0,
        'bank_angle' => 35.0,
        'smoothing' => 0.5,
    ];

    /** Shallowest water right at the shore (metres). */
    public const MIN_DEPTH = 0.3;

    public function __construct(
        public float $lakeDepth = self::DEFAULTS['lake_depth'],
        public float $riverDepth = self::DEFAULTS['river_depth'],
        public float $shoreAngle = self::DEFAULTS['shore_angle'],
        public float $bankAngle = self::DEFAULTS['bank_angle'],
        public float $smoothing = self::DEFAULTS['smoothing'],
    ) {}

    public static function fromMap(Map $map): self
    {
        $value = static fn (string $key): float => (float) ($map->getAttribute($key) ?? self::DEFAULTS[$key]);

        return new self(
            max(self::MIN_DEPTH, $value('lake_depth')),
            max(self::MIN_DEPTH, $value('river_depth')),
            max(0.5, min(89.0, $value('shore_angle'))),
            max(1.0, min(89.0, $value('bank_angle'))),
            max(0.0, min(1.0, $value('smoothing'))),
        );
    }

    /**
     * Water depth at a distance (metres) from the shore, capped at $maxDepth.
     */
    public function depthAt(float $distance, float $maxDepth): float
    {
        return min(max($maxDepth, self::MIN_DEPTH), self::MIN_DEPTH + max(0.0, $distance) * tan(deg2rad($this->shoreAngle)));
    }
}
