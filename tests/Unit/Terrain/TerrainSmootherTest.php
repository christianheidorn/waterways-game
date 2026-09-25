<?php

namespace Tests\Unit\Terrain;

use App\Services\Terrain\HeightGrid;
use App\Services\Terrain\TerrainSmoother;
use App\Services\Terrain\TerrariumElevationSource;
use PHPUnit\Framework\TestCase;

class TerrainSmootherTest extends TestCase
{
    public function test_deterracing_removes_one_metre_steps_but_keeps_the_shape(): void
    {
        $n = 129;
        $cell = 8.0;
        $grid = new HeightGrid($n);
        for ($row = 0; $row < $n; $row++) {
            for ($col = 0; $col < $n; $col++) {
                // Gentle 1 % slope quantized to whole metres (SRTM-style terraces every 12.5 cells).
                $grid->set($col, $row, floor(0.01 * $cell * $col + 0.004 * $cell * $row));
            }
        }
        $original = $grid->copy();

        TerrainSmoother::deterrace($grid, $cell, 0.5);

        $maxStep = 0.0;
        $maxError = 0.0;
        for ($row = 10; $row < $n - 10; $row++) {
            for ($col = 10; $col < $n - 10; $col++) {
                $maxStep = max($maxStep, abs($grid->get($col + 1, $row) - $grid->get($col, $row)));
                $ideal = 0.01 * $cell * $col + 0.004 * $cell * $row - 0.5;
                $maxError = max($maxError, abs($grid->get($col, $row) - $ideal));
            }
        }

        $this->assertLessThan(0.2, $maxStep, 'Terrace steps are gone (true slope is 0.08 m per cell).');
        $this->assertLessThan(0.6, $maxError, 'The surface follows the underlying ramp.');
        $this->assertEqualsWithDelta(array_sum($original->data) / ($n * $n), array_sum($grid->data) / ($n * $n), 0.1);
    }

    public function test_steep_features_are_kept(): void
    {
        $n = 65;
        $grid = new HeightGrid($n);
        for ($row = 0; $row < $n; $row++) {
            for ($col = 0; $col < $n; $col++) {
                // 120 m cone with 60 % flanks.
                $grid->set($col, $row, max(0.0, 120 - 0.6 * 8 * hypot($col - 32, $row - 32)));
            }
        }
        $peak = $grid->get(32, 32);

        TerrainSmoother::deterrace($grid, 8.0, 1.0);

        $this->assertEqualsWithDelta($peak, $grid->get(32, 32), 1.5, 'Change is limited to about one quantization step.');
        $this->assertEqualsWithDelta(120 - 0.6 * 8 * 10, $grid->get(42, 32), 1.0);
    }

    public function test_zero_smoothing_is_a_no_op(): void
    {
        $grid = new HeightGrid(9, array_map(fn ($i) => (float) ($i % 3), range(0, 80)));
        $before = $grid->data;

        TerrainSmoother::deterrace($grid, 8.0, 0.0);

        $this->assertSame($before, $grid->data);
    }

    public function test_catmull_rom_weights_are_interpolating(): void
    {
        $this->assertSame([0.0, 1.0, 0.0, 0.0], TerrariumElevationSource::catmullRom(0.0));
        foreach ([0.1, 0.5, 0.9] as $t) {
            $w = TerrariumElevationSource::catmullRom($t);
            $this->assertEqualsWithDelta(1.0, array_sum($w), 1e-12);
            // Reproduces a linear ramp exactly.
            $this->assertEqualsWithDelta($t, -1 * $w[0] + 0 * $w[1] + 1 * $w[2] + 2 * $w[3], 1e-12);
        }
    }
}
