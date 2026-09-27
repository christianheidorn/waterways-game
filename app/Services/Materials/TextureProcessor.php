<?php

namespace App\Services\Materials;

use GdImage;
use RuntimeException;

/**
 * GD-based helpers that turn a single photo (or a partial PBR set) into a complete, tileable
 * terrain material. Every method is pure: inputs are never modified, a new image is returned.
 *
 * Images are square true-colour GD images; greyscale maps store the same value in R, G and B.
 * Heavy per-pixel work runs on packed int arrays; blurs use GD resampling (down-scale then
 * up-scale) on a wrap-padded copy so derived maps stay tileable.
 */
final class TextureProcessor
{
    /**
     * Decode image bytes into a true-colour GD image.
     */
    public function decode(string $bytes): GdImage
    {
        $image = @imagecreatefromstring($bytes);

        if (! $image instanceof GdImage) {
            throw new RuntimeException('The file is not a readable image (JPEG, PNG or WebP expected).');
        }

        if (! imageistruecolor($image)) {
            imagepalettetotruecolor($image);
        }

        imagealphablending($image, true);

        return $image;
    }

    public function encodeJpeg(GdImage $image, int $quality = 90): string
    {
        ob_start();
        imagejpeg($image, null, $quality);

        return (string) ob_get_clean();
    }

    public function encodePng(GdImage $image): string
    {
        ob_start();
        imagepng($image, null, 6);

        return (string) ob_get_clean();
    }

    /**
     * Centre-crop to a square and resample to $size × $size.
     */
    public function normalizeSquare(GdImage $image, int $size): GdImage
    {
        $w = imagesx($image);
        $h = imagesy($image);
        $side = min($w, $h);

        $dst = $this->canvas($size, $size);
        imagecopyresampled($dst, $image, 0, 0, intdiv($w - $side, 2), intdiv($h - $side, 2), $size, $size, $side, $side);

        return $dst;
    }

    /**
     * Make the texture tile: a band at each edge is cross-faded with the opposite side (smoothstep
     * ramp, variance-preserving so the blend zone keeps its contrast), which removes the seam when
     * the image repeats. The result is resampled back to the input size.
     */
    public function makeSeamless(GdImage $image, float $band = 0.125): GdImage
    {
        $n = imagesx($image);
        $h = imagesy($image);
        $b = max(2, (int) round(min($n, $h) * $band));
        $mean = $this->meanColor($image);

        // Horizontal pass: out(x) = A(x) for x ≥ b; out(x < b) = blend(A(m + x), A(x), s(x)) with m = n - b.
        $m = $n - $b;
        $horizontal = $this->canvas($m, $h);
        imagecopy($horizontal, $image, 0, 0, 0, 0, $m, $h);
        for ($x = 0; $x < $b; $x++) {
            [$wa, $wb, $norm] = $this->rampWeights($x, $b);
            for ($y = 0; $y < $h; $y++) {
                imagesetpixel($horizontal, $x, $y, $this->blendPixel(
                    imagecolorat($image, $x, $y), imagecolorat($image, $m + $x, $y), $wa, $wb, $norm, $mean,
                ));
            }
        }

        // Vertical pass on the result.
        $k = $h - $b;
        $both = $this->canvas($m, $k);
        imagecopy($both, $horizontal, 0, 0, 0, 0, $m, $k);
        for ($y = 0; $y < $b; $y++) {
            [$wa, $wb, $norm] = $this->rampWeights($y, $b);
            for ($x = 0; $x < $m; $x++) {
                imagesetpixel($both, $x, $y, $this->blendPixel(
                    imagecolorat($horizontal, $x, $y), imagecolorat($horizontal, $x, $k + $y), $wa, $wb, $norm, $mean,
                ));
            }
        }

        $out = $this->canvas($n, $h);
        imagecopyresampled($out, $both, 0, 0, 0, 0, $n, $h, $m, $k);

        return $out;
    }

