<?php

namespace Tests\Feature\LandCover;

use Closure;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;

/**
 * Builds small tiled, DEFLATE-compressed GeoTIFFs laid out like ESA WorldCover files and serves
 * them through Http::fake with HTTP Range support.
 */
final class FakeWorldCover
{
    public const BASE_URL = 'https://worldcover.test/map';

    /** @var list<string> Range headers of every request served */
    public static array $ranges = [];

    /**
     * A single-band uint8 tiled GeoTIFF (north-up, top-left origin).
     *
     * @param  Closure(int, int): int  $classAt  pixel (x, y) → class
     */
    public static function tiff(
        int $width,
        int $height,
        int $tileSize,
        float $originX,
        float $originY,
        float $scale,
        Closure $classAt,
        bool $predictor = false,
        bool $bigTiff = false,
    ): string {
        $across = (int) ceil($width / $tileSize);
        $down = (int) ceil($height / $tileSize);
        $tiles = [];

        for ($ty = 0; $ty < $down; $ty++) {
            for ($tx = 0; $tx < $across; $tx++) {
                $raw = '';
                for ($r = 0; $r < $tileSize; $r++) {
                    $prev = 0;
                    for ($c = 0; $c < $tileSize; $c++) {
                        $x = $tx * $tileSize + $c;
                        $y = $ty * $tileSize + $r;
                        $v = $x < $width && $y < $height ? $classAt($x, $y) : 0;
                        $raw .= chr($predictor ? ($v - $prev) & 0xFF : $v);
                        $prev = $v;
                    }
                }
                $tiles[] = gzcompress($raw);
            }
        }

        // tag => [type, values]; types: 3 SHORT, 4 LONG, 12 DOUBLE, 16 LONG8.
        $offsetType = $bigTiff ? 16 : 4;
        $entries = [
            256 => [4, [$width]],
            257 => [4, [$height]],
            258 => [3, [8]],
            259 => [3, [8]],
            262 => [3, [1]],
            277 => [3, [1]],
            317 => [3, [$predictor ? 2 : 1]],
            322 => [3, [$tileSize]],
            323 => [3, [$tileSize]],
            324 => [$offsetType, array_fill(0, count($tiles), 0)],
            325 => [$offsetType, array_map('strlen', $tiles)],
            339 => [3, [1]],
            33550 => [12, [$scale, $scale, 0.0]],
            33922 => [12, [0.0, 0.0, 0.0, $originX, $originY, 0.0]],
        ];

        $header = $bigTiff ? 16 : 8;
        $entrySize = $bigTiff ? 20 : 12;
        $fieldSize = $bigTiff ? 8 : 4;
        $ifdSize = ($bigTiff ? 8 : 2) + count($entries) * $entrySize + ($bigTiff ? 8 : 4);
        $pack = static fn (int $type, array $values): string => match ($type) {
            3 => pack('v*', ...$values),
            4 => pack('V*', ...$values),
            16 => pack('P*', ...$values),
            12 => pack('e*', ...$values),
        };

        // Overflow values sit right after the IFD, tiles after them.
        $extraSize = 0;
        foreach ($entries as [$type, $values]) {
            $len = strlen($pack($type, $values));
            $extraSize += $len > $fieldSize ? $len : 0;
        }
        $offset = $header + $ifdSize + $extraSize;
        $tileOffsets = [];
        foreach ($tiles as $tile) {
            $tileOffsets[] = $offset;
            $offset += strlen($tile);
        }
        $entries[324][1] = $tileOffsets;

        $ifd = $bigTiff ? pack('P', count($entries)) : pack('v', count($entries));
        $extra = '';
        $extraAt = $header + $ifdSize;
        foreach ($entries as $tag => [$type, $values]) {
            $bytes = $pack($type, $values);
            $ifd .= pack('vv', $tag, $type).($bigTiff ? pack('P', count($values)) : pack('V', count($values)));
            if (strlen($bytes) <= $fieldSize) {
                $ifd .= str_pad($bytes, $fieldSize, "\0");
            } else {
                $ifd .= $bigTiff ? pack('P', $extraAt + strlen($extra)) : pack('V', $extraAt + strlen($extra));
                $extra .= $bytes;
            }
        }
        $ifd .= str_repeat("\0", $bigTiff ? 8 : 4);

        $head = $bigTiff ? 'II'.pack('vvvP', 43, 8, 0, $header) : 'II'.pack('vV', 42, $header);

        return $head.$ifd.$extra.implode('', $tiles);
    }

    /**
     * A 3° × 3° WorldCover-like file for the tile whose south-west corner is (lat, lng), with
     * $pixels² pixels, whose class is a function of the pixel centre's (lat, lng).
     *
     * @param  Closure(float, float): int  $classAt  (lat, lng) → class
     */
    public static function file(int $lat, int $lng, Closure $classAt, int $pixels = 300, int $tileSize = 64): string
    {
        $scale = 3 / $pixels;

        return self::tiff($pixels, $pixels, $tileSize, $lng, $lat + 3, $scale, fn (int $x, int $y) => $classAt(
            $lat + 3 - ($y + 0.5) * $scale,
            $lng + ($x + 0.5) * $scale,
        ));
    }

    /**
     * Serve files by WorldCover name (e.g. "N48E009"); other names answer 404.
     *
     * @param  array<string, string>  $files
     */
    public static function serve(array $files, ?int $failWith = null): void
    {
        config(['services.worldcover.url' => self::BASE_URL]);
        self::$ranges = [];

        Http::fake([
            'worldcover.test/*' => function (Request $request) use ($files, $failWith) {
                if ($failWith !== null) {
                    return Http::response('unavailable', $failWith);
                }

                preg_match('#_v200_([NS]\d{2}[EW]\d{3})_Map\.tif$#', $request->url(), $m);
                $file = $files[$m[1] ?? ''] ?? null;

                if ($file === null) {
                    return Http::response('<Error><Code>NoSuchKey</Code></Error>', 404);
                }

                $range = $request->header('Range')[0] ?? null;
                if ($range === null || ! preg_match('/^bytes=(\d+)-(\d+)$/', $range, $r)) {
                    return Http::response($file, 200);
                }

                self::$ranges[] = $m[1].' '.$range;
                $start = (int) $r[1];
                $end = min((int) $r[2], strlen($file) - 1);

                return Http::response(substr($file, $start, $end - $start + 1), 206, [
                    'Content-Range' => "bytes {$start}-{$end}/".strlen($file),
                ]);
            },
        ]);
    }
}
