import { Head } from '@inertiajs/react';
import {
    Clapperboard,
    CloudFog,
    CloudRain,
    SunMedium,
    Waves,
} from 'lucide-react';
import { MapTabs } from '@/components/map-tabs';
import type { SettingsSection } from '@/components/settings-form';
import { SettingsForm } from '@/components/settings-form';
import { LookPresets } from '@/components/look-presets';
import { WeatherPresets } from '@/components/weather-presets';
import { formatTimeOfDay } from '@/lib/format';
import { formatWindDirection } from '@/lib/weather-presets';
import maps from '@/routes/maps';
import type { MapSummary, SettingGroup, SettingValues } from '@/types';

type Props = {
    map: MapSummary;
    group: SettingGroup;
    values: SettingValues;
};

const SECTIONS: SettingsSection[] = [
    {
        title: 'Sky & lighting',
        description:
            'Sun position, sky haze, clouds and their shadows, and overall brightness.',
        icon: SunMedium,
        fields: [
            'time_of_day',
            'sun_azimuth',
            'turbidity',
            'cloud_coverage',
            'cloud_shadow_strength',
            'exposure',
        ],
    },
    {
        title: 'Weather',
        description:
            'Pick a preset for a matching sky, fog, rain and wind, then fine-tune below.',
        icon: CloudRain,
        addon: ({ values, setValues }) => (
            <WeatherPresets
                value={String(values.weather ?? 'clear')}
                onApply={setValues}
            />
        ),
        fields: [
            'weather',
            'precipitation',
            'lightning_frequency',
            'thunder_volume',
            'wetness',
        ],
    },
    {
        title: 'Atmosphere',
        description:
            'Distance fog, valley fog and the wind that moves clouds, rain, foliage and water, with gusts that sweep across fields and canopies.',
        icon: CloudFog,
        fields: [
            'fog_density',
            'height_fog_height',
            'height_fog_density',
            'wind_strength',
            'wind_direction',
            'gust_strength',
            'gust_scale',
            'gust_speed',
        ],
    },
    {
        title: 'Camera & look',
        description:
            'Film look, eye adaptation, light shafts, depth of field and lens effects. Each effect also needs its switch in Graphics settings (on by preset from High / Epic / Cinematic).',
        icon: Clapperboard,
        addon: ({ values, setValues }) => (
            <LookPresets values={values} onApply={setValues} />
        ),
        fields: [
            'color_grade',
            'color_grade_intensity',
            'white_balance',
            'exposure_compensation',
            'auto_exposure_min_ev',
            'auto_exposure_max_ev',
            'auto_exposure_speed',
            'god_ray_intensity',
            'fog_shaft_intensity',
            'bloom_threshold',
            'dof_focus_distance',
            'dof_aperture',
            'dof_max_blur',
            'motion_blur_strength',
            'lens_flare_intensity',
            'chromatic_aberration',
            'film_grain',
            'letterbox',
        ],
    },
    {
        title: 'Water',
        description: 'Colour and clarity of rivers and lakes, plus the ocean.',
        icon: Waves,
        fields: [
            'water_shallow_color',
            'water_deep_color',
            'water_clarity',
            'ocean_enabled',
            'sea_level',
        ],
    },
];

const percent = (v: number) => `${Math.round(v * 100)}%`;

const FORMATTERS = {
    time_of_day: formatTimeOfDay,
    sun_azimuth: (v: number) => `${Math.round(v)}°`,
    cloud_coverage: percent,
    precipitation: percent,
    wetness: percent,
    thunder_volume: percent,
    wind_direction: formatWindDirection,
    cloud_shadow_strength: percent,
    gust_scale: (v: number) => `${Math.round(v)} m`,
    height_fog_height: (v: number) => (v > 0 ? `${Math.round(v)} m` : 'Off'),
};

