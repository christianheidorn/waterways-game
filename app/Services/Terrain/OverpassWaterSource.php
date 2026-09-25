<?php

namespace App\Services\Terrain;

use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Water bodies (areas) and waterways (lines) from OpenStreetMap via the Overpass API.
 */
class OverpassWaterSource
{
    public const DEFAULT_URL = 'https://overpass-api.de/api/interpreter';

    /** Default channel widths (metres) when a waterway has no numeric width tag. */
    public const LINE_WIDTHS = [
        'river' => 18.0,
        'canal' => 10.0,
        'stream' => 3.0,
        'drain' => 1.5,
        'ditch' => 1.5,
    ];

    private const EPSILON = 1e-9;

    /**
     * @param  array{south: float, west: float, north: float, east: float}  $bounds
     */
    public function fetch(array $bounds): WaterFeatures
    {
        try {
            $response = Http::asForm()
                ->connectTimeout(15)
                ->timeout(120)
                ->acceptJson()
                ->post((string) config('services.overpass.url', self::DEFAULT_URL), ['data' => $this->query($bounds)]);

            if (! $response->successful()) {
                return WaterFeatures::unavailable("Overpass returned HTTP {$response->status()}");
            }

            $json = $response->json();

            if (! is_array($json) || ! isset($json['elements']) || ! is_array($json['elements'])) {
                return WaterFeatures::unavailable('Overpass returned an unexpected response');
            }

            $features = $this->parse($json['elements']);

            if (isset($json['remark']) && str_contains(strtolower((string) $json['remark']), 'error')) {
                return new WaterFeatures($features->polygons, $features->lines, 'Overpass: '.$json['remark']);
            }

            return $features;
        } catch (Throwable $e) {
            Log::warning('Overpass water query failed', ['error' => $e->getMessage()]);

            return WaterFeatures::unavailable($e->getMessage());
        }
    }

    /**
     * @param  array{south: float, west: float, north: float, east: float}  $bounds
     */
    public function query(array $bounds): string
    {
        $bbox = sprintf('%.7F,%.7F,%.7F,%.7F', $bounds['south'], $bounds['west'], $bounds['north'], $bounds['east']);

        return <<<OVERPASS
            [out:json][timeout:90];
            (
              way["natural"="water"]({$bbox});
              relation["natural"="water"]({$bbox});
              way["water"]({$bbox});
              relation["water"]({$bbox});
              way["waterway"="riverbank"]({$bbox});
              relation["waterway"="riverbank"]({$bbox});
              way["landuse"~"^(reservoir|basin)$"]({$bbox});
              relation["landuse"~"^(reservoir|basin)$"]({$bbox});
              way["waterway"~"^(river|stream|canal|drain|ditch)$"]({$bbox});
            );
            out geom;
            OVERPASS;
    }

    /**
     * @param  array<int, array<string, mixed>>  $elements
     */
    public function parse(array $elements): WaterFeatures
    {
        $polygons = [];
        $lines = [];

        foreach ($elements as $element) {
            $tags = array_map('strval', (array) ($element['tags'] ?? []));
            $type = $element['type'] ?? null;

            if (($tags['natural'] ?? null) === 'wetland') {
                continue;
            }

            $lineKind = $tags['waterway'] ?? null;

            if ($type === 'way' && isset(self::LINE_WIDTHS[$lineKind])) {
                $points = $this->points($element['geometry'] ?? []);
                if (count($points) >= 2) {
                    $lines[] = ['points' => $points, 'width' => $this->width($tags, $lineKind), 'kind' => $lineKind];
                }

                continue;
            }

            if (! $this->isWaterArea($tags)) {
                continue;
            }

            if ($type === 'way') {
                $ring = $this->points($element['geometry'] ?? []);
                if (count($ring) >= 4 && $this->same($ring[0], end($ring))) {
                    $polygons[] = ['outer' => $ring, 'inners' => [], 'tags' => $tags];
                }
            } elseif ($type === 'relation') {
                array_push($polygons, ...$this->relationPolygons($element, $tags));
            }
        }

        return new WaterFeatures($polygons, $lines);
    }

    /**
     * @param  array<string, string>  $tags
     */
    private function isWaterArea(array $tags): bool
    {
        return ($tags['natural'] ?? null) === 'water'
            || isset($tags['water'])
            || ($tags['waterway'] ?? null) === 'riverbank'
            || in_array($tags['landuse'] ?? null, ['reservoir', 'basin'], true);
    }

