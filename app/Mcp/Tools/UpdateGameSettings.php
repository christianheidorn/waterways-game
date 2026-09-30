<?php

namespace App\Mcp\Tools;

use App\Support\GameSettingsRepository;
use App\Support\GameSettingsSchema;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\Validator;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;

#[Name('update_game_settings')]
#[Description('Changes global game settings of one group: "player" (movement, camera), "graphics" (quality preset, draw distance, shadows, foliage distance / density, post effects, …) or "editor". Pass only the fields to change (see get_settings). Applies live in open editors. Note players can override graphics per device (F10).')]
class UpdateGameSettings extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        return [
            'group' => $schema->string()->enum(array_keys(GameSettingsSchema::groups()))->required(),
            'values' => $schema->object()->description('Field → new value.')->required(),
        ];
    }

    protected function run(Request $request): Response
    {
        $key = (string) $request->get('group');
        $group = GameSettingsSchema::group($key);

        if ($group === null) {
            return Response::error("Unknown settings group \"{$key}\".");
        }

        $values = (array) $request->get('values', []);
        $unknown = array_diff(array_keys($values), array_keys($group->defaults()));

        if ($unknown !== []) {
            return Response::error('Unknown fields: '.implode(', ', $unknown).". See get_settings group \"{$key}\".");
        }

        $data = Validator::make($values, $group->rules())->validate();
        $saved = app(GameSettingsRepository::class)->update($key, $data);
        $this->bridge()->notifyAll('refresh', ['parts' => ['settings']]);

        return $this->json(['changed' => array_intersect_key($saved, $data)]);
    }
}
