import type { WeatherKind } from '@game/shared/types';
import type { LucideIcon } from 'lucide-react';
import {
    Cloud,
    CloudFog,
    CloudLightning,
    CloudRain,
    CloudSun,
    Leaf,
    Snowflake,
    Sun,
} from 'lucide-react';
import { WEATHER_PRESETS } from '@/lib/weather-presets';
import { cn } from '@/lib/utils';
import type { SettingValues } from '@/types';

const ICONS: Record<WeatherKind, LucideIcon> = {
    clear: Sun,
    cloudy: CloudSun,
    overcast: Cloud,
    fog: CloudFog,
    rain: CloudRain,
    storm: CloudLightning,
    snow: Snowflake,
    autumn: Leaf,
};

type Props = {
    /** Currently selected weather (highlights its preset). */
    value?: string | null;
    /** Receives the preset's bundle of environment values. */
    onApply: (values: SettingValues) => void;
    className?: string;
};

/** One-click weather presets (see resources/js/lib/weather-presets.ts). */
export function WeatherPresets({ value, onApply, className }: Props) {
    return (
        <div
            role="group"
            aria-label="Weather presets"
            className={cn('grid grid-cols-4 gap-2 sm:grid-cols-8', className)}
        >
            {(Object.keys(WEATHER_PRESETS) as WeatherKind[]).map((kind) => {
                const preset = WEATHER_PRESETS[kind];
                const Icon = ICONS[kind];
                const active = value === kind;

                return (
                    <button
                        key={kind}
                        type="button"
                        title={preset.description}
                        aria-pressed={active}
                        onClick={() => onApply({ ...preset.values })}
                        className={cn(
                            'flex flex-col items-center gap-1.5 rounded-lg border px-1 py-2.5 text-xs font-medium transition-colors',
                            'hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                            active
                                ? 'border-primary bg-primary/10 text-foreground'
                                : 'bg-background text-muted-foreground',
                        )}
                    >
                        <Icon className="size-5" aria-hidden="true" />
                        {preset.label}
                    </button>
                );
            })}
        </div>
    );
}
