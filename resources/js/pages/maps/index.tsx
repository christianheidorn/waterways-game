import { Head, Link } from '@inertiajs/react';
import { Clapperboard, MapPlus, Settings2, Star } from 'lucide-react';
import Heading from '@/components/heading';
import { MapStatusBadge, TerrainProgress } from '@/components/map-status';
import { MapThumbnail } from '@/components/map-thumbnail';
import { TopoLines } from '@/components/topo-lines';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { usePendingPoll } from '@/hooks/use-pending-poll';
import {
    formatKm,
    formatMetresPerSample,
    isPendingStatus,
    SOURCE_LABELS,
} from '@/lib/format';
import maps from '@/routes/maps';
import type { MapSummary } from '@/types';

export default function MapsIndex({ maps: allMaps }: { maps: MapSummary[] }) {
    usePendingPoll(
        allMaps.some((m) => isPendingStatus(m.terrain_status)),
        ['maps'],
    );

    return (
        <>
            <Head title="Maps" />
            <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 p-4 sm:p-6">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <Heading
                        title="Maps"
                        description="Every world you have created. Open one in the studio to sculpt, paint and plant it."
                    />
                    <Button asChild>
                        <Link href={maps.create()}>
                            <MapPlus />
                            New map
                        </Link>
                    </Button>
                </div>

                {allMaps.length === 0 ? (
                    <div className="relative flex flex-col items-center justify-center overflow-hidden rounded-2xl border border-dashed px-6 py-16 text-center">
                        <TopoLines
                            seed={11}
                            className="absolute inset-0 size-full text-muted-foreground/10"
                        />
                        <div className="relative space-y-4">
                            <h2 className="text-lg font-semibold">
                                No maps yet
                            </h2>
                            <p className="max-w-sm text-sm text-muted-foreground">
                                Create a procedural valley, import a real place,
                                or start from a flat canvas.
                            </p>
                            <Button asChild>
                                <Link href={maps.create()}>
                                    <MapPlus />
                                    Create your first map
                                </Link>
                            </Button>
                        </div>
                    </div>
                ) : (
                    <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                        {allMaps.map((map) => (
                            <MapCard key={map.id} map={map} />
                        ))}
                    </div>
                )}
            </div>
        </>
    );
}

function MapCard({ map }: { map: MapSummary }) {
    return (
        <article className="flex flex-col overflow-hidden rounded-xl border bg-card shadow-xs transition-shadow hover:shadow-md">
            <Link
                href={maps.show(map.slug)}
                className="relative block"
                aria-label={`${map.name} overview`}
            >
                <MapThumbnail map={map} />
                <div className="absolute top-3 left-3 flex gap-1.5">
                    <Badge className="bg-background/90 text-foreground shadow-sm backdrop-blur">
                        {SOURCE_LABELS[map.source]}
                    </Badge>
                    {map.is_default && (
                        <Badge className="bg-background/90 text-foreground shadow-sm backdrop-blur">
                            <Star className="fill-current text-amber-500" />
                            Default
                        </Badge>
                    )}
                </div>
            </Link>
            <div className="flex flex-1 flex-col gap-4 p-4">
                <div className="space-y-1.5">
                    <div className="flex items-start justify-between gap-2">
                        <h2 className="min-w-0 truncate font-semibold">
                            <Link
                                href={maps.show(map.slug)}
                                className="hover:underline"
                            >
                                {map.name}
                            </Link>
                        </h2>
                        <MapStatusBadge status={map.terrain_status} />
                    </div>
                    {map.description && (
                        <p className="line-clamp-2 text-sm text-muted-foreground">
                            {map.description}
                        </p>
                    )}
                </div>

                <dl className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                        <dt className="text-xs text-muted-foreground">Size</dt>
                        <dd className="font-medium tabular-nums">
                            {formatKm(map.size)} × {formatKm(map.size)}
                        </dd>
                    </div>
                    <div>
                        <dt className="text-xs text-muted-foreground">
                            Resolution
                        </dt>
                        <dd className="font-medium tabular-nums">
                            {map.resolution}²{' '}
                            <span className="font-normal text-muted-foreground">
                                ·{' '}
                                {formatMetresPerSample(
                                    map.size,
                                    map.resolution,
                                )}
                            </span>
                        </dd>
                    </div>
                </dl>

                <TerrainProgress
                    status={map.terrain_status}
                    progress={map.terrain_progress}
                    message={map.terrain_message}
                />

                <div className="mt-auto flex flex-wrap gap-2 pt-1">
                    <Button size="sm" asChild>
                        <Link href={maps.editor(map.slug)}>
                            <Clapperboard />
                            Open studio
                        </Link>
                    </Button>
                    <Button size="sm" variant="outline" asChild>
                        <Link href={maps.show(map.slug)}>
                            <Settings2 />
                            Settings
                        </Link>
                    </Button>
                </div>
            </div>
        </article>
    );
}

MapsIndex.layout = {
    breadcrumbs: [{ title: 'Maps', href: maps.index() }],
};
