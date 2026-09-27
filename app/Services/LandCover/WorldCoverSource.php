<?php

namespace App\Services\LandCover;

use App\Models\Map;
use App\Services\Terrain\MapProjection;
use Illuminate\Contracts\Filesystem\Filesystem;
use Illuminate\Http\Client\Pool;
use Illuminate\Http\Client\RequestException;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;
use RuntimeException;
use Throwable;

/**
 * Real-world land cover from ESA WorldCover 10 m v200 (2021), CC-BY 4.0.
 *
 * The dataset is split into 3° × 3° Cloud-Optimized GeoTIFFs of several hundred MB each; only
 * the TIFF header and the internal 1024² tiles covering the map are fetched with HTTP range
 * requests and cached under storage/app/private/cache/worldcover. Open ocean has no files (404),
 * which is treated as "no data" (class 0).
 */
class WorldCoverSource
{
    public const DEFAULT_URL = 'https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map';

    /** Internal tiles a single map may need (a 32 km map at 10 m needs about 25). */
    public const MAX_TILES = 64;

    private const CACHE_DIR = 'cache/worldcover';

    private const HEAD_BYTES = 32768;

    private const CONCURRENCY = 6;

    /** Cells larger than this (m) take the majority class of a 3 × 3 sample footprint. */
    private const MODE_THRESHOLD = 15.0;

    /** Why the last classGrid() call returned null. */
    public ?string $warning = null;

    /** Bytes downloaded by the last call (cache hits excluded). */
    public int $bytesDownloaded = 0;

    /** @var array<string, GeoTiffIndex|false> file name → index (false = no file) */
    private array $indexes = [];

    /**
     * Class grid for a real-world map, or null (see $warning) when land cover is unavailable.
     */
    public function classGrid(Map $map): ?LandCoverGrid
    {
        $this->warning = null;

        try {
            return $this->build(MapProjection::forMap($map));
        } catch (Throwable $e) {
            $this->warning = $e->getMessage();
            Log::warning('WorldCover land cover unavailable', ['map' => $map->id, 'error' => $e->getMessage()]);

            return null;
        }
    }

    /**
     * Sample the class at every grid sample (nearest pixel, or the majority of a 3 × 3 footprint
     * when cells are much larger than the 10 m source pixels). Throws on network / format errors.
     */
    public function build(MapProjection $projection): LandCoverGrid
    {
        $this->bytesDownloaded = 0;
        $n = $projection->resolution;
        $k = $projection->cell > self::MODE_THRESHOLD ? 3 : 1;
        $offsets = $k === 1 ? [0.0] : [-1 / 3, 0.0, 1 / 3];

        // Longitude depends only on the column, latitude only on the row.
        $lngs = [];
        $lats = [];
        for ($i = 0; $i < $n; $i++) {
            foreach ($offsets as $o) {
                $lngs[] = $projection->toLatLng($i + $o, 0)[1];
                $lats[] = $projection->toLatLng(0, $i + $o)[0];
            }
        }

        // Band index = floor(degrees / 3); files are addressed by their south-west corner.
        $lngBands = array_map(fn (float $lng) => (int) floor(self::wrapLng($lng) / 3), $lngs);
        $latBands = array_map(fn (float $lat) => (int) floor($lat / 3), $lats);

        $files = [];
        foreach (array_unique($latBands) as $lb) {
            foreach (array_unique($lngBands) as $gb) {
                $files[$lb][$gb] = $this->index(self::fileName($lb * 3, $gb * 3));
            }
        }

        // Pixel coordinates per column / row sample, from any file of the same band.
        $px = [];
        foreach ($lngs as $i => $lng) {
            $index = self::firstIndex(array_column($files, $lngBands[$i]));
            $px[$i] = $index === null ? -1 : $index->pixelX(self::wrapLng($lng));
        }
        $py = [];
        foreach ($lats as $i => $lat) {
            $index = self::firstIndex(array_values($files[$latBands[$i]]));
            $py[$i] = $index === null ? -1 : $index->pixelY($lat);
        }

        $tiles = $this->loadTiles($files, $latBands, $lngBands, $px, $py);

        return $this->sample($n, $k, $files, $tiles, $latBands, $lngBands, $px, $py);
    }

    /**
     * WorldCover file name for the 3° tile whose south-west corner is at (lat, lng), e.g. N45E009.
     */
    public static function fileName(float $lat, float $lng): string
    {
        $lat = (int) (floor($lat / 3) * 3);
        $lng = (int) (floor(self::wrapLng($lng) / 3) * 3);

        return sprintf('%s%02d%s%03d', $lat < 0 ? 'S' : 'N', abs($lat), $lng < 0 ? 'W' : 'E', abs($lng));
    }

    public static function url(string $fileName): string
    {
        $base = rtrim((string) config('services.worldcover.url', self::DEFAULT_URL), '/');

        return "{$base}/ESA_WorldCover_10m_2021_v200_{$fileName}_Map.tif";
    }

