<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Material;
use App\Services\Materials\Sources\AmbientCgSource;
use App\Services\Materials\Sources\PolyHavenSource;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Throwable;

/**
 * JSON endpoints for the material library UI (source browsing, polling processing materials).
 */
class MaterialApiController extends Controller
{
    public function browse(Request $request, string $source, PolyHavenSource $polyHaven, AmbientCgSource $ambientCg): JsonResponse
    {
        abort_unless(in_array($source, ['polyhaven', 'ambientcg'], true), 404);

        $data = $request->validate([
            'q' => ['nullable', 'string', 'max:100'],
            'category' => ['nullable', 'string', 'max:50'],
            'page' => ['nullable', 'integer', 'min:1', 'max:500'],
        ]);

        try {
            $result = ($source === 'polyhaven' ? $polyHaven : $ambientCg)
                ->search($data['q'] ?? null, $data['category'] ?? null, (int) ($data['page'] ?? 1));
        } catch (Throwable $e) {
            report($e);

            return response()->json(['message' => 'Could not reach '.($source === 'polyhaven' ? 'Poly Haven' : 'ambientCG').': '.$e->getMessage()], 502);
        }

        return response()->json($result);
    }

    public function show(Material $material): JsonResponse
    {
        $material->loadCount('layers');

        return response()->json($material->toStudioArray());
    }
}
