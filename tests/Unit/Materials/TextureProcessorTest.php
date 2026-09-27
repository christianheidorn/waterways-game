<?php

namespace Tests\Unit\Materials;

use App\Services\Materials\TextureProcessor;
use GdImage;
use PHPUnit\Framework\TestCase;
use Tests\Concerns\CreatesTestImages;

class TextureProcessorTest extends TestCase
{
    use CreatesTestImages;

    private TextureProcessor $p;

    protected function setUp(): void
    {
        parent::setUp();
        $this->p = new TextureProcessor;
    }

    public function test_normalize_square_centre_crops_and_resizes(): void
    {
        $img = imagecreatetruecolor(300, 200);
        imagefilledrectangle($img, 0, 0, 49, 199, 0xFF0000);   // left strip is cropped away
        imagefilledrectangle($img, 50, 0, 249, 199, 0x00FF00);
        imagefilledrectangle($img, 250, 0, 299, 199, 0x0000FF); // right strip is cropped away

        $out = $this->p->normalizeSquare($img, 128);

        $this->assertSame([128, 128], [imagesx($out), imagesy($out)]);
        $this->assertSame([0, 255, 0], $this->rgbAt($out, 1, 64));
        $this->assertSame([0, 255, 0], $this->rgbAt($out, 126, 64));
    }

    public function test_make_seamless_makes_opposite_edges_match(): void
    {
        // Diagonal gradient + detail: the raw image tiles terribly (0 ↔ 255 at the edges).
        $n = 128;
        $img = imagecreatetruecolor($n, $n);
        for ($y = 0; $y < $n; $y++) {
            for ($x = 0; $x < $n; $x++) {
                $v = (int) (($x + $y) / (2 * $n - 2) * 200) + (int) (20 * sin($x * 0.7) * cos($y * 0.5)) + 25;
                imagesetpixel($img, $x, $y, ($v << 16) | ($v << 8) | $v);
            }
        }

        $before = $this->edgeDifference($img);
        $out = $this->p->makeSeamless($img);
        $after = $this->edgeDifference($out);

        $this->assertSame([$n, $n], [imagesx($out), imagesy($out)]);
        $this->assertGreaterThan(80, $before['x']);
        $this->assertGreaterThan(80, $before['y']);
        // Across the wrap the jump is now no bigger than between neighbouring interior pixels.
        $this->assertLessThan(max(8, $after['interior'] * 2), $after['x']);
        $this->assertLessThan(max(8, $after['interior'] * 2), $after['y']);
    }

    public function test_flat_height_gives_a_flat_normal_map(): void
    {
        $normal = $this->p->deriveNormal($this->solidImage(64, 64, 0x808080));

        foreach ([[0, 0], [31, 17], [63, 63]] as [$x, $y]) {
            [$r, $g, $b] = $this->rgbAt($normal, $x, $y);
            $this->assertEqualsWithDelta(128, $r, 1);
            $this->assertEqualsWithDelta(128, $g, 1);
            $this->assertEqualsWithDelta(255, $b, 1);
        }
    }

    public function test_normals_use_the_opengl_convention(): void
    {
        // Height rises to the right (x) and towards the bottom of the image (y).
        $n = 64;
        $height = imagecreatetruecolor($n, $n);
        for ($y = 0; $y < $n; $y++) {
            for ($x = 0; $x < $n; $x++) {
                $v = 60 + $x + $y;
                imagesetpixel($height, $x, $y, ($v << 16) | ($v << 8) | $v);
            }
        }

        [$r, $g, $b] = $this->rgbAt($this->p->deriveNormal($height, 3), 32, 32);

        $this->assertLessThan(128, $r, 'Surface rising to +X tilts the normal towards -X.');
        $this->assertGreaterThan(128, $g, 'Surface rising towards the image bottom faces image-up (+Y, OpenGL green up).');
        $this->assertGreaterThan(200, $b);

        [, $flippedG] = $this->rgbAt($this->p->flipNormalGreen($this->p->deriveNormal($height, 3)), 32, 32);
        $this->assertSame(255 - $g, $flippedG);
    }

    public function test_derived_maps_have_the_albedo_size_and_sane_ranges(): void
    {
        $albedo = $this->noiseImage(96, 96);
        $height = $this->p->deriveHeight($albedo);
        $roughness = $this->p->deriveRoughness($albedo, $height);
        $ao = $this->p->deriveAo($height);
        $thumb = $this->p->thumbnail($albedo, 32);

        foreach ([$height, $roughness, $ao] as $map) {
            $this->assertSame([96, 96], [imagesx($map), imagesy($map)]);
        }
        $this->assertSame([32, 32], [imagesx($thumb), imagesy($thumb)]);

        $rough = $this->p->channel($roughness);
        $this->assertGreaterThanOrEqual(178, min($rough));
        $this->assertLessThanOrEqual(243, max($rough));
        $this->assertGreaterThan(0, max($rough) - min($rough), 'Roughness varies with the albedo.');

        $heights = $this->p->channel($height);
        $this->assertLessThan(20, min($heights), 'Height is stretched to the full range.');
        $this->assertGreaterThan(235, max($heights));

        $this->assertGreaterThanOrEqual(127, min($this->p->channel($ao)));
        $this->assertSame(255, max($this->p->channel($ao)));
    }

    public function test_delight_removes_a_lighting_gradient(): void
    {
        // Uniform material lit from the left: brightness falls off strongly to the right.
        $n = 128;
        $img = imagecreatetruecolor($n, $n);
        mt_srand(3);
        for ($y = 0; $y < $n; $y++) {
            for ($x = 0; $x < $n; $x++) {
                $light = 1.4 - $x / $n;
                $v = (int) min(255, (120 + mt_rand(-10, 10)) * $light);
                imagesetpixel($img, $x, $y, ($v << 16) | ($v << 8) | (int) ($v * 0.8));
            }
        }

        $spread = function (GdImage $image): float {
            $lum = $this->p->luminance($this->p->pixels($image));
            $left = $right = 0;
            foreach ($lum as $i => $l) {
                ($i % 128) < 32 ? $left += $l : (($i % 128) >= 96 ? $right += $l : null);
            }

            return abs($left - $right) / (32 * 128);
        };

        $this->assertGreaterThan(80, $spread($img));
        $this->assertLessThan(15, $spread($this->p->delight($img)));
    }

    public function test_split_channels_unpacks_arm_maps(): void
    {
        [$ao, $rough, $metal] = $this->p->splitChannels($this->solidImage(8, 8, 0xC84010));

        $this->assertSame([200, 200, 200], $this->rgbAt($ao, 3, 3));
        $this->assertSame([64, 64, 64], $this->rgbAt($rough, 3, 3));
        $this->assertSame([16, 16, 16], $this->rgbAt($metal, 3, 3));
    }

    /**
     * Mean absolute luminance jump across the horizontal / vertical wrap and between interior neighbours.
     *
     * @return array{x: float, y: float, interior: float}
     */
    private function edgeDifference(GdImage $img): array
    {
        $n = imagesx($img);
        $v = fn (int $x, int $y) => (imagecolorat($img, $x, $y) >> 8) & 0xFF;
        $x = $y = $interior = 0;
        for ($i = 0; $i < $n; $i++) {
            $x += abs($v(0, $i) - $v($n - 1, $i));
            $y += abs($v($i, 0) - $v($i, $n - 1));
            $interior += abs($v(intdiv($n, 3), $i) - $v(intdiv($n, 3) + 1, $i));
        }

        return ['x' => $x / $n, 'y' => $y / $n, 'interior' => $interior / $n];
    }
}
