import type { MapSource } from '@game/shared/types';
import { Dices, Globe, Mountain, Square } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useId } from 'react';
import { GeoAreaPicker } from '@/components/geo-area-picker';
import InputError from '@/components/input-error';
import { SliderField } from '@/components/slider-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { formatKm, formatMetresPerSample } from '@/lib/format';
import { cn } from '@/lib/utils';

export type TerrainFormData = {
    source: MapSource;
    resolution: number;
    size: number;
    center_lat: number | null;
    center_lng: number | null;
    height_scale: number;
    import_water: boolean;
    seed: number | null;
    lake_depth: number;
    river_depth: number;
    shore_angle: number;
    bank_angle: number;
    smoothing: number;
};

/** Mirrors App\Services\Terrain\TerrainShaping::DEFAULTS. */
export const SHAPING_DEFAULTS = {
    lake_depth: 6,
    river_depth: 2,
    shore_angle: 15,
    bank_angle: 35,
    smoothing: 0.5,
} satisfies Partial<TerrainFormData>;

export const PROCEDURAL_SIZES = [1024, 2048, 4096, 8192];

export const SOURCE_OPTIONS: {
    value: MapSource;
    title: string;
    description: string;
    icon: LucideIcon;
}[] = [
    {
        value: 'procedural',
        title: 'Procedural',
        description: 'Generated hills, a river and a lake',
        icon: Mountain,
    },
    {
        value: 'real_world',
        title: 'Real world',
        description: 'Use real elevation data and water from OpenStreetMap',
        icon: Globe,
    },
    {
        value: 'flat',
        title: 'Flat',
        description: 'A blank canvas',
        icon: Square,
    },
];

export function randomSeed(): number {
    return Math.floor(Math.random() * 999_999) + 1;
}

type Props = {
    data: TerrainFormData;
    onChange: (patch: Partial<TerrainFormData>) => void;
    errors: Partial<Record<keyof TerrainFormData, string>>;
    resolutions: number[];
    /** Compact layout for dialogs. */
    compact?: boolean;
};

