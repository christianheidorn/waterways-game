<?php

namespace App\Services\Terrain;

/**
 * Seeded open-world terrain: rolling hills, a couple of ridged mountain areas and valleys,
 * with a meandering river valley and a lake basin carved in so every map has water.
 *
 * Feature sizes are expressed relative to the map size; heights scale sub-linearly with it
 * (roughly 0–220 m for a 2 km map).
 */
class ProceduralHeightmapGenerator
{
    public function __construct(private readonly WaterSurfaceBuilder $water = new WaterSurfaceBuilder) {}

    public function flat(int $resolution, float $height = 10): HeightGrid
    {
        return HeightGrid::filled($resolution, $height);
    }

    /**
     * Terrain only (river/lake beds already carved).
     */
    public function procedural(int $resolution, float $size, int $seed): HeightGrid
    {
        return $this->proceduralWithWater($resolution, $size, $seed)->terrain;
    }

    /**
     * Terrain plus the water surface grid for its river and lake.
     *
     * @param  (callable(float, string): void)|null  $progress  fraction 0-1 and a message
     */
    public function proceduralWithWater(int $resolution, float $size, int $seed, ?callable $progress = null, ?TerrainShaping $shaping = null): WaterSurfaceResult
    {
        $progress ??= static fn () => null;
        $shaping ??= new TerrainShaping;
        $progress(0.0, 'Sculpting hills and mountains');

        $grid = $this->baseTerrain($resolution, $size, $seed, $progress);

        $progress(0.6, 'Carving river valley');
        $river = $this->carveRiver($grid, $size, $seed);

        $progress(0.75, 'Shaping lake basin');
        $lake = $this->carveLake($grid, $size, $seed, $river['centre']);

        // Light version of the real-world de-terracing: softens carved edges.
        TerrainSmoother::deterrace($grid, $size / ($resolution - 1), $shaping->smoothing, 1.0, 0.35);

        $progress(0.85, 'Filling rivers and lakes');

        return $this->water->build($grid, $size, $lake === null ? [] : [$lake], [$river['line']], 0.0, false, $shaping);
    }

    /**
     * @param  callable(float, string): void  $progress
     */
    private function baseTerrain(int $n, float $size, int $seed, callable $progress): HeightGrid
    {
        $base = new SimplexNoise($seed);
        $ridges = new SimplexNoise($seed + 101);
        $masks = new SimplexNoise($seed + 202);

        $heightScale = max(0.35, min(3.0, ($size / 2048) ** 0.6));
        $inv = 1.0 / ($n - 1);
        $data = array_fill(0, $n * $n, 0.0);

        // Skip octaves finer than ~2 cells: they would only alias.
        $maxFreq = ($n - 1) / 2.5;
        $hillOctaves = $this->octavesFor(4.0, $maxFreq, 6);
        $ridgeOctaves = $this->octavesFor(5.0, $maxFreq, 6);

        for ($row = 0; $row < $n; $row++) {
            $v = $row * $inv;
            for ($col = 0; $col < $n; $col++) {
                $u = $col * $inv;

                // Domain warp for less grid-aligned features.
                $wx = $u + 0.08 * $masks->noise($u * 2.1 + 40.0, $v * 2.1);
                $wy = $v + 0.08 * $masks->noise($u * 2.1, $v * 2.1 - 40.0);

                $continent = $base->fbm($wx * 1.6 + 3.1, $wy * 1.6 - 7.7, 3);
                $hills = $base->fbm($wx * 4.0, $wy * 4.0, $hillOctaves);

                $mountainMask = $masks->noise($u * 1.3 - 11.0, $v * 1.3 + 5.0);
                $mountainMask = $this->smoothstep(0.12, 0.6, $mountainMask);
                $mountains = $mountainMask > 0.001
                    ? $mountainMask * $ridges->ridged($wx * 5.0, $wy * 5.0, $ridgeOctaves)
                    : 0.0;

                $valley = 1.0 - abs($ridges->noise($wx * 2.2 + 70.0, $wy * 2.2));
                $valley = $valley ** 6;

                $data[$row * $n + $col] = 45.0 * $continent + 28.0 * $hills + 190.0 * $mountains - 30.0 * $valley;
            }

            if ($row % 64 === 0) {
                $progress(0.55 * $row / $n, 'Sculpting hills and mountains');
            }
        }

        // Normalise into [2, 220] m (scaled with map size).
        $min = min($data);
        $max = max($data);
        $low = 2.0 * $heightScale;
        $range = 218.0 * $heightScale;
        $k = $max > $min ? $range / ($max - $min) : 0.0;

        foreach ($data as $i => $h) {
            $data[$i] = $low + ($h - $min) * $k;
        }

        return new HeightGrid($n, $data);
    }

