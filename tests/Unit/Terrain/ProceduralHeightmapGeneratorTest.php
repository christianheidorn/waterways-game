<?php

namespace Tests\Unit\Terrain;

use App\Services\Terrain\HeightGrid;
use App\Services\Terrain\ProceduralHeightmapGenerator;
use App\Services\Terrain\SimplexNoise;
use App\Services\Terrain\TerrainStorage;
use PHPUnit\Framework\TestCase;

class ProceduralHeightmapGeneratorTest extends TestCase
{
    public function test_flat_grid_has_constant_height_and_correct_byte_size(): void
    {
        $grid = (new ProceduralHeightmapGenerator)->flat(33, 12.5);

        $this->assertSame([12.5, 12.5], $grid->range());
        $this->assertSame(33 * 33 * 4, strlen($grid->toBinary()));
    }

    public function test_procedural_terrain_has_sensible_range_and_water(): void
    {
        $result = (new ProceduralHeightmapGenerator)->proceduralWithWater(129, 2048, 1337);

        [$min, $max] = $result->terrain->range();
        $this->assertGreaterThanOrEqual(-10, $min);
        $this->assertLessThanOrEqual(240, $max);
        $this->assertGreaterThan(80, $max - $min);
        $this->assertSame(129 * 129 * 4, strlen($result->terrain->toBinary()));
        $this->assertSame(129 * 129 * 4, strlen($result->water->toBinary()));

        $this->assertTrue($result->hasWater());
        $this->assertFalse($result->oceanDetected());

        $wet = 0;
        foreach ($result->water->data as $i => $surface) {
            if ($surface !== TerrainStorage::NO_WATER) {
                $wet++;
                $this->assertLessThan($surface, $result->terrain->data[$i], 'Water must sit above its bed.');
            }
        }
        $this->assertSame($result->waterCells, $wet);
        $this->assertGreaterThan(50, $wet);
    }

    public function test_procedural_terrain_is_deterministic_per_seed(): void
    {
        $generator = new ProceduralHeightmapGenerator;

        $a = $generator->procedural(65, 2048, 42);
        $b = $generator->procedural(65, 2048, 42);
        $c = $generator->procedural(65, 2048, 43);

        $this->assertSame($a->data, $b->data);
        $this->assertNotSame($a->data, $c->data);
    }

    public function test_heights_scale_with_map_size(): void
    {
        $generator = new ProceduralHeightmapGenerator;

        $small = $generator->procedural(65, 512, 5)->max();
        $large = $generator->procedural(65, 8192, 5)->max();

        $this->assertGreaterThan($small * 2, $large);
    }

    public function test_simplex_noise_is_bounded_and_seeded(): void
    {
        $a = new SimplexNoise(1);
        $b = new SimplexNoise(2);
        $differs = false;

        for ($i = 0; $i < 2000; $i++) {
            $v = $a->noise($i * 0.173, $i * 0.071);
            $this->assertGreaterThanOrEqual(-1.0, $v);
            $this->assertLessThanOrEqual(1.0, $v);
            $differs = $differs || abs($v - $b->noise($i * 0.173, $i * 0.071)) > 1e-6;
        }

        $this->assertTrue($differs);
    }

    public function test_height_grid_bilinear_sampling(): void
    {
        $grid = new HeightGrid(3, [0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]);

        $this->assertSame(4.0, $grid->get(1, 1));
        $this->assertEqualsWithDelta(2.0, $grid->sample(0.5, 0.5), 1e-9);
        $this->assertEqualsWithDelta(8.0, $grid->sample(5, 5), 1e-9);
    }
}
