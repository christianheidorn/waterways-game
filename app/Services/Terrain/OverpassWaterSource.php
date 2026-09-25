<?php

namespace App\Services\Terrain;

use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Sleep;
use Illuminate\Support\Str;
use Throwable;

/**
 * Water bodies (areas), waterways (lines) and coastline from OpenStreetMap via the Overpass API.
 *
 * Selects what the standard OSM map draws as water: natural=water (any water=*), waterway=riverbank
 * / dock, landuse=reservoir / basin as areas (closed ways and multipolygon relations, with holes),
 * waterway=river / stream / canal / drain / ditch as lines, and natural=coastline.
 */
class OverpassWaterSource
{
    public const DEFAULT_URLS = [
        'https://overpass-api.de/api/interpreter',
        'https://overpass.kumi.systems/api/interpreter',
        'https://overpass.private.coffee/api/interpreter',
    ];

    /** Default channel widths (metres) when a waterway has no numeric width tag. */
    public const LINE_WIDTHS = [
        'river' => 18.0,
        'canal' => 10.0,
        'stream' => 3.0,
        'drain' => 1.5,
        'ditch' => 1.5,
    ];

    /** water=* values of areas that are part of a flowing waterway. */
    private const RIVER_AREA_WATER = ['river', 'canal', 'stream', 'ditch', 'drain', 'rapids', 'stream_pool'];

    /** Rounds over the endpoint list, and the overall time budget (seconds). */
    private const ROUNDS = 2;

    private const TIME_BUDGET = 300;

    private const EPSILON = 1e-9;

    /**
     * Overpass endpoints in the order they are tried.
     *
     * @return list<string>
     */
    public static function endpoints(): array
    {
        $urls = config('services.overpass.urls');
        $urls = is_array($urls) && $urls !== [] ? $urls : self::DEFAULT_URLS;
        $single = config('services.overpass.url');

        if (is_string($single) && trim($single) !== '') {
            array_unshift($urls, $single);
        }

        return array_values(array_unique(array_filter(array_map(
            static fn ($url): string => trim((string) $url),
            $urls,
        ))));
    }

    /**
     * @param  array{south: float, west: float, north: float, east: float}  $bounds
     */
    public function fetch(array $bounds): WaterFeatures
    {
        $query = $this->query($bounds);
        $errors = [];
        $partial = null;
        $started = microtime(true);

        for ($round = 0; $round < self::ROUNDS; $round++) {
            if ($round > 0) {
                if (microtime(true) - $started > self::TIME_BUDGET / 2) {
                    break;
                }
                Sleep::for(3)->seconds();
            }

            foreach (self::endpoints() as $url) {
                if (microtime(true) - $started > self::TIME_BUDGET) {
                    break 2;
                }

                $host = parse_url($url, PHP_URL_HOST) ?: $url;

                try {
                    $response = Http::asForm()
                        ->withUserAgent('Waterways terrain importer')
                        ->connectTimeout(10)
                        ->timeout(100)
                        ->acceptJson()
                        ->post($url, ['data' => $query]);
                } catch (Throwable $e) {
                    $errors[$host] = $this->describe($e);
                    Log::warning('Overpass water query failed', ['url' => $url, 'error' => $e->getMessage()]);

                    continue;
                }

                $result = $this->handle($response);

                if ($result instanceof WaterFeatures) {
                    if ($result->warning === null) {
                        return $result;
                    }
                    $partial ??= $result;
                    $errors[$host] = $result->warning;
                } else {
                    $errors[$host] = $result;
                }

                Log::warning('Overpass water query failed', ['url' => $url, 'error' => $errors[$host]]);
            }
        }

        $detail = collect($errors)->map(fn (string $error, string $host) => "{$host}: {$error}")->implode('; ');

        if ($partial !== null) {
            return $partial->withWarning('Incomplete water data ('.$detail.')');
        }

        return WaterFeatures::unavailable($errors === [] ? 'no Overpass endpoint configured' : 'all Overpass servers failed ('.$detail.')');
    }

    private function describe(Throwable $e): string
    {
        $message = $e->getMessage();

        if (Str::contains(strtolower($message), ['timed out', 'timeout'])) {
            return 'timeout';
        }

        // "cURL error 56: CONNECT tunnel failed, response 403 (see https://…)" → the part before "(see".
        return Str::limit(trim(Str::before($message, '(see')), 60);
    }

