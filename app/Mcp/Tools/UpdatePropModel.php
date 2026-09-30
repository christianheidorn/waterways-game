<?php

namespace App\Mcp\Tools;

use App\Models\PropModel;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Arr;
use Illuminate\Support\Facades\Validator;
use Illuminate\Validation\Rule;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;

#[Name('update_prop_model')]
#[Description('Edits a prop model of the library (pass only what changes): name, category, target_height (real-world height in m the game scales it to; null = the model\'s own size), tags, and collision: "auto" (a few boxes fitted to the model\'s surface, so doorways and arches stay open; the default), "box" (one box around it: cheapest, for solid objects), "mesh" (its exact triangles: walk-in buildings, bridges, stairs) or "none" (walked through). Applies live in open editors; placed copies follow.')]
class UpdatePropModel extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        return [
            'model' => $schema->string()->description('Prop model id or name (see list_prop_models).')->required(),
            'name' => $schema->string(),
            'category' => $schema->string()->enum(array_keys(PropModel::CATEGORIES)),
            'target_height' => $schema->number()->min(0.02)->max(150)->description('Metres; null = the model\'s own size.'),
            'tags' => $schema->array()->items($schema->string()),
            'collision' => $schema->string()->enum(PropModel::COLLISIONS),
        ];
    }

    protected function run(Request $request): Response
    {
        $ref = (string) $request->get('model', '');
        $prop = is_numeric($ref)
            ? PropModel::query()->find((int) $ref)
            : PropModel::query()->whereRaw('lower(name) = ?', [mb_strtolower($ref)])->first();

        if ($prop === null) {
            return Response::error("No prop model \"{$ref}\". See list_prop_models.");
        }

        $input = Arr::only($request->all(), ['name', 'category', 'target_height', 'tags', 'collision']);
        if ($input === []) {
            return Response::error('Nothing to change: pass name, category, target_height, tags or collision.');
        }

        $data = Validator::make($input, [
            'name' => ['sometimes', 'string', 'min:1', 'max:80'],
            'category' => ['sometimes', Rule::in(array_keys(PropModel::CATEGORIES))],
            'target_height' => ['sometimes', 'nullable', 'numeric', 'between:0.02,150'],
            'tags' => ['sometimes', 'nullable', 'array'],
            'tags.*' => ['string', 'max:40'],
            'collision' => ['sometimes', Rule::in(PropModel::COLLISIONS)],
        ])->validate();

        $prop->update($data);
        // Open editors pick up the new name, size and collision.
        $this->bridge()->notifyAll('refresh', ['parts' => ['prop_models']]);

        return $this->json(['prop_model' => GetAssetStatus::propSummary($prop->refresh())]);
    }
}
