<?php

namespace Tests\Unit\Terrain;

use App\Services\Terrain\HeightGrid;
use App\Services\Terrain\TerrainShaping;
use App\Services\Terrain\TerrainStorage;
use App\Services\Terrain\WaterSurfaceBuilder;
use PHPUnit\Framework\TestCase;

class WaterSurfaceBuilderTest extends TestCase
{
    private function wet(HeightGrid $water, int $col, int $row): bool
    {
        return $water->get($col, $row) !== TerrainStorage::NO_WATER;
    }

    public function test_ocean_floods_from_the_edge_but_not_into_inland_depressions(): void
    {
        $n = 65;
        $terrain = new HeightGrid($n);
        for ($row = 0; $row < $n; $row++) {
            for ($col = 0; $col < $n; $col++) {
                // Sloping coast: below sea level on the west edge, land to the east.
                $h = -20 + $col * 1.0;
                // Inland depression below sea level, surrounded by land.
                if (hypot($col - 48, $row - 32) < 5) {
                    $h = -8.0;
                }
                $terrain->set($col, $row, $h);
            }
        }

        $result = (new WaterSurfaceBuilder)->build($terrain, 1024, [], [], 0.0, true);

        $this->assertTrue($result->oceanDetected());
        $this->assertSame(0.0, $result->water->get(0, 32));
        $this->assertSame(0.0, $result->water->get(19, 10));
        $this->assertSame(TerrainStorage::NO_WATER, $result->water->get(48, 32), 'Inland depression is not ocean.');
        $this->assertSame(TerrainStorage::NO_WATER, $result->water->get(40, 10));
        $this->assertLessThanOrEqual(-TerrainShaping::MIN_DEPTH, $result->terrain->get(20, 10), 'Ocean cells keep a minimum depth.');
        $this->assertSame(-20.0, $result->terrain->get(0, 0), 'Bathymetry is preserved.');

        // Depth grows smoothly away from the coast.
        $this->assertLessThan($result->terrain->get(19, 10), $result->terrain->get(15, 10));
    }

    public function test_ocean_is_skipped_when_disabled_or_absent(): void
    {
        $terrain = HeightGrid::filled(33, 5.0);
        $terrain->set(0, 0, -3.0);

        $builder = new WaterSurfaceBuilder;

        $this->assertFalse($builder->build($terrain, 512, [], [], 0.0, true)->hasWater(), 'A single low edge cell is noise.');
        $this->assertFalse($builder->build(HeightGrid::filled(33, -5.0), 512)->hasWater());
    }

    public function test_polygons_with_holes_and_lines_become_water_with_carved_beds(): void
    {
        $n = 65;
        $terrain = new HeightGrid($n);
        foreach ($terrain->data as $i => $_) {
            $terrain->data[$i] = 40 + 0.15 * sin($i * 0.7);
        }

        $lake = [
            'outer' => [[10, 10], [40, 10], [40, 40], [10, 40]],
            'inners' => [[[20, 20], [30, 20], [30, 30], [20, 30]]],
        ];
        $river = ['points' => [[0.0, 55.0], [64.0, 55.0]], 'width' => 40.0];

        $result = (new WaterSurfaceBuilder)->build($terrain, 640, [$lake], [$river]);
        $water = $result->water;

        $this->assertTrue($this->wet($water, 15, 15));
        $this->assertFalse($this->wet($water, 25, 25), 'Inner ring is a hole.');
        $this->assertFalse($this->wet($water, 5, 5));
        $this->assertTrue($this->wet($water, 32, 55));
        $this->assertFalse($this->wet($water, 32, 50), 'River is ~4 cells wide.');

        foreach ($water->data as $i => $surface) {
            if ($surface === TerrainStorage::NO_WATER) {
                continue;
            }
            $this->assertEqualsWithDelta(40, $surface, 0.35);
            $this->assertLessThanOrEqual($surface - TerrainShaping::MIN_DEPTH + 1e-9, $result->terrain->data[$i]);
        }

        // Deepest in the middle of the lake band, capped at the default 6 m; river capped at 2 m.
        $this->assertLessThan($water->get(11, 15) - 3, $result->terrain->get(15, 15));
        $this->assertGreaterThanOrEqual($water->get(15, 15) - 6.0001, $result->terrain->get(15, 15));
        $this->assertGreaterThanOrEqual($water->get(32, 55) - 2.0001, $result->terrain->get(32, 55));
    }

