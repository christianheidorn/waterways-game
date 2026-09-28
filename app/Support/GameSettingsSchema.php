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
            'graphics' => new SettingGroup('graphics', 'Graphics', 'Rendering quality, scalability presets and view distances. Players can override these per device from the in-game graphics menu (F10).', [
                SettingField::select('quality_preset', 'Quality preset', 'high', [
                    'low' => 'Low', 'medium' => 'Medium', 'high' => 'High', 'epic' => 'Epic', 'cinematic' => 'Cinematic', 'custom' => 'Custom',
                ], 'Unreal-style scalability preset. Picking one fills every quality field; editing a field switches to Custom.'),
                // View distance
                SettingField::number('draw_distance', 'Draw distance', 12000, 500, 50000, 100, 'm'),
                SettingField::number('terrain_lod_bias', 'Terrain detail', 1, 0.25, 4, 0.05, '×', 'Higher values keep full terrain detail further away.'),
                // Anti-aliasing
                SettingField::select('anti_aliasing', 'Anti-aliasing', 'taa', [
                    'off' => 'Off', 'fxaa' => 'FXAA (fastest)', 'smaa' => 'SMAA (sharp)', 'msaa' => 'MSAA 4× (geometry edges)', 'taa' => 'TAA (temporal, best)',
                ], 'TAA accumulates samples over frames and removes foliage shimmer; FXAA/SMAA are cheaper filters; MSAA only smooths geometry edges and disables depth-based effects.'),
                SettingField::boolean('antialias', 'Anti-aliasing (legacy MSAA switch)', false, 'Kept for older clients; the game uses "Anti-aliasing" above.'),
                // Post-processing
                SettingField::boolean('bloom', 'Bloom', true),
                SettingField::number('bloom_intensity', 'Bloom intensity', 0.12, 0, 1.5, 0.01, null, 'Strength of the glow around bright areas (sun, sky, specular highlights).'),
                SettingField::boolean('ambient_occlusion', 'Ambient occlusion', false, 'Screen-space ambient occlusion (GTAO). Expensive.'),
                SettingField::select('ao_quality', 'Ambient occlusion quality', 'medium', [
                    'low' => 'Low (half resolution)', 'medium' => 'Medium', 'high' => 'High',
                ], 'Sample count, radius and denoising of GTAO.'),
                SettingField::number('saturation', 'Saturation', 1, 0.5, 1.5, 0.01, '×', 'Colour grading: 1 is neutral.'),
                SettingField::number('contrast', 'Contrast', 1, 0.5, 1.5, 0.01, '×', 'Colour grading: 1 is neutral.'),
                SettingField::number('vignette', 'Vignette', 0, 0, 1, 0.01, null, 'Darkens the screen corners.'),
                // Cinematic post-processing (the artistic amounts are per map: Environment → Camera & look)
                SettingField::boolean('auto_exposure', 'Auto exposure', true, 'Eye adaptation: the image brightens in dark valleys and darkens against a bright sky.'),
                SettingField::boolean('color_grading_lut', 'Colour grading (LUT)', true, 'Applies the map\'s colour grade (film looks). Almost free.'),
                SettingField::select('god_rays', 'Light shafts', 'medium', [
                    'off' => 'Off', 'low' => 'Low', 'medium' => 'Medium', 'high' => 'High',
                ], 'Volumetric sun rays through trees, terrain and fog.'),
                SettingField::select('depth_of_field', 'Depth of field', 'off', [
                    'off' => 'Off', 'low' => 'Low (gameplay)', 'high' => 'High (cinematic bokeh)',
                ], 'Blurs what is out of focus. Focus and aperture are set per map or in photo mode.'),
                SettingField::select('motion_blur', 'Motion blur', 'off', [
                    'off' => 'Off', 'low' => 'Low', 'high' => 'High',
                ]),
                SettingField::select('ssr', 'Screen-space reflections', 'off', [
                    'off' => 'Off', 'low' => 'Low', 'high' => 'High',
                ], 'Reflections on wet ground and glossy surfaces (water has its own reflections).'),
                SettingField::boolean('lens_effects', 'Lens effects', false, 'Lens flare, chromatic aberration and film grain.'),
                SettingField::boolean('contact_shadows', 'Contact shadows', false, 'Small screen-space shadows where objects touch the ground.'),
                // Shadows
                SettingField::select('shadow_quality', 'Shadow quality', 'high', [
                    'off' => 'Off', 'low' => 'Low', 'medium' => 'Medium', 'high' => 'High', 'ultra' => 'Ultra',
                ]),
                SettingField::number('shadow_distance', 'Shadow distance', 220, 20, 1000, 10, 'm'),
                // Textures
                SettingField::select('terrain_texture_resolution', 'Terrain texture resolution', '1024', [
                    '512' => '512 px', '1024' => '1K', '2048' => '2K',
                ], 'Resolution of material textures on the terrain (GPU memory grows 4× per step).'),
                SettingField::number('anisotropy', 'Anisotropic filtering', 8, 1, 16, 1, '×', 'Keeps textures sharp at grazing angles. Clamped to what the GPU supports.'),
                // Effects & weather
                SettingField::select('effects_quality', 'Effects quality', 'high', [
                    'low' => 'Low', 'medium' => 'Medium', 'high' => 'High', 'epic' => 'Epic',
                ], 'Weather particles (rain, snow), splashes and lightning.'),
                SettingField::select('cloud_quality', 'Cloud quality', 'medium', [
                    'off' => 'Off', 'low' => 'Low', 'medium' => 'Medium', 'high' => 'High',
                ]),
                SettingField::select('water_quality', 'Water quality', 'medium', [
                    'low' => 'Low', 'medium' => 'Medium', 'high' => 'High',
                ], 'Resolution of the refraction/depth pass and planar reflections used by water.'),
                // Foliage
                SettingField::number('foliage_density', 'Foliage density', 1, 0, 1, 0.05, '×', 'Scales the number of rendered foliage instances.'),
                SettingField::number('foliage_distance', 'Foliage distance', 1, 0.25, 3, 0.05, '×', 'Scales every foliage type\'s cull distance.'),
                SettingField::number('foliage_shadow_distance', 'Foliage shadow distance', 120, 0, 1000, 10, 'm', 'Foliage beyond this distance casts no shadows. 0 disables foliage shadows.'),
                SettingField::number('foliage_lod_bias', 'Foliage detail', 1, 0.25, 4, 0.05, '×', 'Higher values keep detailed foliage LODs further away.'),
                // Resolution & frame rate
                SettingField::number('render_scale', 'Render scale', 1, 0.5, 2, 0.05, '×', 'Multiplier on the device pixel ratio.'),
                SettingField::number('sharpen', 'Sharpen', 0, 0, 1, 0.01, null, 'Contrast-adaptive sharpening; useful with a render scale below 1.'),
                SettingField::boolean('dynamic_resolution', 'Dynamic resolution', false, 'Lowers the render scale (down to 0.5×) automatically to hold the target frame rate.'),
                SettingField::number('target_fps', 'Target frame rate', 60, 30, 144, 1, 'fps', 'Frame rate dynamic resolution tries to hold.'),
                SettingField::number('max_fps', 'Frame rate limit', 0, 0, 240, 1, 'fps', '0 = unlimited (display refresh rate).'),
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
