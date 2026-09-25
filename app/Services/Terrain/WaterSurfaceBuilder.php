<?php

namespace App\Services\Terrain;

/**
 * Turns water features (in grid coordinates) into a water surface grid and shapes the terrain
 * around it: beds are carved below the surface and banks are limited so misregistered water
 * (OSM outlines vs. elevation data) does not end up next to cliffs.
 *
 * Polygons: list of ['outer' => [[col, row], ...], 'inners' => [[[col, row], ...], ...], 'kind' => 'lake'|'river']
 * Lines:    list of ['points' => [[col, row], ...], 'width' => metres], points in flow direction
 * Coastlines (optional): list of [[col, row], ...] OSM natural=coastline ways (land left, sea right)
 *
 * Levels:
 *  - lakes / water areas: a low percentile of the elevation inside each connected area,
 *  - rivers / streams: a profile sampled along the line that never rises downstream,
 *  - river areas (riverbanks): the level of the nearest river line inside them,
 *  - ocean: sea level, flood-filled from the map edge.
 */
class WaterSurfaceBuilder
{
    /** Extra height the ocean flood fill may climb over (sand bars, DEM noise). */
    public const OCEAN_TOLERANCE = 0.5;

    /** Percentile of the elevation inside a lake used as its level (DEM over lakes is the surface). */
    public const LEVEL_PERCENTILE = 0.15;

    /** Width (metres) of the band next to water in which banks are limited to the bank angle. */
    public const BANK_BAND = 60.0;

    /** Dry cells right next to water are kept at least this far above the water surface. */
    public const SHORE_MARGIN = 0.15;

    private const DRY = 0;

    private const OCEAN = 1;

    private const LAKE = 2;

    private const RIVER_AREA = 3;

    private const LINE = 4;

    /** Temporary marker for cells queued in a flood fill. */
    private const PENDING = -200000.0;

    /**
     * @param  list<array{outer: list<array{0: float, 1: float}>, inners?: list<list<array{0: float, 1: float}>>, kind?: string}>  $polygons
     * @param  list<array{points: list<array{0: float, 1: float}>, width: float}>  $lines
     * @param  list<list<array{0: float, 1: float}>>  $coastlines
     */
    public function build(
        HeightGrid $terrain,
        float $size,
        array $polygons = [],
        array $lines = [],
        float $seaLevel = 0.0,
        bool $oceanFromEdges = false,
        ?TerrainShaping $shaping = null,
        array $coastlines = [],
    ): WaterSurfaceResult {
        $shaping ??= new TerrainShaping;
        $n = $terrain->resolution;
        $cell = $size / ($n - 1);
        $count = $n * $n;
        $t = $terrain->data;
        $noWater = TerrainStorage::NO_WATER;

        $kind = array_fill(0, $count, self::DRY);
        foreach ($polygons as $polygon) {
            $this->rasterizePolygon($kind, $n, $polygon);
        }

        $ocean = $oceanFromEdges ? $this->floodOcean($t, $n, $seaLevel, $this->coastSeeds($coastlines, $n)) : [];
        $level = array_fill(0, $count, $noWater);
        foreach ($ocean as $i => $_) {
            $kind[$i] = self::OCEAN;
            $level[$i] = $seaLevel;
        }
        $oceanCells = count($ocean);
        unset($ocean);

        $this->componentLevels($kind, $level, $t, $n, self::LAKE, $seaLevel);

        $lineDistance = [];
        foreach ($lines as $line) {
            $this->stampLine($kind, $level, $lineDistance, $t, $n, $cell, $line);
        }
        unset($lineDistance);

        $this->spreadRiverAreas($kind, $level, $n);
        $this->componentLevels($kind, $level, $t, $n, self::RIVER_AREA, $seaLevel);

        $wetCells = 0;
        $flow = [];
        foreach ($kind as $i => $k) {
            if ($k !== self::DRY) {
                $wetCells++;
                if ($k >= self::RIVER_AREA) {
                    $flow[] = $i;
                }
            }
        }

        if ($wetCells === 0) {
            return new WaterSurfaceResult(new HeightGrid($n, $t), HeightGrid::filled($n, $noWater), 0, 0);
        }

        $this->regularizeLevels($level, $kind, $flow, $t, $n, $cell);
        unset($flow);

        $this->carveAndShapeBanks($t, $kind, $level, $n, $cell, $shaping);

        foreach ($kind as $i => $k) {
            if ($k === self::DRY) {
                $level[$i] = $noWater;
            }
        }

        return new WaterSurfaceResult(new HeightGrid($n, $t), new HeightGrid($n, $level), $wetCells, $oceanCells);
    }

