<?php

namespace App\Services\LandCover;

use App\Services\Terrain\HeightGrid;
use App\Services\Terrain\SimplexNoise;
use App\Services\Terrain\TerrainSmoother;
use App\Services\Terrain\TerrainStorage;
use InvalidArgumentException;

/**
 * Paints splat.u8 (8 interleaved channel weights per sample, summing to 255) from a land cover
 * class grid:
 *
 *  1. each sample takes the slot its class maps to; class borders are displaced with seeded
 *     simplex noise (domain warp) so they do not follow the 10 m source pixels,
 *  2. the per-slot weight fields are blurred (≈ 12 m, at least one cell) for soft transitions,
 *  3. steep ground (30°–40°) blends to rock, shores up to 2 m above the water line to sand,
 *     and water beds use the water class (the carved water grid is authoritative).
 */
class LandCoverPainter
{
    public const ROCK_SLOPE_FROM = 30.0;

    public const ROCK_SLOPE_TO = 40.0;

    /** Bare ground flatter than this is painted with gravel when bare maps to rock. */
    public const BARE_GRAVEL_SLOPE = 12.0;

    /** Beaches reach this far (m) above the water line. */
    public const BEACH_HEIGHT = 2.0;

    /** Beaches reach this far (m) inland from the water edge (at least one cell). */
    public const BEACH_WIDTH = 12.0;

    /** Blur radius in metres (one box pass; three passes approximate a gaussian). */
    public const BLUR_METRES = 12.0;

    /** Border displacement in metres and the noise wavelength. */
    public const WARP_METRES = 18.0;

    public const WARP_WAVELENGTH = 70.0;

    /**
     * @param  array<int, int>  $mapping  class → slot
     * @param  array<string, int>  $roles  role → slot (see LandCoverMapping::roles)
     */
    public function paint(
        LandCoverGrid $classes,
        HeightGrid $terrain,
        ?HeightGrid $water,
        float $size,
        array $mapping,
        array $roles,
        int $seed = 0,
    ): string {
        $n = $classes->resolution;
        if ($terrain->resolution !== $n || ($water !== null && $water->resolution !== $n)) {
            throw new InvalidArgumentException('Land cover, terrain and water grids must have the same resolution.');
        }

        $count = $n * $n;
        $cell = $size / ($n - 1);
        $heights = $terrain->data;
        $cls = $classes->data;
        $fallback = $mapping[0] ?? ($roles['grass'] ?? 0);
        $rock = $roles['rock'] ?? null;
        $gravel = $roles['gravel'] ?? null;
        $sand = $roles['sand'] ?? null;
        $bareToGravel = $rock !== null && $gravel !== null && ($mapping[WorldCoverClasses::BARE] ?? null) === $rock;

        $slope = $this->slopes($heights, $n, $cell);
        [$wet, $shore] = $this->waterContext($heights, $water, $n, $cell);

        // 1. Class → slot per sample with noise-displaced borders.
        $noise = new SimplexNoise($seed ^ 0x51A7);
        $amp = max(0.5, min(3.0, self::WARP_METRES / $cell));
        $freq = $cell / self::WARP_WAVELENGTH;
        $last = $n - 1;
        $slotOf = [];

        for ($row = 0, $i = 0; $row < $n; $row++) {
            for ($col = 0; $col < $n; $col++, $i++) {
                if (isset($wet[$i])) {
                    $class = WorldCoverClasses::WATER;
                } else {
                    $sc = (int) round($col + $amp * $noise->noise($col * $freq, $row * $freq));
                    $sr = (int) round($row + $amp * $noise->noise($col * $freq + 31.7, $row * $freq - 17.3));
                    $j = ($sr < 0 ? 0 : ($sr > $last ? $last : $sr)) * $n + ($sc < 0 ? 0 : ($sc > $last ? $last : $sc));
                    $class = ord($cls[$j]);
                    // Warped samples must not pull lake-bed paint onto dry land.
                    if ($class === WorldCoverClasses::WATER && ! isset($wet[$j]) && $water !== null) {
                        $class = ord($cls[$i]);
                    }
                }

                $slot = $mapping[$class] ?? $fallback;
                if ($bareToGravel && $slot === $rock && $class === WorldCoverClasses::BARE && $slope[$i] < self::BARE_GRAVEL_SLOPE) {
                    $slot = $gravel;
                }
                $slotOf[$i] = $slot;
            }
        }

        // 2. Blurred weight field per used slot.
        $radius = (int) max(1, min(4, round(self::BLUR_METRES / $cell)));
        $fields = [];
        foreach (array_unique($slotOf) as $slot) {
            $field = array_fill(0, $count, 0.0);
            foreach ($slotOf as $i => $s) {
                if ($s === $slot) {
                    $field[$i] = 1.0;
                }
            }
            $fields[$slot] = TerrainSmoother::gaussian($field, $n, $radius);
        }
        unset($slotOf);
        ksort($fields);

        // 3. Slope / beach overrides and quantisation to 8 bytes summing to 255.
        $out = '';
        $zero = array_fill(0, TerrainStorage::SPLAT_CHANNELS, 0);
        $slots = array_keys($fields);

        for ($i = 0; $i < $count; $i++) {
            $weights = [];
            $sum = 0.0;
            foreach ($slots as $slot) {
                // Box blurs leave float dust (±1e-17) where a field is empty.
                $v = $fields[$slot][$i];
                if ($v > 1e-6) {
                    $weights[$slot] = $v;
                    $sum += $v;
                }
            }
            if ($sum <= 0.0) {
                $weights = [$fallback => 1.0];
                $sum = 1.0;
            }

            $override = [];
            if ($rock !== null && $slope[$i] > self::ROCK_SLOPE_FROM) {
                $override[$rock] = self::smoothstep(self::ROCK_SLOPE_FROM, self::ROCK_SLOPE_TO, $slope[$i]);
            }
            if ($sand !== null && isset($shore[$i])) {
                $override[$sand] = ($override[$sand] ?? 0.0) + $shore[$i] * (1.0 - self::smoothstep(20.0, 32.0, $slope[$i]));
            }

            $keep = 1.0 - min(1.0, array_sum($override));
            $channels = $zero;
            $best = 0;
            $bestValue = -1.0;
            $total = 0;
            foreach ($weights as $slot => $v) {
                $weights[$slot] = $v / $sum * $keep + ($override[$slot] ?? 0.0);
            }
            foreach ($override as $slot => $v) {
                $weights[$slot] ??= $v;
            }
            $norm = array_sum($weights);
            foreach ($weights as $slot => $v) {
                $q = (int) floor($v / $norm * 255);
                $channels[$slot] += $q;
                $total += $q;
                if ($v > $bestValue) {
                    $bestValue = $v;
                    $best = $slot;
                }
            }
            $channels[$best] += 255 - $total;

            $out .= pack('C8', ...$channels);
        }

        return $out;
    }

