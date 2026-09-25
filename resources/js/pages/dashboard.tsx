import { Head, Link } from '@inertiajs/react';
import {
    ArrowRight,
    Clapperboard,
    Globe,
    Map as MapIcon,
    MapPlus,
    Play,
    Star,
    Trees,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { MapStatusBadge, TerrainProgress } from '@/components/map-status';
import { MapThumbnail } from '@/components/map-thumbnail';
import { TopoLines } from '@/components/topo-lines';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { usePendingPoll } from '@/hooks/use-pending-poll';
import {
    formatHeightRange,
    formatKm,
    formatRelative,
    isPendingStatus,
    SOURCE_LABELS,
} from '@/lib/format';
import { dashboard } from '@/routes';
import foliage from '@/routes/foliage';
import maps from '@/routes/maps';
import type { MapSummary } from '@/types';

type Props = {
    maps: MapSummary[];
    stats: {
        maps: number;
        foliageTypes: number;
        realWorldMaps: number;
    };
};

export default function Dashboard({ maps: allMaps, stats }: Props) {
    const featured = allMaps.find((m) => m.is_default) ?? allMaps[0];
    const recent = allMaps.filter((m) => m.id !== featured?.id).slice(0, 6);

    usePendingPoll(
        allMaps.some((m) => isPendingStatus(m.terrain_status)),
        ['maps'],
    );

    return (
        <>
            <Head title="Dashboard" />
            <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 p-4 sm:p-6">
                {featured ? <ContinueCard map={featured} /> : <EmptyHero />}

                <section
                    aria-label="Statistics"
                    className="grid gap-4 sm:grid-cols-3"
                >
                    <StatCard
                        icon={MapIcon}
                        label="Maps"
                        value={stats.maps}
                        href={maps.index()}
                    />
                    <StatCard
                        icon={Trees}
                        label="Foliage types"
                        value={stats.foliageTypes}
                        href={foliage.index()}
                    />
                    <StatCard
                        icon={Globe}
                        label="Real-world maps"
                        value={stats.realWorldMaps}
                        href={maps.index()}
                    />
                </section>

                {allMaps.length > 0 && (
                    <section className="space-y-4">
                        <div className="flex items-center justify-between gap-4">
                            <h2 className="text-lg font-semibold tracking-tight">
                                Recent maps
                            </h2>
                            <div className="flex gap-2">
                                <Button variant="ghost" size="sm" asChild>
                                    <Link href={maps.index()}>
                                        All maps
                                        <ArrowRight />
                                    </Link>
                                </Button>
                                <Button variant="outline" size="sm" asChild>
                                    <Link href={maps.create()}>
                                        <MapPlus />
                                        New map
                                    </Link>
                                </Button>
                            </div>
                        </div>
                        {recent.length > 0 ? (
                            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                                {recent.map((map) => (
                                    <RecentMapCard key={map.id} map={map} />
                                ))}
                            </div>
                        ) : (
                            <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
                                Only one map so far.{' '}
                                <Link
                                    href={maps.create()}
                                    className="font-medium text-foreground underline underline-offset-4"
                                >
                                    Create another
                                </Link>{' '}
                                to try a different place or seed.
                            </p>
                        )}
                    </section>
                )}
            </div>
        </>
    );
}

function ContinueCard({ map }: { map: MapSummary }) {
    return (
        <section
            aria-labelledby="continue-heading"
            className="overflow-hidden rounded-2xl border bg-card shadow-sm"
        >
            <div className="grid md:grid-cols-5">
                <Link
                    href={maps.editor(map.slug)}
                    className="group relative block md:col-span-3"
                    aria-label={`Open ${map.name} in the studio`}
                >
                    <MapThumbnail
                        map={map}
                        className="h-full min-h-52 transition-transform duration-500 group-hover:scale-[1.02]"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent md:bg-gradient-to-r md:from-transparent md:via-transparent md:to-black/5" />
                </Link>
                <div className="flex flex-col justify-between gap-6 p-6 md:col-span-2">
                    <div className="space-y-3">
                        <p className="text-xs font-medium tracking-wider text-sky-600 uppercase dark:text-sky-400">
                            Continue building
                        </p>
                        <h1
                            id="continue-heading"
                            className="text-2xl font-semibold tracking-tight"
                        >
                            {map.name}
                        </h1>
                        {map.description && (
                            <p className="line-clamp-3 text-sm text-muted-foreground">
                                {map.description}
                            </p>
                        )}
                        <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="secondary">
                                {SOURCE_LABELS[map.source]}
                            </Badge>
                            <MapStatusBadge status={map.terrain_status} />
                            {map.is_default && (
                                <Badge variant="outline">
                                    <Star className="fill-current text-amber-500" />
                                    Default
                                </Badge>
                            )}
                        </div>
                        <dl className="grid grid-cols-3 gap-2 pt-2 text-sm">
                            <Fact label="Size" value={formatKm(map.size)} />
                            <Fact
                                label="Heights"
                                value={formatHeightRange(
                                    map.min_height,
                                    map.max_height,
                                )}
                            />
                            <Fact
                                label="Edited"
                                value={formatRelative(map.updated_at)}
                            />
                        </dl>
                        <TerrainProgress
                            status={map.terrain_status}
                            progress={map.terrain_progress}
                            message={map.terrain_message}
                        />
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <Button
                            asChild
                            className="bg-sky-600 text-white hover:bg-sky-600/90 dark:bg-sky-500 dark:hover:bg-sky-500/90"
                        >
                            <Link href={maps.editor(map.slug)}>
                                <Clapperboard />
                                Open in Studio
                            </Link>
                        </Button>
                        <Button variant="outline" asChild>
                            <Link
                                href={maps.editor(map.slug, {
                                    query: { mode: 'play' },
                                })}
                            >
                                <Play />
                                Play test
                            </Link>
                        </Button>
                        <Button variant="ghost" asChild>
                            <Link href={maps.show(map.slug)}>Details</Link>
                        </Button>
                    </div>
                </div>
            </div>
        </section>
    );
}

function Fact({ label, value }: { label: string; value: string }) {
    return (
        <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="truncate font-medium tabular-nums">{value}</dd>
        </div>
    );
}

function EmptyHero() {
    return (
        <section className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-sky-100 via-teal-50 to-emerald-100 p-8 sm:p-12 dark:from-sky-950 dark:via-teal-950 dark:to-emerald-950">
            <TopoLines
                seed={3}
                className="absolute inset-0 size-full text-teal-900/15 dark:text-teal-100/10"
            />
            <div className="relative max-w-xl space-y-4">
                <p className="text-xs font-medium tracking-wider text-sky-700 uppercase dark:text-sky-300">
                    Welcome to Waterways
                </p>
                <h1 className="text-3xl font-semibold tracking-tight">
                    Build your first world
                </h1>
                <p className="text-muted-foreground">
                    Start from generated hills and rivers, a real place on
                    Earth, or a blank canvas. You can sculpt, paint and plant it
                    in the studio afterwards.
                </p>
                <Button asChild size="lg">
                    <Link href={maps.create()}>
                        <MapPlus />
                        Create your first map
                    </Link>
                </Button>
            </div>
        </section>
    );
}

function StatCard({
    icon: Icon,
    label,
    value,
    href,
}: {
    icon: LucideIcon;
    label: string;
    value: number;
    href: ReturnType<typeof maps.index>;
}) {
    return (
        <Link
            href={href}
            className="group flex items-center gap-4 rounded-xl border bg-card p-5 shadow-xs transition-colors hover:bg-accent/50"
        >
            <div className="flex size-11 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600 dark:text-sky-400">
                <Icon className="size-5" />
            </div>
            <div>
                <div className="text-2xl font-semibold tabular-nums">
                    {value}
                </div>
                <div className="text-sm text-muted-foreground">{label}</div>
            </div>
            <ArrowRight className="ml-auto size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        </Link>
    );
}

function RecentMapCard({ map }: { map: MapSummary }) {
    return (
        <article className="group overflow-hidden rounded-xl border bg-card shadow-xs transition-shadow hover:shadow-md">
            <Link href={maps.show(map.slug)} className="block">
                <MapThumbnail map={map} />
            </Link>
            <div className="space-y-3 p-4">
                <div className="flex items-start justify-between gap-2">
                    <Link
                        href={maps.show(map.slug)}
                        className="min-w-0 truncate font-medium hover:underline"
                    >
                        {map.name}
                    </Link>
                    <MapStatusBadge status={map.terrain_status} />
                </div>
                <p className="text-xs text-muted-foreground">
                    {SOURCE_LABELS[map.source]} · {formatKm(map.size)} · edited{' '}
                    {formatRelative(map.updated_at)}
                </p>
                <TerrainProgress
                    status={map.terrain_status}
                    progress={map.terrain_progress}
                    message={map.terrain_message}
                />
                <div className="flex gap-2">
                    <Button size="sm" variant="secondary" asChild>
                        <Link href={maps.editor(map.slug)}>
                            <Clapperboard />
                            Studio
                        </Link>
                    </Button>
                    <Button size="sm" variant="ghost" asChild>
                        <Link href={maps.show(map.slug)}>Settings</Link>
                    </Button>
                </div>
            </div>
        </article>
    );
}

Dashboard.layout = {
    breadcrumbs: [
        {
            title: 'Dashboard',
            href: dashboard(),
        },
    ],
};