    /**
     * Cells connected to the map edge (or to the sea side of a coastline) that lie at or below sea
     * level, spreading over cells up to OCEAN_TOLERANCE above it (4-connected flood fill).
     *
     * @param  array<int, float>  $t
     * @param  list<int>  $seeds  extra seed cells (sea side of coastlines)
     * @return array<int, true>
     */
    public function floodOcean(array $t, int $n, float $seaLevel, array $seeds = []): array
    {
        $limit = $seaLevel + self::OCEAN_TOLERANCE;
        $visited = [];
        $stack = [];
        $last = $n - 1;

        for ($k = 0; $k < $n; $k++) {
            foreach ([$k, $last * $n + $k, $k * $n, $k * $n + $last] as $i) {
                if (! isset($visited[$i]) && $t[$i] <= $seaLevel) {
                    $visited[$i] = true;
                    $stack[] = $i;
                }
            }
        }

        foreach ($seeds as $i) {
            if (! isset($visited[$i]) && $t[$i] <= $limit) {
                $visited[$i] = true;
                $stack[] = $i;
            }
        }

        while ($stack) {
            $i = array_pop($stack);
            $col = $i % $n;

            if ($col > 0 && ! isset($visited[$i - 1]) && $t[$i - 1] <= $limit) {
                $visited[$i - 1] = true;
                $stack[] = $i - 1;
            }
            if ($col < $last && ! isset($visited[$i + 1]) && $t[$i + 1] <= $limit) {
                $visited[$i + 1] = true;
                $stack[] = $i + 1;
            }
            if ($i >= $n && ! isset($visited[$i - $n]) && $t[$i - $n] <= $limit) {
                $visited[$i - $n] = true;
                $stack[] = $i - $n;
            }
            if ($i < $n * $last && ! isset($visited[$i + $n]) && $t[$i + $n] <= $limit) {
                $visited[$i + $n] = true;
                $stack[] = $i + $n;
            }
        }

        // Ignore a handful of edge cells that merely touch sea level (DEM noise on land).
        $minimum = max(16, (int) ($n * $n * 0.0005));

        return count($visited) >= $minimum ? $visited : [];
    }

    /**
     * One cell to the sea side (right) of each coastline segment.
     *
     * @param  list<list<array{0: float, 1: float}>>  $coastlines
     * @return list<int>
     */
    private function coastSeeds(array $coastlines, int $n): array
    {
        $seeds = [];

        foreach ($coastlines as $points) {
            for ($k = 0, $m = count($points) - 1; $k < $m; $k++) {
                [$x1, $y1] = $points[$k];
                [$x2, $y2] = $points[$k + 1];
                $len = hypot($x2 - $x1, $y2 - $y1);
                if ($len < 1e-9) {
                    continue;
                }
                // Right-hand normal in grid space (rows grow southwards).
                $col = (int) round(($x1 + $x2) / 2 - ($y2 - $y1) / $len);
                $row = (int) round(($y1 + $y2) / 2 + ($x2 - $x1) / $len);
                if ($col >= 0 && $col < $n && $row >= 0 && $row < $n) {
                    $seeds[] = $row * $n + $col;
                }
            }
        }

        return $seeds;
    }

    /**
     * Give every connected area of $target cells without a level the LEVEL_PERCENTILE of the
     * elevation inside it. Areas touching the ocean near sea level join it.
     *
     * @param  array<int, int>  $kind
     * @param  array<int, float>  $level
     * @param  array<int, float>  $t
     */
    private function componentLevels(array &$kind, array &$level, array $t, int $n, int $target, float $seaLevel): void
    {
        $noWater = TerrainStorage::NO_WATER;
        $last = $n - 1;

        foreach ($kind as $start => $k) {
            if ($k !== $target || $level[$start] !== $noWater) {
                continue;
            }

            $cells = [];
            $heights = [];
            $stack = [$start];
            $level[$start] = self::PENDING;
            $touchesOcean = false;

            while ($stack) {
                $i = array_pop($stack);
                $cells[] = $i;
                $heights[] = $t[$i];
                $col = $i % $n;

                foreach ([
                    $col > 0 ? $i - 1 : -1,
                    $col < $last ? $i + 1 : -1,
                    $i >= $n ? $i - $n : -1,
                    $i < $n * $last ? $i + $n : -1,
                ] as $j) {
                    if ($j < 0) {
                        continue;
                    }
                    if ($kind[$j] === $target && $level[$j] === $noWater) {
                        $level[$j] = self::PENDING;
                        $stack[] = $j;
                    } elseif ($kind[$j] === self::OCEAN) {
                        $touchesOcean = true;
                    }
                }
            }

            sort($heights);
            $value = $heights[(int) floor(self::LEVEL_PERCENTILE * (count($heights) - 1))];

            if ($touchesOcean && $value <= $seaLevel + self::OCEAN_TOLERANCE) {
                $value = $seaLevel;
            }

            foreach ($cells as $i) {
                $level[$i] = $value;
            }
        }
    }