    /**
     * Carve a meandering river valley running west ↔ east and return its channel polyline.
     *
     * @return array{line: array{points: list<array{0: float, 1: float}>, width: float}, centre: list<float>}
     */
    private function carveRiver(HeightGrid $grid, float $size, int $seed): array
    {
        $n = $grid->resolution;
        $cell = $size / ($n - 1);
        $noise = new SimplexNoise($seed + 303);
        $data = $grid->data;

        $width = max(14.0, 3.2 * $cell, $size * 0.009);
        $halfFlat = $width / 2 + 1.5 * $cell;

        // Centre line (row coordinate per column) with two meander frequencies.
        $offset = 0.25 + 0.5 * (($noise->noise(0.5, 0.5) + 1) / 2);
        $phase = $noise->noise(2.5, 9.1) * M_PI;
        $centre = [];
        for ($col = 0; $col < $n; $col++) {
            $u = $col / ($n - 1);
            $row = $offset
                + 0.09 * sin($u * M_PI * 2.3 + $phase)
                + 0.07 * $noise->fbm($u * 3.0, 4.2, 3);
            $centre[$col] = max(0.12, min(0.88, $row)) * ($n - 1);
        }

        // Cosine of the channel angle per column, to turn vertical offsets into distances.
        $cosAngle = [];
        for ($col = 0; $col < $n; $col++) {
            $slope = ($centre[min($n - 1, $col + 1)] - $centre[max(0, $col - 1)]) / 2;
            $cosAngle[$col] = 1 / sqrt(1 + $slope * $slope);
        }

        // Bed level: lowest terrain across the channel, made monotonic downstream and smoothed.
        $band = (int) ceil($halfFlat / $cell) + 2;
        $bed = [];
        for ($col = 0; $col < $n; $col++) {
            $c = (int) round($centre[$col]);
            $low = INF;
            for ($row = max(0, $c - $band); $row <= min($n - 1, $c + $band); $row++) {
                $low = min($low, $data[$row * $n + $col]);
            }
            $bed[$col] = $low;
        }

        $westToEast = $bed[0] >= $bed[$n - 1];
        $order = $westToEast ? range(0, $n - 1) : range($n - 1, 0);
        $running = INF;
        foreach ($order as $col) {
            $running = min($running, $bed[$col]);
            $bed[$col] = $running;
        }
        $bed = $this->smoothMonotonic($bed, max(2, (int) ($n / 64)));

        // Valley walls rise with a gentle, noise-varied slope; blend with a smooth minimum.
        // The valley only reaches a limited distance from the channel and fades back into the
        // natural terrain, so distant hills are left untouched.
        $valleyRadius = max(120.0, $size * 0.09);
        for ($col = 0; $col < $n; $col++) {
            $u = $col / ($n - 1);
            $wallSlope = 0.16 + 0.1 * $noise->noise($u * 5.0, 1.7);
            $c = $centre[$col];
            $cos = $cosAngle[$col];
            $b = $bed[$col];

            for ($row = 0; $row < $n; $row++) {
                $d = abs($row - $c) * $cell * $cos;

                if ($d > $valleyRadius) {
                    continue;
                }

                $i = $row * $n + $col;
                $h = $data[$i];
                $carved = $d <= $halfFlat ? $b : $b + 0.35 + ($d - $halfFlat) * $wallSlope;
                if ($carved < $h + 6.0) {
                    $shaped = $d <= $halfFlat
                        ? min($h, $b)
                        : max(min($h, $b + 0.3), $this->smoothMin($h, $carved, 3.0));
                    $blend = 1.0 - $this->smoothstep($valleyRadius * 0.55, $valleyRadius, $d);
                    $data[$i] = $h + ($shaped - $h) * $blend;
                }
            }
        }

        $grid->data = $data;

        $points = [];
        $step = max(1, (int) round(8 / max(1.0, $width / $cell)));
        for ($col = 0; $col < $n; $col += $step) {
            $points[] = [(float) $col, $centre[$col]];
        }
        if (end($points)[0] !== (float) ($n - 1)) {
            $points[] = [(float) ($n - 1), $centre[$n - 1]];
        }

        return ['line' => ['points' => $points, 'width' => $width], 'centre' => $centre];
    }

