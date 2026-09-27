import { useForm } from '@inertiajs/react';
import { Paintbrush, Save, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import InputError from '@/components/input-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { usePendingPoll } from '@/hooks/use-pending-poll';
import { LANDCOVER_CLASSES } from '@/lib/materials';
import { cn } from '@/lib/utils';
import maps from '@/routes/maps';
import type { MapDetail } from '@/types';

type LayerOption = { slot: number; name: string };

const REPAINT_WARNING = (
    <span className="flex gap-2">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
        <span>
            All painted terrain layers are replaced by the land cover mapping.
            Hand-painted details are lost (sculpting, water and foliage are
            kept).
        </span>
    </span>
);

type Props = {
    map: MapDetail;
    /** Terrain layers of the map (slot + name) for the mapping selects. */
    layers?: LayerOption[];
    className?: string;
};

/** Land cover (ESA WorldCover) statistics, class → layer mapping and repaint action. */
export function LandcoverCard({ map, layers, className }: Props) {
    const stats = map.landcover_stats ?? {};
    const legend = map.landcover_classes?.length
        ? map.landcover_classes.map((c) => ({ ...c, code: String(c.code) }))
        : LANDCOVER_CLASSES;
    const layerOptions: LayerOption[] =
        layers ??
        Array.from({ length: 8 }, (_, slot) => ({
            slot,
            name: `Channel ${slot + 1}`,
        }));
    const mappingForm = useForm<{ mapping: Record<string, number | null> }>({
        mapping: Object.fromEntries(
            legend.map((c) => [
                c.code,
                map.landcover_mapping?.[c.code] ?? null,
            ]),
        ),
    });
    const applyForm = useForm({});
    // Repainting is queued: refresh the map for a while so stats / revision update.
    const [repainting, setRepainting] = useState(false);

    useEffect(() => {
        if (!repainting) {
            return;
        }

        const t = window.setTimeout(() => setRepainting(false), 30000);

        return () => window.clearTimeout(t);
    }, [repainting]);

    usePendingPoll(repainting, ['map'], 3000);

    const classes = legend.map((c) => ({
        ...c,
        percent: stats[c.code] ?? 0,
    }));
    const present = classes
        .filter((c) => c.percent > 0)
        .sort((a, b) => b.percent - a.percent);
    const hasStats = present.length > 0;
    const editable = hasStats ? present : classes;
    const max = Math.max(1, ...present.map((c) => c.percent));

    const saveMapping = (close: () => void) =>
        mappingForm.submit(maps.landcover.mapping(map.slug), {
            preserveScroll: true,
            onSuccess: () => {
                mappingForm.setDefaults();
                setRepainting(true);
                close();
            },
        });

    return (
        <section
            className={cn(
                'rounded-xl border bg-card p-4 shadow-xs sm:p-6',
                className,
            )}
            aria-labelledby="landcover-title"
        >
            <div className="mb-1 flex items-center justify-between gap-3">
                <h2 id="landcover-title" className="text-sm font-semibold">
                    Land cover
                </h2>
                <Badge
                    variant="outline"
                    className={cn(
                        map.use_landcover &&
                            'border-emerald-500/40 text-emerald-700 dark:text-emerald-400',
                    )}
                >
                    {map.use_landcover ? 'Used for painting' : 'Off'}
                </Badge>
            </div>
            <p className="mb-4 text-xs text-muted-foreground">
                Terrain layers are painted from real land cover (forest,
                grassland, cropland, built-up, water…) at 10 m resolution.
                Source:{' '}
                <a
                    href="https://esa-worldcover.org"
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-2 hover:text-foreground"
                >
                    ESA WorldCover 2021
                </a>{' '}
                ({map.landcover_attribution ?? '© ESA, CC-BY 4.0'}; contains
                modified Copernicus Sentinel data).
                {!map.use_landcover &&
                    ' Turn on “Use land cover” when regenerating the terrain to paint from it automatically.'}
            </p>

            {!map.landcover_available ? (
                <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                    No land cover data yet. It is downloaded when the terrain is
                    generated with “Use land cover” enabled.
                </div>
            ) : (
                <div className="grid gap-6">
                    {hasStats && (
                        <ul className="grid gap-1.5" aria-label="Class shares">
                            {present.map((c) => (
                                <li
                                    key={c.code}
                                    className="grid grid-cols-[7.5rem_1fr_3rem] items-center gap-2 text-xs"
                                >
                                    <span className="truncate" title={c.label}>
                                        {c.label}
                                    </span>
                                    <span className="h-3 overflow-hidden rounded-sm bg-muted">
                                        <span
                                            className="block h-full rounded-sm ring-1 ring-black/10 ring-inset dark:ring-white/10"
                                            style={{
                                                width: `${(c.percent / max) * 100}%`,
                                                backgroundColor: c.color,
                                            }}
                                        />
                                    </span>
                                    <span className="text-right text-muted-foreground tabular-nums">
                                        {c.percent < 0.1
                                            ? '<0.1'
                                            : c.percent.toFixed(1)}
                                        %
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}

                    <div className="grid gap-3">
                        <div>
                            <h3 className="text-sm font-medium">
                                Class → layer
                            </h3>
                            <p className="text-xs text-muted-foreground">
                                Which terrain layer each land cover class
                                paints. “Default” picks a layer by name (forest,
                                grass, rock…).
                            </p>
                        </div>
                        <div className="grid gap-2">
                            {editable.map((c) => {
                                const value = mappingForm.data.mapping[c.code];

                                return (
                                    <div
                                        key={c.code}
                                        className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1 sm:grid-cols-[auto_8.5rem_1fr]"
                                    >
                                        <span
                                            className="size-3 rounded-sm ring-1 ring-black/15 ring-inset dark:ring-white/15"
                                            style={{
                                                backgroundColor: c.color,
                                            }}
                                            aria-hidden
                                        />
                                        <span className="truncate text-xs">
                                            {c.label}
                                        </span>
                                        <Select
                                            value={
                                                value === null ||
                                                value === undefined
                                                    ? 'none'
                                                    : String(value)
                                            }
                                            onValueChange={(v) =>
                                                mappingForm.setData((prev) => ({
                                                    mapping: {
                                                        ...prev.mapping,
                                                        [c.code]:
                                                            v === 'none'
                                                                ? null
                                                                : Number(v),
                                                    },
                                                }))
                                            }
                                        >
                                            <SelectTrigger
                                                size="sm"
                                                className="col-span-2 w-full sm:col-span-1"
                                                aria-label={`Layer for ${c.label}`}
                                            >
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="none">
                                                    <span className="text-muted-foreground">
                                                        Default
                                                    </span>
                                                </SelectItem>
                                                {layerOptions.map((l) => (
                                                    <SelectItem
                                                        key={l.slot}
                                                        value={String(l.slot)}
                                                    >
                                                        {l.slot + 1} · {l.name}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                );
                            })}
                        </div>
                        <InputError
                            message={
                                Object.values(
                                    mappingForm.errors as Record<
                                        string,
                                        string
                                    >,
                                )[0]
                            }
                        />
                        <div className="flex flex-wrap items-center gap-2 pt-1">
                            <ConfirmDialog
                                trigger={
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        disabled={
                                            mappingForm.processing ||
                                            !mappingForm.isDirty
                                        }
                                    >
                                        <Save />
                                        Save mapping
                                    </Button>
                                }
                                title="Save mapping and repaint?"
                                description={REPAINT_WARNING}
                                confirmLabel="Save and repaint"
                                destructive
                                processing={mappingForm.processing}
                                onConfirm={saveMapping}
                            />
                            <ConfirmDialog
                                trigger={
                                    <Button
                                        type="button"
                                        size="sm"
                                        disabled={mappingForm.isDirty}
                                        title={
                                            mappingForm.isDirty
                                                ? 'Save the mapping first'
                                                : undefined
                                        }
                                    >
                                        <Paintbrush />
                                        Repaint from land cover
                                    </Button>
                                }
                                title="Repaint terrain from land cover?"
                                description={REPAINT_WARNING}
                                confirmLabel="Repaint"
                                destructive
                                processing={applyForm.processing}
                                onConfirm={(close) =>
                                    applyForm.submit(
                                        maps.landcover.apply(map.slug),
                                        {
                                            preserveScroll: true,
                                            onSuccess: () => {
                                                setRepainting(true);
                                                close();
                                            },
                                        },
                                    )
                                }
                            />
                        </div>
                    </div>
                </div>
            )}
        </section>
    );
}
