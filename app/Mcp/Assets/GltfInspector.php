<?php

namespace App\Mcp\Assets;

/**
 * Reads the JSON part of a glTF / GLB model without loading geometry: validation and the model's
 * bounding box (from the POSITION accessors' min / max, which glTF requires, transformed through the
 * default scene's node hierarchy).
 */
class GltfInspector
{
    /**
     * The glTF JSON document of a .glb (binary) or .gltf (JSON) file, or null when it is neither.
     *
     * @return array<string, mixed>|null
     */
    public static function document(string $contents): ?array
    {
        if (str_starts_with($contents, 'glTF')) {
            if (strlen($contents) < 20) {
                return null;
            }
            /** @var array{1: int, 2: int} $header */
            $header = unpack('V2', substr($contents, 12, 8));
            [$length, $type] = [$header[1], $header[2]];
            if ($type !== 0x4E4F534A || 20 + $length > strlen($contents)) {
                return null;
            }
            $json = json_decode(substr($contents, 20, $length), true);
        } else {
            $json = json_decode($contents, true);
        }

        return is_array($json) && is_array($json['asset'] ?? null) ? $json : null;
    }

    /**
     * Size of the model at scale 1 (x, y, z in model units — metres for Blender exports), or null when
     * the file holds no measurable geometry.
     *
     * @param  array<string, mixed>  $doc
     * @return array{x: float, y: float, z: float}|null
     */
    public static function dimensions(array $doc): ?array
    {
        $nodes = is_array($doc['nodes'] ?? null) ? $doc['nodes'] : [];
        $scenes = is_array($doc['scenes'] ?? null) ? $doc['scenes'] : [];
        $scene = $scenes[(int) ($doc['scene'] ?? 0)] ?? null;
        $roots = is_array($scene['nodes'] ?? null) ? $scene['nodes'] : array_keys($nodes);

        $min = [INF, INF, INF];
        $max = [-INF, -INF, -INF];
        $stack = array_map(fn ($i) => [(int) $i, self::identity(), 0], $roots);

        while ($stack !== []) {
            [$index, $parent, $depth] = array_pop($stack);
            $node = $nodes[$index] ?? null;
            if (! is_array($node) || $depth > 64) {
                continue;
            }
            $world = self::multiply($parent, self::localMatrix($node));

            foreach (self::meshBounds($doc, $node['mesh'] ?? null) as [$bMin, $bMax]) {
                foreach ([0, 1] as $i) {
                    foreach ([0, 1] as $j) {
                        foreach ([0, 1] as $k) {
                            $p = self::transform($world, [$i ? $bMax[0] : $bMin[0], $j ? $bMax[1] : $bMin[1], $k ? $bMax[2] : $bMin[2]]);
                            for ($a = 0; $a < 3; $a++) {
                                $min[$a] = min($min[$a], $p[$a]);
                                $max[$a] = max($max[$a], $p[$a]);
                            }
                        }
                    }
                }
            }

            foreach (is_array($node['children'] ?? null) ? $node['children'] : [] as $child) {
                $stack[] = [(int) $child, $world, $depth + 1];
            }
        }

        if (! is_finite($min[0]) || ! is_finite($max[0])) {
            return null;
        }

        return ['x' => round($max[0] - $min[0], 3), 'y' => round($max[1] - $min[1], 3), 'z' => round($max[2] - $min[2], 3)];
    }

    /**
     * @param  array<string, mixed>  $doc
     * @return list<array{0: array{float, float, float}, 1: array{float, float, float}}>
     */
    private static function meshBounds(array $doc, mixed $meshIndex): array
    {
        if (! is_int($meshIndex)) {
            return [];
        }

        $bounds = [];
        foreach ($doc['meshes'][$meshIndex]['primitives'] ?? [] as $primitive) {
            $accessor = $doc['accessors'][$primitive['attributes']['POSITION'] ?? -1] ?? null;
            $min = $accessor['min'] ?? null;
            $max = $accessor['max'] ?? null;
            if (is_array($min) && is_array($max) && count($min) === 3 && count($max) === 3) {
                $bounds[] = [array_map('floatval', array_values($min)), array_map('floatval', array_values($max))];
            }
        }

        return $bounds;
    }

    /**
     * Column-major 4×4 matrix (glTF convention) of a node's matrix or translation / rotation / scale.
     *
     * @param  array<string, mixed>  $node
     * @return list<float>
     */
    private static function localMatrix(array $node): array
    {
        if (is_array($node['matrix'] ?? null) && count($node['matrix']) === 16) {
            return array_map('floatval', array_values($node['matrix']));
        }

        [$tx, $ty, $tz] = self::vector($node['translation'] ?? null, [0, 0, 0]);
        [$qx, $qy, $qz, $qw] = self::vector($node['rotation'] ?? null, [0, 0, 0, 1]);
        [$sx, $sy, $sz] = self::vector($node['scale'] ?? null, [1, 1, 1]);

        return [
            (1 - 2 * ($qy * $qy + $qz * $qz)) * $sx, (2 * ($qx * $qy + $qz * $qw)) * $sx, (2 * ($qx * $qz - $qy * $qw)) * $sx, 0,
            (2 * ($qx * $qy - $qz * $qw)) * $sy, (1 - 2 * ($qx * $qx + $qz * $qz)) * $sy, (2 * ($qy * $qz + $qx * $qw)) * $sy, 0,
            (2 * ($qx * $qz + $qy * $qw)) * $sz, (2 * ($qy * $qz - $qx * $qw)) * $sz, (1 - 2 * ($qx * $qx + $qy * $qy)) * $sz, 0,
            $tx, $ty, $tz, 1,
        ];
    }

    /**
     * @param  list<float|int>  $default
     * @return list<float>
     */
    private static function vector(mixed $value, array $default): array
    {
        return array_map('floatval', is_array($value) && count($value) === count($default) ? array_values($value) : $default);
    }

    /** @return list<float> */
    private static function identity(): array
    {
        return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    }

    /**
     * @param  list<float>  $a
     * @param  list<float>  $b
     * @return list<float>
     */
    private static function multiply(array $a, array $b): array
    {
        $out = [];
        for ($col = 0; $col < 4; $col++) {
            for ($row = 0; $row < 4; $row++) {
                $sum = 0.0;
                for ($k = 0; $k < 4; $k++) {
                    $sum += $a[$k * 4 + $row] * $b[$col * 4 + $k];
                }
                $out[$col * 4 + $row] = $sum;
            }
        }

        return $out;
    }

    /**
     * @param  list<float>  $m
     * @param  array{float, float, float}  $p
     * @return array{float, float, float}
     */
    private static function transform(array $m, array $p): array
    {
        return [
            $m[0] * $p[0] + $m[4] * $p[1] + $m[8] * $p[2] + $m[12],
            $m[1] * $p[0] + $m[5] * $p[1] + $m[9] * $p[2] + $m[13],
            $m[2] * $p[0] + $m[6] * $p[1] + $m[10] * $p[2] + $m[14],
        ];
    }
}
