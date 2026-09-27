<?php

namespace App\Services\LandCover;

use Closure;
use RuntimeException;

/**
 * The parts of a tiled, single-band 8-bit (Cloud-Optimized) GeoTIFF needed to read individual
 * internal tiles with HTTP range requests: tile layout, tile offsets/sizes, compression and the
 * GeoTIFF affine transform (ModelTiepoint + ModelPixelScale, north-up).
 *
 * Supports little-endian classic TIFF and BigTIFF, compression none or DEFLATE, predictor 1/2.
 */
final class GeoTiffIndex
{
    private const TAG_IMAGE_WIDTH = 256;

    private const TAG_IMAGE_LENGTH = 257;

    private const TAG_BITS_PER_SAMPLE = 258;

    private const TAG_COMPRESSION = 259;

    private const TAG_SAMPLES_PER_PIXEL = 277;

    private const TAG_PREDICTOR = 317;

    private const TAG_TILE_WIDTH = 322;

    private const TAG_TILE_LENGTH = 323;

    private const TAG_TILE_OFFSETS = 324;

    private const TAG_TILE_BYTE_COUNTS = 325;

    private const TAG_SAMPLE_FORMAT = 339;

    private const TAG_MODEL_PIXEL_SCALE = 33550;

    private const TAG_MODEL_TIEPOINT = 33922;

    /** Byte size per TIFF field type. */
    private const TYPE_SIZES = [1 => 1, 2 => 1, 3 => 2, 4 => 4, 5 => 8, 6 => 1, 7 => 1, 8 => 2, 9 => 4, 10 => 8, 11 => 4, 12 => 8, 16 => 8, 17 => 8, 18 => 8];

    private const COMPRESSION_NONE = 1;

    private const COMPRESSION_DEFLATE = 8;

    private const COMPRESSION_DEFLATE_OLD = 32946;

    /**
     * @param  list<int>  $offsets  byte offset of each internal tile (row-major)
     * @param  list<int>  $counts  byte count of each internal tile (0 = sparse / empty)
     */
    public function __construct(
        public readonly int $width,
        public readonly int $height,
        public readonly int $tileWidth,
        public readonly int $tileLength,
        public readonly int $compression,
        public readonly int $predictor,
        public readonly array $offsets,
        public readonly array $counts,
        public readonly float $originX,
        public readonly float $originY,
        public readonly float $scaleX,
        public readonly float $scaleY,
    ) {}

