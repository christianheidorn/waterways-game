<?php

namespace App\Mcp\Tools;

use App\Mcp\ToolError;
use App\Support\GameSettingsSchema;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\Validator;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;

#[Name('set_device_graphics')]
#[Description('The in-game graphics menu (F10), live in the open editor: graphics overrides for the device (browser) the editor runs on, layered over the project settings and stored in that browser. Without arguments it reports the current preset, scalability group levels, the overrides and every applied value. `preset` (low, medium, high, epic, cinematic), `groups` (scalability group → low / medium / high / epic: view_distance, anti_aliasing, post_processing, shadows, textures, effects, foliage, shading, resolution) and `settings` (single graphics fields, e.g. render_scale, max_pixel_ratio, dynamic_resolution, target_fps, max_fps, renderer_backend; see get_settings group "graphics") apply in that order; `reset: true` drops the overrides first. A renderer_backend change applies after a reload. To change the project defaults for everyone, use update_game_settings group "graphics".')]
class SetDeviceGraphics extends WaterwaysTool
{
    public const GROUPS = ['view_distance', 'anti_aliasing', 'post_processing', 'shadows', 'textures', 'effects', 'foliage', 'shading', 'resolution'];

    public function schema(JsonSchema $schema): array
    {
        return [
            'map' => $this->mapArgument($schema),
            'preset' => $schema->string()->enum(['low', 'medium', 'high', 'epic', 'cinematic']),
            'groups' => $schema->object()->description('Scalability group → level (low, medium, high, epic).'),
            'settings' => $schema->object()->description('Graphics field → value.'),
            'reset' => $schema->boolean()->description('Back to the project defaults (drops this device\'s overrides) before applying the rest.'),
        ];
    }

    protected function run(Request $request): Response
    {
        $data = $request->validate([
            'preset' => ['sometimes', 'in:low,medium,high,epic,cinematic'],
            'groups' => ['sometimes', 'array'],
            'groups.*' => ['in:low,medium,high,epic'],
            'settings' => ['sometimes', 'array'],
            'reset' => ['sometimes', 'boolean'],
        ]);
        $unknownGroups = array_diff(array_keys($data['groups'] ?? []), self::GROUPS);

        if ($unknownGroups !== []) {
            throw new ToolError('Unknown scalability groups: '.implode(', ', $unknownGroups).'. Groups: '.implode(', ', self::GROUPS).'.');
        }

        $settings = (array) ($data['settings'] ?? []);

        if ($settings !== []) {
            $group = GameSettingsSchema::group('graphics');
            $unknown = array_diff(array_keys($settings), array_keys($group->defaults()));

            if ($unknown !== []) {
                throw new ToolError('Unknown graphics fields: '.implode(', ', $unknown).'. See get_settings group "graphics".');
            }

            $settings = Validator::make($settings, $group->rules())->validate();
        }

        $map = $this->map($request);
        $change = array_filter([
            'preset' => $data['preset'] ?? null,
            'groups' => isset($data['groups']) ? (object) $data['groups'] : null,
            'settings' => $settings !== [] ? (object) $settings : null,
            'reset' => ($data['reset'] ?? false) ?: null,
        ], fn ($v) => $v !== null);

        $result = $this->bridge()->run($map, 'graphics', $change === [] ? ['read' => true] : $change, timeout: 30);

        return $this->json(['map' => $map->slug, 'changed' => $change !== [], ...$result]);
    }
}
