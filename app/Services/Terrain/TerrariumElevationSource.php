<?php

namespace App\Services\Terrain;

use App\Models\Map;
use GdImage;
use Illuminate\Contracts\Filesystem\Filesystem;
use Illuminate\Http\Client\Pool;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Storage;
use RuntimeException;

/**
 * Real-world elevation from the AWS Terrain Tiles dataset (Terrarium PNG encoding):
 * height = R·256 + G + B/256 − 32768 metres.
 */
class TerrariumElevationSource
{
    public const TILE_SIZE = 256;

    public const MAX_ZOOM = 15;

    public const MAX_TILES = 144;

    public const DEFAULT_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

    /** Ground resolution (m/px) of zoom 0 at the equator for 256 px tiles. */
    private const EQUATOR_RESOLUTION = 156543.03392804097;

    private const CACHE_DIR = 'cache/terrarium';

    private const CONCURRENCY = 8;

    /** @var array<string, GdImage> decoded tile images for the current tile row */
    private array $images = [];

    /**
     * @param  (callable(float, string): void)|null  $progress  fraction 0-1 and a message
     */
    public function heightGrid(Map $map, ?callable $progress = null): HeightGrid
    {
        return $this->build(MapProjection::forMap($map), $progress);
    }

    /**
     * @param  (callable(float, string): void)|null  $progress
     */
    public function build(MapProjection $projection, ?callable $progress = null): HeightGrid
    {
        $progress ??= static fn () => null;
        $bounds = $projection->bounds();
        $zoom = self::chooseZoom($bounds, $projection->cell);
        $range = self::tileRange($bounds, $zoom);

        $progress(0.0, "Downloading elevation tiles (zoom {$zoom})");
        $this->download($zoom, $range, $progress);

        $progress(0.5, 'Sampling elevation');

        try {
            return $this->sample($projection, $zoom, $progress);
        } finally {
            $this->images = [];
        }
    }

    /**
     * Highest zoom whose pixel size is ≤ the map cell size (0..15), lowered until the
     * bounding box needs at most $maxTiles tiles.
     *
     * @param  array{south: float, west: float, north: float, east: float}  $bounds
     */
    public static function chooseZoom(array $bounds, float $cellSize, int $maxTiles = self::MAX_TILES): int
    {
        $lat = ($bounds['north'] + $bounds['south']) / 2;
        $base = self::EQUATOR_RESOLUTION * cos(deg2rad($lat));
        $zoom = (int) ceil(log(max($base / max($cellSize, 0.01), 1.0), 2));
        $zoom = max(0, min(self::MAX_ZOOM, $zoom));

        while ($zoom > 0 && self::tileCount(self::tileRange($bounds, $zoom)) > $maxTiles) {
            $zoom--;
        }

        return $zoom;
    }

    public static function groundResolution(float $lat, int $zoom): float
    {
        return self::EQUATOR_RESOLUTION * cos(deg2rad($lat)) / (2 ** $zoom);
    }

    /**
     * Inclusive tile index range covering the bounds (plus the half pixel needed for bilinear sampling).
     *
     * @param  array{south: float, west: float, north: float, east: float}  $bounds
     * @return array{minX: int, maxX: int, minY: int, maxY: int}
     */
    public static function tileRange(array $bounds, int $zoom): array
    {
        $size = self::TILE_SIZE;
        $max = (2 ** $zoom) - 1;

        return [
            'minX' => (int) floor((self::lngToPixelX($bounds['west'], $zoom) - 1) / $size),
            'maxX' => (int) floor((self::lngToPixelX($bounds['east'], $zoom) + 1) / $size),
            'minY' => max(0, (int) floor((self::latToPixelY($bounds['north'], $zoom) - 1) / $size)),
            'maxY' => min($max, (int) floor((self::latToPixelY($bounds['south'], $zoom) + 1) / $size)),
        ];
    }

