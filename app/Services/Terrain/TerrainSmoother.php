<?php

namespace App\Services\Terrain;

/**
 * Smoothing helpers for heightmaps.
 *
 * De-terracing: real-world elevation (SRTM based) is quantized to whole metres, which shows up as
 * flat plateaus separated by 1 m steps in gentle terrain. A gaussian blur (radius in metres) is
 * blended in, strongest where the terrain is flat, and the change per sample is soft-limited to about
 * one quantization step so real features (ridges, embankments, cliffs) keep their shape.
 */
final class TerrainSmoother
{
    /**
     * @param  float  $cell  metres per sample
     * @param  float  $smoothing  0..1 user setting
     * @param  float  $quantum  height of one quantization step in metres (1 m × height scale)
     * @param  float  $strength  extra multiplier (procedural maps use a light pass)
     */
    public static function deterrace(HeightGrid $grid, float $cell, float $smoothing, float $quantum = 1.0, float $strength = 1.0): void
    {
        $smoothing = max(0.0, min(1.0, $smoothing));
        $amount = min(1.0, $smoothing * 2.0) * max(0.0, $strength);

        if ($amount <= 0.0) {
            return;
        }

        $n = $grid->resolution;
        $raw = $grid->data;
        $cur = $raw;

        // Radius in metres (~ the 30 m source resolution of SRTM), expressed in cells.
        $sigma = 10.0 + 40.0 * $smoothing;
        $radius = (int) max(1, min(12, round($sigma / $cell)));
        $limit = max(0.05, $quantum * (0.6 + 0.8 * $smoothing));
        $limit4 = $limit ** 4;
        $inv2Cell = 1.0 / (2.0 * $cell);
        $last = $n - 1;

        for ($iteration = 0; $iteration < 2; $iteration++) {
            $blur = self::gaussian($cur, $n, $radius);

            for ($row = 0; $row < $n; $row++) {
                $base = $row * $n;
                $up = ($row > 0 ? $row - 1 : 0) * $n;
                $down = ($row < $last ? $row + 1 : $last) * $n;

                for ($col = 0; $col < $n; $col++) {
                    $i = $base + $col;
                    $gx = ($blur[$base + ($col < $last ? $col + 1 : $last)] - $blur[$base + ($col > 0 ? $col - 1 : 0)]) * $inv2Cell;
                    $gz = ($blur[$down + $col] - $blur[$up + $col]) * $inv2Cell;
                    $slope = sqrt($gx * $gx + $gz * $gz);

                    // Full strength on flat ground, a quarter on steep slopes (> ~30°).
                    $s = $slope <= 0.08 ? 0.0 : ($slope >= 0.6 ? 1.0 : ($slope - 0.08) / 0.52);
                    $weight = 1.0 - 0.75 * $s * $s * (3.0 - 2.0 * $s);

                    // Soft limit of the change: identity for small deltas, saturates at ±limit.
                    $delta = $blur[$i] - $raw[$i];
                    $d2 = $delta * $delta;
                    $delta /= sqrt(sqrt(1.0 + $d2 * $d2 / $limit4));

                    $cur[$i] = $raw[$i] + $amount * $weight * $delta;
                }
            }
        }

        $grid->data = $cur;
    }

    /**
     * Approximate gaussian (three box blurs, σ ≈ radius cells), edges clamped.
     *
     * @param  array<int, float>  $data
     * @return array<int, float>
     */
    public static function gaussian(array $data, int $n, int $radius): array
    {
        for ($pass = 0; $pass < 3; $pass++) {
            $data = self::boxBlur($data, $n, $radius);
        }

        return $data;
    }

    /**
     * Separable box blur with clamped edges.
     *
     * @param  array<int, float>  $src
     * @return array<int, float>
     */
    public static function boxBlur(array $src, int $n, int $r): array
    {
        $last = $n - 1;
        $inv = 1.0 / (2 * $r + 1);
        $tmp = array_fill(0, $n * $n, 0.0);

        // Horizontal.
        for ($row = 0; $row < $n; $row++) {
            $base = $row * $n;
            $sum = $src[$base] * ($r + 1);
            for ($k = 1; $k <= $r; $k++) {
                $sum += $src[$base + ($k < $last ? $k : $last)];
            }
            for ($col = 0; $col < $n; $col++) {
                $tmp[$base + $col] = $sum * $inv;
                $add = $col + $r + 1;
                $remove = $col - $r;
                $sum += $src[$base + ($add < $last ? $add : $last)] - $src[$base + ($remove > 0 ? $remove : 0)];
            }
        }

        // Vertical, walking rows so memory is read sequentially.
        $out = array_fill(0, $n * $n, 0.0);
        $sums = array_fill(0, $n, 0.0);
        for ($col = 0; $col < $n; $col++) {
            $sums[$col] = $tmp[$col] * ($r + 1);
        }
        for ($k = 1; $k <= $r; $k++) {
            $base = ($k < $last ? $k : $last) * $n;
            for ($col = 0; $col < $n; $col++) {
                $sums[$col] += $tmp[$base + $col];
            }
        }
        for ($row = 0; $row < $n; $row++) {
            $base = $row * $n;
            $add = $row + $r + 1;
            $remove = $row - $r;
            $addBase = ($add < $last ? $add : $last) * $n;
            $removeBase = ($remove > 0 ? $remove : 0) * $n;
            for ($col = 0; $col < $n; $col++) {
                $out[$base + $col] = $sums[$col] * $inv;
                $sums[$col] += $tmp[$addBase + $col] - $tmp[$removeBase + $col];
            }
        }

        return $out;
    }
}