/** Source choice + source specific options (area picker, seed, size) + resolution. */
export function TerrainSourceFields({
    data,
    onChange,
    errors,
    resolutions,
    compact = false,
}: Props) {
    const id = useId();

    const selectSource = (source: MapSource) => {
        if (source === data.source) {
            return;
        }

        const patch: Partial<TerrainFormData> = { source };

        // A real-world area can be up to 16 km; generated maps offer up to 8 km.
        if (source !== 'real_world' && !PROCEDURAL_SIZES.includes(data.size)) {
            patch.size = 4096;
        }

        if (source === 'procedural' && !data.seed) {
            patch.seed = randomSeed();
        }

        onChange(patch);
    };

    return (
        <div className="grid gap-8">
            <fieldset className="grid gap-3">
                <legend className="mb-3 text-sm font-medium">
                    Terrain source
                </legend>
                <div
                    role="radiogroup"
                    aria-label="Terrain source"
                    className={cn(
                        'grid gap-3',
                        compact ? 'sm:grid-cols-3' : 'md:grid-cols-3',
                    )}
                >
                    {SOURCE_OPTIONS.map((option) => {
                        const selected = data.source === option.value;

                        return (
                            <button
                                key={option.value}
                                type="button"
                                role="radio"
                                aria-checked={selected}
                                onClick={() => selectSource(option.value)}
                                className={cn(
                                    'group relative flex items-start gap-3 rounded-xl border bg-card p-4 text-left transition-all outline-none hover:border-foreground/30 focus-visible:ring-[3px] focus-visible:ring-ring/50',
                                    compact
                                        ? 'sm:flex-col'
                                        : 'md:flex-col md:p-5',
                                    selected &&
                                        'border-sky-500 bg-sky-500/5 ring-1 ring-sky-500 hover:border-sky-500 dark:bg-sky-500/10',
                                )}
                            >
                                <div
                                    className={cn(
                                        'flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors',
                                        selected &&
                                            'bg-sky-500 text-white dark:bg-sky-500',
                                    )}
                                >
                                    <option.icon className="size-5" />
                                </div>
                                <div className="space-y-1">
                                    <div className="font-medium">
                                        {option.title}
                                    </div>
                                    <p className="text-sm text-muted-foreground">
                                        {option.description}
                                    </p>
                                </div>
                                <span
                                    aria-hidden="true"
                                    className={cn(
                                        'absolute top-3 right-3 size-4 rounded-full border-2 border-muted-foreground/40',
                                        selected &&
                                            'border-sky-500 bg-sky-500 shadow-[inset_0_0_0_2px_var(--color-card)]',
                                    )}
                                />
                            </button>
                        );
                    })}
                </div>
                <InputError message={errors.source} />
            </fieldset>

            {data.source === 'real_world' && (
                <div className="grid gap-6">
                    <div className="grid gap-2">
                        <Label>Area</Label>
                        <p className="-mt-1 text-sm text-muted-foreground">
                            Drag the marker, click the map or search for a
                            place. The highlighted square becomes your map.
                        </p>
                        <GeoAreaPicker
                            value={
                                data.center_lat !== null &&
                                data.center_lng !== null
                                    ? {
                                          lat: data.center_lat,
                                          lng: data.center_lng,
                                          size: data.size,
                                      }
                                    : null
                            }
                            onChange={(area) =>
                                onChange({
                                    center_lat: Number(area.lat.toFixed(6)),
                                    center_lng: Number(area.lng.toFixed(6)),
                                    size: area.size,
                                })
                            }
                            resolution={data.resolution}
                        />
                        <InputError
                            message={
                                errors.center_lat ??
                                errors.center_lng ??
                                errors.size
                            }
                        />
                    </div>
                    <div className="grid gap-6 md:grid-cols-2">
                        <SliderField
                            label="Height scale"
                            value={data.height_scale}
                            onChange={(v) => onChange({ height_scale: v })}
                            min={0.1}
                            max={5}
                            step={0.05}
                            unit="×"
                            description="Exaggerate or flatten the real elevation."
                            error={errors.height_scale}
                        />
                        <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
                            <div className="space-y-1">
                                <Label htmlFor={`${id}-water`}>
                                    Import water
                                </Label>
                                <p className="text-xs text-muted-foreground">
                                    Rivers, lakes and coastline from
                                    OpenStreetMap.
                                </p>
                            </div>
                            <Switch
                                id={`${id}-water`}
                                checked={data.import_water}
                                onCheckedChange={(checked) =>
                                    onChange({ import_water: checked })
                                }
                            />
                        </div>
                    </div>
                </div>
            )}

            {data.source !== 'flat' && (
                <fieldset className="grid gap-4">
                    <legend className="text-sm font-medium">
                        Water &amp; shaping
                    </legend>
                    <p className="-mt-2 text-sm text-muted-foreground">
                        Depth is carved into the terrain below the water level
                        detected from the elevation data.
                    </p>
                    <div className="grid gap-6 md:grid-cols-2">
                        <SliderField
                            label="Lake depth"
                            value={data.lake_depth}
                            onChange={(v) => onChange({ lake_depth: v })}
                            min={0.5}
                            max={100}
                            step={0.5}
                            unit="m"
                            description="Maximum depth of lakes, ponds, reservoirs and the ocean shelf."
                            error={errors.lake_depth}
                        />
                        <SliderField
                            label="River depth"
                            value={data.river_depth}
                            onChange={(v) => onChange({ river_depth: v })}
                            min={0.2}
                            max={30}
                            step={0.1}
                            unit="m"
                            description="Maximum depth of rivers, streams, canals and ditches."
                            error={errors.river_depth}
                        />
                        <SliderField
                            label="Shore slope"
                            value={data.shore_angle}
                            onChange={(v) => onChange({ shore_angle: v })}
                            min={1}
                            max={60}
                            step={1}
                            unit="°"
                            description="How quickly water deepens away from the shore. Low values give wide shallows."
                            error={errors.shore_angle}
                        />
                        <SliderField
                            label="Bank angle"
                            value={data.bank_angle}
                            onChange={(v) => onChange({ bank_angle: v })}
                            min={10}
                            max={80}
                            step={1}
                            unit="°"
                            description="Steepest bank allowed right next to water. Removes cliffs where map outlines and elevation data disagree."
                            error={errors.bank_angle}
                        />
                        <SliderField
                            label="Terrain smoothing"
                            value={data.smoothing}
                            onChange={(v) => onChange({ smoothing: v })}
                            min={0}
                            max={1}
                            step={0.05}
                            formatValue={(v) => `${Math.round(v * 100)}%`}
                            description={
                                data.source === 'real_world'
                                    ? 'Removes stair steps from whole-metre elevation data, mostly in flat areas. 0 keeps the raw data.'
                                    : 'Softens the generated terrain slightly.'
                            }
                            error={errors.smoothing}
                        />
                    </div>
                </fieldset>
            )}

            <div
                className={cn(
                    'grid gap-6',
                    data.source === 'procedural'
                        ? 'sm:grid-cols-3'
                        : data.source === 'flat'
                          ? 'sm:grid-cols-2'
                          : 'sm:grid-cols-1 md:max-w-sm',
                )}
            >
                {data.source === 'procedural' && (
                    <div className="grid content-start gap-2">
                        <Label htmlFor={`${id}-seed`}>Seed</Label>
                        <div className="flex gap-2">
                            <Input
                                id={`${id}-seed`}
                                type="number"
                                min={1}
                                max={999999}
                                value={data.seed ?? ''}
                                onChange={(e) =>
                                    onChange({
                                        seed:
                                            e.target.value === ''
                                                ? null
                                                : Number(e.target.value),
                                    })
                                }
                                placeholder="Random"
                                className="tabular-nums"
                            />
                            <Button
                                type="button"
                                variant="outline"
                                size="icon"
                                onClick={() => onChange({ seed: randomSeed() })}
                                title="Randomise seed"
                            >
                                <Dices />
                                <span className="sr-only">Randomise seed</span>
                            </Button>
                        </div>
                        <InputError message={errors.seed} />
                    </div>
                )}

                {data.source !== 'real_world' && (
                    <div className="grid content-start gap-2">
                        <Label htmlFor={`${id}-size`}>Map size</Label>
                        <Select
                            value={String(data.size)}
                            onValueChange={(v) => onChange({ size: Number(v) })}
                        >
                            <SelectTrigger id={`${id}-size`} className="w-full">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {(PROCEDURAL_SIZES.includes(data.size)
                                    ? PROCEDURAL_SIZES
                                    : [...PROCEDURAL_SIZES, data.size].sort(
                                          (a, b) => a - b,
                                      )
                                ).map((size) => (
                                    <SelectItem key={size} value={String(size)}>
                                        {formatKm(size)} × {formatKm(size)}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <InputError message={errors.size} />
                    </div>
                )}

                <div className="grid content-start gap-2">
                    <Label htmlFor={`${id}-resolution`}>
                        Heightmap resolution
                    </Label>
                    <Select
                        value={String(data.resolution)}
                        onValueChange={(v) =>
                            onChange({ resolution: Number(v) })
                        }
                    >
                        <SelectTrigger
                            id={`${id}-resolution`}
                            className="w-full"
                        >
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {resolutions.map((resolution) => (
                                <SelectItem
                                    key={resolution}
                                    value={String(resolution)}
                                >
                                    {resolution} × {resolution}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                        {formatMetresPerSample(data.size, data.resolution)} per
                        sample. Higher resolutions give finer detail but use
                        more memory.
                    </p>
                    <InputError message={errors.resolution} />
                </div>
            </div>
        </div>
    );
}
