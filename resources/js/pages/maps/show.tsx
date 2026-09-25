import { Head, useForm } from '@inertiajs/react';
import { RefreshCw, Star, Trash2, TriangleAlert } from 'lucide-react';
import type { FormEvent, ReactNode } from 'react';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { GeoAreaPreview } from '@/components/geo-area-picker';
import InputError from '@/components/input-error';
import { MapStatusBadge, TerrainProgress } from '@/components/map-status';
import { MapTabs } from '@/components/map-tabs';
import { MapThumbnail } from '@/components/map-thumbnail';
import type { TerrainFormData } from '@/components/terrain-source-fields';
import { TerrainSourceFields } from '@/components/terrain-source-fields';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { usePendingPoll } from '@/hooks/use-pending-poll';
import {
    formatCoordinate,
    formatDateTime,
    formatHeightRange,
    formatKm,
    formatMetresPerSample,
    formatNumber,
    isPendingStatus,
    SOURCE_LABELS,
} from '@/lib/format';
import { cn } from '@/lib/utils';
import maps from '@/routes/maps';
import type { MapDetail } from '@/types';

type Props = {
    map: MapDetail;
    resolutions: number[];
};

export default function ShowMap({ map, resolutions }: Props) {
    const pending = isPendingStatus(map.terrain_status);

    usePendingPoll(pending, ['map']);

    return (
        <>
            <Head title={map.name} />
            <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 p-4 sm:p-6">
                <MapTabs map={map} />

                <div className="grid gap-6 lg:grid-cols-3">
                    <div className="space-y-6 lg:col-span-2">
                        <Panel className="overflow-hidden p-0 sm:p-0">
                            <MapThumbnail map={map} className="aspect-[16/7]" />
                            <div className="flex flex-col gap-3 p-4 sm:p-6">
                                <div className="flex items-center justify-between gap-3">
                                    <h2 className="text-sm font-semibold">
                                        Terrain
                                    </h2>
                                    <MapStatusBadge
                                        status={map.terrain_status}
                                    />
                                </div>
                                {map.terrain_status === 'ready' ? (
                                    <p className="text-sm text-muted-foreground">
                                        Last generated{' '}
                                        {formatDateTime(
                                            map.terrain_generated_at,
                                        )}
                                        . Revision {map.revision}.
                                    </p>
                                ) : (
                                    <TerrainProgress
                                        status={map.terrain_status}
                                        progress={map.terrain_progress}
                                        message={map.terrain_message}
                                    />
                                )}
                            </div>
                        </Panel>

                        <DetailsForm map={map} />
                    </div>

                    <div className="space-y-6">
                        <Panel title="Key facts">
                            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                                <Fact label="Source">
                                    {SOURCE_LABELS[map.source]}
                                </Fact>
                                <Fact label="Size">
                                    {formatKm(map.size)} × {formatKm(map.size)}
                                </Fact>
                                <Fact label="Resolution">
                                    {map.resolution} × {map.resolution}
                                </Fact>
                                <Fact label="Cell size">
                                    {formatMetresPerSample(
                                        map.size,
                                        map.resolution,
                                    )}
                                </Fact>
                                <Fact label="Height range">
                                    {formatHeightRange(
                                        map.min_height,
                                        map.max_height,
                                    )}
                                </Fact>
                                {map.source === 'procedural' && (
                                    <Fact label="Seed">{map.seed}</Fact>
                                )}
                                {map.source === 'real_world' && (
                                    <>
                                        <Fact label="Height scale">
                                            {formatNumber(map.height_scale)}×
                                        </Fact>
                                        <Fact label="Water import">
                                            {map.import_water ? 'On' : 'Off'}
                                        </Fact>
                                    </>
                                )}
                                <Fact label="Last generated" wide>
                                    {formatDateTime(map.terrain_generated_at)}
                                </Fact>
                            </dl>
                        </Panel>

                        {map.center_lat !== null && map.center_lng !== null && (
                            <Panel title="Location">
                                {map.bounds && (
                                    <GeoAreaPreview
                                        bounds={map.bounds}
                                        className="mb-4 h-48"
                                    />
                                )}
                                <dl className="grid gap-3 text-sm">
                                    <Fact label="Centre">
                                        {formatCoordinate(
                                            map.center_lat,
                                            'lat',
                                        )}
                                        ,{' '}
                                        {formatCoordinate(
                                            map.center_lng,
                                            'lng',
                                        )}
                                    </Fact>
                                    {map.bounds && (
                                        <Fact label="Bounds">
                                            <span className="block text-xs leading-relaxed font-normal text-muted-foreground">
                                                N {map.bounds.north.toFixed(4)}°
                                                · S{' '}
                                                {map.bounds.south.toFixed(4)}
                                                °
                                                <br />W{' '}
                                                {map.bounds.west.toFixed(4)}° ·
                                                E {map.bounds.east.toFixed(4)}°
                                            </span>
                                        </Fact>
                                    )}
                                </dl>
                            </Panel>
                        )}

                        <Panel title="Actions">
                            <div className="grid gap-2">
                                <MakeDefaultButton map={map} />
                                <RegenerateDialog
                                    map={map}
                                    resolutions={resolutions}
                                    disabled={pending}
                                />
                                <DeleteMapButton map={map} />
                            </div>
                        </Panel>
                    </div>
                </div>
            </div>
        </>
    );
}

function Panel({
    title,
    children,
    className,
}: {
    title?: string;
    children: ReactNode;
    className?: string;
}) {
    return (
        <section
            className={cn(
                'rounded-xl border bg-card p-4 shadow-xs sm:p-6',
                className,
            )}
        >
            {title && <h2 className="mb-4 text-sm font-semibold">{title}</h2>}
            {children}
        </section>
    );
}