    /**
     * @return WaterFeatures|string features (possibly partial, with a warning) or an error
     */
    private function handle(Response $response): WaterFeatures|string
    {
        if (! $response->successful()) {
            return "HTTP {$response->status()}";
        }

        $json = $response->json();

        if (! is_array($json) || ! isset($json['elements']) || ! is_array($json['elements'])) {
            return 'unexpected response';
        }

        $features = $this->parse($json['elements']);
        $remark = strtolower((string) ($json['remark'] ?? ''));

        if (str_contains($remark, 'error') || str_contains($remark, 'timed out')) {
            return $features->isEmpty()
                ? Str::limit((string) $json['remark'], 80)
                : $features->withWarning(Str::limit((string) $json['remark'], 80));
        }

        return $features;
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
              way["waterway"~"^(riverbank|dock)$"]({$bbox});
              relation["waterway"~"^(riverbank|dock)$"]({$bbox});
              way["landuse"~"^(reservoir|basin)$"]({$bbox});
              relation["landuse"~"^(reservoir|basin)$"]({$bbox});
              way["waterway"~"^(river|stream|canal|drain|ditch)$"]({$bbox});
              way["natural"="coastline"]({$bbox});
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
        $coastlines = [];

        // Ways that are members of a returned multipolygon are assembled through the relation.
        $memberWays = [];
        foreach ($elements as $element) {
            if (($element['type'] ?? null) === 'relation') {
                foreach ((array) ($element['members'] ?? []) as $member) {
                    if (($member['type'] ?? null) === 'way' && isset($member['ref'])) {
                        $memberWays[(int) $member['ref']] = true;
                    }
                }
            }
        }

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

            if ($type === 'way' && ($tags['natural'] ?? null) === 'coastline') {
                $points = $this->points($element['geometry'] ?? []);
                if (count($points) >= 2) {
                    $coastlines[] = $points;
                }

                continue;
            }

            if (! $this->isWaterArea($tags)) {
                continue;
            }

            $kind = $this->areaKind($tags);

            if ($type === 'way') {
                $ring = $this->points($element['geometry'] ?? []);
                $closed = count($ring) >= 4 && $this->same($ring[0], end($ring));

                if (! $closed && isset($memberWays[(int) ($element['id'] ?? 0)])) {
                    continue;
                }
                if (! $closed && count($ring) >= 3) {
                    $ring[] = $ring[0];
                    $closed = true;
                }
                if ($closed) {
                    $polygons[] = ['outer' => $ring, 'inners' => [], 'tags' => $tags, 'kind' => $kind];
                }
            } elseif ($type === 'relation' && in_array($tags['type'] ?? 'multipolygon', ['multipolygon', 'boundary'], true)) {
                array_push($polygons, ...$this->relationPolygons($element, $tags, $kind));
            }
        }

        return new WaterFeatures($polygons, $lines, null, $coastlines);
    }

    /**
     * @param  array<string, string>  $tags
     */
    private function isWaterArea(array $tags): bool
    {
        return ($tags['natural'] ?? null) === 'water'
            || isset($tags['water'])
            || in_array($tags['waterway'] ?? null, ['riverbank', 'dock'], true)
            || in_array($tags['landuse'] ?? null, ['reservoir', 'basin'], true);
    }

    /**
     * @param  array<string, string>  $tags
     */
    private function areaKind(array $tags): string
    {
        return ($tags['waterway'] ?? null) === 'riverbank' || in_array($tags['water'] ?? null, self::RIVER_AREA_WATER, true)
            ? 'river'
            : 'lake';
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
     * Tags may live on the relation only (member ways untagged); member geometry is complete
     * (`out geom;` is not clipped to the bbox), so rings reaching outside the map still close.
     *
     * @param  array<string, mixed>  $relation
     * @param  array<string, string>  $tags
     * @return list<array{outer: list<array{0: float, 1: float}>, inners: list<list<array{0: float, 1: float}>>, tags: array<string, string>, kind: string}>
     */
    private function relationPolygons(array $relation, array $tags, string $kind): array
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

        $polygons = array_map(fn (array $ring) => ['outer' => $ring, 'inners' => [], 'tags' => $tags, 'kind' => $kind], $outers);

        if ($polygons === []) {
            return [];
        }

        foreach ($inners as $inner) {
            $target = array_key_last($polygons);
            foreach ($polygons as $k => $polygon) {
                if ($this->contains($polygon['outer'], $inner[0])) {
                    $target = $k;
                    break;
                }
            }
            $polygons[$target]['inners'][] = $inner;
        }

        return $polygons;
    }

    /**
     * Join ways end-to-end (reversing where needed, growing at both ends) into closed rings.
     * Chains that cannot be closed by other ways are closed by joining their ends (≥ 3 points).
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

            while (! (count($ring) >= 4 && $this->same($ring[0], end($ring)))) {
                $head = $ring[0];
                $tail = end($ring);
                $found = false;

                foreach ($open as $k => $way) {
                    if ($this->same($way[0], $tail)) {
                        array_pop($ring);
                        array_push($ring, ...$way);
                    } elseif ($this->same(end($way), $tail)) {
                        array_pop($ring);
                        array_push($ring, ...array_reverse($way));
                    } elseif ($this->same(end($way), $head)) {
                        array_shift($ring);
                        $ring = [...$way, ...$ring];
                    } elseif ($this->same($way[0], $head)) {
                        array_shift($ring);
                        $ring = [...array_reverse($way), ...$ring];
                    } else {
                        continue;
                    }

                    unset($open[$k]);
                    $found = true;
                    break;
                }

                if (! $found) {
                    break;
                }
            }

            if (! $this->same($ring[0], end($ring)) && count($ring) >= 3) {
                $ring[] = $ring[0];
            }

            if (count($ring) >= 4) {
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