    /**
     * Rasterize one waterway line with a surface profile along it.
     *
     * @param  array<int, int>  $kind
     * @param  array<int, float>  $level
     * @param  array<int, float>  $lineDistance  distance (cells) of each line cell to the line that set its level
     * @param  array<int, float>  $t
     * @param  array{points: list<array{0: float, 1: float}>, width: float}  $line
     */
    private function stampLine(array &$kind, array &$level, array &$lineDistance, array $t, int $n, float $cell, array $line): void
    {
        $points = array_values($line['points']);
        if (count($points) === 0) {
            return;
        }
        if (count($points) === 1) {
            $points[] = $points[0];
        }

        $radius = max(0.0, (float) $line['width'] / 2 / $cell);

        // Cumulative arc length (cells) at each vertex.
        $cum = [0.0];
        for ($k = 1, $m = count($points); $k < $m; $k++) {
            $cum[$k] = $cum[$k - 1] + hypot($points[$k][0] - $points[$k - 1][0], $points[$k][1] - $points[$k - 1][1]);
        }
        $total = end($cum);
        $samples = max(2, (int) ceil($total) + 1);
        $spacing = $total > 1e-9 ? $total / ($samples - 1) : 1.0;

        $profile = $this->lineProfile($points, $cum, $samples, $spacing, $kind, $level, $t, $n, $radius);
        if ($profile === null) {
            return;
        }

        $last = $n - 1;
        $r2 = $radius * $radius;

        for ($k = 0, $m = count($points) - 1; $k < $m; $k++) {
            [$ax, $ay] = $points[$k];
            [$bx, $by] = $points[$k + 1];
            $dx = $bx - $ax;
            $dy = $by - $ay;
            $len2 = $dx * $dx + $dy * $dy;
            $len = sqrt($len2);

            // Thick part: every cell centre within the channel radius, plus a continuous 1-cell path.
            $candidates = $this->traverse($ax, $ay, $bx, $by, $n);
            if ($radius > 0.5) {
                $minCol = max(0, (int) ceil(min($ax, $bx) - $radius));
                $maxCol = min($last, (int) floor(max($ax, $bx) + $radius));
                $minRow = max(0, (int) ceil(min($ay, $by) - $radius));
                $maxRow = min($last, (int) floor(max($ay, $by) + $radius));
                for ($row = $minRow; $row <= $maxRow; $row++) {
                    for ($col = $minCol; $col <= $maxCol; $col++) {
                        $candidates[] = $row * $n + $col;
                    }
                }
            }

            foreach ($candidates as $i) {
                $k2 = $kind[$i];
                if ($k2 === self::OCEAN || $k2 === self::LAKE) {
                    continue;
                }
                $col = $i % $n;
                $row = intdiv($i, $n);
                $u = $len2 > 0 ? (($col - $ax) * $dx + ($row - $ay) * $dy) / $len2 : 0.0;
                $u = $u < 0 ? 0.0 : ($u > 1 ? 1.0 : $u);
                $ex = $ax + $u * $dx - $col;
                $ey = $ay + $u * $dy - $row;
                $e2 = $ex * $ex + $ey * $ey;
                // Traversed cells are always accepted (the line passes through them).
                if ($e2 > $r2 && $e2 > 0.5) {
                    continue;
                }
                $e = sqrt($e2);
                if (isset($lineDistance[$i]) && $e >= $lineDistance[$i]) {
                    continue;
                }

                $f = ($cum[$k] + $u * $len) / $spacing;
                $s0 = min($samples - 1, max(0, (int) floor($f)));
                $s1 = min($samples - 1, $s0 + 1);
                $frac = max(0.0, min(1.0, $f - $s0));

                $lineDistance[$i] = $e;
                $level[$i] = $profile[$s0] + ($profile[$s1] - $profile[$s0]) * $frac;
                if ($k2 === self::DRY) {
                    $kind[$i] = self::LINE;
                }
            }
        }
    }

