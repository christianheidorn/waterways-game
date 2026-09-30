<?php

namespace App\Mcp;

use App\Models\TerrainLayer;
use GdImage;
use Illuminate\Support\Collection;

/**
 * Top-down images of a map for agents to reason about space: the terrain as a map, heights, slopes,
 * layers or water, with a labelled world-coordinate grid (metres), north up and the player start
 * marked. Rendered from the saved terrain with GD (no editor needed).
 */
class MapImageRenderer
{
    public const KINDS = ['map', 'height', 'slope', 'layers', 'water'];

    /** Distinct colours per layer slot (the editor's "Layers" view uses the same idea). */
    private const SLOT_COLORS = [
        [230, 57, 70], [82, 183, 136], [255, 183, 3], [69, 123, 157],
        [155, 93, 229], [244, 132, 95], [0, 180, 216], [240, 240, 240],
    ];

    private const SLOPE_STOPS = [[0, [60, 160, 70]], [15, [220, 210, 60]], [30, [240, 140, 40]], [45, [210, 40, 40]], [60, [120, 40, 150]]];

    private const HEIGHT_STOPS = [[0.0, [58, 110, 60]], [0.25, [120, 150, 70]], [0.5, [200, 180, 100]], [0.75, [140, 110, 80]], [0.9, [170, 170, 170]], [1.0, [250, 250, 250]]];

    /**
     * @param  array{min: array{x: float, z: float}, max: array{x: float, z: float}}|null  $area  crop (world metres)
     * @return array{image: string, mime: string, meta: array<string, mixed>}
     */
    public function render(TerrainData $t, string $kind, ?array $area, int $maxSize): array
    {
        $half = $t->size / 2;
        $x0 = max(-$half, (float) ($area['min']['x'] ?? -$half));
        $z0 = max(-$half, (float) ($area['min']['z'] ?? -$half));
        $x1 = min($half, (float) ($area['max']['x'] ?? $half));
        $z1 = min($half, (float) ($area['max']['z'] ?? $half));

        if ($x1 - $x0 < 1 || $z1 - $z0 < 1) {
            throw new ToolError('The area is empty or outside the map.');
        }

        $scale = $maxSize / max($x1 - $x0, $z1 - $z0);
        $w = max(64, (int) round(($x1 - $x0) * $scale));
        $h = max(64, (int) round(($z1 - $z0) * $scale));
        $img = imagecreatetruecolor($w, $h);
        [$minH, $maxH] = $t->range();
        $layers = $t->map->layers()->get()->keyBy('slot');
        $contour = $this->niceStep(($maxH - $minH) / 12);
        $metresPerPixel = ($x1 - $x0) / $w;
        // Gradients over about a pixel's footprint (at least one sample).
        $step = max(1, (int) round($metresPerPixel / $t->cell));
        $fine = $metresPerPixel < $t->cell * 0.75;
        $bands = [];

        for ($py = 0; $py < $h; $py++) {
            $z = $z0 + ($py + 0.5) * $metresPerPixel;

            for ($px = 0; $px < $w; $px++) {
                $x = $x0 + ($px + 0.5) * $metresPerPixel;
                [$gx, $gz] = $t->toGrid($x, $z);
                $col = (int) round($gx);
                $row = (int) round($gz);
                // Zoomed in (pixels smaller than samples): interpolate, so crops are not blocky.
                $ground = $fine ? $t->height($x, $z) : $t->heightAt($col, $row);
                $shade = $fine ? $this->hillshadeAt($t, $x, $z) : $this->hillshade($t, $col, $row, $step);
                $water = $t->waterAt($col, $row);
                $rgb = $this->color($kind, $t, $col, $row, $ground, $minH, $maxH, $shade, $layers);

                if ($water !== null && $water > $ground && $kind !== 'slope' && $kind !== 'layers') {
                    $depth = min(1, ($water - $ground) / 8);
                    $rgb = $this->mix([70, 140, 190], [20, 60, 120], $depth);
                }

                $band = (int) floor($ground / $contour);
                $bands[$py * $w + $px] = $band;
                imagesetpixel($img, $px, $py, ($rgb[0] << 16) | ($rgb[1] << 8) | $rgb[2]);
            }
        }

        if ($kind === 'map' || $kind === 'height') {
            $this->contours($img, $bands, $w, $h);
        }

        $grid = $this->niceStep(max($x1 - $x0, $z1 - $z0) / 7);
        $this->grid($img, $x0, $z0, $x1, $z1, $metresPerPixel, $grid);
        $this->markSpawn($img, $t, $x0, $z0, $metresPerPixel);
        $legend = $this->legend($img, $kind, $layers, $minH, $maxH, $contour);

        ob_start();
        imagejpeg($img, null, 88);
        $data = (string) ob_get_clean();
        imagedestroy($img);

        return [
            'image' => $data,
            'mime' => 'image/jpeg',
            'meta' => [
                'kind' => $kind,
                'area' => ['min' => ['x' => $x0, 'z' => $z0], 'max' => ['x' => $x1, 'z' => $z1]],
                'pixels' => [$w, $h],
                'metres_per_pixel' => round($metresPerPixel, 2),
                'orientation' => 'North (−z) is up, east (+x) is right. Pixel (px, py) is world x = area.min.x + px · metres_per_pixel, z = area.min.z + py · metres_per_pixel.',
                'grid_lines_every_m' => $grid,
                'contours_every_m' => $kind === 'map' || $kind === 'height' ? $contour : null,
                'height_range_m' => [round($minH, 1), round($maxH, 1)],
                'legend' => $legend,
                'note' => $t->hasPaint() ? null : 'No terrain paint is saved yet: everything shows as layer slot 0 (the editor auto-paints the layers until the map is saved).',
            ],
        ];
    }

