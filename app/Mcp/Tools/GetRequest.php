<?php

namespace App\Mcp\Tools;

use App\Mcp\MapImageRenderer;
use App\Mcp\TerrainData;
use App\Mcp\ToolError;
use App\Models\AgentRequest;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\Storage;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\ResponseFactory;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[Name('get_request')]
#[Description('One build request in full: the note, the outlined area (a polygon in world metres, usable directly as a polygon shape for the world-editing tools, plus its bounds and centre), the user\'s camera, and images: the user\'s screenshot of the area, their reference images, a top-down map of the area with the outline drawn in magenta, and earlier result images. Mark it in_progress with update_request when you start.')]
#[IsReadOnly]
class GetRequest extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        return ['id' => $schema->integer()->required()];
    }

    protected function run(Request $request): Response|ResponseFactory
    {
        $agentRequest = AgentRequest::query()->with('map')->find((int) $request->get('id'))
            ?? throw new ToolError('No such request. See list_requests.');
        $bounds = $agentRequest->bounds();
        $disk = Storage::disk('public');
        $images = [];
        $captions = [];
        $add = function (?string $path, string $caption) use ($disk, &$images, &$captions) {
            if ($path !== null && $disk->exists($path)) {
                $images[] = Response::image($disk->get($path), $disk->mimeType($path) ?: 'image/jpeg');
                $captions[] = $caption;
            }
        };

        $add($agentRequest->screenshot_path, "the user's view when making the request (the outline is drawn on the terrain)");

        foreach ($agentRequest->reference_paths ?? [] as $i => $path) {
            $add($path, 'reference image '.($i + 1));
        }

        if (function_exists('imagecreatetruecolor')) {
            try {
                $pad = max(60, 0.4 * max($bounds['max']['x'] - $bounds['min']['x'], $bounds['max']['z'] - $bounds['min']['z']));
                $render = app(MapImageRenderer::class)->render(
                    TerrainData::load($agentRequest->map),
                    'map',
                    ['min' => ['x' => $bounds['min']['x'] - $pad, 'z' => $bounds['min']['z'] - $pad], 'max' => ['x' => $bounds['max']['x'] + $pad, 'z' => $bounds['max']['z'] + $pad]],
                    800,
                    $agentRequest->area,
                );
                $images[] = Response::image($render['image'], $render['mime']);
                $captions[] = 'top-down map of the area (outline in magenta, grid in metres, north up)';
            } catch (ToolError) {
                // No terrain saved yet: the other images still help.
            }
        }

        foreach ($agentRequest->result_paths ?? [] as $i => $path) {
            $add($path, 'earlier result image '.($i + 1));
        }

        return Response::make([
            Response::text(json_encode([
                'id' => $agentRequest->id,
                'map' => $agentRequest->map->slug,
                'status' => $agentRequest->status,
                'note' => $agentRequest->note,
                'area' => [
                    'shape' => ['type' => 'polygon', 'points' => $agentRequest->area],
                    ...$bounds,
                ],
                'camera' => $agentRequest->camera,
                'agent_message' => $agentRequest->agent_message,
                'images' => $captions,
                'created_at' => $agentRequest->created_at?->toIso8601String(),
            ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)),
            ...$images,
        ]);
    }
}