    /**
     * Water level every ~cell along a line: the lowest terrain across the channel, anchored to
     * lakes / the ocean it passes through, made non-increasing downstream and smoothed.
     *
     * @param  list<array{0: float, 1: float}>  $points
     * @param  list<float>  $cum
     * @param  array<int, int>  $kind
     * @param  array<int, float>  $level
     * @param  array<int, float>  $t
     * @return list<float>|null
     */
    private function lineProfile(array $points, array $cum, int $samples, float $spacing, array $kind, array $level, array $t, int $n, float $radius): ?array
    {
        $last = $n - 1;
        $disk = min(10.0, max(1.0, $radius + 1.0));
        $disk2 = $disk * $disk;
        $noWater = TerrainStorage::NO_WATER;

        $values = [];
        $anchors = [];
        $valid = [];
        $segment = 0;
        $segments = count($points) - 1;

        for ($s = 0; $s < $samples; $s++) {
            $d = $s * $spacing;
            while ($segment < $segments - 1 && $cum[$segment + 1] < $d) {
                $segment++;
            }
            $segLen = $cum[$segment + 1] - $cum[$segment];
            $u = $segLen > 1e-9 ? max(0.0, min(1.0, ($d - $cum[$segment]) / $segLen)) : 0.0;
            $x = $points[$segment][0] + ($points[$segment + 1][0] - $points[$segment][0]) * $u;
            $y = $points[$segment][1] + ($points[$segment + 1][1] - $points[$segment][1]) * $u;

            $c = (int) round($x);
            $r = (int) round($y);
            if ($c < 0 || $c > $last || $r < 0 || $r > $last) {
                continue;
            }

            $i = $r * $n + $c;
            if (($kind[$i] === self::LAKE || $kind[$i] === self::OCEAN) && $level[$i] !== $noWater) {
                $valid[] = $s;
                $values[] = $level[$i];
                $anchors[] = true;

                continue;
            }

            $min = INF;
            $reach = (int) floor($disk);
            for ($rr = max(0, $r - $reach); $rr <= min($last, $r + $reach); $rr++) {
                $ddy = $rr - $y;
                for ($cc = max(0, $c - $reach); $cc <= min($last, $c + $reach); $cc++) {
                    $ddx = $cc - $x;
                    if ($ddx * $ddx + $ddy * $ddy <= $disk2 || ($cc === $c && $rr === $r)) {
                        $h = $t[$rr * $n + $cc];
                        if ($h < $min) {
                            $min = $h;
                        }
                    }
                }
            }

            $valid[] = $s;
            $values[] = $min;
            $anchors[] = false;
        }

        if ($values === []) {
            return null;
        }

        $fitted = $this->fitProfile($values, $anchors);

        // Expand to all samples (those outside the grid take the nearest valid value).
        $profile = array_fill(0, $samples, $fitted[0]);
        $v = 0;
        $count = count($valid);
        for ($s = 0; $s < $samples; $s++) {
            while ($v < $count - 1 && abs($valid[$v + 1] - $s) <= abs($valid[$v] - $s)) {
                $v++;
            }
            $profile[$s] = $fitted[$v];
        }

        return $profile;
    }

    /**
     * Robust non-increasing fit: median filter → weighted isotonic regression (anchors weigh
     * heavily) → capped slightly above the local minimum → running minimum → moving average.
     * Lines that clearly run uphill (drawn against the flow) are fitted in reverse.
     *
     * @param  list<float>  $values
     * @param  list<bool>  $anchors
     * @return list<float>
     */
    public function fitProfile(array $values, array $anchors): array
    {
        $m = count($values);
        $third = max(1, intdiv($m, 3));
        $head = array_sum(array_slice($values, 0, $third)) / $third;
        $tail = array_sum(array_slice($values, $m - $third)) / $third;
        $reverse = $tail > $head + 0.5;

        if ($reverse) {
            $values = array_reverse($values);
            $anchors = array_reverse($anchors);
        }

        $median = [];
        $weights = [];
        for ($k = 0; $k < $m; $k++) {
            if ($anchors[$k]) {
                $median[$k] = $values[$k];
                $weights[$k] = 50.0;

                continue;
            }
            $window = array_slice($values, max(0, $k - 2), min($m, $k + 3) - max(0, $k - 2));
            sort($window);
            $median[$k] = $window[intdiv(count($window), 2)];
            $weights[$k] = 1.0;
        }

        $iso = $this->isotonicDecreasing($median, $weights);

        $running = INF;
        $capped = [];
        for ($k = 0; $k < $m; $k++) {
            $v = $anchors[$k] ? $median[$k] : min($iso[$k], $median[$k] + 0.25);
            $running = min($running, $v);
            $capped[$k] = $running;
        }

        // Moving average keeps the sequence non-increasing.
        $radius = 3;
        $smooth = [];
        for ($k = 0; $k < $m; $k++) {
            $sum = 0.0;
            for ($j = $k - $radius; $j <= $k + $radius; $j++) {
                $sum += $capped[$j < 0 ? 0 : ($j >= $m ? $m - 1 : $j)];
            }
            $smooth[$k] = $sum / (2 * $radius + 1);
        }

        return $reverse ? array_reverse($smooth) : $smooth;
    }

