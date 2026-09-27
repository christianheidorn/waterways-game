import type { EnvironmentSettings, WeatherKind } from '@game/shared/types';

type WeatherFields = Pick<
    EnvironmentSettings,
    | 'weather'
    | 'cloud_coverage'
    | 'turbidity'
    | 'fog_density'
    | 'height_fog_height'
    | 'height_fog_density'
    | 'precipitation'
    | 'lightning_frequency'
    | 'wind_strength'
    | 'wetness'
    | 'exposure'
>;

export type WeatherPreset = {
    label: string;
    description: string;
    values: WeatherFields;
};

/**
 * One-click weather looks for the environment editors. Each preset sets a coherent bundle of sky,
 * fog, precipitation, wind and ground values; time of day, sun direction, wind direction and thunder
 * volume are left alone. The game blends to the new look over a few seconds.
 */
export const WEATHER_PRESETS: Record<WeatherKind, WeatherPreset> = {
    clear: {
        label: 'Clear',
        description: 'Blue sky with a few fair-weather clouds.',
        values: {
            weather: 'clear',
            cloud_coverage: 0.15,
            turbidity: 2.2,
            fog_density: 0.00015,
            height_fog_height: 0,
            height_fog_density: 0.012,
            precipitation: 0,
            lightning_frequency: 0,
            wind_strength: 0.35,
            wetness: 0,
            exposure: 0.5,
        },
    },
    cloudy: {
        label: 'Cloudy',
        description: 'Broken cumulus with sunny spells.',
        values: {
            weather: 'cloudy',
            cloud_coverage: 0.55,
            turbidity: 3,
            fog_density: 0.00025,
            height_fog_height: 0,
            height_fog_density: 0.012,
            precipitation: 0,
            lightning_frequency: 0,
            wind_strength: 0.6,
            wetness: 0,
            exposure: 0.5,
        },
    },
    overcast: {
        label: 'Overcast',
        description: 'A grey, even cloud deck and soft light.',
        values: {
            weather: 'overcast',
            cloud_coverage: 0.95,
            turbidity: 6,
            fog_density: 0.0005,
            height_fog_height: 0,
            height_fog_density: 0.012,
            precipitation: 0,
            lightning_frequency: 0,
            wind_strength: 0.5,
            wetness: 0.1,
            exposure: 0.55,
        },
    },
    fog: {
        label: 'Foggy',
        description: 'Misty air with fog pooling in the valleys.',
        values: {
            weather: 'fog',
            cloud_coverage: 0.8,
            turbidity: 7,
            fog_density: 0.0008,
            height_fog_height: 80,
            height_fog_density: 0.014,
            precipitation: 0,
            lightning_frequency: 0,
            wind_strength: 0.1,
            wetness: 0.25,
            exposure: 0.55,
        },
    },
    rain: {
        label: 'Rain',
        description: 'Steady rain, wet ground and ripples on the water.',
        values: {
            weather: 'rain',
            cloud_coverage: 0.92,
            turbidity: 8,
            fog_density: 0.0007,
            height_fog_height: 40,
            height_fog_density: 0.008,
            precipitation: 0.65,
            lightning_frequency: 0,
            wind_strength: 0.8,
            wetness: 0.6,
            exposure: 0.6,
        },
    },
    storm: {
        label: 'Storm',
        description: 'Downpour, gusts, lightning and thunder.',
        values: {
            weather: 'storm',
            cloud_coverage: 1,
            turbidity: 10,
            fog_density: 0.0009,
            height_fog_height: 60,
            height_fog_density: 0.01,
            precipitation: 1,
            lightning_frequency: 6,
            wind_strength: 1.4,
            wetness: 0.9,
            exposure: 0.6,
        },
    },
    snow: {
        label: 'Snow',
        description: 'Falling snow that settles on the ground.',
        values: {
            weather: 'snow',
            cloud_coverage: 0.88,
            turbidity: 6,
            fog_density: 0.001,
            height_fog_height: 0,
            height_fog_density: 0.012,
            precipitation: 0.6,
            lightning_frequency: 0,
            wind_strength: 0.3,
            wetness: 0,
            exposure: 0.5,
        },
    },
};

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** "45° NE": the direction the wind blows towards. */
export function formatWindDirection(degrees: number): string {
    return `${Math.round(degrees)}° ${COMPASS[Math.round(degrees / 45) % 8]}`;
}
