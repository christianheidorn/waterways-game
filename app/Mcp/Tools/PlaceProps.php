<?php

namespace App\Mcp\Tools;

use App\Mcp\Assets\PropBudget;
use App\Models\Map;
use App\Models\PropModel;
use App\Services\Terrain\TerrainStorage;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\Validator;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;

#[Name('place_props')]
#[Description('Places props (models from the prop library: huts, bridges, fences, rocks, …; see list_prop_models) on the terrain, live in the open editor (one undo step; saved unless save is false). Either exact `placements` (x, z in metres, rotation in degrees — 0 faces +Z, random when omitted — scale on the library size, offset in metres above/below the ground), or `scatter` `count` props of `models` inside a `shape`, kept apart (spacing from the model size unless given), off slopes steeper than max_slope and out of water. Props follow the terrain height, so sculpting afterwards keeps them grounded. Returns the new prop ids.')]
class PlaceProps extends WaterwaysTool
{
    use PropModelArguments;
    use ShapeArgument;

    public function schema(JsonSchema $schema): array
    {
        return [
            'map' => $this->mapArgument($schema),
            'placements' => $schema->array()->items($schema->object([
                'model' => $schema->string()->description('Prop model id or name.')->required(),
                'x' => $schema->number()->required(),
                'z' => $schema->number()->required(),
                'rotation' => $schema->number()->description('Degrees around the vertical axis (0 faces +Z).'),
                'scale' => $schema->number()->min(0.05)->max(20),
                'offset' => $schema->number()->min(-50)->max(50),
            ]))->description('Exact placements (up to 500).'),
            'shape' => $this->shapeSchema($schema)->description('scatter: the area to scatter in.'),
            'models' => $schema->array()->items($schema->string())->description('scatter: prop model ids or names to mix.'),
            'count' => $schema->integer()->min(1)->max(2000)->description('scatter: how many props to try to place.'),
            'spacing' => $schema->number()->min(0)->max(500)->description('scatter: minimum distance between props (m).'),
            'max_slope' => $schema->number()->min(0)->max(90)->description('scatter: steepest ground in degrees (default 25).'),
            'scale_min' => $schema->number()->min(0.05)->max(20),
            'scale_max' => $schema->number()->min(0.05)->max(20),
            'avoid_water' => $schema->boolean()->description('scatter: keep props out of water (default true).'),
            'seed' => $schema->integer(),
            'save' => $schema->boolean()->description('Save the map after the edit (default true).'),
        ];
    }

    protected function run(Request $request): Response
    {
        $input = $request->all();

        if (! empty($input['placements'])) {
            $data = Validator::make($input, [
                'placements' => ['required', 'array', 'max:500'],
                'placements.*.model' => ['required'],
                'placements.*.x' => ['required', 'numeric'],
                'placements.*.z' => ['required', 'numeric'],
                'placements.*.rotation' => ['sometimes', 'numeric'],
                'placements.*.scale' => ['sometimes', 'numeric', 'between:0.05,20'],
                'placements.*.offset' => ['sometimes', 'numeric', 'between:-50,50'],
            ])->validate();
            $models = $this->resolvePropModels(array_column($data['placements'], 'model'), 'placements');
            $placements = array_map(fn (array $p) => array_filter([
                'model' => $models[(string) $p['model']]->id,
                'x' => (float) $p['x'],
                'z' => (float) $p['z'],
                'rotation' => isset($p['rotation']) ? (float) $p['rotation'] : null,
                'scale' => isset($p['scale']) ? (float) $p['scale'] : null,
                'offset' => isset($p['offset']) ? (float) $p['offset'] : null,
            ], fn ($v) => $v !== null), $data['placements']);

            $map = $this->map($request);

            return $this->worldEdit($map, $request, 'place_props', [
                'kind' => 'props',
                'action' => 'place',
                'placements' => $placements,
                'prop_models' => $this->propModelRefs($models),
            ], fn () => $this->budgetNotes($map, $request, $models, array_count_values(array_column($placements, 'model'))));
        }

        $shape = $this->validatedShape($input);
        $data = Validator::make($input, [
            'models' => ['required', 'array', 'min:1', 'max:20'],
            'models.*' => ['required'],
            'count' => ['required', 'integer', 'between:1,2000'],
            'spacing' => ['sometimes', 'numeric', 'between:0,500'],
            'max_slope' => ['sometimes', 'numeric', 'between:0,90'],
            'scale_min' => ['sometimes', 'numeric', 'between:0.05,20'],
            'scale_max' => ['sometimes', 'numeric', 'between:0.05,20'],
            'avoid_water' => ['sometimes', 'boolean'],
            'seed' => ['sometimes', 'integer'],
        ], [
            'models.required' => 'Give either placements, or a shape with models and count to scatter.',
        ])->validate();
        $models = $this->resolvePropModels($data['models']);
        $map = $this->map($request);
        $ids = array_values(array_unique(array_map(fn ($m) => $m->id, $models)));
        // Scattered copies are spread over the models.
        $share = (int) ceil($data['count'] / max(1, count($ids)));

        return $this->worldEdit($map, $request, 'place_props scatter', [
            'kind' => 'props',
            'action' => 'scatter',
            'shape' => $shape,
            'prop_models' => $this->propModelRefs($models),
            'params' => array_filter([
                'models' => array_values(array_unique(array_map(fn ($m) => $m->id, $models))),
                'count' => (int) $data['count'],
                'spacing' => isset($data['spacing']) ? (float) $data['spacing'] : null,
                'max_slope' => isset($data['max_slope']) ? (float) $data['max_slope'] : null,
                'scale_min' => isset($data['scale_min']) ? (float) $data['scale_min'] : null,
                'scale_max' => isset($data['scale_max']) ? (float) $data['scale_max'] : null,
                'avoid_water' => isset($data['avoid_water']) ? (bool) $data['avoid_water'] : null,
                'seed' => $data['seed'] ?? null,
            ], fn ($v) => $v !== null),
        ], fn () => $this->budgetNotes($map, $request, $models, array_fill_keys($ids, $share)));
    }

    /**
     * Performance warnings for the models just placed: over-budget models, and many copies of heavy or
     * vegetation models (from the saved props when the edit was saved, else the requested counts).
     *
     * @param  array<int, PropModel>  $models
     * @param  array<int, int>  $placed  copies requested per model id
     * @return array<string, mixed>
     */
    private function budgetNotes(Map $map, Request $request, array $models, array $placed): array
    {
        $totals = $placed;
        if ($request->get('save') !== false) {
            $file = json_decode((string) app(TerrainStorage::class)->read($map, 'props'), true);
            $saved = collect(is_array($file) && is_array($file['props'] ?? null) ? $file['props'] : [])->countBy('model')->all();
            $totals = array_intersect_key($saved, $placed) + $placed;
        }

        $warnings = [];
        foreach (collect($models)->unique('id') as $model) {
            $model->measure();
            $warning = PropBudget::placementWarning($model, (int) ($totals[$model->id] ?? 0));
            if ($warning !== null) {
                $warnings[] = $warning;
            }
        }

        return $warnings !== [] ? ['performance_warnings' => $warnings] : [];
    }
}