    /**
     * Carve a flat-floored lake basin in the lowest suitable spot away from the river.
     *
     * @param  list<float>  $riverCentre
     * @return array{outer: list<array{0: float, 1: float}>, inners: list<never>, kind: string}|null
     */
    private function carveLake(HeightGrid $grid, float $size, int $seed, array $riverCentre): ?array
    {
        $n = $grid->resolution;
        $cell = $size / ($n - 1);
        $noise = new SimplexNoise($seed + 404);
        $data = $grid->data;

        $radius = max(4.0 * $cell, $size * 0.065); // metres
        $radiusCells = $radius / $cell;
        $shore = $radius * 0.9;

        // Pick the lowest candidate (sampled on a seeded jittered lattice) away from the river.
        $best = null;
        for ($k = 0; $k < 24; $k++) {
            $cu = 0.2 + 0.6 * (($noise->noise($k * 1.37, 0.3) + 1) / 2);
            $cv = 0.2 + 0.6 * (($noise->noise(0.7, $k * 1.91) + 1) / 2);
            $col = $cu * ($n - 1);
            $row = $cv * ($n - 1);
            $riverRow = $riverCentre[(int) round($col)];
            if (abs($row - $riverRow) * $cell < $radius * 2.4 + $shore) {
                continue;
            }
            $h = $grid->sample($col, $row);
            if ($best === null || $h < $best[2]) {
                $best = [$col, $row, $h];
            }
        }

        if ($best === null) {
            return null;
        }

        [$cx, $cy] = $best;

        // Wobbly outline radius per angle.
        $segments = 48;
        $radii = [];
        for ($s = 0; $s < $segments; $s++) {
            $a = $s / $segments * 2 * M_PI;
            $radii[$s] = $radiusCells * (1 + 0.28 * $noise->noise(cos($a) * 1.3 + 9.0, sin($a) * 1.3));
        }
        $radiusAt = static function (float $angle) use ($radii, $segments): float {
            $f = ($angle / (2 * M_PI) + 1.0) * $segments;
            $i0 = ((int) floor($f)) % $segments;
            $t = $f - floor($f);

            return $radii[$i0] + ($radii[($i0 + 1) % $segments] - $radii[$i0]) * $t;
        };

        // Lake level: lowest terrain around the basin so the water cannot spill out.
        $reach = (int) ceil($radiusCells * 1.4 + $shore / $cell + 2);
        $level = INF;
        for ($row = max(0, (int) $cy - $reach); $row <= min($n - 1, (int) $cy + $reach); $row++) {
            for ($col = max(0, (int) $cx - $reach); $col <= min($n - 1, (int) $cx + $reach); $col++) {
                $dist = hypot($col - $cx, $row - $cy);
                if ($dist <= $radiusAt(atan2($row - $cy, $col - $cx)) * 1.35 + 2.0) {
                    $level = min($level, $data[$row * $n + $col]);
                }
            }
        }

        $shoreCells = $shore / $cell;
        for ($row = max(0, (int) $cy - $reach); $row <= min($n - 1, (int) $cy + $reach); $row++) {
            for ($col = max(0, (int) $cx - $reach); $col <= min($n - 1, (int) $cx + $reach); $col++) {
                $dist = hypot($col - $cx, $row - $cy);
                $edge = $radiusAt(atan2($row - $cy, $col - $cx)) + 0.75;
                $i = $row * $n + $col;
                if ($dist <= $edge) {
                    $data[$i] = $level;
                } elseif ($dist <= $edge + $shoreCells) {
                    $s = $this->smoothstep(0.0, 1.0, ($dist - $edge) / $shoreCells);
                    $data[$i] = min($data[$i], $level + ($data[$i] - $level) * $s + 0.35 * (1 - $s) + 0.02);
                }
            }
        }

        $grid->data = $data;

        $outer = [];
        foreach ($radii as $s => $r) {
            $a = $s / $segments * 2 * M_PI;
            $outer[] = [$cx + cos($a) * $r, $cy + sin($a) * $r];
        }

        return ['outer' => $outer, 'inners' => [], 'kind' => 'lake'];
    }

    private function octavesFor(float $baseFreq, float $maxFreq, int $cap): int
    {
        $octaves = 1;
        while ($octaves < $cap && $baseFreq * (2 ** $octaves) <= $maxFreq) {
            $octaves++;
        }

        return $octaves;
    }

    /**
     * Moving average that preserves monotonicity of the input.
     *
     * @param  array<int, float>  $values
     * @return array<int, float>
     */
    private function smoothMonotonic(array $values, int $radius): array
    {
        $count = count($values);
        $out = [];
        for ($i = 0; $i < $count; $i++) {
            $sum = 0.0;
            $k = 0;
            for ($j = $i - $radius; $j <= $i + $radius; $j++) {
                $sum += $values[max(0, min($count - 1, $j))];
                $k++;
            }
            $out[$i] = $sum / $k;
        }

        return $out;
    }

    private function smoothstep(float $edge0, float $edge1, float $x): float
    {
        $t = max(0.0, min(1.0, ($x - $edge0) / ($edge1 - $edge0)));

        return $t * $t * (3 - 2 * $t);
    }

    /**
     * Polynomial smooth minimum.
     */
    private function smoothMin(float $a, float $b, float $k): float
    {
        $h = max(0.0, min(1.0, 0.5 + 0.5 * ($b - $a) / $k));

        return $b + ($a - $b) * $h - $k * $h * (1 - $h);
    }
}
