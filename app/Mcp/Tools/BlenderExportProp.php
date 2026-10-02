<?php

namespace App\Mcp\Tools;

use App\Enums\FoliageKind;
use App\Mcp\Blender\BlenderRunner;
use App\Mcp\ToolError;
use App\Models\FoliageAsset;
use App\Models\PropModel;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\ResponseFactory;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;

#[Name('blender_export_prop')]
#[Description(<<<'TXT'
Exports a blender_run job's model as a game-ready .glb and imports it into the project: kind "prop" (placeable object, see place_props) or "foliage" (rock / plant model for foliage types). The export joins the parts (one draw call per material), applies modifiers and transforms, puts the pivot at the base centre and writes metres with +Y up. Optional max_triangles decimates first; lods (e.g. [1, 0.4, 0.15]) writes <name>_LOD0.. levels for foliage (props draw one level).
The import is the same as import_model: name, category, target_height (real-world height in metres; default the model's own size), collision (auto / box / mesh for walk-in buildings / none), buoyancy (floating props), tags; for foliage foliage_kind, create_type, bake. Returns the prop model (id for place_props) or foliage asset, the export stats and budget warnings (props: 20k triangles, 8 materials).
TXT)]
class BlenderExportProp extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        return [
            'job_id' => $schema->string()->description('The blender_run job whose scene to export.')->required(),
            'name' => $schema->string()->description('Library name, e.g. "Fishing hut".')->required(),
            'kind' => $schema->string()->enum(['prop', 'foliage'])->description('"prop" (default) or "foliage".'),
            'category' => $schema->string()->enum(array_keys(PropModel::CATEGORIES))->description('Props: library category (default "other").'),
            'target_height' => $schema->number()->min(0.02)->max(150)->description('Real-world height in metres (default: the model\'s own height; modelled in metres it is already right).'),
            'collision' => $schema->string()->enum(PropModel::COLLISIONS)->description('Props: auto (default), box, mesh (walk-in buildings) or none.'),
            'buoyancy' => UpdatePropModel::buoyancySchema($schema),
            'tags' => $schema->array()->items($schema->string())->description('Props: search tags.'),
            'max_triangles' => $schema->integer()->min(50)->max(500000)->description('Decimate the model to about this many triangles before exporting.'),
            'lods' => $schema->array()->items($schema->number()->min(0.01)->max(1))->description('Foliage: LOD triangle shares, first 1, e.g. [1, 0.4, 0.15].'),
            'join' => $schema->boolean()->description('Join all parts into one mesh (default true).'),
            'foliage_kind' => $schema->string()->enum(array_column(FoliageKind::cases(), 'value'))->description('Foliage: plant kind (rocks: "rock").'),
            'style' => $schema->string()->enum(array_keys(FoliageAsset::STYLES))->description('Foliage: realistic (default) or stylized.'),
            'create_type' => $schema->boolean()->description('Foliage: also create a foliage type (default false).'),
            'bake' => $schema->boolean()->description('Foliage: bake in an open editor right away (default true).'),
        ];
    }

    protected function run(Request $request): Response|ResponseFactory
    {
        $runner = app(BlenderRunner::class);
        $scene = $runner->jobScene((string) $request->get('job_id', ''));
        $name = trim((string) $request->get('name', ''));
        if ($name === '') {
            throw new ToolError('Pass a name for the model.');
        }
        $kind = (string) ($request->get('kind') ?? 'prop');
        if (! in_array($kind, ['prop', 'foliage'], true)) {
            throw new ToolError('kind must be "prop" or "foliage".');
        }

        $lods = $this->lods($request->get('lods'));
        $warnings = [];
        if ($lods !== null && $kind === 'prop') {
            $warnings[] = 'Props draw one level of detail: lods were ignored. Keep props light instead (max_triangles).';
            $lods = null;
        }

        $max = $request->get('max_triangles');
        $script = 'path, info = wb.export_glb(wb.out("model.glb"), name='.json_encode($name, JSON_UNESCAPED_UNICODE)
            .', max_triangles='.($max !== null ? (int) $max : 'None')
            .', lods='.($lods !== null ? json_encode($lods) : 'None')
            .', join_parts='.($request->get('join') === false ? 'False' : 'True').")\n";
        $job = $runner->run($script, $scene, false);
        $glb = $job->path('model.glb');

        if (! $job->ok() || ! is_file($glb)) {
            return BlenderRun::respond($job, 'The export failed: fix the scene with blender_run continue_job and try again.');
        }

        $import = app(ImportModel::class)->handle(new Request(array_filter([
            'kind' => $kind,
            'path' => $glb,
            'name' => $name,
            'category' => $request->get('category'),
            'target_height' => $request->get('target_height'),
            'collision' => $request->get('collision'),
            'buoyancy' => $request->get('buoyancy'),
            'tags' => $request->get('tags'),
            'foliage_kind' => $request->get('foliage_kind'),
            'style' => $request->get('style'),
            'create_type' => $request->get('create_type'),
            'bake' => $request->get('bake'),
        ], fn ($value) => $value !== null)));

        if (! $import instanceof Response) {
            return $import;
        }
        if ($import->isError()) {
            return Response::error('The model was exported to '.$glb.' but the import failed: '.$import->content());
        }

        $imported = json_decode((string) $import->content(), true);
        $export = $job->stats() ?? [];

        return $this->json([
            ...(is_array($imported) ? $imported : ['import' => (string) $import->content()]),
            'export' => [
                'job_id' => $job->id,
                'glb' => $glb,
                'triangles' => $export['triangles'] ?? null,
                'materials' => $export['materials'] ?? null,
                'dimensions' => $export['dimensions'] ?? null,
                'lods' => $export['lods'] ?? null,
            ],
            ...($warnings !== [] ? ['export_warnings' => $warnings] : []),
        ]);
    }

    /** @return list<float>|null */
    private function lods(mixed $value): ?array
    {
        if ($value === null || $value === []) {
            return null;
        }
        if (! is_array($value) || count($value) > 5) {
            throw new ToolError('lods must be a list of up to 5 triangle shares, e.g. [1, 0.4, 0.15].');
        }
        $lods = [];
        foreach (array_values($value) as $share) {
            if (! is_numeric($share) || $share <= 0 || $share > 1) {
                throw new ToolError('Every lods share must be between 0 and 1.');
            }
            $lods[] = round((float) $share, 4);
        }
        $lods[0] = 1.0;

        return $lods;
    }
}