export default function MapEnvironment({ map, group, values }: Props) {
    return (
        <>
            <Head title={`${map.name} · Environment`} />
            <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 p-4 sm:p-6">
                <MapTabs map={map} />

                <div className="grid gap-6 lg:grid-cols-3">
                    <div className="lg:col-span-2">
                        <SettingsForm
                            group={group}
                            values={values}
                            action={maps.environment.update(map.slug)}
                            sections={SECTIONS}
                            formatters={FORMATTERS}
                            submitLabel="Save environment"
                        />
                    </div>
                    <aside className="space-y-4 self-start text-sm text-muted-foreground lg:sticky lg:top-4">
                        <div className="rounded-xl border bg-muted/40 p-4">
                            <h2 className="mb-1 font-medium text-foreground">
                                {group.title}
                            </h2>
                            <p>{group.description}</p>
                            <p className="mt-3">
                                These values are the starting point every time
                                the map loads. You can preview changes live in
                                the studio&apos;s environment panel.
                            </p>
                        </div>
                        <EnvironmentPreview values={values} />
                    </aside>
                </div>
            </div>
        </>
    );
}

function mixHex(a: string, b: string, t: number): string {
    const pa = [1, 3, 5].map((i) => Number.parseInt(a.slice(i, i + 2), 16));
    const pb = [1, 3, 5].map((i) => Number.parseInt(b.slice(i, i + 2), 16));
    const k = Math.min(1, Math.max(0, t));

    return `rgb(${pa.map((v, i) => Math.round(v + (pb[i] - v) * k)).join(' ')})`;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
    const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));

    return t * t * (3 - 2 * t);
}

/** A tiny sky/water swatch reflecting the saved values. */
function EnvironmentPreview({ values }: { values: SettingValues }) {
    const hours = Number(values.time_of_day ?? 12);
    const daylight = Math.max(0, Math.sin(((hours - 6) / 12) * Math.PI));
    const day = smoothstep(0.05, 0.6, daylight);
    const dusk = smoothstep(0, 0.12, daylight) * (1 - day);
    const skyTop = mixHex('#0b1026', '#3b82f6', day);
    const horizonDay = mixHex('#1e293b', '#bae6fd', day);
    const skyBottom =
        dusk > 0.05
            ? mixHex('#1e293b', '#fb923c', dusk + day * 0.2)
            : horizonDay;
    const overcast = Math.min(
        1,
        Math.max(0, (Number(values.cloud_coverage ?? 0) - 0.4) / 0.6),
    );
    const precipitation = Number(values.precipitation ?? 0);
    const shallow = String(values.water_shallow_color ?? '#2fa3a0');
    const deep = String(values.water_deep_color ?? '#0b2f45');

    return (
        <div
            className="overflow-hidden rounded-xl border shadow-xs"
            aria-hidden="true"
        >
            <div
                className="relative h-28"
                style={{
                    background: `linear-gradient(to bottom, ${skyTop}, ${skyBottom})`,
                }}
            >
                <div
                    className="absolute inset-0 bg-slate-500"
                    style={{ opacity: overcast * (0.35 + day * 0.4) }}
                />
                {precipitation > 0.02 && (
                    <div
                        className="absolute inset-0"
                        style={{
                            opacity: 0.25 + precipitation * 0.5,
                            backgroundImage:
                                values.weather === 'snow'
                                    ? 'radial-gradient(circle, rgb(255 255 255 / 0.9) 1px, transparent 1.5px)'
                                    : 'repeating-linear-gradient(105deg, transparent 0 6px, rgb(226 232 240 / 0.45) 6px 7px)',
                            backgroundSize:
                                values.weather === 'snow'
                                    ? '9px 9px'
                                    : undefined,
                        }}
                    />
                )}
                <div
                    className="absolute size-6 rounded-full bg-amber-100 shadow-[0_0_24px_8px_rgba(253,230,138,0.6)]"
                    style={{
                        left: `${10 + (Math.min(Math.max(hours, 6), 18) - 6) * (80 / 12)}%`,
                        bottom: `${10 + daylight * 60}%`,
                        opacity: daylight > 0.02 ? 1 - overcast * 0.85 : 0,
                    }}
                />
            </div>
            <div
                className="h-14"
                style={{
                    background: `linear-gradient(to bottom, ${shallow}, ${deep})`,
                }}
            />
            <div className="bg-card px-3 py-2 text-xs">
                {formatTimeOfDay(hours)} · saved look
            </div>
        </div>
    );
}

MapEnvironment.layout = (props: Props) => ({
    breadcrumbs: [
        { title: 'Maps', href: maps.index() },
        { title: props.map.name, href: maps.show(props.map.slug) },
        { title: 'Environment', href: maps.environment.edit(props.map.slug) },
    ],
});