    /**
     * Weighted pool-adjacent-violators fit of a non-increasing sequence.
     *
     * @param  list<float>  $values
     * @param  list<float>  $weights
     * @return list<float>
     */
    private function isotonicDecreasing(array $values, array $weights): array
    {
        $blockValue = [];
        $blockWeight = [];
        $blockSize = [];
        $b = -1;

        foreach ($values as $k => $v) {
            $b++;
            $blockValue[$b] = $v;
            $blockWeight[$b] = $weights[$k];
            $blockSize[$b] = 1;

            while ($b > 0 && $blockValue[$b - 1] < $blockValue[$b]) {
                $w = $blockWeight[$b - 1] + $blockWeight[$b];
                $blockValue[$b - 1] = ($blockValue[$b - 1] * $blockWeight[$b - 1] + $blockValue[$b] * $blockWeight[$b]) / $w;
                $blockWeight[$b - 1] = $w;
                $blockSize[$b - 1] += $blockSize[$b];
                unset($blockValue[$b], $blockWeight[$b], $blockSize[$b]);
                $b--;
            }
        }

        $out = [];
        for ($k = 0; $k <= $b; $k++) {
            for ($j = 0; $j < $blockSize[$k]; $j++) {
                $out[] = $blockValue[$k];
            }
        }

        return $out;
    }

    /**
     * River areas (riverbanks, water=river) take the level of the nearest river line in them.
     *
     * @param  array<int, int>  $kind
     * @param  array<int, float>  $level
     */
    private function spreadRiverAreas(array $kind, array &$level, int $n): void
    {
        $noWater = TerrainStorage::NO_WATER;
        $queue = [];
        $hasAreas = false;

        foreach ($kind as $i => $k) {
            if ($k === self::LINE || ($k === self::RIVER_AREA && $level[$i] !== $noWater)) {
                $queue[] = $i;
            } elseif ($k === self::RIVER_AREA) {
                $hasAreas = true;
            }
        }

        if (! $hasAreas) {
            return;
        }

        $last = $n - 1;
        for ($q = 0; $q < count($queue); $q++) {
            $i = $queue[$q];
            $col = $i % $n;
            $row = intdiv($i, $n);
            for ($dr = -1; $dr <= 1; $dr++) {
                $rr = $row + $dr;
                if ($rr < 0 || $rr > $last) {
                    continue;
                }
                for ($dc = -1; $dc <= 1; $dc++) {
                    $cc = $col + $dc;
                    if ($cc < 0 || $cc > $last) {
                        continue;
                    }
                    $j = $rr * $n + $cc;
                    if ($kind[$j] === self::RIVER_AREA && $level[$j] === $noWater) {
                        $level[$j] = $level[$i];
                        $queue[] = $j;
                    }
                }
            }
        }
    }

    /**
     * Remove single-cell spikes / holes (3×3 median over wet neighbours) from flowing water and
     * make sure its surface never steps up to a wet neighbour by more than the local terrain step.
     * Lakes and the ocean stay flat.
     *
     * @param  array<int, float>  $level
     * @param  array<int, int>  $kind
     * @param  list<int>  $flow  indices of line / river-area cells (ascending)
     * @param  array<int, float>  $t
     */
    private function regularizeLevels(array &$level, array $kind, array $flow, array $t, int $n, float $cell): void
    {
        if ($flow === []) {
            return;
        }

        $last = $n - 1;
        $neighbours = static function (int $i) use ($n, $last): array {
            $col = $i % $n;
            $row = intdiv($i, $n);
            $out = [];
            for ($dr = -1; $dr <= 1; $dr++) {
                $rr = $row + $dr;
                if ($rr < 0 || $rr > $last) {
                    continue;
                }
                for ($dc = -1; $dc <= 1; $dc++) {
                    $cc = $col + $dc;
                    if (($dr !== 0 || $dc !== 0) && $cc >= 0 && $cc <= $last) {
                        $out[] = $rr * $n + $cc;
                    }
                }
            }

            return $out;
        };

        $filtered = [];
        foreach ($flow as $i) {
            $values = [$level[$i]];
            foreach ($neighbours($i) as $j) {
                if ($kind[$j] !== self::DRY && $kind[$j] !== self::OCEAN) {
                    $values[] = $level[$j];
                }
            }
            sort($values);
            $filtered[$i] = $values[intdiv(count($values), 2)];
        }
        foreach ($filtered as $i => $v) {
            $level[$i] = $v;
        }
        unset($filtered);

        $steps = [];
        foreach ($flow as $i) {
            $step = 0.02 * $cell;
            $col = $i % $n;
            foreach ([$col > 0 ? $i - 1 : $i, $col < $last ? $i + 1 : $i, $i >= $n ? $i - $n : $i, $i < $n * $last ? $i + $n : $i] as $j) {
                $step = max($step, abs($t[$i] - $t[$j]));
            }
            $steps[$i] = $step;
        }

        foreach ([$flow, array_reverse($flow)] as $order) {
            foreach ($order as $i) {
                $limit = $level[$i];
                foreach ($neighbours($i) as $j) {
                    if ($kind[$j] !== self::DRY && $limit > $level[$j] + $steps[$i]) {
                        $limit = $level[$j] + $steps[$i];
                    }
                }
                $level[$i] = $limit;
            }
        }
    }

