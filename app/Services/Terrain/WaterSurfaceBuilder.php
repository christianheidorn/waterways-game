<?php

namespace App\Services\Terrain;

/**
 * Turns water features (in grid coordinates) into a water surface grid and carves the terrain
 * underneath so rivers and lakes have a bed.
 *
 * Polygons: list of ['outer' => [[col, row], ...], 'inners' => [[[col, row], ...], ...]]
 * Lines:    list of ['points' => [[col, row], ...], 'width' => metres]
 */
class WaterSurfaceBuilder
{
    public const LAKE_MAX_DEPTH = 8.0;

    public const RIVER_MAX_DEPTH = 2.5;

    /** Blur radius (cells) used to derive the water surface from the terrain. */
    private const BLUR_RADIUS = 3;

    /** Max height the surface may sit above the bank terrain at mask edges. */
    private const EDGE_TOLERANCE = 0.3;

    /** Extra height the ocean flood fill may climb over (sand bars, DEM noise). */
    private const OCEAN_TOLERANCE = 0.5;

    private const OCEAN_MIN_DEPTH = 0.5;

    private const MASK_LINE = 1;

    private const MASK_LAKE = 2;

    /**
     * @param  list<array{outer: list<array{0: float, 1: float}>, inners?: list<list<array{0: float, 1: float}>>}>  $polygons
     * @param  list<array{points: list<array{0: float, 1: float}>, width: float}>  $lines
     */
    public function build(
        HeightGrid $terrain,
        float $size,
        array $polygons = [],
        array $lines = [],
        float $seaLevel = 0.0,
        bool $oceanFromEdges = false,
    ): WaterSurfaceResult {
        $n = $terrain->resolution;
        $cell = $size / ($n - 1);
        $count = $n * $n;
        $t = $terrain->data;

        $mask = array_fill(0, $count, 0);
        foreach ($polygons as $polygon) {
            $this->rasterizePolygon($mask, $n, [$polygon['outer'], ...($polygon['inners'] ?? [])]);
        }
        foreach ($lines as $line) {
            $this->rasterizeLine($mask, $n, $line['points'], max(0.55, $line['width'] / 2 / $cell));
        }

        $ocean = $oceanFromEdges ? $this->floodOcean($t, $n, $seaLevel) : [];
        $water = array_fill(0, $count, TerrainStorage::NO_WATER);

        foreach ($ocean as $i => $_) {
            $water[$i] = $seaLevel;
            $mask[$i] = 0;
            if ($t[$i] <= $seaLevel) {
                $t[$i] = min($t[$i], $seaLevel - self::OCEAN_MIN_DEPTH);
            }
        }

        $maskCells = 0;
        foreach ($mask as $m) {
            if ($m !== 0) {
                $maskCells++;
            }
        }

        if ($maskCells > 0) {
            $surface = $this->surfaceFromTerrain($t, $mask, $ocean, $n);
            $distance = $this->distanceToShore($mask, $ocean, $n, $cell);
            $halfCell = $cell * 0.5;

            foreach ($surface as $i => $s) {
                $d = max(0.0, $distance[$i] - $halfCell);
                $maxDepth = $mask[$i] === self::MASK_LAKE ? self::LAKE_MAX_DEPTH : self::RIVER_MAX_DEPTH;
                $depth = min($maxDepth, 0.6 + $d * 0.35);
                $t[$i] = min($t[$i], $s - $depth);
                $water[$i] = $s;
            }
        }

        return new WaterSurfaceResult(
            new HeightGrid($n, $t),
            new HeightGrid($n, $water),
            $maskCells + count($ocean),
            count($ocean),
        );
    }

    /**
     * Cells connected to the map edge that lie at or below sea level (4-connected flood fill).
     *
     * @param  array<int, float>  $t
     * @return array<int, true>
     */
    public function floodOcean(array $t, int $n, float $seaLevel): array
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
     * Water surface per masked cell: masked box blur of the terrain, then a 1-ring minimum,
     * clamped so it never floats above the adjacent bank.
     *
     * @param  array<int, float>  $t
     * @param  array<int, int>  $mask
     * @param  array<int, true>  $ocean
     * @return array<int, float> surface height keyed by cell index (masked cells only)
     */
    private function surfaceFromTerrain(array $t, array $mask, array $ocean, int $n): array
    {
        $r = self::BLUR_RADIUS;
        $count = $n * $n;

        // Separable box sums of terrain·mask and mask.
        $hSum = array_fill(0, $count, 0.0);
        $hCnt = array_fill(0, $count, 0);
        for ($row = 0; $row < $n; $row++) {
            $base = $row * $n;
            $sum = 0.0;
            $cnt = 0;
            for ($c = 0; $c <= min($r, $n - 1); $c++) {
                if ($mask[$base + $c] !== 0) {
                    $sum += $t[$base + $c];
                    $cnt++;
                }
            }
            for ($col = 0; $col < $n; $col++) {
                $hSum[$base + $col] = $sum;
                $hCnt[$base + $col] = $cnt;
                $add = $col + $r + 1;
                $remove = $col - $r;
                if ($add < $n && $mask[$base + $add] !== 0) {
                    $sum += $t[$base + $add];
                    $cnt++;
                }
                if ($remove >= 0 && $mask[$base + $remove] !== 0) {
                    $sum -= $t[$base + $remove];
                    $cnt--;
                }
            }
        }

        $blurred = [];
        for ($col = 0; $col < $n; $col++) {
            $sum = 0.0;
            $cnt = 0;
            for ($rr = 0; $rr <= min($r, $n - 1); $rr++) {
                $sum += $hSum[$rr * $n + $col];
                $cnt += $hCnt[$rr * $n + $col];
            }
            for ($row = 0; $row < $n; $row++) {
                $i = $row * $n + $col;
                if ($mask[$i] !== 0 && $cnt > 0) {
                    $blurred[$i] = $sum / $cnt;
                }
                $add = $row + $r + 1;
                $remove = $row - $r;
                if ($add < $n) {
                    $sum += $hSum[$add * $n + $col];
                    $cnt += $hCnt[$add * $n + $col];
                }
                if ($remove >= 0) {
                    $sum -= $hSum[$remove * $n + $col];
                    $cnt -= $hCnt[$remove * $n + $col];
                }
            }
        }
        unset($hSum, $hCnt);

        $last = $n - 1;
        $surface = [];
        foreach ($blurred as $i => $value) {
            $col = $i % $n;
            $row = intdiv($i, $n);
            $min = $value;
            $bank = INF;

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
                    if (isset($blurred[$j])) {
                        if ($blurred[$j] < $min) {
                            $min = $blurred[$j];
                        }
                    } elseif (! isset($ocean[$j]) && $t[$j] < $bank) {
                        $bank = $t[$j];
                    }
                }
            }

