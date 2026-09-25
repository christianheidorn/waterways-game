<?php

namespace App\Services\Terrain;

/**
 * Water geometry in lat/lng as returned by OverpassWaterSource.
 *
 * Points are [lat, lng] pairs. Rings are open or closed (the rasterizer treats them as closed).
 */
final readonly class WaterFeatures
{
    /**
     * @param  list<array{outer: list<array{0: float, 1: float}>, inners: list<list<array{0: float, 1: float}>>, tags: array<string, string>}>  $polygons
     * @param  list<array{points: list<array{0: float, 1: float}>, width: float, kind: string}>  $lines
     */
    public function __construct(
        public array $polygons = [],
        public array $lines = [],
        public ?string $warning = null,
    ) {}

    public static function unavailable(string $warning): self
    {
        return new self([], [], $warning);
    }

    public function isEmpty(): bool
    {
        return $this->polygons === [] && $this->lines === [];
    }

    /**
     * Project everything into grid coordinates for WaterSurfaceBuilder.
     *
     * @return array{polygons: list<array{outer: list<array{0: float, 1: float}>, inners: list<list<array{0: float, 1: float}>>}>, lines: list<array{points: list<array{0: float, 1: float}>, width: float}>}
     */
    public function toGrid(MapProjection $projection): array
    {
        $ring = static fn (array $points): array => array_map(
            static fn (array $p): array => $projection->toGrid($p[0], $p[1]),
            $points,
        );

        return [
            'polygons' => array_map(static fn (array $polygon): array => [
                'outer' => $ring($polygon['outer']),
                'inners' => array_map($ring, $polygon['inners']),
            ], $this->polygons),
            'lines' => array_map(static fn (array $line): array => [
                'points' => $ring($line['points']),
                'width' => $line['width'],
            ], $this->lines),
        ];
    }
}
