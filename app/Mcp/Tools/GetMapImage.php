<?php

namespace App\Mcp\Tools;

use App\Mcp\MapImageRenderer;
use App\Mcp\TerrainData;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\Validator;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\ResponseFactory;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[Name('get_map_image')]
#[Description('A top-down image of a map (north up) with a labelled world-coordinate grid in metres and the player start: the best way to plan where to build and to read coordinates for shapes. kind: "map" (terrain coloured by layer, hill shading, water, contour lines), "height" (elevation colours + contours), "slope", "layers" (one distinct colour per layer slot + legend) or "water". `area` crops to a rectangle to zoom in. Rendered from the SAVED map (world-edit tools save by default); works without an open editor.')]
#[IsReadOnly]
class GetMapImage extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        $point = fn () => $schema->object(['x' => $schema->number()->required(), 'z' => $schema->number()->required()]);

        return [
            'map' => $this->mapArgument($schema),
            'kind' => $schema->string()->enum(MapImageRenderer::KINDS)->description('Default map.'),
            'area' => $schema->object(['min' => $point()->required(), 'max' => $point()->required()])->description('Crop (world metres): min = north-west corner, max = south-east corner. Default: the whole map.'),
            'size' => $schema->integer()->min(256)->max(1536)->description('Longest side in pixels (default 900).'),
        ];
    }

    protected function run(Request $request): Response|ResponseFactory
    {
        $data = Validator::make($request->all(), [
            'kind' => ['sometimes', 'in:'.implode(',', MapImageRenderer::KINDS)],
            'area' => ['sometimes', 'array'],
            'area.min.x' => ['required_with:area', 'numeric'],
            'area.min.z' => ['required_with:area', 'numeric'],
            'area.max.x' => ['required_with:area', 'numeric', 'gt:area.min.x'],
            'area.max.z' => ['required_with:area', 'numeric', 'gt:area.min.z'],
            'size' => ['sometimes', 'integer', 'between:256,1536'],
        ])->validate();

        if (! function_exists('imagecreatetruecolor')) {
            return Response::error('Map images need the PHP GD extension (with JPEG support), which is not installed.');
        }

        $map = $this->map($request);
        $render = app(MapImageRenderer::class)->render(
            TerrainData::load($map),
            $data['kind'] ?? 'map',
            $data['area'] ?? null,
            (int) ($data['size'] ?? 900),
        );
        $unsaved = $this->bridge()->session($map)?->state['unsaved'] ?? [];

        return Response::make([
            Response::image($render['image'], $render['mime']),
            Response::text(json_encode([
                'map' => $map->slug,
                ...$render['meta'],
                'warning' => $unsaved ? 'The open editor has unsaved changes ('.implode(', ', $unsaved).') that this image does not show.' : null,
            ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)),
        ]);
    }
}