    /**
     * @param  array{minX: int, maxX: int, minY: int, maxY: int}  $range
     */
    public static function tileCount(array $range): int
    {
        return ($range['maxX'] - $range['minX'] + 1) * ($range['maxY'] - $range['minY'] + 1);
    }

    public static function lngToPixelX(float $lng, int $zoom): float
    {
        return ($lng + 180.0) / 360.0 * self::TILE_SIZE * (2 ** $zoom);
    }

    public static function latToPixelY(float $lat, int $zoom): float
    {
        $lat = max(-85.05112878, min(85.05112878, $lat));
        $rad = deg2rad($lat);

        return (1.0 - log(tan($rad) + 1.0 / cos($rad)) / M_PI) / 2.0 * self::TILE_SIZE * (2 ** $zoom);
    }

    public static function decodeHeight(int $rgb): float
    {
        return (($rgb >> 16) & 0xFF) * 256.0 + (($rgb >> 8) & 0xFF) + ($rgb & 0xFF) / 256.0 - 32768.0;
    }

    public static function tileUrl(int $zoom, int $x, int $y): string
    {
        $base = rtrim((string) config('services.terrarium.url', self::DEFAULT_URL), '/');

        return "{$base}/{$zoom}/{$x}/{$y}.png";
    }

    public static function cachePath(int $zoom, int $x, int $y): string
    {
        return self::CACHE_DIR."/{$zoom}/{$x}/{$y}.png";
    }

    private function disk(): Filesystem
    {
        return Storage::disk('local');
    }

    /**
     * Fetch all tiles in the range that are not cached yet (concurrently, one retry round).
     *
     * @param  array{minX: int, maxX: int, minY: int, maxY: int}  $range
     * @param  callable(float, string): void  $progress
     */
    private function download(int $zoom, array $range, callable $progress): void
    {
        $missing = [];
        for ($y = $range['minY']; $y <= $range['maxY']; $y++) {
            for ($x = $range['minX']; $x <= $range['maxX']; $x++) {
                $wx = $this->wrapX($x, $zoom);
                if (! $this->disk()->exists(self::cachePath($zoom, $wx, $y))) {
                    $missing["{$wx}/{$y}"] = [$wx, $y];
                }
            }
        }

        $total = max(1, count($missing));
        $done = 0;

        for ($attempt = 0; $attempt < 2 && $missing; $attempt++) {
            $failed = [];

            foreach (array_chunk($missing, 24, true) as $chunk) {
                $responses = Http::pool(function (Pool $pool) use ($chunk, $zoom) {
                    foreach ($chunk as $key => [$x, $y]) {
                        $pool->as($key)->connectTimeout(10)->timeout(30)->get(self::tileUrl($zoom, $x, $y));
                    }
                }, self::CONCURRENCY);

                foreach ($chunk as $key => [$x, $y]) {
                    $response = $responses[$key] ?? null;

                    if ($response instanceof Response && $response->successful() && str_starts_with($response->body(), "\x89PNG")) {
                        $this->disk()->put(self::cachePath($zoom, $x, $y), $response->body());
                        $done++;
                    } else {
                        $failed[$key] = [$x, $y];
                    }
                }

                $progress(0.5 * $done / $total, "Downloading elevation tiles ({$done}/{$total})");
            }

            $missing = $failed;
        }

        if ($missing) {
            throw new RuntimeException(sprintf(
                'Could not download %d elevation tile(s) (e.g. %s).', count($missing), self::tileUrl($zoom, ...array_values($missing)[0]),
            ));
        }
    }