    public function test_depth_settings_control_the_carve(): void
    {
        $terrain = HeightGrid::filled(65, 40.0);
        $lake = ['outer' => [[5, 5], [45, 5], [45, 45], [5, 45]], 'inners' => []];
        $river = ['points' => [[0.0, 55.0], [64.0, 55.0]], 'width' => 40.0];
        $shaping = new TerrainShaping(lakeDepth: 15, riverDepth: 0.8, shoreAngle: 45);

        $result = (new WaterSurfaceBuilder)->build($terrain, 640, [$lake], [$river], 0.0, false, $shaping);

        $this->assertEqualsWithDelta(40.0 - 15.0, $result->terrain->get(25, 25), 0.01);
        $this->assertEqualsWithDelta(40.0 - 0.8, $result->terrain->get(32, 55), 0.01);
    }

    public function test_tiny_lake_smaller_than_a_cell_still_becomes_water(): void
    {
        $terrain = HeightGrid::filled(33, 20.0);
        // A ~6 m pond between cell centres on a 32 m grid.
        $pond = ['outer' => [[10.3, 10.3], [10.45, 10.3], [10.45, 10.45], [10.3, 10.45]], 'inners' => []];
        // A narrow sliver of water (a quarter cell wide) running diagonally.
        $sliver = ['outer' => [[2.1, 20.0], [12.1, 30.0], [12.35, 30.0], [2.35, 20.0]], 'inners' => []];

        $result = (new WaterSurfaceBuilder)->build($terrain, 1024, [$pond, $sliver]);

        $this->assertTrue($this->wet($result->water, 10, 10));
        $this->assertLessThan(20.0 - TerrainShaping::MIN_DEPTH + 1e-9, $result->terrain->get(10, 10));

        for ($k = 0; $k <= 10; $k++) {
            $this->assertTrue($this->wet($result->water, 2 + $k, 20 + $k), "Sliver cell {$k} is water.");
        }
    }

    public function test_stream_narrower_than_a_cell_is_continuous(): void
    {
        $n = 65;
        $terrain = new HeightGrid($n);
        for ($row = 0; $row < $n; $row++) {
            for ($col = 0; $col < $n; $col++) {
                $terrain->set($col, $row, 100 - 0.3 * ($col + $row));
            }
        }
        // 1.5 m wide stream on a 16 m grid, at an awkward angle.
        $stream = ['points' => [[3.2, 5.7], [30.6, 21.1], [58.9, 60.4]], 'width' => 1.5];

        $result = (new WaterSurfaceBuilder)->build($terrain, 1024, [], [$stream]);
        $water = $result->water;

        $start = 6 * 65 + 3;
        $end = 60 * 65 + 59;
        $this->assertTrue($this->wet($water, 3, 6));
        $this->assertTrue($this->wet($water, 59, 60));

        // 4-connected flood fill over wet cells reaches the end of the stream.
        $seen = [$start => true];
        $stack = [$start];
        while ($stack) {
            $i = array_pop($stack);
            foreach ([$i - 1, $i + 1, $i - $n, $i + $n] as $j) {
                if ($j >= 0 && $j < $n * $n && abs(($j % $n) - ($i % $n)) <= 1
                    && ! isset($seen[$j]) && $water->data[$j] !== TerrainStorage::NO_WATER) {
                    $seen[$j] = true;
                    $stack[] = $j;
                }
            }
        }
        $this->assertArrayHasKey($end, $seen, 'Stream channel is 4-connected from source to mouth.');
        $this->assertLessThan(3 * 70, count($seen), 'Stream stays narrow.');
    }

