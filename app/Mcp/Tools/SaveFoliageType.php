<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\FoliageTypeController;
use App\Models\FoliageType;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\Validator;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;

#[Name('save_foliage_type')]
#[Description('Creates a foliage type, or updates one when `id` is given (pass only what changes). Fields: name, kind (conifer, broadleaf, palm, bush, grass, flower, reed, rock), color, color_secondary, tint, min_scale, max_scale, density (instances per 100 m² at full strength), min_slope, max_slope (degrees), min_height, max_height (m, null = no limit), align_to_normal, random_yaw, cast_shadows, cull_distance (m), allow_underwater, foliage_asset_id (a baked model). Applies live in open editors; ground cover regrows.')]
class SaveFoliageType extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        return [
            'id' => $schema->integer()->description('Type to update; omit to create.'),
            'values' => $schema->object()->required(),
        ];
    }

    protected function run(Request $request): Response
    {
        $id = $request->get('id');
        $type = $id !== null ? FoliageType::query()->find((int) $id) : null;

        if ($id !== null && $type === null) {
            return Response::error("No foliage type {$id}. See list_foliage_types.");
        }

        $values = (array) $request->get('values', []);
        $rules = FoliageTypeController::rules();
        $current = $type ? [...$type->only(array_keys($rules)), 'kind' => $type->kind->value] : [
            'color' => '#4f7a2a', 'color_secondary' => '#7a9a3a', 'min_scale' => 0.8, 'max_scale' => 1.2,
            'density' => 1, 'min_slope' => 0, 'max_slope' => 35, 'cull_distance' => 500,
            'align_to_normal' => false, 'random_yaw' => true, 'cast_shadows' => true, 'allow_underwater' => false,
        ];
        $data = Validator::make([...$current, ...$values], $rules)->validate();

        if ($type) {
            $type->update(array_intersect_key($data, $values));
        } else {
            $type = FoliageType::query()->create($data);
        }

        $this->bridge()->notifyAll('refresh', ['parts' => ['foliage_types']]);

        return $this->json($type->refresh()->load('asset')->toGameArray());
    }
}
