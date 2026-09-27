<?php

namespace Tests\Concerns;

use GdImage;

trait CreatesTestImages
{
    /**
     * A noisy coloured test image (deterministic).
     */
    protected function noiseImage(int $w, int $h, int $seed = 1, int $base = 0x6A7A3A): GdImage
    {
        mt_srand($seed);
        $img = imagecreatetruecolor($w, $h);
        for ($y = 0; $y < $h; $y++) {
            for ($x = 0; $x < $w; $x++) {
                $d = mt_rand(-40, 40);
                $r = max(0, min(255, (($base >> 16) & 0xFF) + $d));
                $g = max(0, min(255, (($base >> 8) & 0xFF) + $d));
                $b = max(0, min(255, ($base & 0xFF) + $d));
                imagesetpixel($img, $x, $y, ($r << 16) | ($g << 8) | $b);
            }
        }

        return $img;
    }

    protected function solidImage(int $w, int $h, int $color): GdImage
    {
        $img = imagecreatetruecolor($w, $h);
        imagefilledrectangle($img, 0, 0, $w - 1, $h - 1, $color);

        return $img;
    }

    protected function jpeg(GdImage $image, int $quality = 92): string
    {
        ob_start();
        imagejpeg($image, null, $quality);

        return (string) ob_get_clean();
    }

    protected function png(GdImage $image): string
    {
        ob_start();
        imagepng($image);

        return (string) ob_get_clean();
    }

    /**
     * @return array{0: int, 1: int, 2: int}
     */
    protected function rgbAt(GdImage $image, int $x, int $y): array
    {
        $c = imagecolorat($image, $x, $y);

        return [($c >> 16) & 0xFF, ($c >> 8) & 0xFF, $c & 0xFF];
    }

    /**
     * Mean colour of a stored image.
     *
     * @return array{0: float, 1: float, 2: float}
     */
    protected function meanRgb(string $bytes): array
    {
        $img = imagecreatefromstring($bytes);
        $w = imagesx($img);
        $h = imagesy($img);
        $sum = [0, 0, 0];
        $count = 0;
        for ($y = 0; $y < $h; $y += max(1, intdiv($h, 32))) {
            for ($x = 0; $x < $w; $x += max(1, intdiv($w, 32))) {
                foreach ($this->rgbAt($img, $x, $y) as $i => $v) {
                    $sum[$i] += $v;
                }
                $count++;
            }
        }

        return [$sum[0] / $count, $sum[1] / $count, $sum[2] / $count];
    }
}
