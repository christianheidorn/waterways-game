<?php

namespace Tests\Unit\Terrain;

use App\Services\Terrain\HeightGrid;
use App\Services\Terrain\TerrainStorage;
use App\Services\Terrain\WaterSurfaceBuilder;
use PHPUnit\Framework\TestCase;

class WaterSurfaceBuilderTest extends TestCase
{
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
        $this->assertLessThanOrEqual(-0.5, $result->terrain->get(20, 10), 'Ocean cells keep at least 0.5 m depth.');
        $this->assertSame(-20.0, $result->terrain->get(0, 0), 'Bathymetry is preserved.');
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

        $this->assertNotSame(TerrainStorage::NO_WATER, $water->get(15, 15));
        $this->assertSame(TerrainStorage::NO_WATER, $water->get(25, 25), 'Inner ring is a hole.');
        $this->assertSame(TerrainStorage::NO_WATER, $water->get(5, 5));
        $this->assertNotSame(TerrainStorage::NO_WATER, $water->get(32, 55));
        $this->assertSame(TerrainStorage::NO_WATER, $water->get(32, 50), 'River is ~4 cells wide.');

        foreach ($water->data as $i => $surface) {
            if ($surface === TerrainStorage::NO_WATER) {
                continue;
            }
            $this->assertEqualsWithDelta(40, $surface, 0.35);
            $this->assertLessThanOrEqual($surface - 0.6, $result->terrain->data[$i]);
        }

        // Deepest in the middle of the lake band, capped at 8 m; river capped at 2.5 m.
        $this->assertLessThan($water->get(11, 15) - 3, $result->terrain->get(15, 15));
        $this->assertGreaterThanOrEqual($water->get(15, 15) - 8.0001, $result->terrain->get(15, 15));
        $this->assertGreaterThanOrEqual($water->get(32, 55) - 2.5001, $result->terrain->get(32, 55));
    }
}