function Fact({
    label,
    children,
    wide = false,
}: {
    label: string;
    children: ReactNode;
    wide?: boolean;
}) {
    return (
        <div className={cn('min-w-0', wide && 'col-span-2')}>
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="font-medium tabular-nums">{children}</dd>
        </div>
    );
}

function DetailsForm({ map }: { map: MapDetail }) {
    const form = useForm({
        name: map.name,
        description: map.description ?? '',
    });

    const submit = (e: FormEvent) => {
        e.preventDefault();
        form.submit(maps.update(map.slug), {
            preserveScroll: true,
            onSuccess: () => form.setDefaults(),
        });
    };

    return (
        <Panel title="Details">
            <form onSubmit={submit} className="grid gap-5">
                <div className="grid gap-2">
                    <Label htmlFor="map-name">Name</Label>
                    <Input
                        id="map-name"
                        value={form.data.name}
                        onChange={(e) => form.setData('name', e.target.value)}
                        required
                        maxLength={120}
                        aria-invalid={form.errors.name ? true : undefined}
                    />
                    <InputError message={form.errors.name} />
                </div>
                <div className="grid gap-2">
                    <Label htmlFor="map-description">Description</Label>
                    <Textarea
                        id="map-description"
                        value={form.data.description}
                        onChange={(e) =>
                            form.setData('description', e.target.value)
                        }
                        rows={3}
                        maxLength={2000}
                        placeholder="What is this world about?"
                    />
                    <InputError message={form.errors.description} />
                </div>
                <div className="flex items-center gap-3">
                    <Button
                        type="submit"
                        disabled={form.processing || !form.isDirty}
                    >
                        {form.processing && <Spinner />}
                        Save details
                    </Button>
                    {form.recentlySuccessful && (
                        <span className="text-sm text-muted-foreground">
                            Saved
                        </span>
                    )}
                </div>
            </form>
        </Panel>
    );
}

function MakeDefaultButton({ map }: { map: MapDetail }) {
    const form = useForm({});

    if (map.is_default) {
        return (
            <div className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
                <Star className="size-4 fill-current text-amber-500" />
                This is the default map
            </div>
        );
    }

    return (
        <Button
            variant="outline"
            className="justify-start"
            disabled={form.processing}
            onClick={() =>
                form.submit(maps.default(map.slug), { preserveScroll: true })
            }
        >
            {form.processing ? <Spinner /> : <Star />}
            Make default
        </Button>
    );
}

function RegenerateDialog({
    map,
    resolutions,
    disabled,
}: {
    map: MapDetail;
    resolutions: number[];
    disabled: boolean;
}) {
    const [open, setOpen] = useState(false);
    const form = useForm<TerrainFormData>({
        source: map.source,
        resolution: map.resolution,
        size: map.size,
        center_lat: map.center_lat,
        center_lng: map.center_lng,
        height_scale: map.height_scale,
        import_water: map.import_water,
        seed: map.seed,
    });

    const submit = (e: FormEvent) => {
        e.preventDefault();
        form.transform((data) => ({
            ...data,
            center_lat: data.source === 'real_world' ? data.center_lat : null,
            center_lng: data.source === 'real_world' ? data.center_lng : null,
        }));
        form.submit(maps.regenerate(map.slug), {
            preserveScroll: true,
            onSuccess: () => setOpen(false),
        });
    };

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button
                    variant="outline"
                    className="justify-start"
                    disabled={disabled}
                >
                    <RefreshCw />
                    Regenerate terrain…
                </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
                <form onSubmit={submit} className="grid gap-6">
                    <DialogHeader>
                        <DialogTitle>Regenerate terrain</DialogTitle>
                        <DialogDescription>
                            Rebuild {map.name} from a source. You can keep the
                            current settings or pick a new area, seed or
                            resolution.
                        </DialogDescription>
                    </DialogHeader>

                    <Alert variant="destructive">
                        <TriangleAlert />
                        <AlertTitle>Your edits will be discarded</AlertTitle>
                        <AlertDescription>
                            Sculpting, painted terrain layers, water edits and
                            placed foliage are replaced by the freshly generated
                            terrain. Environment settings and layer definitions
                            are kept.
                        </AlertDescription>
                    </Alert>

                    <TerrainSourceFields
                        data={form.data}
                        onChange={(patch) =>
                            form.setData((prev) => ({ ...prev, ...patch }))
                        }
                        errors={form.errors}
                        resolutions={resolutions}
                        compact
                    />

                    <DialogFooter className="gap-2">
                        <DialogClose asChild>
                            <Button type="button" variant="secondary">
                                Cancel
                            </Button>
                        </DialogClose>
                        <Button
                            type="submit"
                            variant="destructive"
                            disabled={form.processing}
                        >
                            {form.processing ? <Spinner /> : <RefreshCw />}
                            Discard edits and regenerate
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function DeleteMapButton({ map }: { map: MapDetail }) {
    const form = useForm({});

    return (
        <ConfirmDialog
            trigger={
                <Button
                    variant="ghost"
                    className="justify-start text-red-600 hover:bg-red-500/10 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                >
                    <Trash2 />
                    Delete map
                </Button>
            }
            title={`Delete ${map.name}?`}
            description="The map, its terrain, paint, water and foliage will be permanently removed. This cannot be undone."
            confirmLabel="Delete map"
            destructive
            processing={form.processing}
            onConfirm={() => form.submit(maps.destroy(map.slug))}
        />
    );
}

ShowMap.layout = (props: Props) => ({
    breadcrumbs: [
        { title: 'Maps', href: maps.index() },
        { title: props.map.name, href: maps.show(props.map.slug) },
    ],
});
