<?php

namespace Tests\Unit\LandCover;

use App\Services\LandCover\LandCoverGrid;
use App\Services\LandCover\LandCoverMapping;
use App\Services\LandCover\LandCoverPainter;
use App\Services\Terrain\HeightGrid;
use App\Services\Terrain\TerrainStorage;
use PHPUnit\Framework\TestCase;

class LandCoverPainterTest extends TestCase
{
    private const SLOTS = [0 => 'Grass', 1 => 'Meadow', 2 => 'Forest floor', 3 => 'Rock', 4 => 'Sand', 5 => 'Mud', 6 => 'Gravel', 7 => 'Snow'];

    private const N = 33;

    /**
     * @param  callable(int, int): int  $classAt
     */
    private static function classes(callable $classAt): LandCoverGrid
    {
        $data = '';
        for ($row = 0; $row < self::N; $row++) {
            for ($col = 0; $col < self::N; $col++) {
                $data .= chr($classAt($col, $row));
            }
        }

        return new LandCoverGrid(self::N, $data);
    }

    /**
     * @param  callable(int, int): float  $heightAt
     */
    private static function heights(callable $heightAt): HeightGrid
    {
        $grid = HeightGrid::filled(self::N, 0.0);
        for ($row = 0; $row < self::N; $row++) {
            for ($col = 0; $col < self::N; $col++) {
                $grid->set($col, $row, $heightAt($col, $row));
            }
        }

        return $grid;
    }

    /**
     * @return list<int> 8 channel weights of a sample
     */
    private static function weights(string $splat, int $col, int $row): array
    {
        return array_values(unpack('C8', substr($splat, ($row * self::N + $col) * 8, 8)));
    }

    /**
     * @param  array<int, int>  $mapping
     */
    private function paint(LandCoverGrid $classes, HeightGrid $terrain, ?HeightGrid $water = null, array $mapping = []): string
    {
        return (new LandCoverPainter)->paint(
            $classes, $terrain, $water, 32 * 16.0,
            LandCoverMapping::resolve(self::SLOTS, $mapping), LandCoverMapping::roles(self::SLOTS), 7,
        );
    }

    public function test_classes_map_to_layers_with_soft_borders_and_weights_sum_to_255(): void
    {
        // West half forest, east half grassland, a built-up block in the south-east.
        $classes = self::classes(fn (int $c, int $r) => $c < 16 ? 10 : ($r > 24 && $c > 24 ? 50 : 30));
        $splat = $this->paint($classes, self::heights(fn () => 100.0));

        $this->assertSame(self::N * self::N * TerrainStorage::SPLAT_CHANNELS, strlen($splat));
        foreach (array_chunk(array_values(unpack('C*', $splat)), 8) as $i => $sample) {
            $this->assertSame(255, array_sum($sample), "sample {$i}");
        }

        $this->assertSame(255, self::weights($splat, 3, 16)[2], 'Forest floor deep in the forest');
        $this->assertSame(255, self::weights($splat, 22, 8)[0], 'Grass in the grassland');
        $this->assertGreaterThan(200, self::weights($splat, 30, 30)[6], 'Built-up → gravel');

        // Borders blend: some sample near the forest edge carries both layers.
        $mixed = false;
        for ($c = 13; $c <= 18; $c++) {
            $w = self::weights($splat, $c, 16);
            $mixed = $mixed || ($w[0] > 10 && $w[2] > 10);
        }
        $this->assertTrue($mixed, 'Forest / grass border is blended.');

        $this->assertSame($splat, $this->paint($classes, self::heights(fn () => 100.0)), 'Deterministic for a seed.');
    }

    public function test_user_mapping_is_respected(): void
    {
        $classes = self::classes(fn () => 10);
        $splat = $this->paint($classes, self::heights(fn () => 100.0), null, [10 => 7]);

        $this->assertSame(255, self::weights($splat, 16, 16)[7]);
    }

    public function test_steep_slopes_become_rock(): void
    {
        // Grassland everywhere; east of column 20 a 60° slope.
        $cell = 16.0;
        $classes = self::classes(fn () => 30);
        $terrain = self::heights(fn (int $c) => $c <= 20 ? 100.0 : 100.0 + ($c - 20) * $cell * tan(deg2rad(60)));

        $splat = $this->paint($classes, $terrain);

        $this->assertSame(255, self::weights($splat, 26, 16)[3], 'Steep → rock');
        $this->assertSame(255, self::weights($splat, 8, 16)[0], 'Flat → grass');
    }

    public function test_beaches_and_lake_beds(): void
    {
        // A lake (surface 100 m) in the west; land rises gently from 100.5 m at the shore.
        $classes = self::classes(fn () => 10);
        $terrain = self::heights(fn (int $c) => $c < 10 ? 95.0 : 100.5 + ($c - 10) * 1.5);
        $water = self::heights(fn (int $c) => $c < 10 ? 100.0 : TerrainStorage::NO_WATER);

        $splat = $this->paint($classes, $terrain, $water);

        $this->assertSame(255, self::weights($splat, 3, 16)[5], 'Lake bed → mud (water class)');
        $this->assertGreaterThan(200, self::weights($splat, 10, 16)[4], 'Shore just above the water → sand');
        $this->assertSame(0, self::weights($splat, 20, 16)[4], 'No sand far from the water');
    }

    public function test_default_mapping_follows_layer_names_and_categories(): void
    {
        $defaults = LandCoverMapping::defaults(self::SLOTS);
        $this->assertSame([0 => 0, 10 => 2, 20 => 1, 30 => 0, 40 => 1, 50 => 6, 60 => 3, 70 => 7, 80 => 5, 90 => 5, 95 => 5, 100 => 1], $defaults);

        $custom = LandCoverMapping::defaults([
            0 => 'Lawn grass', 1 => 'Wheat field field', 2 => 'Pine needles forest', 3 => 'Granite cliff rock', 5 => 'Asphalt urban',
        ]);
        $this->assertSame(1, $custom[40], 'Cropland → field layer');
        $this->assertSame(5, $custom[50], 'Built-up → urban layer');
        $this->assertSame(2, $custom[10]);
        $this->assertSame(3, $custom[60]);
        $this->assertSame(0, $custom[70], 'No snow layer → grass fallback');
        $this->assertSame(0, $custom[80], 'No mud / sand → grass fallback');

        $resolved = LandCoverMapping::resolve(self::SLOTS, ['10' => 7, '30' => null, '40' => 12]);
        $this->assertSame(7, $resolved[10]);
        $this->assertSame(0, $resolved[30], 'null keeps the default');
        $this->assertSame(1, $resolved[40], 'Unknown slots are ignored');
    }
}
