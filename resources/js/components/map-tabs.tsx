import { Link } from '@inertiajs/react';
import {
    Clapperboard,
    Info,
    Layers,
    Play,
    Star,
    SunMedium,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { MapStatusBadge } from '@/components/map-status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useCurrentUrl } from '@/hooks/use-current-url';
import { formatKm, SOURCE_LABELS } from '@/lib/format';
import { cn } from '@/lib/utils';
import maps from '@/routes/maps';
import type { MapSummary } from '@/types';

type Props = {
    map: MapSummary;
    /** Extra buttons shown before "Open Studio". */
    actions?: ReactNode;
    className?: string;
};

/** Header + tab navigation shared by the map overview, environment and terrain layer pages. */
export function MapTabs({ map, actions, className }: Props) {
    const { isCurrentUrl } = useCurrentUrl();

    const tabs = [
        { title: 'Overview', href: maps.show(map.slug), icon: Info },
        {
            title: 'Environment',
            href: maps.environment.edit(map.slug),
            icon: SunMedium,
        },
        {
            title: 'Terrain layers',
            href: maps.layers.index(map.slug),
            icon: Layers,
        },
    ];

    return (
        <div className={cn('space-y-5', className)}>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-2">
                    <h1 className="truncate text-2xl font-semibold tracking-tight">
                        {map.name}
                    </h1>
                    <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                        <Badge variant="secondary">
                            {SOURCE_LABELS[map.source]}
                        </Badge>
                        <MapStatusBadge status={map.terrain_status} />
                        {map.is_default && (
                            <Badge variant="outline" className="gap-1">
                                <Star className="fill-current text-amber-500" />
                                Default
                            </Badge>
                        )}
                        <span className="tabular-nums">
                            {formatKm(map.size)} × {formatKm(map.size)}
                        </span>
                    </div>
                </div>
                <div className="flex flex-wrap gap-2">
                    {actions}
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
                    <Button
                        asChild
                        className="bg-sky-600 text-white hover:bg-sky-600/90 dark:bg-sky-500 dark:hover:bg-sky-500/90"
                    >
                        <Link href={maps.editor(map.slug)}>
                            <Clapperboard />
                            Open Studio
                        </Link>
                    </Button>
                </div>
            </div>

            <nav
                aria-label="Map sections"
                className="-mx-4 overflow-x-auto border-b px-4 sm:mx-0 sm:px-0"
            >
                <ul className="flex min-w-max gap-1">
                    {tabs.map((tab) => {
                        const active = isCurrentUrl(tab.href);

                        return (
                            <li key={tab.title}>
                                <Link
                                    href={tab.href}
                                    prefetch
                                    preserveScroll
                                    aria-current={active ? 'page' : undefined}
                                    className={cn(
                                        '-mb-px flex items-center gap-2 border-b-2 border-transparent px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground',
                                        active &&
                                            'border-foreground text-foreground',
                                    )}
                                >
                                    <tab.icon className="size-4" />
                                    {tab.title}
                                </Link>
                            </li>
                        );
                    })}
                </ul>
            </nav>
        </div>
    );
}