    /**
     * Carve beds, limit banks to the bank angle and soften the shoreline.
     *
     * @param  array<int, float>  $t
     * @param  array<int, int>  $kind
     * @param  array<int, float>  $level
     */
    private function carveAndShapeBanks(array &$t, array $kind, array $level, int $n, float $cell, TerrainShaping $shaping): void
    {
        $halfCell = 0.5 * $cell;
        $minDepth = TerrainShaping::MIN_DEPTH;

        // Distance of wet cells to the shore (nearest dry cell).
        $inside = [];
        $none = [];
        foreach ($kind as $i => $k) {
            $inside[$i] = $k === self::DRY ? 0.0 : INF;
        }
        $inside = $this->chamfer($inside, $n, $cell, $none, false);

        foreach ($kind as $i => $k) {
            if ($k === self::DRY) {
                continue;
            }
            $maxDepth = ($k === self::LAKE || $k === self::OCEAN) ? $shaping->lakeDepth : $shaping->riverDepth;
            $bed = $level[$i] - $shaping->depthAt(max(0.0, $inside[$i] - $halfCell), $maxDepth);
            if ($t[$i] > $bed) {
                $t[$i] = $bed;
            }
        }

        // Distance of dry cells to the nearest water, and which water cell that is.
        $outside = [];
        $nearest = [];
        foreach ($kind as $i => $k) {
            $wet = $k !== self::DRY;
            $outside[$i] = $wet ? 0.0 : INF;
            $nearest[$i] = $wet ? $i : -1;
        }
        $outside = $this->chamfer($outside, $n, $cell, $nearest, true);

        $band = max(self::BANK_BAND, 3 * $cell);
        $fadeFrom = 0.6 * $band;
        $tanBank = tan(deg2rad($shaping->bankAngle));
        // The game meshes 1025 grids at every second sample and extrapolates the surface one step
        // onto dry ground, so keep the shore above water that far out.
        $raiseReach = ($n > 600 ? 2.9 : 1.5) * $cell;

        $shore = [];
        $bankLimit = [];
        foreach ($kind as $i => $k) {
            if ($k !== self::DRY) {
                // Soften the bed near the shore, but keep the full carve along the middle of a
                // channel (cells without a deeper neighbour), so narrow streams keep their depth.
                if ($inside[$i] <= 2.5 * $cell && $this->hasDeeperNeighbour($inside, $i, $n)) {
                    $shore[] = $i;
                }

                continue;
            }
            $dist = $outside[$i];
            if ($dist > $band) {
                continue;
            }
            $j = $nearest[$i];
            $surface = $level[$j];

            $limit = INF;
            if ($kind[$j] !== self::OCEAN) {
                $limit = $surface + $tanBank * max(0.0, $dist - $halfCell);
                if ($t[$i] > $limit) {
                    $w = $dist <= $fadeFrom ? 1.0 : 1.0 - $this->smoothstep($fadeFrom, $band, $dist);
                    $t[$i] -= $w * ($t[$i] - $limit);
                }
            }

            if ($dist <= 4.0 * $cell) {
                $shore[] = $i;
                $bankLimit[$i] = max($t[$i], $limit);
            }
        }
        unset($inside);

        // Soft shore: blend in a small gaussian (σ ≈ 2 cells) over a band of ~4 cells around the
        // water edge. This rounds off stair-stepped DEM shorelines and the step at the waterline.
        // Beds are blurred as if the shore sat at water level, banks as if the water were solid at
        // its surface, so neither side is dragged towards the other's extreme.
        $before = [];
        $bed = $t;
        $bank = $t;
        foreach ($kind as $i => $k) {
            if ($k === self::DRY) {
                if ($outside[$i] <= $band) {
                    $bed[$i] = min($t[$i], $level[$nearest[$i]]);
                }
            } else {
                $bank[$i] = $level[$i];
            }
        }
        $bed = TerrainSmoother::gaussian($bed, $n, 2);
        $bank = TerrainSmoother::gaussian($bank, $n, 2);
        $inner = 1.5 * $cell;
        $outer = 4.0 * $cell;
        foreach ($shore as $i) {
            $before[$i] = $t[$i];
            if ($kind[$i] !== self::DRY) {
                $t[$i] = $bed[$i];

                continue;
            }
            $dist = $outside[$i];
            $w = $dist <= $inner ? 1.0 : 1.0 - $this->smoothstep($inner, $outer, $dist);
            $t[$i] = min($t[$i] + $w * ($bank[$i] - $t[$i]), $bankLimit[$i]);
        }
        unset($bed, $bank, $bankLimit);

        // Keep beds under water and the immediate shore just above it.
        foreach ($shore as $i) {
            if ($kind[$i] !== self::DRY) {
                $t[$i] = min($t[$i], $level[$i] - $minDepth);
            }
        }
        foreach ($kind as $i => $k) {
            if ($k !== self::DRY || $outside[$i] > $raiseReach) {
                continue;
            }
            $surface = $level[$nearest[$i]];
            $original = $before[$i] ?? $t[$i];
            if ($t[$i] < $surface + self::SHORE_MARGIN && $original > $surface - 1.0) {
                $t[$i] = $surface + self::SHORE_MARGIN;
            }
        }
    }