    /**
     * Remove baked-in low-frequency lighting: divide by a heavily blurred luminance and rescale
     * so the mean brightness is preserved.
     */
    public function delight(GdImage $image, float $strength = 1.0): GdImage
    {
        $size = imagesx($image);
        $h = imagesy($image);
        $lum = $this->luminanceOf($image);
        $low = $this->blur($lum, $size, $h, max(4, intdiv(min($size, $h), 10)), pad: 'mirror');
        $mean = array_sum($lum) / max(1, count($lum));

        $out = $this->canvas($size, $h);
        $i = 0;
        for ($y = 0; $y < $h; $y++) {
            for ($x = 0; $x < $size; $x++) {
                $f = $mean / max(8.0, $low[$i++]);
                $f = 1 + ($f - 1) * $strength;
                $f = $f < 0.4 ? 0.4 : ($f > 2.5 ? 2.5 : $f);
                $p = imagecolorat($image, $x, $y);
                $r = (int) ((($p >> 16) & 0xFF) * $f);
                $g = (int) ((($p >> 8) & 0xFF) * $f);
                $b = (int) (($p & 0xFF) * $f);
                imagesetpixel($out, $x, $y, (($r > 255 ? 255 : $r) << 16) | (($g > 255 ? 255 : $g) << 8) | ($b > 255 ? 255 : $b));
            }
        }

        return $out;
    }

    /**
     * Height from albedo: luminance with the large-scale component removed, lightly smoothed and
     * stretched to the full 0..255 range.
     */
    public function deriveHeight(GdImage $albedo): GdImage
    {
        $n = imagesx($albedo);
        $h = imagesy($albedo);
        $lum = $this->luminanceOf($albedo);
        $low = $this->blur($lum, $n, $h, max(4, intdiv($n, 16)));

        $hp = [];
        foreach ($lum as $i => $l) {
            $hp[] = $l - $low[$i] + 128;
        }

        $mild = $this->blur($hp, $n, $h, 1, gaussian: true);

        return $this->greyImage($this->stretch($mild), $n, $h);
    }

    /**
     * Tangent-space normal map from a height map (Sobel, wrap-around). OpenGL convention:
     * red = +X (right), green = +Y (up in texture space), blue = +Z.
     */
    public function deriveNormal(GdImage $height, float $strength = 1.0): GdImage
    {
        $n = imagesx($height);
        $h = imagesy($height);
        $v = $this->channel($height);

        // Assume the height map spans ~2 % of the tile width, so detail keeps its look at any resolution.
        $k = $strength * 0.02 * $n / (8 * 255);

        $out = [];
        for ($y = 0; $y < $h; $y++) {
            $up = (($y - 1 + $h) % $h) * $n;
            $row = $y * $n;
            $down = (($y + 1) % $h) * $n;
            for ($x = 0; $x < $n; $x++) {
                $l = $x === 0 ? $n - 1 : $x - 1;
                $r = $x === $n - 1 ? 0 : $x + 1;
                $tl = $v[$up + $l];
                $tr = $v[$up + $r];
                $bl = $v[$down + $l];
                $br = $v[$down + $r];
                $gx = ($tr + 2 * $v[$row + $r] + $br) - ($tl + 2 * $v[$row + $l] + $bl);
                $gy = ($bl + 2 * $v[$down + $x] + $br) - ($tl + 2 * $v[$up + $x] + $tr);
                $nx = -$gx * $k;
                $ny = $gy * $k;
                $len = sqrt($nx * $nx + $ny * $ny + 1);
                $out[] = ((int) round(($nx / $len + 1) * 127.5) << 16)
                    | ((int) round(($ny / $len + 1) * 127.5) << 8)
                    | (int) round((1 / $len + 1) * 127.5);
            }
        }

        return $this->fromPixels($out, $n, $h);
    }

    /**
     * Roughness: mostly rough (0.7–0.95), darker areas and cavities slightly rougher.
     */
    public function deriveRoughness(GdImage $albedo, GdImage $height): GdImage
    {
        $n = imagesx($albedo);
        $h = imagesy($albedo);
        $lum = $this->luminanceOf($albedo);
        $hv = $this->channel($this->ensureSize($height, $n, $h));
        $mean = array_sum($lum) / max(1, count($lum));

        $out = [];
        foreach ($lum as $i => $l) {
            $r = 0.84 + ($mean - $l) / 255 * 0.35 + (128 - $hv[$i]) / 255 * 0.12;
            $r = $r < 0.7 ? 0.7 : ($r > 0.95 ? 0.95 : $r);
            $out[] = (int) round($r * 255);
        }

        return $this->greyImage($out, $n, $h);
    }