    /**
     * @param  array<string, string>  $tags
     */
    private function width(array $tags, string $kind): float
    {
        $raw = str_replace(',', '.', trim($tags['width'] ?? ''));

        if (preg_match('/^\d+(\.\d+)?(\s*m)?$/', $raw) && (float) $raw > 0) {
            return min((float) $raw, 2000.0);
        }

        return self::LINE_WIDTHS[$kind];
    }

    /**
     * Stitch a multipolygon relation's member ways into closed rings and group inners by outer.
     *
     * @param  array<string, mixed>  $relation
     * @param  array<string, string>  $tags
     * @return list<array{outer: list<array{0: float, 1: float}>, inners: list<list<array{0: float, 1: float}>>, tags: array<string, string>}>
     */
    private function relationPolygons(array $relation, array $tags): array
    {
        $ways = ['outer' => [], 'inner' => []];

        foreach ((array) ($relation['members'] ?? []) as $member) {
            if (($member['type'] ?? null) !== 'way') {
                continue;
            }
            $role = ($member['role'] ?? '') === 'inner' ? 'inner' : 'outer';
            $points = $this->points($member['geometry'] ?? []);
            if (count($points) >= 2) {
                $ways[$role][] = $points;
            }
        }

        $outers = $this->stitch($ways['outer']);
        $inners = $this->stitch($ways['inner']);

        $polygons = array_map(fn (array $ring) => ['outer' => $ring, 'inners' => [], 'tags' => $tags], $outers);

        foreach ($inners as $inner) {
            foreach ($polygons as $k => $polygon) {
                if ($this->contains($polygon['outer'], $inner[0]) || $k === array_key_last($polygons)) {
                    $polygons[$k]['inners'][] = $inner;
                    break;
                }
            }
        }

        return $polygons;
    }

    /**
     * Join open ways end-to-end (reversing where needed) into closed rings. Rings that cannot be
     * closed are dropped.
     *
     * @param  list<list<array{0: float, 1: float}>>  $ways
     * @return list<list<array{0: float, 1: float}>>
     */
    public function stitch(array $ways): array
    {
        $rings = [];
        $open = [];

        foreach ($ways as $way) {
            if (count($way) >= 4 && $this->same($way[0], end($way))) {
                $rings[] = $way;
            } else {
                $open[] = $way;
            }
        }

        while ($open) {
            $ring = array_shift($open);

            while (! $this->same($ring[0], end($ring))) {
                $tail = end($ring);
                $found = false;

                foreach ($open as $k => $way) {
                    if ($this->same($way[0], $tail)) {
                        $next = $way;
                    } elseif ($this->same(end($way), $tail)) {
                        $next = array_reverse($way);
                    } else {
                        continue;
                    }

                    array_pop($ring);
                    array_push($ring, ...$next);
                    unset($open[$k]);
                    $found = true;
                    break;
                }

                if (! $found) {
                    break;
                }
            }

            if (count($ring) >= 4 && $this->same($ring[0], end($ring))) {
                $rings[] = $ring;
            }

            $open = array_values($open);
        }

        return $rings;
    }

    /**
     * @param  mixed  $geometry
     * @return list<array{0: float, 1: float}>
     */
    private function points($geometry): array
    {
        $points = [];

        foreach ((array) $geometry as $node) {
            if (isset($node['lat'], $node['lon'])) {
                $points[] = [(float) $node['lat'], (float) $node['lon']];
            }
        }

        return $points;
    }

    /**
     * @param  array{0: float, 1: float}  $a
     * @param  array{0: float, 1: float}  $b
     */
    private function same(array $a, array $b): bool
    {
        return abs($a[0] - $b[0]) < self::EPSILON && abs($a[1] - $b[1]) < self::EPSILON;
    }

    /**
     * @param  list<array{0: float, 1: float}>  $ring
     * @param  array{0: float, 1: float}  $point
     */
    private function contains(array $ring, array $point): bool
    {
        $inside = false;
        $count = count($ring);

        for ($i = 0, $j = $count - 1; $i < $count; $j = $i++) {
            [$yi, $xi] = $ring[$i];
            [$yj, $xj] = $ring[$j];
            if ((($yi > $point[0]) !== ($yj > $point[0]))
                && $point[1] < ($xj - $xi) * ($point[0] - $yi) / ($yj - $yi) + $xi) {
                $inside = ! $inside;
            }
        }

        return $inside;
    }
}