    /**
     * @param  Collection<int, TerrainLayer>  $layers
     * @return array{0: int, 1: int, 2: int}
     */
    private function color(string $kind, TerrainData $t, int $col, int $row, float $ground, float $minH, float $maxH, float $shade, $layers): array
    {
        switch ($kind) {
            case 'height':
                $rgb = $this->ramp(self::HEIGHT_STOPS, ($ground - $minH) / max(1e-6, $maxH - $minH));

                return $this->shade($rgb, 0.6 + 0.5 * $shade);
            case 'slope':
                return $this->shade($this->ramp(self::SLOPE_STOPS, $t->slopeAt($col, $row)), 0.8 + 0.25 * $shade);
            case 'water':
                return $this->shade([200, 200, 196], 0.55 + 0.5 * $shade);
            case 'layers':
            case 'map':
                $weights = $t->weightsAt($col, $row);
                $sum = max(1, array_sum($weights));
                $rgb = [0.0, 0.0, 0.0];

                foreach ($weights as $slot => $weight) {
                    if ($weight === 0) {
                        continue;
                    }

                    $c = $kind === 'layers'
                        ? self::SLOT_COLORS[$slot]
                        : $this->hex($layers[$slot]->color ?? '#777777');

                    for ($k = 0; $k < 3; $k++) {
                        $rgb[$k] += $c[$k] * $weight / $sum;
                    }
                }

                return $this->shade($rgb, $kind === 'layers' ? 0.75 + 0.3 * $shade : 0.55 + 0.6 * $shade);
        }

        return [128, 128, 128];
    }

    /** Light from the north-west, 0 (facing away) … 1 (facing the light). */
    private function hillshade(TerrainData $t, int $col, int $row, int $step): float
    {
        $dx = ($t->heightAt($col + $step, $row) - $t->heightAt($col - $step, $row)) / (2 * $step * $t->cell);
        $dz = ($t->heightAt($col, $row + $step) - $t->heightAt($col, $row - $step)) / (2 * $step * $t->cell);
        // Normal (-dx, 1, -dz) against light (-1, 1.4, -1) normalised.
        $n = sqrt($dx * $dx + 1 + $dz * $dz);
        $dot = ($dx + 1.4 + $dz) / ($n * sqrt(3.96));

        return max(0.0, min(1.0, $dot));
    }