    /**
     * Cavity ambient occlusion: darken where the surface sits below its local average.
     */
    public function deriveAo(GdImage $height): GdImage
    {
        $n = imagesx($height);
        $h = imagesy($height);
        $v = $this->channel($height);
        $low = $this->blur($v, $n, $h, max(2, intdiv($n, 64)));

        $out = [];
        foreach ($v as $i => $value) {
            $cavity = $value - $low[$i];
            $ao = $cavity < 0 ? 1 + $cavity / 255 * 1.6 : 1.0;
            $out[] = (int) round(($ao < 0.5 ? 0.5 : $ao) * 255);
        }

        return $this->greyImage($out, $n, $h);
    }

    public function thumbnail(GdImage $albedo, int $size = 256): GdImage
    {
        return $this->normalizeSquare($albedo, $size);
    }

    /**
     * Convert a DirectX (-Y) normal map to OpenGL (+Y) or back.
     */
    public function flipNormalGreen(GdImage $normal): GdImage
    {
        $out = [];
        foreach ($this->pixels($normal) as $p) {
            $out[] = ($p & 0xFF00FF) | ((255 - (($p >> 8) & 0xFF)) << 8);
        }

        return $this->fromPixels($out, imagesx($normal), imagesy($normal));
    }

    /**
     * Split a packed map (e.g. ARM/ORM: R = AO, G = roughness, B = metalness) into greyscale images.
     *
     * @return array{0: GdImage, 1: GdImage, 2: GdImage}
     */
    public function splitChannels(GdImage $image): array
    {
        $w = imagesx($image);
        $h = imagesy($image);
        $r = $g = $b = [];
        foreach ($this->pixels($image) as $p) {
            $r[] = ($p >> 16) & 0xFF;
            $g[] = ($p >> 8) & 0xFF;
            $b[] = $p & 0xFF;
        }

        return [$this->greyImage($r, $w, $h), $this->greyImage($g, $w, $h), $this->greyImage($b, $w, $h)];
    }

    /**
     * Greyscale copy (GD native, cheap even at 4K).
     */
    public function greyscale(GdImage $image): GdImage
    {
        $copy = $this->canvas(imagesx($image), imagesy($image));
        imagecopy($copy, $image, 0, 0, 0, 0, imagesx($image), imagesy($image));
        imagefilter($copy, IMG_FILTER_GRAYSCALE);

        return $copy;
    }

    // ---------------------------------------------------------------------------------------
    // Pixel helpers (public for tests)
    // ---------------------------------------------------------------------------------------

    /**
     * @return list<int> packed 0xRRGGBB values, row-major
     */
    public function pixels(GdImage $image): array
    {
        $w = imagesx($image);
        $h = imagesy($image);
        $out = [];
        for ($y = 0; $y < $h; $y++) {
            for ($x = 0; $x < $w; $x++) {
                $out[] = imagecolorat($image, $x, $y) & 0xFFFFFF;
            }
        }

        return $out;
    }

    /**
     * Red channel of every pixel (the value of a greyscale map).
     *
     * @return list<int>
     */
    public function channel(GdImage $image): array
    {
        $w = imagesx($image);
        $h = imagesy($image);
        $out = [];
        for ($y = 0; $y < $h; $y++) {
            for ($x = 0; $x < $w; $x++) {
                $out[] = (imagecolorat($image, $x, $y) >> 16) & 0xFF;
            }
        }

        return $out;
    }

    /**
     * Rec. 709 luma (0..255) of every pixel.
     *
     * @return list<int>
     */
    public function luminanceOf(GdImage $image): array
    {
        $w = imagesx($image);
        $h = imagesy($image);
        $out = [];
        for ($y = 0; $y < $h; $y++) {
            for ($x = 0; $x < $w; $x++) {
                $p = imagecolorat($image, $x, $y);
                $out[] = ((($p >> 16) & 0xFF) * 54 + (($p >> 8) & 0xFF) * 183 + ($p & 0xFF) * 19) >> 8;
            }
        }

        return $out;
    }

