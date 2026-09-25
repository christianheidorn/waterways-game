<?php

namespace App\Http\Controllers\Api;

use App\Enums\TerrainStatus;
use App\Http\Controllers\Controller;
use App\Models\Map;
use App\Services\Terrain\TerrainStorage;
use App\Support\GameManifest;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Storage;
use RuntimeException;

/**
 * Data endpoints used by the game running in the iframe.
 */
class MapDataController extends Controller
{
    private const ASSETS = ['heightmap', 'water', 'splatmap', 'foliage'];

    public function __construct(private readonly TerrainStorage $storage) {}

    public function manifest(Map $map, GameManifest $manifest): JsonResponse
    {
        $map->load('layers');

        return response()->json($manifest->build($map))->header('Cache-Control', 'no-store');
    }

    public function status(Map $map): JsonResponse
    {
        return response()->json([
            'status' => $map->terrain_status->value,
            'progress' => $map->terrain_progress,
            'message' => $map->terrain_message,
            'revision' => $map->revision,
        ]);
    }

    public function show(Map $map, string $asset): Response
    {
        abort_unless(in_array($asset, self::ASSETS, true), 404);

        $contents = $this->storage->read($map, $asset);
        abort_if($contents === null, 404);

        return response($contents, 200, [
            'Content-Type' => $asset === 'foliage' ? 'application/json' : 'application/octet-stream',
            'Cache-Control' => 'private, max-age=31536000, immutable',
        ]);
    }

    public function update(Request $request, Map $map, string $asset): JsonResponse
    {
        abort_unless(in_array($asset, self::ASSETS, true), 404);
        abort_if($map->terrain_status !== TerrainStatus::Ready, 409, 'Terrain is still being generated.');

        $contents = $request->getContent();

        if ($request->header('X-Payload-Encoding') === 'gzip') {
            $decoded = @gzdecode($contents);
            abort_if($decoded === false, 422, 'Invalid gzip payload.');
            $contents = $decoded;
        }

        if ($asset === 'foliage') {
            $json = json_decode($contents, true);
            abort_unless(is_array($json) && is_array($json['instances'] ?? null), 422, 'Invalid foliage payload.');
        }

        try {
            $this->storage->write($map, $asset, $contents);
        } catch (RuntimeException $e) {
            abort(422, $e->getMessage());
        }

        $attributes = ['revision' => $map->revision + 1];

        if ($asset === 'heightmap') {
            $min = $request->header('X-Min-Height');
            $max = $request->header('X-Max-Height');

            if (is_numeric($min) && is_numeric($max)) {
                $attributes['min_height'] = (float) $min;
                $attributes['max_height'] = (float) $max;
            }
        }

        $map->update($attributes);

        return response()->json(['revision' => $map->revision]);
    }

    public function updateMeta(Request $request, Map $map): JsonResponse
    {
        $data = $request->validate([
            'spawn' => ['sometimes', 'nullable', 'array'],
            'spawn.x' => ['required_with:spawn', 'numeric'],
            'spawn.z' => ['required_with:spawn', 'numeric'],
            'spawn.yaw' => ['sometimes', 'numeric'],
        ]);

        if (array_key_exists('spawn', $data)) {
            $map->update([
                'spawn_x' => $data['spawn']['x'] ?? null,
                'spawn_z' => $data['spawn']['z'] ?? null,
                'spawn_yaw' => $data['spawn']['yaw'] ?? 0,
            ]);
        }

        return response()->json(['map' => GameManifest::mapInfo($map)]);
    }

    public function storeThumbnail(Request $request, Map $map): JsonResponse
    {
        $data = $request->validate([
            'image' => ['required', 'string', 'starts_with:data:image/jpeg;base64,', 'max:4000000'],
        ]);

        $binary = base64_decode(substr($data['image'], strlen('data:image/jpeg;base64,')), true);
        abort_if($binary === false, 422, 'Invalid image.');

        Storage::disk('public')->put($map->thumbnailPath(), $binary);

        return response()->json(['url' => $map->thumbnailUrl()]);
    }
}
