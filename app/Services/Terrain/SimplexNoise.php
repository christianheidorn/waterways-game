<?php

namespace App\Services\Terrain;

/**
 * Seeded 2D simplex noise (port of Stefan Gustavson's reference implementation).
 *
 * Output is roughly in [-1, 1]. The permutation table is shuffled with a local PRNG so the
 * global mt_rand state is never touched.
 */
final class SimplexNoise
{
    private const F2 = 0.36602540378443865; // 0.5 * (sqrt(3) - 1)

    private const G2 = 0.21132486540518713; // (3 - sqrt(3)) / 6

    private const GRAD_X = [1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0];

    private const GRAD_Y = [1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1];

    /** @var list<int> */
    private array $perm = [];

    /** @var list<int> gradient index per permutation slot (perm % 12) */
    private array $permMod12 = [];

    public function __construct(int $seed = 0)
    {
        $p = range(0, 255);
        $state = ($seed ^ 0x5DEECE6) & 0x7FFFFFFF;

        for ($i = 255; $i > 0; $i--) {
            $state = ($state * 1103515245 + 12345) & 0x7FFFFFFF;
            $j = ($state >> 8) % ($i + 1);
            [$p[$i], $p[$j]] = [$p[$j], $p[$i]];
        }

        for ($i = 0; $i < 512; $i++) {
            $this->perm[$i] = $p[$i & 255];
            $this->permMod12[$i] = $p[$i & 255] % 12;
        }
    }

    public function noise(float $xin, float $yin): float
    {
        $s = ($xin + $yin) * self::F2;
        $i = (int) floor($xin + $s);
        $j = (int) floor($yin + $s);
        $t = ($i + $j) * self::G2;
        $x0 = $xin - ($i - $t);
        $y0 = $yin - ($j - $t);

        if ($x0 > $y0) {
            $i1 = 1;
            $j1 = 0;
        } else {
            $i1 = 0;
            $j1 = 1;
        }

        $x1 = $x0 - $i1 + self::G2;
        $y1 = $y0 - $j1 + self::G2;
        $x2 = $x0 - 1.0 + 2.0 * self::G2;
        $y2 = $y0 - 1.0 + 2.0 * self::G2;

        $ii = $i & 255;
        $jj = $j & 255;
        $perm = $this->perm;
        $mod = $this->permMod12;
        $n = 0.0;

        $t0 = 0.5 - $x0 * $x0 - $y0 * $y0;
        if ($t0 > 0) {
            $g = $mod[$ii + $perm[$jj]];
            $t0 *= $t0;
            $n += $t0 * $t0 * (self::GRAD_X[$g] * $x0 + self::GRAD_Y[$g] * $y0);
        }

        $t1 = 0.5 - $x1 * $x1 - $y1 * $y1;
        if ($t1 > 0) {
            $g = $mod[$ii + $i1 + $perm[$jj + $j1]];
            $t1 *= $t1;
            $n += $t1 * $t1 * (self::GRAD_X[$g] * $x1 + self::GRAD_Y[$g] * $y1);
        }

        $t2 = 0.5 - $x2 * $x2 - $y2 * $y2;
        if ($t2 > 0) {
            $g = $mod[$ii + 1 + $perm[$jj + 1]];
            $t2 *= $t2;
            $n += $t2 * $t2 * (self::GRAD_X[$g] * $x2 + self::GRAD_Y[$g] * $y2);
        }

        return 70.0 * $n;
    }

    /**
     * Fractal Brownian motion, normalised to roughly [-1, 1].
     */
    public function fbm(float $x, float $y, int $octaves, float $lacunarity = 2.0, float $gain = 0.5): float
    {
        $sum = 0.0;
        $amp = 1.0;
        $norm = 0.0;

        for ($o = 0; $o < $octaves; $o++) {
            $sum += $amp * $this->noise($x, $y);
            $norm += $amp;
            $amp *= $gain;
            $x = $x * $lacunarity + 17.3;
            $y = $y * $lacunarity - 9.1;
        }

        return $sum / $norm;
    }

    /**
     * Ridged multifractal noise in [0, 1]: sharp crests where the base noise crosses zero.
     */
    public function ridged(float $x, float $y, int $octaves, float $lacunarity = 2.0, float $gain = 0.5): float
    {
        $sum = 0.0;
        $amp = 1.0;
        $norm = 0.0;
        $weight = 1.0;

        for ($o = 0; $o < $octaves; $o++) {
            $r = 1.0 - abs($this->noise($x, $y));
            $r *= $r * $weight;
            $weight = min(1.0, max(0.0, $r * 1.6));
            $sum += $amp * $r;
            $norm += $amp;
            $amp *= $gain;
            $x = $x * $lacunarity + 31.7;
            $y = $y * $lacunarity + 5.3;
        }

        return $sum / $norm;
    }
}
