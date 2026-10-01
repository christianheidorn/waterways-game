<?php

namespace App\Mcp\Tools;

use App\Support\EnvironmentDefaults;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\Validator;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;

#[Name('update_environment')]
#[Description('Changes a map\'s environment: weather, time of day, sun, clouds and their shadows, fog and light shafts in fog, wind and travelling gusts, rain puddles and footprints in snow, water look (shoreline foam and its breakup, river flow, caustics on shallow beds), sea level, … Pass only the fields to change in `values` (see get_settings group "environment" for every field and its range). Applies live in an open editor.')]
class UpdateEnvironment extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        return [
            'map' => $this->mapArgument($schema),
            'values' => $schema->object()->description('Field → new value, e.g. {"time_of_day": 18.5, "weather": "rain"}.')->required(),
        ];
    }

    protected function run(Request $request): Response
    {
        $map = $this->map($request);
        $group = EnvironmentDefaults::group();
        $values = (array) $request->get('values', []);
        $unknown = array_diff(array_keys($values), array_keys($group->defaults()));

        if ($unknown !== []) {
            return Response::error('Unknown environment fields: '.implode(', ', $unknown).'. See get_settings group "environment".');
        }

        $data = Validator::make($values, $group->rules())->validate();
        $this->snapshots()->autoBefore($map, 'update_environment');
        $map->update(['environment' => $group->merge([...$map->resolvedEnvironment(), ...$data])]);
        $live = $this->bridge()->notify($map, 'refresh', ['parts' => ['environment']]);

        return $this->json(['changed' => array_intersect_key($map->resolvedEnvironment(), $data), 'live' => $live]);
    }
}