    /**
     * Parse the first IFD. $head holds the first bytes of the file; values stored beyond it are
     * read through $fetch(offset, length).
     *
     * @param  Closure(int, int): string  $fetch
     */
    public static function parse(string $head, Closure $fetch): self
    {
        $read = static function (int $offset, int $length) use ($head, $fetch): string {
            if ($offset + $length <= strlen($head)) {
                return substr($head, $offset, $length);
            }

            $bytes = $fetch($offset, $length);
            if (strlen($bytes) < $length) {
                throw new RuntimeException('Truncated TIFF header.');
            }

            return substr($bytes, 0, $length);
        };

        if (strlen($head) < 16) {
            throw new RuntimeException('Not a TIFF file (too short).');
        }
        if (substr($head, 0, 2) !== 'II') {
            throw new RuntimeException('Only little-endian TIFF files are supported.');
        }

        $magic = self::u16($head, 2);
        if ($magic === 42) {
            $big = false;
            $ifd = self::u32($head, 4);
            $entryCount = self::u16($read($ifd, 2), 0);
            $entryStart = $ifd + 2;
            $entrySize = 12;
            $fieldSize = 4;
        } elseif ($magic === 43) {
            $big = true;
            $ifd = self::u64($head, 8);
            $entryCount = self::u64($read($ifd, 8), 0);
            $entryStart = $ifd + 8;
            $entrySize = 20;
            $fieldSize = 8;
        } else {
            throw new RuntimeException('Not a TIFF file.');
        }

        if ($entryCount < 1 || $entryCount > 1000) {
            throw new RuntimeException('Corrupt TIFF directory.');
        }

        $entries = $read($entryStart, $entryCount * $entrySize);
        $tags = [];

        for ($e = 0; $e < $entryCount; $e++) {
            $base = $e * $entrySize;
            $tag = self::u16($entries, $base);
            $type = self::u16($entries, $base + 2);
            $count = $big ? self::u64($entries, $base + 4) : self::u32($entries, $base + 4);
            $size = (self::TYPE_SIZES[$type] ?? 0) * $count;

            if (! in_array($tag, [
                self::TAG_IMAGE_WIDTH, self::TAG_IMAGE_LENGTH, self::TAG_BITS_PER_SAMPLE, self::TAG_COMPRESSION,
                self::TAG_SAMPLES_PER_PIXEL, self::TAG_PREDICTOR, self::TAG_TILE_WIDTH, self::TAG_TILE_LENGTH,
                self::TAG_TILE_OFFSETS, self::TAG_TILE_BYTE_COUNTS, self::TAG_SAMPLE_FORMAT,
                self::TAG_MODEL_PIXEL_SCALE, self::TAG_MODEL_TIEPOINT,
            ], true) || $size === 0) {
                continue;
            }

            $field = substr($entries, $base + ($big ? 12 : 8), $fieldSize);
            $raw = $size <= $fieldSize
                ? substr($field, 0, $size)
                : $read($big ? self::u64($field, 0) : self::u32($field, 0), $size);

            $tags[$tag] = self::decode($type, $raw);
        }

        $first = static fn (int $tag, ?int $default = null): int => isset($tags[$tag][0])
            ? (int) $tags[$tag][0]
            : ($default ?? throw new RuntimeException("TIFF tag {$tag} is missing."));

        if (! isset($tags[self::TAG_TILE_WIDTH], $tags[self::TAG_TILE_OFFSETS], $tags[self::TAG_TILE_BYTE_COUNTS])) {
            throw new RuntimeException('Only tiled TIFF files are supported.');
        }
        if ($first(self::TAG_BITS_PER_SAMPLE, 1) !== 8 || $first(self::TAG_SAMPLES_PER_PIXEL, 1) !== 1) {
            throw new RuntimeException('Only single-band 8-bit TIFF files are supported.');
        }
        if (! in_array($first(self::TAG_SAMPLE_FORMAT, 1), [1, 2], true)) {
            throw new RuntimeException('Unsupported TIFF sample format.');
        }

        $compression = $first(self::TAG_COMPRESSION, self::COMPRESSION_NONE);
        if (! in_array($compression, [self::COMPRESSION_NONE, self::COMPRESSION_DEFLATE, self::COMPRESSION_DEFLATE_OLD], true)) {
            throw new RuntimeException("Unsupported TIFF compression {$compression}.");
        }
        $predictor = $first(self::TAG_PREDICTOR, 1);
        if (! in_array($predictor, [1, 2], true)) {
            throw new RuntimeException("Unsupported TIFF predictor {$predictor}.");
        }

        $scale = $tags[self::TAG_MODEL_PIXEL_SCALE] ?? null;
        $tie = $tags[self::TAG_MODEL_TIEPOINT] ?? null;
        if ($scale === null || $tie === null || count($scale) < 2 || count($tie) < 6 || $scale[0] <= 0 || $scale[1] <= 0) {
            throw new RuntimeException('GeoTIFF georeferencing (ModelPixelScale / ModelTiepoint) is missing.');
        }

        $width = $first(self::TAG_IMAGE_WIDTH);
        $height = $first(self::TAG_IMAGE_LENGTH);
        $tileWidth = $first(self::TAG_TILE_WIDTH);
        $tileLength = $first(self::TAG_TILE_LENGTH);
        $offsets = array_map('intval', $tags[self::TAG_TILE_OFFSETS]);
        $counts = array_map('intval', $tags[self::TAG_TILE_BYTE_COUNTS]);
        $expected = (int) (ceil($width / $tileWidth) * ceil($height / $tileLength));

        if (count($offsets) < $expected || count($counts) < $expected) {
            throw new RuntimeException('TIFF tile index is incomplete.');
        }

        return new self(
            $width, $height, $tileWidth, $tileLength, $compression, $predictor,
            array_values($offsets), array_values($counts),
            (float) $tie[3] - (float) $tie[0] * (float) $scale[0],
            (float) $tie[4] + (float) $tie[1] * (float) $scale[1],
            (float) $scale[0],
            (float) $scale[1],
        );
    }