    /**
     * @param  array<int, float>  $inside
     */
    private function hasDeeperNeighbour(array $inside, int $i, int $n): bool
    {
        $col = $i % $n;
        $row = intdiv($i, $n);
        $own = $inside[$i] + 1e-6;

        for ($rr = max(0, $row - 1); $rr <= min($n - 1, $row + 1); $rr++) {
            for ($cc = max(0, $col - 1); $cc <= min($n - 1, $col + 1); $cc++) {
                if ($inside[$rr * $n + $cc] > $own) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * Two-pass chamfer distance transform (metres). Cells with distance 0 are sources; $nearest
     * carries the source index along when $carry is set.
     *
     * @param  array<int, float>  $d
     * @param  array<int, int>  $nearest
     * @return array<int, float>
     */
    private function chamfer(array $d, int $n, float $cell, array &$nearest, bool $carry): array
    {
        $diag = $cell * M_SQRT2;
        $last = $n - 1;

        for ($row = 0; $row < $n; $row++) {
            $base = $row * $n;
            for ($col = 0; $col < $n; $col++) {
                $i = $base + $col;
                $best = $d[$i];
                if ($best === 0.0) {
                    continue;
                }
                $from = -1;
                if ($col > 0 && $best > $d[$i - 1] + $cell) {
                    $best = $d[$i - 1] + $cell;
                    $from = $i - 1;
                }
                if ($row > 0) {
                    $j = $i - $n;
                    if ($best > $d[$j] + $cell) {
                        $best = $d[$j] + $cell;
                        $from = $j;
                    }
                    if ($col > 0 && $best > $d[$j - 1] + $diag) {
                        $best = $d[$j - 1] + $diag;
                        $from = $j - 1;
                    }
                    if ($col < $last && $best > $d[$j + 1] + $diag) {
                        $best = $d[$j + 1] + $diag;
                        $from = $j + 1;
                    }
                }
                if ($from >= 0) {
                    $d[$i] = $best;
                    if ($carry) {
                        $nearest[$i] = $nearest[$from];
                    }
                }
            }
        }

        for ($row = $last; $row >= 0; $row--) {
            $base = $row * $n;
            for ($col = $last; $col >= 0; $col--) {
                $i = $base + $col;
                $best = $d[$i];
                if ($best === 0.0) {
                    continue;
                }
                $from = -1;
                if ($col < $last && $best > $d[$i + 1] + $cell) {
                    $best = $d[$i + 1] + $cell;
                    $from = $i + 1;
                }
                if ($row < $last) {
                    $j = $i + $n;
                    if ($best > $d[$j] + $cell) {
                        $best = $d[$j] + $cell;
                        $from = $j;
                    }
                    if ($col < $last && $best > $d[$j + 1] + $diag) {
                        $best = $d[$j + 1] + $diag;
                        $from = $j + 1;
                    }
                    if ($col > 0 && $best > $d[$j - 1] + $diag) {
                        $best = $d[$j - 1] + $diag;
                        $from = $j - 1;
                    }
                }
                if ($from >= 0) {
                    $d[$i] = $best;
                    if ($carry) {
                        $nearest[$i] = $nearest[$from];
                    }
                }
            }
        }

        return $d;
    }

    /**
     * Even-odd scanline fill of all rings (inner rings become holes), by cell centre. Thin or tiny
     * polygons additionally mark every cell their outline passes through so they never vanish.
     *
     * @param  array<int, int>  $kind
     * @param  array{outer: list<array{0: float, 1: float}>, inners?: list<list<array{0: float, 1: float}>>, kind?: string}  $polygon
     */
    private function rasterizePolygon(array &$kind, int $n, array $polygon): void
    {
        $value = ($polygon['kind'] ?? 'lake') === 'river' ? self::RIVER_AREA : self::LAKE;
        $mark = static function (int $i) use (&$kind, $value): void {
            if ($kind[$i] === self::DRY || ($value === self::LAKE && $kind[$i] === self::RIVER_AREA)) {
                $kind[$i] = $value;
            }
        };

        $outer = $polygon['outer'];
        $rings = [$outer, ...($polygon['inners'] ?? [])];
        $last = $n - 1;
        $buckets = [];
        $edges = [];

        foreach ($rings as $ring) {
            $count = count($ring);
            if ($count < 3) {
                continue;
            }
            for ($k = 0; $k < $count; $k++) {
                [$x1, $y1] = $ring[$k];
                [$x2, $y2] = $ring[($k + 1) % $count];
                if ($y1 == $y2) {
                    continue;
                }
                $rowStart = max(0, (int) ceil(min($y1, $y2)));
                $rowEnd = min($last, (int) ceil(max($y1, $y2)) - 1);
                if ($rowStart > $rowEnd) {
                    continue;
                }
                $e = count($edges);
                $edges[] = [$x1, $y1, ($x2 - $x1) / ($y2 - $y1)];
                for ($row = $rowStart; $row <= $rowEnd; $row++) {
                    $buckets[$row][] = $e;
                }
            }
        }

        foreach ($buckets as $row => $edgeIds) {
            $xs = [];
            foreach ($edgeIds as $e) {
                [$x1, $y1, $slope] = $edges[$e];
                $xs[] = $x1 + ($row - $y1) * $slope;
            }
            sort($xs);
            $base = $row * $n;
            for ($k = 0, $m = count($xs) - 1; $k < $m; $k += 2) {
                $from = max(0, (int) ceil($xs[$k]));
                $to = min($last, (int) floor($xs[$k + 1]));
                for ($col = $from; $col <= $to; $col++) {
                    $mark($base + $col);
                }
            }
        }

        // Thin (narrower than ~3 cells) or tiny polygons: conservative outline.
        $count = count($outer);
        if ($count === 0) {
            return;
        }
        $area = 0.0;
        $perimeter = 0.0;
        for ($k = 0; $k < $count; $k++) {
            [$x1, $y1] = $outer[$k];
            [$x2, $y2] = $outer[($k + 1) % $count];
            $area += $x1 * $y2 - $x2 * $y1;
            $perimeter += hypot($x2 - $x1, $y2 - $y1);
        }
        $area = abs($area) / 2;

        if ($perimeter < 1e-9 || 2 * $area / $perimeter < 1.5) {
            for ($k = 0; $k < $count; $k++) {
                [$x1, $y1] = $outer[$k];
                [$x2, $y2] = $outer[($k + 1) % $count];
                foreach ($this->traverse($x1, $y1, $x2, $y2, $n) as $i) {
                    $mark($i);
                }
            }
        }
    }

    /**
     * Grid cells (indices, inside the grid) a segment passes through — a 4-connected path.
     * Cell (c, r) covers [c − ½, c + ½] × [r − ½, r + ½].
     *
     * @return list<int>
     */
    private function traverse(float $x1, float $y1, float $x2, float $y2, int $n): array
    {
        $last = $n - 1;
        if ((max($x1, $x2) < -0.5) || (min($x1, $x2) > $last + 0.5) || (max($y1, $y2) < -0.5) || (min($y1, $y2) > $last + 0.5)) {
            return [];
        }

        $c = (int) floor($x1 + 0.5);
        $r = (int) floor($y1 + 0.5);
        $cEnd = (int) floor($x2 + 0.5);
        $rEnd = (int) floor($y2 + 0.5);
        $dx = $x2 - $x1;
        $dy = $y2 - $y1;
        $stepC = $dx > 0 ? 1 : -1;
        $stepR = $dy > 0 ? 1 : -1;
        $tDeltaC = $dx != 0 ? 1 / abs($dx) : INF;
        $tDeltaR = $dy != 0 ? 1 / abs($dy) : INF;
        $tMaxC = $dx > 0 ? ($c + 0.5 - $x1) / $dx : ($dx < 0 ? ($x1 - ($c - 0.5)) / -$dx : INF);
        $tMaxR = $dy > 0 ? ($r + 0.5 - $y1) / $dy : ($dy < 0 ? ($y1 - ($r - 0.5)) / -$dy : INF);
        $steps = abs($cEnd - $c) + abs($rEnd - $r);

        $cells = [];
        for ($s = 0; $s <= $steps; $s++) {
            if ($c >= 0 && $c <= $last && $r >= 0 && $r <= $last) {
                $cells[] = $r * $n + $c;
            }
            if ($tMaxC < $tMaxR) {
                $tMaxC += $tDeltaC;
                $c += $stepC;
            } else {
                $tMaxR += $tDeltaR;
                $r += $stepR;
            }
        }

        return $cells;
    }

    private function smoothstep(float $edge0, float $edge1, float $x): float
    {
        $t = max(0.0, min(1.0, ($x - $edge0) / ($edge1 - $edge0)));

        return $t * $t * (3 - 2 * $t);
    }
}
