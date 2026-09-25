<?php

namespace App\Support;

/**
 * Global game configuration groups (player, graphics, editor) with defaults and constraints.
 */
final class GameSettingsSchema
{
    /**
     * @return array<string, SettingGroup>
     */
    public static function groups(): array
    {
        return [
            'player' => new SettingGroup('player', 'Player', 'Character movement, physics and camera.', [
                SettingField::number('walk_speed', 'Walk speed', 3.2, 0.5, 20, 0.1, 'm/s'),
                SettingField::number('run_speed', 'Run speed', 7.5, 1, 40, 0.1, 'm/s'),
                SettingField::number('swim_speed', 'Swim speed', 2.4, 0.5, 15, 0.1, 'm/s'),
                SettingField::number('jump_velocity', 'Jump velocity', 5.2, 0, 30, 0.1, 'm/s'),
                SettingField::number('gravity', 'Gravity', 18, 1, 60, 0.1, 'm/s²'),
                SettingField::number('character_height', 'Character height', 1.8, 0.5, 4, 0.01, 'm'),
                SettingField::number('max_slope', 'Max walkable slope', 50, 10, 89, 1, '°'),
                SettingField::number('camera_distance', 'Camera distance', 5.5, 1, 30, 0.1, 'm'),
                SettingField::number('camera_height', 'Camera height', 1.6, 0, 10, 0.05, 'm'),
                SettingField::number('fov', 'Field of view', 60, 30, 110, 1, '°'),
                SettingField::number('mouse_sensitivity', 'Mouse sensitivity', 1, 0.1, 5, 0.05),
                SettingField::boolean('invert_y', 'Invert Y axis', false),
                SettingField::color('character_color', 'Jacket colour', '#c2552d'),
                SettingField::text('character_model_url', 'Character model (GLB URL)', null, 'Optional rigged glTF/GLB. Clips named idle/walk/run/jump/swim are used when present.'),
            ]),
            'graphics' => new SettingGroup('graphics', 'Graphics', 'Rendering quality and view distances.', [
                SettingField::select('shadow_quality', 'Shadow quality', 'high', [
                    'off' => 'Off', 'low' => 'Low', 'medium' => 'Medium', 'high' => 'High', 'ultra' => 'Ultra',
                ]),
                SettingField::number('shadow_distance', 'Shadow distance', 220, 20, 1000, 10, 'm'),
                SettingField::number('render_scale', 'Render scale', 1, 0.5, 2, 0.05, '×', 'Multiplier on the device pixel ratio.'),
                SettingField::number('draw_distance', 'Draw distance', 12000, 500, 50000, 100, 'm'),
                SettingField::number('terrain_lod_bias', 'Terrain detail', 1, 0.25, 4, 0.05, '×', 'Higher values keep full terrain detail further away.'),
                SettingField::number('foliage_density', 'Foliage density', 1, 0, 1, 0.05, '×', 'Scales the number of rendered foliage instances.'),
                SettingField::number('foliage_distance', 'Foliage distance', 1, 0.25, 3, 0.05, '×', 'Scales every foliage type\'s cull distance.'),
                SettingField::select('water_quality', 'Water quality', 'medium', [
                    'low' => 'Low', 'medium' => 'Medium', 'high' => 'High',
                ], 'Resolution of the refraction/depth pass used by water.'),
                SettingField::boolean('antialias', 'Anti-aliasing (MSAA)', true),
                SettingField::boolean('bloom', 'Bloom', true),
                SettingField::boolean('ambient_occlusion', 'Ambient occlusion', false, 'Screen-space ambient occlusion (GTAO). Expensive.'),
            ]),
            'editor' => new SettingGroup('editor', 'Editor', 'In-game world editor behaviour.', [
                SettingField::number('autosave_minutes', 'Autosave interval', 0, 0, 60, 1, 'min', '0 disables autosave.'),
                SettingField::number('undo_steps', 'Undo steps', 50, 5, 200, 1),
                SettingField::number('fly_speed', 'Camera fly speed', 60, 5, 1000, 1, 'm/s'),
                SettingField::boolean('show_stats', 'Show performance stats', true),
            ]),
        ];
    }

    public static function group(string $key): ?SettingGroup
    {
        return self::groups()[$key] ?? null;
    }
}