            if ($bank !== INF) {
                $min = min($min, min($t[$i], $bank) + self::EDGE_TOLERANCE);
            }

            $surface[$i] = $min;
        }

        return $surface;
    }

    /**
     * Chamfer distance (metres) from each water cell to the nearest dry cell.
     *
     * @param  array<int, int>  $mask
     * @param  array<int, true>  $ocean
     * @return array<int, float>
     */
    private function distanceToShore(array $mask, array $ocean, int $n, float $cell): array
    {
        $diag = $cell * M_SQRT2;
        $d = [];
        foreach ($mask as $i => $m) {
            $d[$i] = ($m !== 0 || isset($ocean[$i])) ? INF : 0.0;
        }

        $last = $n - 1;
        for ($row = 0; $row < $n; $row++) {
            for ($col = 0; $col < $n; $col++) {
                $i = $row * $n + $col;
                if ($d[$i] === 0.0) {
                    continue;
                }
                $v = $d[$i];
                if ($col > 0) {
                    $v = min($v, $d[$i - 1] + $cell);
                }
                if ($row > 0) {
                    $v = min($v, $d[$i - $n] + $cell);
                    if ($col > 0) {
                        $v = min($v, $d[$i - $n - 1] + $diag);
                    }
                    if ($col < $last) {
                        $v = min($v, $d[$i - $n + 1] + $diag);
                    }
                }
                $d[$i] = $v;
            }
        }

        for ($row = $last; $row >= 0; $row--) {
            for ($col = $last; $col >= 0; $col--) {
                $i = $row * $n + $col;
                if ($d[$i] === 0.0) {
                    continue;
                }
                $v = $d[$i];
                if ($col < $last) {
                    $v = min($v, $d[$i + 1] + $cell);
                }
                if ($row < $last) {
                    $v = min($v, $d[$i + $n] + $cell);
                    if ($col < $last) {
                        $v = min($v, $d[$i + $n + 1] + $diag);
                    }
                    if ($col > 0) {
                        $v = min($v, $d[$i + $n - 1] + $diag);
                    }
                }
                $d[$i] = $v;
            }
        }

        return $d;
    }

    /**
     * Even-odd scanline fill of all rings together (inner rings become holes).
     *
     * @param  array<int, int>  $mask
     * @param  list<list<array{0: float, 1: float}>>  $rings
     */
    private function rasterizePolygon(array &$mask, int $n, array $rings): void
    {
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
                $yMin = min($y1, $y2);
                $yMax = max($y1, $y2);
                $rowStart = max(0, (int) ceil($yMin));
                $rowEnd = min($last, (int) ceil($yMax) - 1);
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
                    $mask[$base + $col] = self::MASK_LAKE;
                }
            }
        }
    }

    /**
     * Stamp a thick polyline: every cell centre within $radius cells of a segment.
     *
     * @param  array<int, int>  $mask
     * @param  list<array{0: float, 1: float}>  $points
     */
    private function rasterizeLine(array &$mask, int $n, array $points, float $radius): void
    {
        $last = $n - 1;
        $r2 = $radius * $radius;
        $count = count($points);

        if ($count === 1) {
            $points[] = $points[0];
            $count = 2;
        }

        for ($k = 0; $k < $count - 1; $k++) {
            [$ax, $ay] = $points[$k];
            [$bx, $by] = $points[$k + 1];
            $minCol = max(0, (int) ceil(min($ax, $bx) - $radius));
            $maxCol = min($last, (int) floor(max($ax, $bx) + $radius));
            $minRow = max(0, (int) ceil(min($ay, $by) - $radius));
            $maxRow = min($last, (int) floor(max($ay, $by) + $radius));
            if ($minCol > $maxCol || $minRow > $maxRow) {
                continue;
            }
            $dx = $bx - $ax;
            $dy = $by - $ay;
            $len2 = $dx * $dx + $dy * $dy;

            for ($row = $minRow; $row <= $maxRow; $row++) {
                $base = $row * $n;
                for ($col = $minCol; $col <= $maxCol; $col++) {
                    if ($mask[$base + $col] !== 0) {
                        continue;
                    }
                    $u = $len2 > 0 ? (($col - $ax) * $dx + ($row - $ay) * $dy) / $len2 : 0.0;
                    $u = $u < 0 ? 0.0 : ($u > 1 ? 1.0 : $u);
                    $ex = $ax + $u * $dx - $col;
                    $ey = $ay + $u * $dy - $row;
                    if ($ex * $ex + $ey * $ey <= $r2) {
                        $mask[$base + $col] = self::MASK_LINE;
                    }
                }
            }
        }
    }
}