    private static function wrapLng(float $lng): float
    {
        return fmod(fmod($lng + 180.0, 360.0) + 360.0, 360.0) - 180.0;
    }

    /**
     * @param  array<int, GeoTiffIndex|false>  $candidates
     */
    private static function firstIndex(array $candidates): ?GeoTiffIndex
    {
        foreach ($candidates as $index) {
            if ($index instanceof GeoTiffIndex) {
                return $index;
            }
        }

        return null;
    }

    private function disk(): Filesystem
    {
        return Storage::disk('local');
    }

    /**
     * The header of one WorldCover file (cached), or false when the file does not exist.
     */
    private function index(string $fileName): GeoTiffIndex|false
    {
        if (isset($this->indexes[$fileName])) {
            return $this->indexes[$fileName];
        }

        $cache = self::CACHE_DIR."/{$fileName}/header.json";
        $cached = $this->disk()->exists($cache) ? json_decode((string) $this->disk()->get($cache), true) : null;

        if (is_array($cached)) {
            return $this->indexes[$fileName] = ($cached['missing'] ?? false) ? false : GeoTiffIndex::fromArray($cached);
        }

        $url = self::url($fileName);
        $head = $this->range($url, 0, self::HEAD_BYTES, allowMissing: true);

        if ($head === null) {
            $this->disk()->put($cache, json_encode(['missing' => true]));

            return $this->indexes[$fileName] = false;
        }

        $index = GeoTiffIndex::parse($head, fn (int $offset, int $length) => (string) $this->range($url, $offset, $length));
        $this->disk()->put($cache, json_encode($index->toArray()));

        return $this->indexes[$fileName] = $index;
    }

    /**
     * Fetch (or read from cache) and decode every internal tile the map touches.
     *
     * @param  array<int, array<int, GeoTiffIndex|false>>  $files
     * @param  list<int>  $latBands
     * @param  list<int>  $lngBands
     * @param  list<int>  $px
     * @param  list<int>  $py
     * @return array<string, string> "lat|lng|tile" → decoded tile bytes
     */
    private function loadTiles(array $files, array $latBands, array $lngBands, array $px, array $py): array
    {
        $needed = [];

        foreach ($files as $lb => $row) {
            foreach ($row as $gb => $index) {
                if (! $index instanceof GeoTiffIndex) {
                    continue;
                }

                $xs = array_intersect_key($px, array_filter($lngBands, fn (int $b) => $b === $gb));
                $ys = array_intersect_key($py, array_filter($latBands, fn (int $b) => $b === $lb));
                $x0 = max(0, min($xs));
                $x1 = min($index->width - 1, max($xs));
                $y0 = max(0, min($ys));
                $y1 = min($index->height - 1, max($ys));

                for ($ty = intdiv($y0, $index->tileLength); $x0 <= $x1 && $ty <= intdiv($y1, $index->tileLength); $ty++) {
                    for ($tx = intdiv($x0, $index->tileWidth); $tx <= intdiv($x1, $index->tileWidth); $tx++) {
                        $t = $ty * $index->tilesAcross() + $tx;
                        $needed["{$lb}|{$gb}|{$t}"] = [self::fileName($lb * 3, $gb * 3), $index, $t];
                    }
                }
            }
        }

        if (count($needed) > self::MAX_TILES) {
            throw new RuntimeException(sprintf('Map area needs %d land cover tiles (max %d).', count($needed), self::MAX_TILES));
        }

        $raw = [];
        $missing = [];
        foreach ($needed as $key => [$fileName, $index, $t]) {
            $cache = self::CACHE_DIR."/{$fileName}/{$t}.bin";
            if ($index->counts[$t] === 0) {
                $raw[$key] = '';
            } elseif ($this->disk()->exists($cache)) {
                $raw[$key] = (string) $this->disk()->get($cache);
            } else {
                $missing[$key] = [$fileName, $index, $t, $cache];
            }
        }

        for ($attempt = 0; $attempt < 2 && $missing; $attempt++) {
            $responses = Http::pool(function (Pool $pool) use ($missing) {
                foreach ($missing as $key => [$fileName, $index, $t]) {
                    $start = $index->offsets[$t];
                    $pool->as($key)->connectTimeout(10)->timeout(60)
                        ->withHeaders(['Range' => 'bytes='.$start.'-'.($start + $index->counts[$t] - 1)])
                        ->get(self::url($fileName));
                }
            }, self::CONCURRENCY);

            foreach ($missing as $key => [$fileName, $index, $t, $cache]) {
                $response = $responses[$key] ?? null;
                $body = $response instanceof Response ? self::slice($response, $index->offsets[$t], $index->counts[$t]) : null;

                if ($body !== null) {
                    $this->bytesDownloaded += strlen($body);
                    $this->disk()->put($cache, $body);
                    $raw[$key] = $body;
                    unset($missing[$key]);
                }
            }
        }

        if ($missing) {
            throw new RuntimeException(sprintf('Could not download %d land cover tile(s).', count($missing)));
        }

        $decoded = [];
        foreach ($needed as $key => [$fileName, $index, $t]) {
            try {
                $decoded[$key] = $index->decodeTile($raw[$key]);
            } catch (RuntimeException $e) {
                $this->disk()->delete(self::CACHE_DIR."/{$fileName}/{$t}.bin");

                throw $e;
            }
        }

        return $decoded;
    }