    /** Hillshade from interpolated heights one sample apart (zoomed-in images). */
    private function hillshadeAt(TerrainData $t, float $x, float $z): float
    {
        $d = $t->cell;
        $dx = ($t->height($x + $d, $z) - $t->height($x - $d, $z)) / (2 * $d);
        $dz = ($t->height($x, $z + $d) - $t->height($x, $z - $d)) / (2 * $d);
        $n = sqrt($dx * $dx + 1 + $dz * $dz);

        return max(0.0, min(1.0, ($dx + 1.4 + $dz) / ($n * sqrt(3.96))));
    }

    /** @param array<int, int> $bands */
    private function contours(GdImage $img, array $bands, int $w, int $h): void
    {
        $line = imagecolorallocatealpha($img, 30, 30, 30, 90);

        for ($py = 0; $py < $h - 1; $py++) {
            for ($px = 0; $px < $w - 1; $px++) {
                $b = $bands[$py * $w + $px];

                if ($b !== $bands[$py * $w + $px + 1] || $b !== $bands[($py + 1) * $w + $px]) {
                    imagesetpixel($img, $px, $py, $line);
                }
            }
        }
    }

    private function grid(GdImage $img, float $x0, float $z0, float $x1, float $z1, float $mpp, float $step): void
    {
        $line = imagecolorallocatealpha($img, 255, 255, 255, 70);
        $text = imagecolorallocate($img, 20, 20, 20);
        $box = imagecolorallocatealpha($img, 255, 255, 255, 30);
        $w = imagesx($img);
        $h = imagesy($img);

        for ($x = ceil($x0 / $step) * $step; $x <= $x1; $x += $step) {
            $px = (int) round(($x - $x0) / $mpp);
            imageline($img, $px, 0, $px, $h, $line);
            $this->label($img, $px + 2, 2, 'x '.$this->fmt($x), $text, $box);
        }

        for ($z = ceil($z0 / $step) * $step; $z <= $z1; $z += $step) {
            $py = (int) round(($z - $z0) / $mpp);
            imageline($img, 0, $py, $w, $py, $line);
            $this->label($img, 2, $py + 2, 'z '.$this->fmt($z), $text, $box);
        }

        $this->label($img, $w - 24, $h - 18, 'N ^', $text, $box);
    }

    private function markSpawn(GdImage $img, TerrainData $t, float $x0, float $z0, float $mpp): void
    {
        if ($t->map->spawn_x === null) {
            return;
        }

        $px = (int) round(($t->map->spawn_x - $x0) / $mpp);
        $py = (int) round(($t->map->spawn_z - $z0) / $mpp);
        $red = imagecolorallocate($img, 220, 30, 30);
        imagefilledellipse($img, $px, $py, 9, 9, $red);
        $this->label($img, $px + 6, $py - 6, 'start', imagecolorallocate($img, 20, 20, 20), imagecolorallocatealpha($img, 255, 255, 255, 30));
    }