    /**
     * @param  list<int>  $pixels
     */
    public function fromPixels(array $pixels, int $w, int $h): GdImage
    {
        $img = $this->canvas($w, $h);
        $i = 0;
        for ($y = 0; $y < $h; $y++) {
            for ($x = 0; $x < $w; $x++) {
                imagesetpixel($img, $x, $y, $pixels[$i++]);
            }
        }

        return $img;
    }

    /**
     * @param  list<int|float>  $values  0..255 (clamped)
     */
    public function greyImage(array $values, int $w, int $h): GdImage
    {
        $img = $this->canvas($w, $h);
        $i = 0;
        for ($y = 0; $y < $h; $y++) {
            for ($x = 0; $x < $w; $x++) {
                $v = (int) ($values[$i++] + 0.5);
                imagesetpixel($img, $x, $y, ($v < 0 ? 0 : ($v > 255 ? 255 : $v)) * 0x010101);
            }
        }

        return $img;
    }

    /**
     * @param  list<int>  $pixels
     * @return list<int> Rec. 709 luma 0..255
     */
    public function luminance(array $pixels): array
    {
        $out = [];
        foreach ($pixels as $p) {
            $out[] = ((($p >> 16) & 0xFF) * 54 + (($p >> 8) & 0xFF) * 183 + ($p & 0xFF) * 19) >> 8;
        }

        return $out;
    }

    // ---------------------------------------------------------------------------------------

    private function canvas(int $w, int $h): GdImage
    {
        $img = imagecreatetruecolor(max(1, $w), max(1, $h));
        imagealphablending($img, false);

        return $img;
    }

    private function ensureSize(GdImage $image, int $w, int $h): GdImage
    {
        if (imagesx($image) === $w && imagesy($image) === $h) {
            return $image;
        }

        $out = $this->canvas($w, $h);
        imagecopyresampled($out, $image, 0, 0, 0, 0, $w, $h, imagesx($image), imagesy($image));

        return $out;
    }

    /**
     * @return array{0: float, 1: float, 2: float} weight of the inner pixel, of the wrapped pixel, 1/√(Σw²)
     */
    private function rampWeights(int $i, int $band): array
    {
        $t = ($i + 0.5) / $band;
        $w = $t * $t * (3 - 2 * $t);

        return [$w, 1 - $w, 1 / sqrt($w * $w + (1 - $w) * (1 - $w))];
    }

    /**
     * Variance-preserving linear blend of two packed pixels around the image mean.
     *
     * @param  array{0: float, 1: float, 2: float}  $mean
     */
    private function blendPixel(int $a, int $b, float $wa, float $wb, float $norm, array $mean): int
    {
        $out = 0;
        foreach ([16, 8, 0] as $i => $shift) {
            $v = (int) round($mean[$i] + ((($a >> $shift) & 0xFF) * $wa + (($b >> $shift) & 0xFF) * $wb - $mean[$i]) * $norm);
            $out |= ($v < 0 ? 0 : ($v > 255 ? 255 : $v)) << $shift;
        }

        return $out;
    }

    /**
     * @return array{0: float, 1: float, 2: float}
     */
    private function meanColor(GdImage $image): array
    {
        $px = $this->canvas(1, 1);
        imagecopyresampled($px, $image, 0, 0, 0, 0, 1, 1, imagesx($image), imagesy($image));
        $c = imagecolorat($px, 0, 0);

        return [($c >> 16) & 0xFF, ($c >> 8) & 0xFF, $c & 0xFF];
    }

