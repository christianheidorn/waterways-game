<?php

namespace App\Services\Ai;

use App\Models\Map;
use App\Services\Terrain\TerrainStorage;
use Throwable;

/**
 * Cheap statistics of a map's heightmap and splat map for the AI layer planner (sampled, so
 * even 1025² maps take a few milliseconds).
 */
class TerrainAnalysis
{
    /** Max samples per statistic. */
    public const MAX_SAMPLES = 65536;

    public function __construct(private readonly TerrainStorage $terrain) {}

    /**
     * Height and slope percentiles.
     *
     * @return array{height_m: array<string, float>, slope_deg: array<string, float>, steep_percent: array<string, float>}|null
     */
    public function relief(Map $map): ?array
    {
        $res = $map->resolution;

        try {
            $bytes = $this->terrain->read($map, 'heightmap');
        } catch (Throwable) {
            return null;
        }

        if ($bytes === null || $res < 3 || strlen($bytes) !== $res * $res * 4) {
            return null;
        }

        $heights = unpack('g*', $bytes);
        $cell = $map->size / ($res - 1);
        $stride = max(1, (int) ceil(sqrt(($res * $res) / self::MAX_SAMPLES)));
        $h = [];
        $slopes = [];

        for ($row = 1; $row < $res - 1; $row += $stride) {
            for ($col = 1; $col < $res - 1; $col += $stride) {
                $i = $row * $res + $col + 1; // unpack() is 1-based
                $dx = ($heights[$i + 1] - $heights[$i - 1]) / (2 * $cell);
                $dz = ($heights[$i + $res] - $heights[$i - $res]) / (2 * $cell);
                $h[] = $heights[$i];
                $slopes[] = rad2deg(atan(sqrt($dx * $dx + $dz * $dz)));
            }
        }

        if ($slopes === []) {
            return null;
        }

        sort($h);
        sort($slopes);
        $n = count($slopes);
        $share = fn (float $deg) => round(100 * count(array_filter($slopes, fn ($s) => $s > $deg)) / $n, 1);

        return [
            'height_m' => [
                'p5' => round(self::percentile($h, 5), 1),
                'p50' => round(self::percentile($h, 50), 1),
                'p95' => round(self::percentile($h, 95), 1),
            ],
            'slope_deg' => [
                'p10' => round(self::percentile($slopes, 10), 1),
                'p50' => round(self::percentile($slopes, 50), 1),
                'p90' => round(self::percentile($slopes, 90), 1),
                'p99' => round(self::percentile($slopes, 99), 1),
            ],
            'steep_percent' => ['over_20' => $share(20), 'over_30' => $share(30), 'over_45' => $share(45)],
        ];
    }

    /**
     * Share of the painted weight per slot in percent (from splat.u8), or null without a splat map.
     *
     * @return array<int, float>|null slot → percent
     */
    public function coverage(Map $map): ?array
    {
        try {
            $bytes = $this->terrain->read($map, 'splatmap');
        } catch (Throwable) {
            return null;
        }

        $channels = TerrainStorage::SPLAT_CHANNELS;
        if ($bytes === null || strlen($bytes) < $channels || strlen($bytes) % $channels !== 0) {
            return null;
        }

        $texels = intdiv(strlen($bytes), $channels);
        $stride = max(1, intdiv($texels, self::MAX_SAMPLES));
        $sums = array_fill(0, $channels, 0);

        for ($t = 0; $t < $texels; $t += $stride) {
            $weights = unpack('C'.$channels, $bytes, $t * $channels);
            for ($c = 0; $c < $channels; $c++) {
                $sums[$c] += $weights[$c + 1];
            }
        }

        $total = array_sum($sums);
        if ($total === 0) {
            return array_fill(0, $channels, 0.0);
        }

        return array_map(fn (int $sum) => round(100 * $sum / $total, 1), $sums);
    }

    /**
     * @param  list<float>  $sorted
     */
    private static function percentile(array $sorted, float $p): float
    {
        $index = (count($sorted) - 1) * $p / 100;
        $lo = (int) floor($index);
        $hi = (int) ceil($index);

        return $sorted[$lo] + ($sorted[$hi] - $sorted[$lo]) * ($index - $lo);
    }
}
