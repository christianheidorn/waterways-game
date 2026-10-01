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
        'autumn' => 'Autumn leaves',
    ];

    public static function group(): SettingGroup
    {
        return new SettingGroup('environment', 'Environment', 'Sky, lighting, fog and water appearance for this map.', [
            SettingField::number('time_of_day', 'Time of day', 15.5, 0, 24, 0.05, 'h'),
            SettingField::number('sun_azimuth', 'Sun direction', 200, 0, 360, 1, '°', 'Rotates the path of the sun around the map.'),
            SettingField::number('turbidity', 'Haze', 2.5, 1, 20, 0.1, null, 'Atmospheric turbidity; higher values make the sky milkier.'),
            SettingField::number('cloud_coverage', 'Cloud coverage', 0.25, 0, 1, 0.01),
            SettingField::number('cloud_shadow_strength', 'Cloud shadows', 0.6, 0, 1, 0.01, null, 'How much the shadows of drifting clouds darken the ground, water, plants and props. How much of the land they cover follows the cloud coverage.'),
            SettingField::number('fog_density', 'Fog density', 0.00018, 0, 0.004, 0.00001),
            SettingField::number('exposure', 'Exposure', 0.5, 0.1, 2, 0.01),
            SettingField::number('bounce_light', 'Bounce light', 1, 0, 2, 0.01, null, 'Sunlight and skylight bounced off the ground, trees and props: valleys pick up the warm or green light of their slopes and forests get darker underneath (1 = physical, 0 = off). Needs the Bounce light graphics setting.'),
            SettingField::number('wind_strength', 'Wind strength', 0.4, 0, 2, 0.01),
            SettingField::number('wind_direction', 'Wind direction', 45, 0, 360, 1, '°', 'Direction the wind blows towards (0 = north, 90 = east). Moves clouds and slants rain.'),
            SettingField::number('gust_strength', 'Gust strength', 0.5, 0, 2, 0.01, null, 'Gusts that travel downwind across grass fields and canopies as visible waves (0 = steady wind).'),
            SettingField::number('gust_scale', 'Gust size', 40, 5, 300, 1, 'm', 'Size of the gust patches sweeping over the vegetation.'),
            SettingField::number('gust_speed', 'Gust speed', 1, 0, 4, 0.05, '×', 'How fast gust fronts travel downwind, relative to the wind strength.'),
            SettingField::select('weather', 'Weather', 'clear', self::WEATHER, 'Weather type; the studio presets also set a matching sky, fog and rain. Snow turns precipitation into snowfall.'),
            SettingField::number('precipitation', 'Precipitation', 0, 0, 1, 0.01, null, 'Amount of rain (or snow) falling around the camera.'),
            SettingField::number('falling_leaves', 'Falling leaves', 0, 0, 1, 0.01, null, 'Autumn leaves blowing through the air around the camera; works with any weather.'),
            SettingField::number('lightning_frequency', 'Lightning', 0, 0, 20, 0.1, '/min', 'Lightning strikes per minute.'),
            SettingField::number('thunder_volume', 'Thunder volume', 0.7, 0, 1, 0.01),
            SettingField::number('height_fog_height', 'Valley fog height', 0, 0, 2000, 1, 'm', 'Fog that pools in valleys, up to this height above the lowest point of the map (or sea level with an ocean). 0 = off.'),
            SettingField::number('height_fog_density', 'Valley fog density', 0.012, 0, 0.1, 0.0005, null, 'Thickness of the valley fog at its base.'),
            SettingField::number('wetness', 'Ground wetness', 0, 0, 1, 0.01, null, 'How wet the ground looks. Rain also soaks the ground over time.'),
            SettingField::number('puddles', 'Puddles', 0.6, 0, 1, 0.01, null, 'How much rain water collects in hollows and on flat low ground as reflective puddles that ripple in the rain (0 = none). They fill while it rains and dry afterwards.'),
            SettingField::number('puddle_dry_time', 'Puddle drying time', 240, 10, 1800, 5, 's', 'How long full puddles take to dry up after the rain stops.'),
            SettingField::number('footprint_depth', 'Footprints in snow', 0.7, 0, 1, 0.01, null, 'How deep the character\'s footprints press into snow cover (0 = none). Needs the Snow footprints graphics switch.'),
            SettingField::number('footprint_fade_time', 'Footprints fade', 300, 10, 1800, 5, 's', 'How long footprints take to fade without snowfall; falling snow fills them much faster.'),
            // Camera & look (post-processing; each effect also needs its quality switch in Graphics settings)
            SettingField::select('color_grade', 'Colour grade', 'filmic', [
                'neutral' => 'Neutral', 'filmic' => 'Filmic', 'golden_hour' => 'Golden hour', 'teal_orange' => 'Teal & orange',
                'cold_storm' => 'Cold storm', 'bleach_bypass' => 'Bleach bypass', 'vintage' => 'Vintage', 'noir' => 'Noir',
                'lush' => 'Lush', 'desert' => 'Desert',
            ], 'Film look applied as a colour lookup table.'),
            SettingField::number('color_grade_intensity', 'Grade strength', 0.6, 0, 1, 0.01),
            SettingField::number('white_balance', 'White balance', 0, -1, 1, 0.01, null, 'Negative is cooler / bluer, positive warmer.'),
            SettingField::number('exposure_compensation', 'Exposure compensation', 0, -3, 3, 0.05, 'EV'),
            SettingField::number('auto_exposure_min_ev', 'Auto exposure: darkest', -1.5, -6, 0, 0.1, 'EV', 'How far eye adaptation may darken the image.'),
            SettingField::number('auto_exposure_max_ev', 'Auto exposure: brightest', 1.5, 0, 6, 0.1, 'EV', 'How far eye adaptation may brighten the image (dark valleys, night).'),
            SettingField::number('auto_exposure_speed', 'Adaptation speed', 1.2, 0.1, 10, 0.1, '/s'),
            SettingField::number('god_ray_intensity', 'Light shaft intensity', 0.6, 0, 2, 0.01),
            SettingField::number('fog_shaft_intensity', 'Light shafts in fog', 0.8, 0, 2, 0.01, null, 'Sunbeams through trees and cloud gaps in fog and haze. Grows with the fog density; needs the Light shafts graphics switch.'),
            SettingField::number('bloom_threshold', 'Bloom threshold', 4.5, 0.5, 20, 0.1, null, 'How bright something must be to glow (display-referred).'),
            SettingField::number('dof_focus_distance', 'Focus distance', 0, 0, 5000, 0.5, 'm', '0 = autofocus on the centre of the screen.'),
            SettingField::number('dof_aperture', 'Aperture', 5.6, 1, 22, 0.1, 'f/', 'Lower f-numbers give shallower depth of field and bigger bokeh.'),
            SettingField::number('dof_max_blur', 'Max blur', 12, 1, 40, 0.5, 'px'),
            SettingField::number('motion_blur_strength', 'Motion blur strength', 0.5, 0, 1, 0.01),
            SettingField::number('lens_flare_intensity', 'Lens flare', 0.4, 0, 1, 0.01),
            SettingField::number('chromatic_aberration', 'Chromatic aberration', 0.15, 0, 1, 0.01),
            SettingField::number('film_grain', 'Film grain', 0.1, 0, 1, 0.01),
            SettingField::number('letterbox', 'Letterbox', 0, 0, 3, 0.01, ':1', '0 = off; 2.39 for a cinemascope frame.'),
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
            SettingField::number('foam_breakup', 'Foam breakup', 0.6, 0, 1, 0.01, null, 'Breaks the shoreline foam into drifting patches and streaks (0 = an even band).'),
            SettingField::boolean('rapids_foam', 'Rapids foam', true, 'White water where rivers flow fast.'),
            SettingField::number('caustics_intensity', 'Caustics', 0.8, 0, 2, 0.01, null, 'Dancing light patterns the waves focus onto shallow river and lake beds (0 = off). Needs the Caustics graphics switch.'),
            SettingField::number('caustics_scale', 'Caustics size', 2.5, 0.5, 10, 0.1, 'm', 'Size of the caustic light cells.'),
            SettingField::number('caustics_depth', 'Caustics depth', 4, 0.5, 20, 0.1, 'm', 'Water depth down to which caustics reach the bed (they fade with depth).'),
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