    /**
     * @param  Collection<int, TerrainLayer>  $layers
     * @return array<string, string>
     */
    private function legend(GdImage $img, string $kind, $layers, float $minH, float $maxH, float $contour): array
    {
        $entries = match ($kind) {
            'layers' => $layers->mapWithKeys(fn (TerrainLayer $l) => ["slot {$l->slot}: {$l->name}" => self::SLOT_COLORS[$l->slot]])->all(),
            'slope' => ['0 deg' => self::SLOPE_STOPS[0][1], '15 deg' => self::SLOPE_STOPS[1][1], '30 deg' => self::SLOPE_STOPS[2][1], '45 deg' => self::SLOPE_STOPS[3][1], '60+ deg' => self::SLOPE_STOPS[4][1]],
            'height' => [
                round($minH).' m' => self::HEIGHT_STOPS[0][1],
                round(($minH + $maxH) / 2).' m' => self::HEIGHT_STOPS[2][1],
                round($maxH).' m' => self::HEIGHT_STOPS[5][1],
            ],
            'water' => ['shallow water' => [70, 140, 190], 'deep water (8 m+)' => [20, 60, 120]],
            default => $layers->mapWithKeys(fn (TerrainLayer $l) => ["slot {$l->slot}: {$l->name}" => $this->hex($l->color)])->all(),
        };

        $text = imagecolorallocate($img, 20, 20, 20);
        $box = imagecolorallocatealpha($img, 255, 255, 255, 25);
        $y = imagesy($img) - 16 * count($entries) - 8;
        imagefilledrectangle($img, 4, $y - 4, 4 + 8 + 7 * max(array_map('strlen', array_keys($entries)) ?: [4]) + 22, imagesy($img) - 6, $box);
        $described = [];

        foreach ($entries as $name => $rgb) {
            imagefilledrectangle($img, 8, $y + 2, 20, $y + 12, imagecolorallocate($img, ...array_map('intval', $rgb)));
            imagestring($img, 3, 26, $y, (string) $name, $text);
            $described[(string) $name] = sprintf('#%02x%02x%02x', ...array_map('intval', $rgb));
            $y += 16;
        }

        if ($kind === 'map' || $kind === 'height') {
            $described['contour lines'] = "every {$contour} m";
        }

        return $described;
    }

    private function label(GdImage $img, int $x, int $y, string $s, int $text, int $box): void
    {
        imagefilledrectangle($img, $x - 1, $y, $x + 7 * strlen($s) + 1, $y + 13, $box);
        imagestring($img, 3, $x, $y, $s, $text);
    }

    /** 1, 2, 2.5 or 5 × 10ⁿ, at least $raw. */
    private function niceStep(float $raw): float
    {
        $raw = max($raw, 0.5);
        $pow = 10 ** floor(log10($raw));

        foreach ([1, 2, 2.5, 5, 10] as $m) {
            if ($m * $pow >= $raw) {
                return $m * $pow;
            }
        }

        return 10 * $pow;
    }

    private function fmt(float $v): string
    {
        return (string) (round($v) == $v ? (int) $v : round($v, 1));
    }

    /**
     * @param  list<array{0: float, 1: array{0: int, 1: int, 2: int}}>  $stops
     * @return array{0: int, 1: int, 2: int}
     */
    private function ramp(array $stops, float $v): array
    {
        if ($v <= $stops[0][0]) {
            return $stops[0][1];
        }

        for ($i = 1; $i < count($stops); $i++) {
            if ($v <= $stops[$i][0]) {
                $t = ($v - $stops[$i - 1][0]) / ($stops[$i][0] - $stops[$i - 1][0]);

                return $this->mix($stops[$i - 1][1], $stops[$i][1], $t);
            }
        }

        return $stops[count($stops) - 1][1];
    }

    /** @return array{0: int, 1: int, 2: int} */
    private function mix(array $a, array $b, float $t): array
    {
        return [(int) ($a[0] + ($b[0] - $a[0]) * $t), (int) ($a[1] + ($b[1] - $a[1]) * $t), (int) ($a[2] + ($b[2] - $a[2]) * $t)];
    }

    /** @return array{0: int, 1: int, 2: int} */
    private function shade(array $rgb, float $k): array
    {
        return [(int) max(0, min(255, $rgb[0] * $k)), (int) max(0, min(255, $rgb[1] * $k)), (int) max(0, min(255, $rgb[2] * $k))];
    }

    /** @return array{0: int, 1: int, 2: int} */
    private function hex(string $hex): array
    {
        $hex = ltrim($hex, '#');

        return [hexdec(substr($hex, 0, 2)), hexdec(substr($hex, 2, 2)), hexdec(substr($hex, 4, 2))];
    }
}
