<?php

namespace Tests\Feature\Terrain;

use App\Services\Terrain\MapProjection;
use App\Services\Terrain\TerrariumElevationSource;
use Closure;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Storage;
use RuntimeException;
use Tests\TestCase;

class TerrariumElevationSourceTest extends TestCase
{
    protected function setUp(): void
    {
        parent::setUp();

        Storage::fake('local');
    }

    /**
     * Encode a Terrarium PNG tile whose pixel heights come from $height(globalPx, globalPy).
     *
     * @param  Closure(int, int): float  $height
     */
    public static function tilePng(int $x, int $y, Closure $height): string
    {
        $image = imagecreatetruecolor(256, 256);

        for ($py = 0; $py < 256; $py++) {
            for ($px = 0; $px < 256; $px++) {
                $v = $height($x * 256 + $px, $y * 256 + $py) + 32768;
                $r = (int) floor($v / 256);
                $g = (int) floor($v) % 256;
                $b = (int) round(($v - floor($v)) * 256);
                imagesetpixel($image, $px, $py, ($r << 16) | ($g << 8) | min(255, $b));
            }
        }

        ob_start();
        imagepng($image);

        return (string) ob_get_clean();
    }

    /**
     * @param  Closure(int, int): float  $height
     */
    public static function fakeTiles(Closure $height): void
    {
        Http::fake([
            's3.amazonaws.com/*' => function (Request $request) use ($height) {
                preg_match('#/(\d+)/(\d+)/(\d+)\.png$#', $request->url(), $m);

                return Http::response(self::tilePng((int) $m[2], (int) $m[3], $height), 200, ['Content-Type' => 'image/png']);
            },
        ]);
    }

    public function test_zoom_is_the_highest_level_not_coarser_than_the_cell_size(): void
    {
        $bounds = (new MapProjection(47.0, 8.0, 2048, 257))->bounds();

        $zoom = TerrariumElevationSource::chooseZoom($bounds, 8.0);

        $this->assertSame(14, $zoom);
        $this->assertLessThanOrEqual(8.0, TerrariumElevationSource::groundResolution(47.0, $zoom));
        $this->assertGreaterThan(8.0, TerrariumElevationSource::groundResolution(47.0, $zoom - 1));

        $this->assertSame(15, TerrariumElevationSource::chooseZoom($bounds, 0.5), 'Clamped to zoom 15.');
        $this->assertSame(0, TerrariumElevationSource::chooseZoom($bounds, 1e9));
    }

    public function test_zoom_is_lowered_to_cap_the_tile_count(): void
    {
        $bounds = (new MapProjection(47.0, 8.0, 16384, 1025))->bounds();

        $uncapped = TerrariumElevationSource::chooseZoom($bounds, 16.0, 10_000);
        $capped = TerrariumElevationSource::chooseZoom($bounds, 16.0, 4);

        $this->assertLessThan($uncapped, $capped);
        $this->assertLessThanOrEqual(4, TerrariumElevationSource::tileCount(TerrariumElevationSource::tileRange($bounds, $capped)));
        $this->assertGreaterThan(4, TerrariumElevationSource::tileCount(TerrariumElevationSource::tileRange($bounds, $capped + 1)));
    }

    public function test_decodes_a_constant_plane(): void
    {
        self::fakeTiles(fn () => 123.0);

        $grid = app(TerrariumElevationSource::class)->build(new MapProjection(46.5, 7.5, 2048, 33));

        [$min, $max] = $grid->range();
        $this->assertEqualsWithDelta(123.0, $min, 0.01);
        $this->assertEqualsWithDelta(123.0, $max, 0.01);
    }

    public function test_bilinearly_samples_a_gradient_across_tiles_and_caches_downloads(): void
    {
        $projection = new MapProjection(46.5, 7.5, 3000, 65);
        $zoom = TerrariumElevationSource::chooseZoom($projection->bounds(), $projection->cell);
        $range = TerrariumElevationSource::tileRange($projection->bounds(), $zoom);
        $gx0 = $range['minX'] * 256;
        $gy0 = $range['minY'] * 256;
        $height = fn (float $gx, float $gy): float => 200 + 0.05 * ($gx - $gx0) - 0.03 * ($gy - $gy0);

        self::fakeTiles($height);

        $grid = app(TerrariumElevationSource::class)->build($projection);

        $this->assertGreaterThan(1, TerrariumElevationSource::tileCount($range), 'Fixture should span several tiles.');
        Http::assertSentCount(TerrariumElevationSource::tileCount($range));
        Storage::disk('local')->assertExists(TerrariumElevationSource::cachePath($zoom, $range['minX'], $range['minY']));

        foreach ([[0, 0], [64, 0], [0, 64], [64, 64], [32, 32], [17, 45]] as [$col, $row]) {
            [$lat, $lng] = $projection->toLatLng($col, $row);
            $expected = $height(
                TerrariumElevationSource::lngToPixelX($lng, $zoom) - 0.5,
                TerrariumElevationSource::latToPixelY($lat, $zoom) - 0.5,
            );
            $this->assertEqualsWithDelta($expected, $grid->get($col, $row), 0.01, "Sample {$col},{$row}");
        }

        // North (row 0) is higher than south because height falls with pixel y.
        $this->assertGreaterThan($grid->get(32, 64), $grid->get(32, 0));

        // A second build is served entirely from the cache.
        app(TerrariumElevationSource::class)->build($projection);
        Http::assertSentCount(TerrariumElevationSource::tileCount($range));
    }

    public function test_throws_when_tiles_cannot_be_downloaded(): void
    {
        Http::fake(['*' => Http::response('nope', 503)]);

        $this->expectException(RuntimeException::class);

        try {
            app(TerrariumElevationSource::class)->build(new MapProjection(46.5, 7.5, 2048, 33));
        } finally {
            // One attempt plus one retry per tile.
            $this->assertSame(0, Http::recorded()->count() % 2);
        }
    }

    public function test_tile_url_is_configurable(): void
    {
        config(['services.terrarium.url' => 'https://tiles.example.test/terrarium/']);

        $this->assertSame('https://tiles.example.test/terrarium/12/1/2.png', TerrariumElevationSource::tileUrl(12, 1, 2));
    }
}