    /**
     * @param  array<int, array<int, GeoTiffIndex|false>>  $files
     * @param  array<string, string>  $tiles
     * @param  list<int>  $latBands
     * @param  list<int>  $lngBands
     * @param  list<int>  $px
     * @param  list<int>  $py
     */
    private function sample(int $n, int $k, array $files, array $tiles, array $latBands, array $lngBands, array $px, array $py): LandCoverGrid
    {
        // Nested tile lookup [latBand][lngBand][tile] and per-sample pixel addressing. All files
        // share one tile size (as WorldCover does).
        $grid = [];
        foreach ($tiles as $key => $bytes) {
            [$lb, $gb, $t] = array_map('intval', explode('|', $key));
            $grid[$lb][$gb][$t] = $bytes;
        }
        $any = null;
        foreach ($files as $row) {
            $any ??= self::firstIndex($row);
        }
        if ($any === null) {
            return LandCoverGrid::filled($n);
        }
        $tw = $any->tileWidth;
        $tl = $any->tileLength;
        $across = $any->tilesAcross();

        $cols = [];
        foreach ($px as $ci => $x) {
            $index = self::firstIndex(array_column($files, $lngBands[$ci]));
            $cols[$ci] = $index === null || $x < 0 || $x >= $index->width
                ? null
                : [$lngBands[$ci], intdiv($x, $tw), $x % $tw];
        }
        $rows = [];
        foreach ($py as $ri => $y) {
            $index = self::firstIndex(array_values($files[$latBands[$ri]]));
            $rows[$ri] = $index === null || $y < 0 || $y >= $index->height
                ? null
                : [$latBands[$ri], intdiv($y, $tl) * $across, ($y % $tl) * $tw];
        }

        $lookup = static function (int $ri, int $ci) use ($grid, $rows, $cols): int {
            $r = $rows[$ri];
            $c = $cols[$ci];
            if ($r === null || $c === null) {
                return 0;
            }
            $tile = $grid[$r[0]][$c[0]][$r[1] + $c[1]] ?? null;

            return $tile === null ? 0 : ord($tile[$r[2] + $c[2]]);
        };

        $out = '';
        $center = intdiv($k, 2);

        for ($row = 0; $row < $n; $row++) {
            $line = [];
            for ($col = 0; $col < $n; $col++) {
                if ($k === 1) {
                    $line[] = $lookup($row, $col);

                    continue;
                }

                $counts = [];
                for ($sr = 0; $sr < $k; $sr++) {
                    for ($sc = 0; $sc < $k; $sc++) {
                        $c = $lookup($row * $k + $sr, $col * $k + $sc);
                        $counts[$c] = ($counts[$c] ?? 0) + 1;
                    }
                }

                // Majority class; ties go to the class at the sample itself.
                $best = $lookup($row * $k + $center, $col * $k + $center);
                foreach ($counts as $c => $count) {
                    if ($count > $counts[$best]) {
                        $best = $c;
                    }
                }
                $line[] = $best;
            }
            $out .= pack('C*', ...$line);
        }

        return new LandCoverGrid($n, $out);
    }

    /**
     * GET a byte range; null for 404 when allowed.
     */
    private function range(string $url, int $offset, int $length, bool $allowMissing = false): ?string
    {
        $response = Http::connectTimeout(10)->timeout(60)
            ->retry(2, 500, fn (Throwable $e) => ! $e instanceof RequestException || $e->response->serverError(), throw: false)
            ->withHeaders(['Range' => 'bytes='.$offset.'-'.($offset + $length - 1)])
            ->get($url);

        if ($allowMissing && $response->status() === 404) {
            return null;
        }

        $body = self::slice($response, $offset, $length, partialOk: true);

        if ($body === null) {
            throw new RuntimeException("WorldCover request failed (HTTP {$response->status()}) for ".basename($url).'.');
        }

        $this->bytesDownloaded += strlen($body);

        return $body;
    }

    /**
     * The requested byte range from a 206 (or a 200 that ignored the Range header).
     */
    private static function slice(Response $response, int $offset, int $length, bool $partialOk = false): ?string
    {
        $body = $response->body();

        if ($response->status() === 200) {
            $body = substr($body, $offset, $length);
        } elseif ($response->status() !== 206) {
            return null;
        }

        // A header range may run past the end of a small file; tile ranges must be complete.
        if (strlen($body) < $length && ! ($partialOk && $body !== '')) {
            return null;
        }

        return $body;
    }
}