    /**
     * Low-pass filter a scalar field. $factor is the down-scale factor (radius ≈ factor px);
     * $gaussian applies a single 3×3 gaussian instead. $pad: 'wrap' treats the field as tiling,
     * 'mirror' reflects it at the borders (for images that do not tile yet).
     *
     * Values may lie outside 0..255 (e.g. high-passed data); they are offset into range for GD
     * and scaled back, with 8-bit precision.
     *
     * @param  list<int|float>  $values
     * @return list<float>
     */
    private function blur(array $values, int $w, int $h, int $factor, bool $gaussian = false, string $pad = 'wrap'): array
    {
        $min = min($values);
        $max = max($values);
        $scale = 255 / max(1e-6, $max - $min);

        $img = $this->canvas($w, $h);
        $i = 0;
        for ($y = 0; $y < $h; $y++) {
            for ($x = 0; $x < $w; $x++) {
                imagesetpixel($img, $x, $y, (int) (($values[$i++] - $min) * $scale + 0.5) * 0x010101);
            }
        }

        $padding = $gaussian ? 2 : min(intdiv($w, 2), intdiv($h, 2), max(2, $factor * 2));
        $img = $this->padImage($img, $padding, $pad === 'mirror');
        $pw = imagesx($img);
        $ph = imagesy($img);

        if ($gaussian) {
            imagefilter($img, IMG_FILTER_GAUSSIAN_BLUR);
            $blurred = $img;
        } else {
            $sw = max(1, (int) round($pw / $factor));
            $sh = max(1, (int) round($ph / $factor));
            $small = $this->canvas($sw, $sh);
            imagecopyresampled($small, $img, 0, 0, 0, 0, $sw, $sh, $pw, $ph);
            // Soften the grid before up-scaling so no blocks remain.
            imagefilter($small, IMG_FILTER_GAUSSIAN_BLUR);
            $blurred = $this->canvas($pw, $ph);
            imagecopyresampled($blurred, $small, 0, 0, 0, 0, $pw, $ph, $sw, $sh);
        }

        $inv = 1 / $scale;
        $out = [];
        for ($y = 0; $y < $h; $y++) {
            for ($x = 0; $x < $w; $x++) {
                $out[] = (imagecolorat($blurred, $x + $padding, $y + $padding) & 0xFF) * $inv + $min;
            }
        }

        return $out;
    }

    /**
     * Surround the image with a $pad px border copied from the opposite edges (torus wrap) or
     * reflected at the edges (mirror).
     */
    private function padImage(GdImage $img, int $pad, bool $mirror): GdImage
    {
        $w = imagesx($img);
        $h = imagesy($img);
        $out = $this->canvas($w + 2 * $pad, $h + 2 * $pad);

        foreach ([-1, 0, 1] as $ty) {
            foreach ([-1, 0, 1] as $tx) {
                $tile = $img;
                if ($mirror && ($tx !== 0 || $ty !== 0)) {
                    $tile = $this->canvas($w, $h);
                    imagecopy($tile, $img, 0, 0, 0, 0, $w, $h);
                    $mode = match (true) {
                        $tx !== 0 && $ty !== 0 => IMG_FLIP_BOTH,
                        $tx !== 0 => IMG_FLIP_HORIZONTAL,
                        default => IMG_FLIP_VERTICAL,
                    };
                    imageflip($tile, $mode);
                }
                imagecopy($out, $tile, $pad + $tx * $w, $pad + $ty * $h, 0, 0, $w, $h);
            }
        }

        return $out;
    }

    /**
     * Stretch values to 0..255 between the 1st and 99th percentile.
     *
     * @param  list<int|float>  $values
     * @return list<int>
     */
    private function stretch(array $values): array
    {
        $min = min($values);
        $max = max($values);
        if ($max - $min < 1e-6) {
            return array_fill(0, count($values), 128);
        }

        // 1024-bucket histogram → percentiles without sorting.
        $buckets = array_fill(0, 1024, 0);
        $bs = 1023 / ($max - $min);
        foreach ($values as $v) {
            $buckets[(int) (($v - $min) * $bs)]++;
        }

        $total = count($values);
        $lo = $this->percentileBucket($buckets, (int) ($total * 0.01)) / $bs + $min;
        $hi = ($this->percentileBucket($buckets, (int) ($total * 0.99)) + 1) / $bs + $min;
        $span = max(1e-6, $hi - $lo);

        $out = [];
        foreach ($values as $v) {
            $t = ($v - $lo) / $span * 255;
            $out[] = $t < 0 ? 0 : ($t > 255 ? 255 : (int) $t);
        }

        return $out;
    }

    /**
     * @param  list<int>  $buckets
     */
    private function percentileBucket(array $buckets, int $target): int
    {
        $sum = 0;
        foreach ($buckets as $i => $count) {
            $sum += $count;
            if ($sum > $target) {
                return $i;
            }
        }

        return count($buckets) - 1;
    }
}
