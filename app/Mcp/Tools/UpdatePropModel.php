<?php

namespace App\Mcp\Tools;

use App\Mcp\ToolError;
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
#[Description('Edits a prop model of the library (pass only what changes): name, category, target_height (real-world height in m the game scales it to; null = the model\'s own size), tags, collision: "auto" (a few boxes fitted to the model\'s surface, so doorways and arches stay open; the default), "box" (one box around it: cheapest, for solid objects), "mesh" (its exact triangles: walk-in buildings, bridges, stairs) or "none" (walked through), and buoyancy: {mode: "float", density, drift} makes copies placed in water float — they bob and tilt on the waves, push ripples, can be pushed by the player and, with drift "return" / "stay", drift with currents and wind while playing (saved positions stay the anchor); {mode: "none"} sinks them again. Applies live in open editors; placed copies follow.')]
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
            'buoyancy' => self::buoyancySchema($schema),
        ];
    }

    /** The `buoyancy` argument (shared with import_model). */
    public static function buoyancySchema(JsonSchema $schema): mixed
    {
        return $schema->object([
            'mode' => $schema->string()->enum(PropModel::BUOYANCY_MODES)->description('"float" floats on water, "none" stands on the ground / bed (default float).'),
            'density' => $schema->number()->min(0.05)->max(0.95)->description('Share of its height under water: 0.1 floats high (a leaf, an empty boat), 0.5 half (a log; default), 0.9 barely above the surface.'),
            'drift' => $schema->string()->enum(PropModel::BUOYANCY_DRIFTS)->description('"none" bobs in place (default), "return" drifts with currents, wind and pushes while playing and is back at its saved spot afterwards, "stay" drifts and stays where it ended up (until the map is reloaded).'),
        ])->description('Props: float on water (bob and tilt on the waves, drift).');
    }

    /**
     * Checks a `buoyancy` argument and merges it over the current setting.
     *
     * @param  array<string, mixed>|null  $current
     * @return array{mode: string, density: float, drift: string}|null
     */
    public static function buoyancyFromArgument(mixed $value, ?array $current = null): ?array
    {
        if (is_string($value)) {
            $value = ['mode' => $value];
        }

        if (! is_array($value)) {
            throw new ToolError('buoyancy must be an object: {mode: "float" | "none", density: 0.05-0.95, drift: "none" | "return" | "stay"}.');
        }

        if (isset($value['mode']) && ! in_array($value['mode'], PropModel::BUOYANCY_MODES, true)) {
            throw new ToolError('Unknown buoyancy mode "'.$value['mode'].'". Use float or none.');
        }

        if (isset($value['drift']) && ! in_array($value['drift'], PropModel::BUOYANCY_DRIFTS, true)) {
            throw new ToolError('Unknown buoyancy drift "'.$value['drift'].'". Use none, return or stay.');
        }

        if (isset($value['density']) && (! is_numeric($value['density']) || $value['density'] < 0.05 || $value['density'] > 0.95)) {
            throw new ToolError('buoyancy density must be between 0.05 and 0.95 (share of the height under water).');
        }

        return PropModel::normalizeBuoyancy($value, $current);
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
        $buoyancy = $request->get('buoyancy');
        if ($input === [] && $buoyancy === null) {
            return Response::error('Nothing to change: pass name, category, target_height, tags, collision or buoyancy.');
        }

        $data = Validator::make($input, [
            'name' => ['sometimes', 'string', 'min:1', 'max:80'],
            'category' => ['sometimes', Rule::in(array_keys(PropModel::CATEGORIES))],
            'target_height' => ['sometimes', 'nullable', 'numeric', 'between:0.02,150'],
            'tags' => ['sometimes', 'nullable', 'array'],
            'tags.*' => ['string', 'max:40'],
            'collision' => ['sometimes', Rule::in(PropModel::COLLISIONS)],
        ])->validate();

        if ($buoyancy !== null) {
            $data['buoyancy'] = self::buoyancyFromArgument($buoyancy, $prop->buoyancy);
        }

        $prop->update($data);
        // Open editors pick up the new name, size and collision.
        $this->bridge()->notifyAll('refresh', ['parts' => ['prop_models']]);

        return $this->json(['prop_model' => GetAssetStatus::propSummary($prop->refresh())]);
    }
}
