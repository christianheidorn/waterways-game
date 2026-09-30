<?php

namespace App\Mcp\Tools;

use App\Mcp\Assets\PropBudget;
use App\Mcp\ToolError;
use App\Models\FoliageAsset;
use App\Models\Material;
use App\Models\PropModel;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\Storage;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[Name('get_asset_status')]
#[Description('Status of an imported or generated asset: a prop model, foliage asset or material, by id. Statuses: queued / processing (generation running; poll again in 15–30 s), awaiting_bake (foliage: waiting to be optimised in a browser; call bake_foliage_asset), ready, failed (with the reason). Includes preview / file URLs when available.')]
#[IsReadOnly]
class GetAssetStatus extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        return [
            'type' => $schema->string()->enum(['prop_model', 'foliage_asset', 'material'])->required(),
            'id' => $schema->integer()->required(),
        ];
    }

    protected function run(Request $request): Response
    {
        $id = (int) $request->get('id');

        return $this->json(match ($request->get('type')) {
            'prop_model' => self::propSummary(PropModel::query()->find($id) ?? throw new ToolError("No prop model {$id}. See list_prop_models.")),
            'foliage_asset' => self::foliageSummary(FoliageAsset::query()->find($id) ?? throw new ToolError("No foliage asset {$id}.")),
            'material' => self::materialSummary(Material::query()->find($id) ?? throw new ToolError("No material {$id}. See list_materials.")),
            default => throw new ToolError('type must be prop_model, foliage_asset or material.'),
        });
    }

    /**
     * @return array<string, mixed>
     */
    public static function propSummary(PropModel $prop): array
    {
        $prop->measure();
        $warnings = PropBudget::warnings($prop);

        return [
            'type' => 'prop_model',
            'id' => $prop->id,
            'name' => $prop->name,
            'category' => $prop->category,
            'source' => $prop->source,
            'status' => $prop->status,
            'message' => $prop->status_message,
            'target_height_m' => $prop->target_height,
            'dimensions_m' => $prop->dimensions,
            // Per placed copy; each mesh is a draw call per copy and render pass.
            'triangles' => $prop->triangles,
            'meshes' => $prop->meshes,
            'materials' => $prop->materials,
            ...($warnings !== [] ? ['budget_warnings' => $warnings] : []),
            'tags' => $prop->tags ?? [],
            'model_url' => $prop->toGameArray()['model_url'],
            'thumbnail_url' => $prop->toGameArray()['thumbnail_url'],
            'file' => $prop->model_path ? Storage::disk('public')->path($prop->model_path) : null,
        ];
    }

    /**
     * @return array<string, mixed>
     */
    public static function foliageSummary(FoliageAsset $asset): array
    {
        $game = $asset->toGameArray();

        return [
            'type' => 'foliage_asset',
            'id' => $asset->id,
            'name' => $asset->name,
            'kind' => $asset->kind->value,
            'style' => $asset->style,
            'status' => $asset->status,
            'message' => $asset->status_message,
            'target_height_m' => $asset->target_height,
            'height_m' => $game['height'],
            'triangles_per_lod' => $game['triangles'],
            'model_url' => $game['model_url'],
            'thumbnail_url' => $game['thumbnail_url'],
            'used_by_foliage_types' => $asset->types()->pluck('id')->all(),
        ];
    }

    /**
     * @return array<string, mixed>
     */
    public static function materialSummary(Material $material): array
    {
        return [
            'type' => 'material',
            'id' => $material->id,
            'name' => $material->name,
            'category' => $material->category,
            'status' => $material->status,
            'message' => $material->status_message,
            'tile_size_m' => $material->tile_size,
            'thumbnail_url' => $material->toGameArray()['thumbnail_url'],
            'next' => $material->isReady() ? 'Assign it with update_terrain_layer material_id '.$material->id.'.' : null,
        ];
    }
}
