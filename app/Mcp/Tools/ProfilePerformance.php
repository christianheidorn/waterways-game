<?php

namespace App\Mcp\Tools;

use App\Mcp\PerformanceFindings;
use App\Models\PropModel;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\Validator;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[Name('profile_performance')]
#[Description(<<<'TXT'
Measures rendering performance live in the open editor, from the current view or a camera placed like take_screenshot (the user's camera is put back). Takes about 5–20 s (the measurement itself at most 15 s).
Returns: frame stats (fps, CPU and GPU ms, draw calls, triangles, resolution / dynamic resolution scale), GPU time per render pass, a breakdown per system (terrain, water, foliage per type with instances and triangles per LOD, ground cover per layer, props per model with copies, triangles / meshes / materials per copy, shadows with cascades and casters), and the key output: `costs`, what each system costs, measured by switching props, placed foliage, ground cover, water and shadow map updates off for a few frames each (then everything is restored exactly). `findings` sums it up in plain words.
Use it after large placements (props, foliage, biomes) and whenever the editor feels slow. Costs smaller than `noise_ms` are measurement noise.
TXT)]
#[IsReadOnly]
class ProfilePerformance extends WaterwaysTool
{
    use CameraArguments;

    private const SYSTEMS = ['props', 'foliage', 'ground_cover', 'water', 'shadows'];

    public function schema(JsonSchema $schema): array
    {
        return [
            'map' => $this->mapArgument($schema),
            ...$this->cameraSchema($schema),
            'sample_frames' => $schema->integer()->min(10)->max(240)->description('Frames measured per state (baseline and each system off; default 40). More = steadier, slower; the whole run stays under ~20 s.'),
            'systems' => $schema->array()->items($schema->string()->enum(self::SYSTEMS))->description('Systems to measure by switching them off (default all: props, foliage, ground_cover, water, shadows).'),
            'keep_camera' => $schema->boolean()->description('Leave the user\'s view at the new camera (default false).'),
        ];
    }

    protected function run(Request $request): Response
    {
        $data = Validator::make($request->all(), [
            'sample_frames' => ['sometimes', 'integer', 'between:10,240'],
            'systems' => ['sometimes', 'array'],
            'systems.*' => ['string', 'in:'.implode(',', self::SYSTEMS)],
        ])->validate();

        $map = $this->map($request);
        $result = $this->bridge()->run($map, 'profile', array_filter([
            ...$this->cameraPayload($request),
            'sample_frames' => $data['sample_frames'] ?? null,
            'systems' => $data['systems'] ?? null,
            'keep_camera' => (bool) $request->get('keep_camera', false),
            'budget_ms' => 15000,
        ], fn ($v) => $v !== null), timeout: 90);

        $result = $this->withLibraryStats($result);

        return $this->json([
            'map' => $map->slug,
            'findings' => PerformanceFindings::analyse($result),
            ...$result,
        ]);
    }

    /**
     * Props whose objects were not loaded (or are drawn another way) get their triangles / meshes /
     * materials from the library, as measured on import.
     *
     * @param  array<string, mixed>  $result
     * @return array<string, mixed>
     */
    private function withLibraryStats(array $result): array
    {
        $models = $result['systems']['props']['models'] ?? null;
        if (! is_array($models) || $models === []) {
            return $result;
        }

        $library = PropModel::query()->whereIn('id', array_column($models, 'model_id'))->get()->keyBy('id');

        foreach ($models as $i => $m) {
            $model = $library[$m['model_id'] ?? 0] ?? null;
            if ($model === null) {
                continue;
            }
            $model->measure();
            foreach (['triangles_per_instance' => 'triangles', 'meshes_per_instance' => 'meshes', 'materials_per_instance' => 'materials'] as $key => $column) {
                $models[$i][$key] ??= $model->{$column};
            }
            if (($models[$i]['triangles_total'] ?? null) === null && $models[$i]['triangles_per_instance'] !== null) {
                $models[$i]['triangles_total'] = $models[$i]['triangles_per_instance'] * (int) ($m['instances'] ?? 0);
            }
        }

        $result['systems']['props']['models'] = $models;

        return $result;
    }
}