    public function tilesAcross(): int
    {
        return (int) ceil($this->width / $this->tileWidth);
    }

    public function tilesDown(): int
    {
        return (int) ceil($this->height / $this->tileLength);
    }

    /**
     * Pixel column containing a longitude / x (may lie outside the image).
     */
    public function pixelX(float $x): int
    {
        return (int) floor(($x - $this->originX) / $this->scaleX);
    }

    public function pixelY(float $y): int
    {
        return (int) floor(($this->originY - $y) / $this->scaleY);
    }

    /**
     * Decompress one internal tile into tileWidth × tileLength bytes.
     */
    public function decodeTile(string $raw): string
    {
        $size = $this->tileWidth * $this->tileLength;

        if ($raw === '') {
            return str_repeat("\0", $size);
        }

        if ($this->compression !== self::COMPRESSION_NONE) {
            $inflated = @gzuncompress($raw);
            if ($inflated === false) {
                $inflated = @zlib_decode($raw);
            }
            if ($inflated === false) {
                $inflated = @gzinflate($raw);
            }
            if ($inflated === false) {
                throw new RuntimeException('Could not inflate a TIFF tile.');
            }
            $raw = $inflated;
        }

        if (strlen($raw) < $size) {
            $raw .= str_repeat("\0", $size - strlen($raw));
        } elseif (strlen($raw) > $size) {
            $raw = substr($raw, 0, $size);
        }

        if ($this->predictor === 2) {
            $raw = self::undoHorizontalPredictor($raw, $this->tileWidth, $this->tileLength);
        }

        return $raw;
    }

    public static function undoHorizontalPredictor(string $bytes, int $width, int $rows): string
    {
        $values = unpack('C*', $bytes) ?: [];
        $out = '';

        for ($r = 0; $r < $rows; $r++) {
            $i = $r * $width + 1;
            $acc = 0;
            $line = [];
            for ($c = 0; $c < $width; $c++) {
                $acc = ($acc + $values[$i + $c]) & 0xFF;
                $line[] = $acc;
            }
            $out .= pack('C*', ...$line);
        }

        return $out;
    }

    /**
     * @return array<string, mixed>
     */
    public function toArray(): array
    {
        return get_object_vars($this);
    }

    /**
     * @param  array<string, mixed>  $data
     */
    public static function fromArray(array $data): self
    {
        return new self(
            (int) $data['width'], (int) $data['height'], (int) $data['tileWidth'], (int) $data['tileLength'],
            (int) $data['compression'], (int) $data['predictor'],
            array_map('intval', $data['offsets']), array_map('intval', $data['counts']),
            (float) $data['originX'], (float) $data['originY'], (float) $data['scaleX'], (float) $data['scaleY'],
        );
    }

    /**
     * @return list<int|float|string>
     */
    private static function decode(int $type, string $raw): array
    {
        return array_values(match ($type) {
            1, 7 => unpack('C*', $raw),
            6 => unpack('c*', $raw),
            2 => [rtrim($raw, "\0")],
            3 => unpack('v*', $raw),
            8 => array_map(fn (int $v) => $v >= 0x8000 ? $v - 0x10000 : $v, unpack('v*', $raw)),
            4, 9 => unpack('V*', $raw),
            16, 17, 18 => unpack('P*', $raw),
            11 => unpack('g*', $raw),
            12 => unpack('e*', $raw),
            default => [],
        } ?: []);
    }

    private static function u16(string $bytes, int $offset): int
    {
        return unpack('v', $bytes, $offset)[1];
    }

    private static function u32(string $bytes, int $offset): int
    {
        return unpack('V', $bytes, $offset)[1];
    }

    private static function u64(string $bytes, int $offset): int
    {
        return unpack('P', $bytes, $offset)[1];
    }
}