    public function test_river_level_never_rises_downstream(): void
    {
        $n = 129;
        $terrain = new HeightGrid($n);
        for ($row = 0; $row < $n; $row++) {
            for ($col = 0; $col < $n; $col++) {
                // Valley falling west → east with noise, bumps and a spurious dip.
                $h = 120 - 0.4 * $col + 0.02 * ($row - 64) ** 2 + 1.5 * sin($col * 0.9) * cos($row * 0.7);
                if ($col === 40) {
                    $h -= 6.0;
                }
                $terrain->set($col, $row, $h);
            }
        }
        $points = [];
        for ($col = 2; $col <= 126; $col += 6) {
            $points[] = [(float) $col, 64.0 + 6 * sin($col * 0.05)];
        }

        $result = (new WaterSurfaceBuilder)->build($terrain, 1024, [], [['points' => $points, 'width' => 12.0]]);

        $previous = INF;
        foreach ($points as [$x, $y]) {
            $level = $result->water->get((int) round($x), (int) round($y));
            $this->assertNotSame(TerrainStorage::NO_WATER, $level);
            $this->assertLessThanOrEqual($previous + 1e-6, $level, "Level rises at column {$x}.");
            $previous = $level;
        }

        $this->assertGreaterThan(
            $result->water->get(20, (int) round(64 + 6 * sin(1.0))) - 20,
            $result->water->get(60, (int) round(64 + 6 * sin(3.0))),
            'A single dip does not drag the whole river down.',
        );
    }

    public function test_river_drawn_uphill_is_fitted_in_the_other_direction(): void
    {
        $values = [10.0, 10.5, 11.0, 12.0, 12.5, 13.0, 14.0, 15.0, 16.0];
        $fit = (new WaterSurfaceBuilder)->fitProfile($values, array_fill(0, count($values), false));

        for ($k = 1; $k < count($fit); $k++) {
            $this->assertGreaterThanOrEqual($fit[$k - 1] - 1e-9, $fit[$k]);
        }
        $this->assertGreaterThan(13.0, end($fit));
    }

    public function test_lake_level_is_a_low_percentile_and_banks_are_limited(): void
    {
        $n = 97;
        $cell = 8.0;
        $terrain = new HeightGrid($n);
        for ($row = 0; $row < $n; $row++) {
            for ($col = 0; $col < $n; $col++) {
                // DEM lake (flat, 50 m) is 3 cells east of the OSM outline; land around is a 30 m plateau.
                $inDemLake = $col >= 33 && $col <= 73 && $row >= 30 && $row <= 70;
                $terrain->set($col, $row, $inDemLake ? 50.0 : 80.0 + 0.01 * $col);
            }
        }
        $lake = ['outer' => [[30, 30], [70, 30], [70, 70], [30, 70]], 'inners' => []];
        $shaping = new TerrainShaping(bankAngle: 35);

        $result = (new WaterSurfaceBuilder)->build($terrain, $cell * ($n - 1), [$lake], [], 0.0, false, $shaping);
        $t = $result->terrain;
        $water = $result->water;

        $this->assertEqualsWithDelta(50.0, $water->get(50, 50), 1e-9, 'Level follows the DEM lake, not the misregistered shore.');

        $maxSlope = tan(deg2rad(35)) + 0.05;
        for ($row = 0; $row < $n; $row++) {
            for ($col = 0; $col < $n - 1; $col++) {
                foreach ([[$col + 1, $row], [$col, min($n - 1, $row + 1)]] as [$c2, $r2]) {
                    if ($this->wet($water, $col, $row) !== $this->wet($water, $c2, $r2)) {
                        $slope = abs($t->get($col, $row) - $t->get($c2, $r2)) / $cell;
                        $this->assertLessThanOrEqual($maxSlope, $slope, "Bank too steep at {$col},{$row}.");
                    }
                }
            }
        }

        // Shore cells sit just above the water, terrain beyond the bank band is untouched.
        $this->assertGreaterThan(50.0, $t->get(29, 50));
        $this->assertLessThan(50.0 + 0.7 * 12 + 1, $t->get(28, 50));
        $this->assertSame(80.0 + 0.01 * 5, $t->get(5, 50));
    }
}
