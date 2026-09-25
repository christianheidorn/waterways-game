<?php

namespace App\Support;

/**
 * Per-map environment (sky, lighting, fog, water look).
 */
final class EnvironmentDefaults
{
    public static function group(): SettingGroup
    {
        return new SettingGroup('environment', 'Environment', 'Sky, lighting, fog and water appearance for this map.', [
            SettingField::number('time_of_day', 'Time of day', 15.5, 0, 24, 0.05, 'h'),
            SettingField::number('sun_azimuth', 'Sun direction', 200, 0, 360, 1, '°', 'Rotates the path of the sun around the map.'),
            SettingField::number('turbidity', 'Haze', 2.5, 1, 20, 0.1, null, 'Atmospheric turbidity; higher values make the sky milkier.'),
            SettingField::number('cloud_coverage', 'Cloud coverage', 0.25, 0, 1, 0.01),
            SettingField::number('fog_density', 'Fog density', 0.00018, 0, 0.004, 0.00001),
            SettingField::number('exposure', 'Exposure', 0.5, 0.1, 2, 0.01),
            SettingField::number('wind_strength', 'Wind strength', 0.4, 0, 2, 0.01),
            SettingField::color('water_shallow_color', 'Shallow water colour', '#3aa6a0', 'Tint of clear, shallow water. Also controls which colours the water absorbs.'),
            SettingField::color('water_deep_color', 'Deep water colour', '#0a2a3c', 'Colour of the water body where it is too deep to see the bottom.'),
            SettingField::number('water_clarity', 'Water clarity', 5, 0.3, 40, 0.1, 'm', 'How far you can see into the water before the deep colour takes over.'),
            SettingField::number('water_roughness', 'Surface roughness', 0.05, 0.0, 0.5, 0.01, null, 'Lower = mirror-like reflections, higher = blurrier, matte water.'),
            SettingField::number('water_reflectivity', 'Reflection strength', 1, 0, 2, 0.05),
            SettingField::number('water_refraction', 'Refraction', 0.5, 0, 2, 0.05, null, 'How strongly waves bend the view of the ground beneath the surface.'),
            SettingField::number('wave_scale', 'Wave size', 8, 1, 60, 0.5, 'm', 'Size of the surface ripples and chop.'),
            SettingField::number('wave_strength', 'Wave strength', 0.4, 0, 2, 0.05, null, 'Steepness of the ripples (0 = glassy calm).'),
            SettingField::number('wave_speed', 'Wave speed', 1, 0, 3, 0.05),
            SettingField::number('wave_height', 'Swell height', 0.15, 0, 3, 0.01, 'm', 'Rolling swell on deep water (lakes, sea). Shallow water stays calm.'),
            SettingField::number('flow_speed', 'River flow speed', 1, 0, 4, 0.05, '×', 'How fast rivers visibly flow downhill.'),
            SettingField::boolean('shore_foam', 'Shoreline foam', true, 'Foam where water meets land, rocks and plants.'),
            SettingField::number('foam_width', 'Foam width', 0.8, 0.1, 6, 0.05, 'm', 'Water depth up to which shoreline foam appears.'),
            SettingField::number('foam_intensity', 'Foam intensity', 0.45, 0, 1, 0.01),
            SettingField::boolean('rapids_foam', 'Rapids foam', true, 'White water where rivers flow fast.'),
            SettingField::boolean('ocean_enabled', 'Ocean', false, 'Fill everything below sea level that touches the map edge with ocean.'),
            SettingField::number('sea_level', 'Sea level', 0, -500, 5000, 0.1, 'm'),
        ]);
    }

    /**
     * @param  array<string, mixed>  $values
     * @return array<string, mixed>
     */
    public static function merge(array $values): array
    {
        return self::group()->merge($values);
    }
}
