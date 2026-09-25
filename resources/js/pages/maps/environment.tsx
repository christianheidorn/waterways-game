import { Head } from '@inertiajs/react';
import { CloudFog, SunMedium, Waves } from 'lucide-react';
import { MapTabs } from '@/components/map-tabs';
import type { SettingsSection } from '@/components/settings-form';
import { SettingsForm } from '@/components/settings-form';
import { formatTimeOfDay } from '@/lib/format';
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
        description: 'Sun position, sky haze, clouds and overall brightness.',
        icon: SunMedium,
        fields: [
            'time_of_day',
            'sun_azimuth',
            'turbidity',
            'cloud_coverage',
            'exposure',
        ],
    },
    {
        title: 'Atmosphere',
        description: 'Distance fog and how strongly foliage and water move.',
        icon: CloudFog,
        fields: ['fog_density', 'wind_strength'],
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

const FORMATTERS = {
    time_of_day: formatTimeOfDay,
    sun_azimuth: (v: number) => `${Math.round(v)}°`,
    cloud_coverage: (v: number) => `${Math.round(v * 100)}%`,
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
                    className="absolute size-6 rounded-full bg-amber-100 shadow-[0_0_24px_8px_rgba(253,230,138,0.6)]"
                    style={{
                        left: `${10 + (Math.min(Math.max(hours, 6), 18) - 6) * (80 / 12)}%`,
                        bottom: `${10 + daylight * 60}%`,
                        opacity: daylight > 0.02 ? 1 : 0,
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
