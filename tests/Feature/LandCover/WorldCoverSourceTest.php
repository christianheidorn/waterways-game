<?php

namespace Tests\Feature\LandCover;

use App\Models\Map;
use App\Services\LandCover\GeoTiffIndex;
use App\Services\LandCover\WorldCoverSource;
use App\Services\Terrain\MapProjection;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Sleep;
use Tests\TestCase;

class WorldCoverSourceTest extends TestCase
{
    protected function setUp(): void
    {
        parent::setUp();

        Storage::fake('local');
        Sleep::fake();
    }

    public function test_file_names_use_the_south_west_corner_of_the_3_degree_tile(): void
    {
        $this->assertSame('N45E009', WorldCoverSource::fileName(46.3, 11.9));
        $this->assertSame('N45E012', WorldCoverSource::fileName(46.3625, 14.0936));
        $this->assertSame('S03W003', WorldCoverSource::fileName(-0.5, -0.1));
        $this->assertSame('N00E000', WorldCoverSource::fileName(0.0, 0.0));
        $this->assertSame('S36W072', WorldCoverSource::fileName(-33.4, -70.6));
        $this->assertSame('N48E177', WorldCoverSource::fileName(48.5, 179.9));
        $this->assertStringEndsWith('/ESA_WorldCover_10m_2021_v200_N45E012_Map.tif', WorldCoverSource::url('N45E012'));
    }

    public function test_parses_classic_and_big_tiff_with_predictor_and_reads_values_past_the_head(): void
    {
        $classAt = fn (int $x, int $y) => [10, 30, 80, 50][($x + 2 * $y) % 4];

        foreach ([false, true] as $big) {
            $tiff = FakeWorldCover::tiff(100, 70, 32, 9.0, 48.0, 0.01, $classAt, predictor: true, bigTiff: $big);
            $fetched = 0;
            $index = GeoTiffIndex::parse(substr($tiff, 0, 64), function (int $offset, int $length) use ($tiff, &$fetched) {
                $fetched++;

                return substr($tiff, $offset, $length);
            });

            $this->assertGreaterThan(0, $fetched, 'Values beyond the head are fetched.');
            $this->assertSame([100, 70, 32, 32, 8, 2], [$index->width, $index->height, $index->tileWidth, $index->tileLength, $index->compression, $index->predictor]);
            $this->assertSame(4, $index->tilesAcross());
            $this->assertSame(12, count($index->offsets));
            $this->assertEqualsWithDelta(9.0, $index->originX, 1e-12);
            $this->assertEqualsWithDelta(48.0, $index->originY, 1e-12);
            $this->assertSame(5, $index->pixelX(9.055));
            $this->assertSame(3, $index->pixelY(47.965));

            // Tile (1, 1) holds pixels x 32..63, y 32..63.
            $t = 1 * 4 + 1;
            $tile = $index->decodeTile(substr($tiff, $index->offsets[$t], $index->counts[$t]));
            $this->assertSame(32 * 32, strlen($tile));
            foreach ([[0, 0], [5, 7], [31, 31]] as [$c, $r]) {
                $this->assertSame($classAt(32 + $c, 32 + $r), ord($tile[$r * 32 + $c]));
            }

            $this->assertEquals($index, GeoTiffIndex::fromArray(json_decode(json_encode($index->toArray()), true)));
        }
    }

    public function test_samples_classes_across_four_files_and_treats_missing_files_as_no_data(): void
    {
        // Quadrants around (48°N, 9°E): NW forest, NE grass, SW cropland; SE file missing (ocean).
        $quadrant = fn (float $lat, float $lng) => $lat >= 48 ? ($lng < 9 ? 10 : 30) : ($lng < 9 ? 40 : 80);
        FakeWorldCover::serve([
            'N48E006' => FakeWorldCover::file(48, 6, $quadrant),
            'N48E009' => FakeWorldCover::file(48, 9, $quadrant),
            'N45E006' => FakeWorldCover::file(45, 6, $quadrant),
        ]);

        $map = new Map(['center_lat' => 48.0, 'center_lng' => 9.0, 'size' => 32768, 'resolution' => 33]);
        $source = app(WorldCoverSource::class);
        $grid = $source->classGrid($map);

        $this->assertNotNull($grid, (string) $source->warning);
        $this->assertSame(33, $grid->resolution);
        $this->assertSame(10, $grid->get(4, 4), 'North-west');
        $this->assertSame(30, $grid->get(28, 4), 'North-east');
        $this->assertSame(40, $grid->get(4, 28), 'South-west');
        $this->assertSame(0, $grid->get(28, 28), 'South-east has no file → no data');
        $this->assertEqualsWithDelta(25.0, $grid->stats()[10], 6.0);
        $this->assertGreaterThan(0, $source->bytesDownloaded);

        // Only headers and the few internal tiles under the map were requested.
        $tileRequests = array_filter(FakeWorldCover::$ranges, fn (string $r) => ! str_contains($r, 'bytes=0-'));
        $this->assertLessThanOrEqual(12, count($tileRequests));
        $this->assertNotEmpty($tileRequests);

        // Everything is cached: a second run makes no requests.
        Http::fake(fn () => Http::response('offline', 500));
        $again = app(WorldCoverSource::class)->classGrid($map);
        $this->assertSame($grid->data, $again?->data);
        Http::assertNothingSent();
    }

    public function test_nearest_sampling_matches_the_pixel_under_each_sample(): void
    {
        // Cells under 15 m take the nearest pixel. 3000 px over 3° = 0.001° per pixel; classes
        // alternate every two pixel columns.
        $stripe = fn (float $lat, float $lng) => ((int) floor(($lng - 9) / 0.002)) % 2 === 0 ? 10 : 30;
        FakeWorldCover::serve(['N48E009' => FakeWorldCover::file(48, 9, $stripe, pixels: 3000, tileSize: 256)]);

        $projection = new MapProjection(49.5, 10.5, 256, 33);
        $grid = app(WorldCoverSource::class)->build($projection);

        for ($col = 0; $col < 33; $col++) {
            [$lat, $lng] = $projection->toLatLng($col, 16);
            $px = (int) floor(($lng - 9) / 0.001);
            $this->assertSame($px % 4 < 2 ? 10 : 30, $grid->get($col, 16), "col {$col}");
        }
    }

    public function test_failures_return_null_with_a_warning(): void
    {
        FakeWorldCover::serve([], failWith: 503);

        $source = app(WorldCoverSource::class);
        $grid = $source->classGrid(new Map(['center_lat' => 46.36, 'center_lng' => 14.09, 'size' => 4096, 'resolution' => 33]));

        $this->assertNull($grid);
        $this->assertStringContainsString('HTTP 503', (string) $source->warning);
    }
}
