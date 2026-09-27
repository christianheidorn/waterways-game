<?php

namespace App\Support;

/**
 * Per-map environment (sky, lighting, fog, weather, water look).
 *
 * Keep in sync with EnvironmentSettings in resources/game/shared/types.ts. Maps saved before a field
 * existed get its default through merge().
 */
final class EnvironmentDefaults
{
    /** @var array<string, string> */
    public const WEATHER = [
        'clear' => 'Clear',
        'cloudy' => 'Cloudy',
        'overcast' => 'Overcast',
        'fog' => 'Foggy',
        'rain' => 'Rain',
        'storm' => 'Thunderstorm',
        'snow' => 'Snow',
    ];

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
            SettingField::number('wind_direction', 'Wind direction', 45, 0, 360, 1, '°', 'Direction the wind blows towards (0 = north, 90 = east). Moves clouds and slants rain.'),
            SettingField::select('weather', 'Weather', 'clear', self::WEATHER, 'Weather type; the studio presets also set a matching sky, fog and rain. Snow turns precipitation into snowfall.'),
            SettingField::number('precipitation', 'Precipitation', 0, 0, 1, 0.01, null, 'Amount of rain (or snow) falling around the camera.'),
            SettingField::number('lightning_frequency', 'Lightning', 0, 0, 20, 0.1, '/min', 'Lightning strikes per minute.'),
            SettingField::number('thunder_volume', 'Thunder volume', 0.7, 0, 1, 0.01),
            SettingField::number('height_fog_height', 'Valley fog height', 0, 0, 2000, 1, 'm', 'Fog that pools in valleys, up to this height above the lowest point of the map (or sea level with an ocean). 0 = off.'),
            SettingField::number('height_fog_density', 'Valley fog density', 0.012, 0, 0.1, 0.0005, null, 'Thickness of the valley fog at its base.'),
            SettingField::number('wetness', 'Ground wetness', 0, 0, 1, 0.01, null, 'How wet the ground looks. Rain also soaks the ground over time.'),
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
