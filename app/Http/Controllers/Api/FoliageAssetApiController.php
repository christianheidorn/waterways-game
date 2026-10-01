<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\FoliageAsset;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;

/**
 * JSON endpoints for the foliage asset library: asset details and receiving browser bakes.
 */
class FoliageAssetApiController extends Controller
{
    public function show(FoliageAsset $asset): JsonResponse
    {
        return response()->json($asset->loadCount('types')->toStudioArray());
    }

    /**
     * Receive the GLB + thumbnail baked by resources/game/tools/FoliageBaker.ts.
     */
    public function bake(Request $request, FoliageAsset $asset): JsonResponse
    {
        $data = $request->validate([
            'model' => ['required', 'file', 'max:81920'],
            'thumbnail' => ['required', 'file', 'image', 'mimes:png,webp,jpg,jpeg', 'max:4096'],
            'meta' => ['required', 'json'],
        ]);

        $model = $request->file('model');
        $handle = fopen($model->getRealPath(), 'rb');
        $magic = $handle ? fread($handle, 4) : '';
        if ($handle) {
            fclose($handle);
        }
        if ($magic !== 'glTF') {
            return response()->json(['message' => 'The baked model is not a GLB file.'], 422);
        }

        $meta = $this->meta(json_decode($data['meta'], true));
        $disk = Storage::disk('public');
        $dir = $asset->storageDirectory();

        foreach ([$asset->model_path, $asset->thumbnail_path] as $old) {
            if ($old) {
                $disk->delete($old);
            }
        }

        $stamp = time();
        $modelPath = $model->storeAs($dir, "model-{$stamp}.glb", 'public');
        $thumbPath = $request->file('thumbnail')->storeAs($dir, "thumbnail-{$stamp}.png", 'public');

        $asset->forceFill([
            'model_path' => $modelPath,
            'thumbnail_path' => $thumbPath,
            'meta' => [
                ...array_intersect_key($asset->meta ?? [], array_flip(['source_polycount'])),
                ...$meta,
                'model_bytes' => $model->getSize(),
            ],
            'status' => 'ready',
            'status_message' => null,
        ])->save();

        return response()->json($asset->loadCount('types')->toStudioArray());
    }

    public function bakeFailed(Request $request, FoliageAsset $asset): JsonResponse
    {
        $data = $request->validate(['message' => ['required', 'string', 'max:1000']]);

        $asset->forceFill([
            'status' => 'failed',
            'status_message' => Str::limit('Optimising failed: '.$data['message'], 250),
        ])->save();

        return response()->json($asset->toStudioArray());
    }

    /**
     * @return array<string, mixed>
     */
    private function meta(mixed $raw): array
    {
        $raw = is_array($raw) ? $raw : [];
        $num = fn (string $key, float $min, float $max) => isset($raw[$key]) && is_numeric($raw[$key])
            ? round((float) min($max, max($min, (float) $raw[$key])), 3)
            : null;
        $list = fn (string $key, float $min, float $max, int $limit) => array_values(array_map(
            fn ($v) => round((float) min($max, max($min, (float) $v)), 3),
            array_slice(array_filter(is_array($raw[$key] ?? null) ? $raw[$key] : [], 'is_numeric'), 0, $limit),
        ));

        return array_filter([
            'height' => $num('height', 0.01, 200),
            'width' => $num('width', 0.01, 200),
            'triangles' => array_map('intval', $list('triangles', 0, 5_000_000, 6)),
            'source_triangles' => isset($raw['source_triangles']) && is_numeric($raw['source_triangles']) ? (int) $raw['source_triangles'] : null,
            'texture_size' => isset($raw['texture_size']) && is_numeric($raw['texture_size']) ? (int) $raw['texture_size'] : null,
            'lod_distances' => $list('lod_distances', 0, 1, 6),
            // Far LOD kind: octahedral impostor (older bakes: crossed cards, no key).
            'impostor' => ($raw['impostor'] ?? null) === 'octahedral' ? 'octahedral' : null,
            // Problems the bake worked around (e.g. an impostor left out after its alpha check).
            'warnings' => array_values(array_map(
                fn ($w) => Str::limit(trim($w), 300),
                array_slice(array_filter(is_array($raw['warnings'] ?? null) ? $raw['warnings'] : [], fn ($w) => is_string($w) && trim($w) !== ''), 0, 8),
            )),
        ], fn ($v) => $v !== null && $v !== []);
    }
}
