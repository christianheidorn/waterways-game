<?php

namespace App\Mcp\Tools;

use App\Enums\FoliageKind;
use App\Mcp\Assets\EditorBakes;
use App\Mcp\Assets\GltfInspector;
use App\Mcp\Assets\LoadedModel;
use App\Mcp\Assets\ModelSource;
use App\Mcp\ToolError;
use App\Models\FoliageAsset;
use App\Models\FoliageType;
use App\Models\PropModel;
use App\Services\Foliage\FoliageTypeDefaults;
use App\Services\Foliage\ModelUploads;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;
use RuntimeException;

#[Name('import_model')]
#[Description(<<<'TXT'
Imports a 3D model (glTF 2.0: .glb, or .gltf) into the project, as a prop (kind "prop": a placeable object such as a hut, bridge, fence or boulder; see place_props) or as a foliage asset (kind "foliage": a plant or rock model for foliage types).
Source: exactly one of `path` (a file on the user's computer, e.g. a .glb exported by Blender MCP to ~/Desktop/hut.glb), `url` (http/https download) or `base64` (small .glb files, ≤ 15 MB). Limit 100 MB. Props must be .glb; foliage also accepts .gltf with its .bin / textures next to it.
Props are ready right away (dimensions are measured from the file). Model tips: metres, +Y up, the pivot at the base; set target_height to the real-world height so the game scales it.
Foliage assets must be optimised ("baked": LODs, impostor) in a browser: when an editor is open this happens there automatically (the tool waits up to ~90 s), else the asset waits until the user opens the studio's Foliage page or an editor (then call bake_foliage_asset). create_type: true also creates a foliage type using the asset (edit it with save_foliage_type, add it to ground cover with update_terrain_layer).
TXT)]
class ImportModel extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        return [
            'kind' => $schema->string()->enum(['prop', 'foliage'])->description('"prop" (placeable object) or "foliage" (plant / rock model for foliage types).')->required(),
            'name' => $schema->string()->description('Library name (default: from the file name).'),
            'path' => $schema->string()->description('Absolute path of a .glb / .gltf file on this computer (~ is expanded).'),
            'url' => $schema->string()->description('http(s) URL of a .glb (or self-contained .gltf).'),
            'base64' => $schema->string()->description('The .glb file as base64 (≤ 15 MB).'),
            'file_name' => $schema->string()->description('With base64: the file name, e.g. "hut.glb" (default model.glb).'),
            'category' => $schema->string()->enum(array_keys(PropModel::CATEGORIES))->description('Props: library category (default "other").'),
            'foliage_kind' => $schema->string()->enum(array_column(FoliageKind::cases(), 'value'))->description('Foliage: plant kind (guessed from the name when omitted). Rocks and dead wood are "rock".'),
            'style' => $schema->string()->enum(array_keys(FoliageAsset::STYLES))->description('Foliage: realistic (default) or stylized.'),
            'target_height' => $schema->number()->min(0.02)->max(150)->description('Real-world height in metres; the game scales the model to it (default: the model\'s own size).'),
            'tags' => $schema->array()->items($schema->string())->description('Props: search tags.'),
            'create_type' => $schema->boolean()->description('Foliage: also create a foliage type that uses the asset (default false).'),
            'bake' => $schema->boolean()->description('Foliage: bake right away in an open editor (default true).'),
        ];
    }

    protected function run(Request $request): Response
    {
        $sources = app(ModelSource::class);

        try {
            $model = $sources->load([
                'path' => $request->get('path'),
                'url' => $request->get('url'),
                'base64' => $request->get('base64'),
                'file_name' => $request->get('file_name'),
            ]);

            return $request->get('kind') === 'foliage'
                ? $this->foliage($model, $request)
                : $this->prop($model, $request);
        } finally {
            $sources->cleanup();
        }
    }

    private function prop(LoadedModel $model, Request $request): Response
    {
        if ($model->extension !== 'glb') {
            throw new ToolError('Props must be binary glTF (.glb). In Blender: File → Export → glTF 2.0, format "glTF Binary (.glb)".');
        }

        $category = (string) ($request->get('category') ?? 'other');
        if (! array_key_exists($category, PropModel::CATEGORIES)) {
            throw new ToolError('Unknown category "'.$category.'". Use one of: '.implode(', ', array_keys(PropModel::CATEGORIES)).'.');
        }

        $height = $this->height($request);
        $dimensions = GltfInspector::dimensions($model->document);
        $prop = PropModel::query()->create([
            'name' => $this->assetName($request, $model),
            'category' => $category,
            'source' => $request->get('url') ? 'url' : 'upload',
            'status' => 'processing',
            'target_height' => $height,
            'dimensions' => $dimensions,
            'tags' => array_values(array_filter(array_map('strval', (array) $request->get('tags', [])))) ?: null,
        ]);

        $path = "props/{$prop->id}/model.glb";
        Storage::disk('public')->put($path, (string) file_get_contents($model->path));
        $prop->forceFill(['model_path' => $path, 'status' => 'ready'])->save();

        return $this->json([
            'prop_model' => GetAssetStatus::propSummary($prop),
            'note' => $dimensions === null ? 'The size of the model could not be measured from the file.' : null,
            'next' => 'Place it with place_props (prop_model_id '.$prop->id.').',
        ]);
    }

    private function foliage(LoadedModel $model, Request $request): Response
    {
        $kind = $request->get('foliage_kind');
        if ($kind !== null && FoliageKind::tryFrom((string) $kind) === null) {
            throw new ToolError('Unknown foliage_kind "'.$kind.'".');
        }

        $base = pathinfo($model->name, PATHINFO_FILENAME);
        $file = new UploadedFile($model->path, $base.'.'.$model->extension, null, null, true);

        try {
            $assets = app(ModelUploads::class)->ingest($file, [
                'name' => $this->assetName($request, $model),
                'kind' => $kind,
                'style' => $request->get('style'),
                'target_height' => $this->height($request),
            ]);
        } catch (RuntimeException $e) {
            throw new ToolError('Import failed: '.$e->getMessage());
        }

        $asset = $assets[0];
        // A single-model zip names the asset after the entry: keep the name the agent asked for.
        if ($request->get('name')) {
            $asset->forceFill(['name' => Str::limit((string) $request->get('name'), 80, '')])->save();
        }

        $type = null;
        if ($request->get('create_type')) {
            $type = FoliageType::query()->create([
                ...app(FoliageTypeDefaults::class)->forKind($asset->kind),
                'name' => Str::limit($asset->name, 60, ''),
                'foliage_asset_id' => $asset->id,
            ]);
        }

        $bakes = app(EditorBakes::class);
        $bake = null;
        $bakeError = null;
        if ($request->get('bake') !== false && $bakes->available()) {
            try {
                $bake = $bakes->bake($asset);
            } catch (ToolError $e) {
                $bakeError = $e->getMessage();
            }
            $asset->refresh();
        }

        if ($type !== null) {
            $this->bridge()->notifyAll('refresh', ['parts' => ['foliage_types']]);
        }

        return $this->json([
            'foliage_asset' => GetAssetStatus::foliageSummary($asset),
            'foliage_type' => $type ? ['id' => $type->id, 'name' => $type->name, 'kind' => $type->kind->value] : null,
            'bake_error' => $bakeError,
            'next' => match ($asset->status) {
                'ready' => $type ? "Foliage type {$type->id} uses the model; tune it with save_foliage_type and add it to a layer's ground cover (update_terrain_layer) or scatter it (edit_foliage)."
                    : 'Use it in a foliage type: save_foliage_type with foliage_asset_id '.$asset->id.'.',
                'failed' => 'Optimising failed: '.$asset->status_message,
                default => $bake !== null
                    ? 'Still optimising in the editor: poll get_asset_status (type foliage_asset, id '.$asset->id.').'
                    : 'Waiting to be optimised in a browser: ask the user to open an editor (any map) or the studio\'s Foliage page, then call bake_foliage_asset (asset_id '.$asset->id.') or poll get_asset_status.',
            },
        ]);
    }

    private function assetName(Request $request, LoadedModel $model): string
    {
        $name = trim((string) $request->get('name', ''));

        return Str::limit($name !== '' ? $name : Str::headline(pathinfo($model->name, PATHINFO_FILENAME)), 80, '') ?: 'Model';
    }

    private function height(Request $request): ?float
    {
        $height = $request->get('target_height');
        if ($height === null) {
            return null;
        }
        if (! is_numeric($height) || $height < 0.02 || $height > 150) {
            throw new ToolError('target_height must be between 0.02 and 150 metres.');
        }

        return (float) $height;
    }
}
