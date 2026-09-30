<?php

namespace App\Mcp\Tools;

use App\Support\EnvironmentDefaults;
use App\Support\GameSettingsRepository;
use App\Support\GameSettingsSchema;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[Name('get_settings')]
#[Description('Setting fields (type, range, options, description) and current values of one settings group: "environment" (per map: weather, time of day, sun, fog, clouds, wind, water look, …) or the global "player", "graphics" and "editor" groups. Use before update_environment / update_game_settings.')]
#[IsReadOnly]
class GetSettings extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        return [
            'group' => $schema->string()->enum(['environment', ...array_keys(GameSettingsSchema::groups())])->required(),
            'map' => $this->mapArgument($schema)->description('For "environment": map slug or id (defaults to the open / default map).'),
        ];
    }

    protected function run(Request $request): Response
    {
        $group = $request->get('group');

        if ($group === 'environment') {
            $map = $this->map($request);

            return $this->json([
                'map' => $map->slug,
                'fields' => EnvironmentDefaults::group()->toArray()['fields'],
                'values' => $map->resolvedEnvironment(),
            ]);
        }

        $schema = GameSettingsSchema::group((string) $group);

        return $schema === null
            ? Response::error("Unknown settings group \"{$group}\".")
            : $this->json([
                'fields' => $schema->toArray()['fields'],
                'values' => app(GameSettingsRepository::class)->get((string) $group),
            ]);
    }
}
