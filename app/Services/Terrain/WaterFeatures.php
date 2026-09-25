<?php

namespace App\Services\Terrain;

/**
 * Water geometry in lat/lng as returned by OverpassWaterSource.
 *
 * Points are [lat, lng] pairs. Rings are open or closed (the rasterizer treats them as closed).
 * Polygon kind is 'lake' (standing water: lakes, ponds, reservoirs, basins, docks) or 'river'
 * (river / canal areas whose level follows the waterway line inside them).
 */
final readonly class WaterFeatures
{
    /**
     * @param  list<array{outer: list<array{0: float, 1: float}>, inners: list<list<array{0: float, 1: float}>>, tags: array<string, string>, kind?: string}>  $polygons
     * @param  list<array{points: list<array{0: float, 1: float}>, width: float, kind: string}>  $lines
     * @param  list<list<array{0: float, 1: float}>>  $coastlines  natural=coastline ways (land left, sea right)
     */
    public function __construct(
        public array $polygons = [],
        public array $lines = [],
        public ?string $warning = null,
        public array $coastlines = [],
    ) {}

    public static function unavailable(string $warning): self
    {
        return new self([], [], $warning);
    }

    public function isEmpty(): bool
    {
        return $this->polygons === [] && $this->lines === [] && $this->coastlines === [];
    }

    public function withWarning(?string $warning): self
    {
        return new self($this->polygons, $this->lines, $warning, $this->coastlines);
    }

    /**
     * Human readable import summary, e.g. "3 lakes, 1 river area, 12 rivers/streams".
     */
    public function summary(): string
    {
        $lakes = 0;
        $rivers = 0;
        foreach ($this->polygons as $polygon) {
            ($polygon['kind'] ?? 'lake') === 'river' ? $rivers++ : $lakes++;
        }

        $parts = [];
        if ($lakes > 0) {
            $parts[] = $lakes.' '.($lakes === 1 ? 'lake' : 'lakes');
        }
        if ($rivers > 0) {
            $parts[] = $rivers.' '.($rivers === 1 ? 'river area' : 'river areas');
        }
        if ($this->lines !== []) {
            $parts[] = count($this->lines).' rivers/streams';
        }
        if ($this->coastlines !== []) {
            $parts[] = 'coastline';
        }

        return implode(', ', $parts);
    }

    /**
     * Project everything into grid coordinates for WaterSurfaceBuilder.
     *
     * @return array{polygons: list<array{outer: list<array{0: float, 1: float}>, inners: list<list<array{0: float, 1: float}>>, kind: string}>, lines: list<array{points: list<array{0: float, 1: float}>, width: float, kind: string}>, coastlines: list<list<array{0: float, 1: float}>>}
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
                'kind' => $polygon['kind'] ?? 'lake',
            ], $this->polygons),
            'lines' => array_map(static fn (array $line): array => [
                'points' => $ring($line['points']),
                'width' => $line['width'],
                'kind' => $line['kind'],
            ], $this->lines),
            'coastlines' => array_map($ring, $this->coastlines),
        ];
    }
}