    /**
     * Bilinearly sample the tile mosaic at every grid sample. Pixel rows are decoded lazily,
     * at most once each, as the grid is walked from north to south.
     *
     * @param  callable(float, string): void  $progress
     */
    private function sample(MapProjection $projection, int $zoom, callable $progress): HeightGrid
    {
        $n = $projection->resolution;
        $worldPixels = self::TILE_SIZE * (2 ** $zoom);

        // Longitude depends on the column only, latitude on the row only.
        $colX0 = [];
        $colFx = [];
        $minPx = PHP_INT_MAX;
        $maxPx = PHP_INT_MIN;
        for ($col = 0; $col < $n; $col++) {
            [, $lng] = $projection->toLatLng($col, 0);
            $sx = self::lngToPixelX($lng, $zoom) - 0.5;
            $x0 = (int) floor($sx);
            $colX0[$col] = $x0;
            $colFx[$col] = $sx - $x0;
            $minPx = min($minPx, $x0);
            $maxPx = max($maxPx, $x0 + 1);
        }
        foreach ($colX0 as $col => $x0) {
            $colX0[$col] = $x0 - $minPx;
        }

        $data = array_fill(0, $n * $n, 0.0);
        $rows = [];

        for ($row = 0; $row < $n; $row++) {
            [$lat] = $projection->toLatLng(0, $row);
            $sy = self::latToPixelY($lat, $zoom) - 0.5;
            $y0 = (int) floor($sy);
            $fy = $sy - $y0;
            $y0c = max(0, min($worldPixels - 1, $y0));
            $y1c = max(0, min($worldPixels - 1, $y0 + 1));

            foreach (array_keys($rows) as $cached) {
                if ($cached < $y0c) {
                    unset($rows[$cached]);
                }
            }
            $top = $rows[$y0c] ??= $this->decodeRow($zoom, $y0c, $minPx, $maxPx);
            $bottom = $rows[$y1c] ??= $this->decodeRow($zoom, $y1c, $minPx, $maxPx);

            $base = $row * $n;
            for ($col = 0; $col < $n; $col++) {
                $x = $colX0[$col];
                $fx = $colFx[$col];
                $t = $top[$x] + ($top[$x + 1] - $top[$x]) * $fx;
                $b = $bottom[$x] + ($bottom[$x + 1] - $bottom[$x]) * $fx;
                $data[$base + $col] = $t + ($b - $t) * $fy;
            }

            if ($row % 32 === 0) {
                $progress(0.5 + 0.5 * $row / $n, 'Sampling elevation');
            }
        }

        return new HeightGrid($n, $data);
    }

    /**
     * Decode one global pixel row between two global pixel columns into heights.
     *
     * @return list<float>
     */
    private function decodeRow(int $zoom, int $py, int $fromPx, int $toPx): array
    {
        $size = self::TILE_SIZE;
        $ty = intdiv($py, $size);
        $inner = $py - $ty * $size;
        $out = [];

        for ($px = $fromPx; $px <= $toPx; $px++) {
            $tx = intdiv($px - ($px < 0 ? $size - 1 : 0), $size);
            $image = $this->image($zoom, $this->wrapX($tx, $zoom), $ty);
            $end = min($toPx, $tx * $size + $size - 1);
            for (; $px <= $end; $px++) {
                $out[] = self::decodeHeight(imagecolorat($image, $px - $tx * $size, $inner));
            }
            $px--;
        }

        return $out;
    }

    private function image(int $zoom, int $x, int $y): GdImage
    {
        $key = "{$x}/{$y}";

        if (! isset($this->images[$key])) {
            // Rows are walked north → south: drop images from tile rows above this one.
            foreach (array_keys($this->images) as $cached) {
                if ((int) explode('/', $cached)[1] < $y) {
                    unset($this->images[$cached]);
                }
            }

            $bytes = $this->disk()->get(self::cachePath($zoom, $x, $y));
            $image = $bytes === null ? false : @imagecreatefromstring($bytes);

            if (! $image instanceof GdImage) {
                $this->disk()->delete(self::cachePath($zoom, $x, $y));

                throw new RuntimeException("Corrupt elevation tile {$zoom}/{$x}/{$y}.");
            }

            if (! imageistruecolor($image)) {
                imagepalettetotruecolor($image);
            }

            $this->images[$key] = $image;
        }

        return $this->images[$key];
    }

    private function wrapX(int $x, int $zoom): int
    {
        $count = 2 ** $zoom;

        return (($x % $count) + $count) % $count;
    }
}