    /**
     * Slope in degrees per sample (central differences).
     *
     * @param  array<int, float>  $h
     * @return array<int, float>
     */
    private function slopes(array $h, int $n, float $cell): array
    {
        $slope = [];
        $last = $n - 1;

        for ($row = 0, $i = 0; $row < $n; $row++) {
            $up = $row > 0 ? $i - $n : $i;
            $down = $row < $last ? $i + $n : $i;
            $dy = ($row > 0 && $row < $last) ? 2 * $cell : $cell;
            for ($col = 0; $col < $n; $col++, $i++, $up++, $down++) {
                $left = $col > 0 ? $i - 1 : $i;
                $right = $col < $last ? $i + 1 : $i;
                $dx = ($col > 0 && $col < $last) ? 2 * $cell : $cell;
                $gx = ($h[$right] - $h[$left]) / $dx;
                $gy = ($h[$down] - $h[$up]) / $dy;
                $slope[$i] = rad2deg(atan(sqrt($gx * $gx + $gy * $gy)));
            }
        }

        return $slope;
    }

    /**
     * Wet samples (water surface above the ground) and a 0–1 beach strength for dry samples
     * near water that are at most BEACH_HEIGHT above the adjacent water surface.
     *
     * @param  array<int, float>  $h
     * @return array{0: array<int, float>, 1: array<int, float>} wet: index → level, shore: index → strength
     */
    private function waterContext(array $h, ?HeightGrid $water, int $n, float $cell): array
    {
        if ($water === null) {
            return [[], []];
        }

        $wet = [];
        foreach ($water->data as $i => $level) {
            if ($level !== TerrainStorage::NO_WATER && $level > $h[$i]) {
                $wet[$i] = $level;
            }
        }

        $reach = max(1, (int) round(self::BEACH_WIDTH / $cell));
        $level = $wet;
        $frontier = array_keys($wet);
        $shore = [];

        for ($step = 1; $step <= $reach && $frontier; $step++) {
            $next = [];
            foreach ($frontier as $i) {
                $col = $i % $n;
                foreach ([$col > 0 ? $i - 1 : -1, $col < $n - 1 ? $i + 1 : -1, $i - $n, $i + $n] as $j) {
                    if ($j < 0 || $j >= $n * $n || isset($level[$j])) {
                        continue;
                    }
                    $level[$j] = $level[$i];
                    $next[] = $j;
                    $above = $h[$j] - $level[$i];
                    if ($above <= self::BEACH_HEIGHT) {
                        $shore[$j] = 1.0 - self::smoothstep(self::BEACH_HEIGHT * 0.5, self::BEACH_HEIGHT, $above);
                    }
                }
            }
            $frontier = $next;
        }

        return [$wet, $shore];
    }

    private static function smoothstep(float $edge0, float $edge1, float $x): float
    {
        $t = max(0.0, min(1.0, ($x - $edge0) / ($edge1 - $edge0)));

        return $t * $t * (3 - 2 * $t);
    }
}
