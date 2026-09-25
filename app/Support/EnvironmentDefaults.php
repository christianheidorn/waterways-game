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
            SettingField::color('water_shallow_color', 'Shallow water colour', '#2fa3a0'),
            SettingField::color('water_deep_color', 'Deep water colour', '#0b2f45'),
            SettingField::number('water_clarity', 'Water clarity', 4, 0.5, 30, 0.1, 'm', 'Depth at which the deep colour takes over.'),
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
