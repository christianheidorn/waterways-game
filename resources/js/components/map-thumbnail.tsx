import type { MapSource } from '@game/shared/types';
import { Globe, Mountain, Square } from 'lucide-react';
import { TopoLines } from '@/components/topo-lines';
import { cn } from '@/lib/utils';

const GRADIENTS: Record<MapSource, string> = {
    procedural:
        'from-emerald-200 via-teal-200 to-sky-300 dark:from-emerald-950 dark:via-teal-900 dark:to-sky-900',
    real_world:
        'from-sky-200 via-cyan-200 to-indigo-300 dark:from-sky-950 dark:via-cyan-900 dark:to-indigo-900',
    flat: 'from-amber-100 via-stone-200 to-lime-200 dark:from-stone-900 dark:via-stone-800 dark:to-lime-950',
};

const ICONS = {
    procedural: Mountain,
    real_world: Globe,
    flat: Square,
} satisfies Record<MapSource, unknown>;

type Props = {
    map: {
        id: number;
        name: string;
        source: MapSource;
        thumbnail_url: string | null;
    };
    className?: string;
    showIcon?: boolean;
};

/** A map's saved thumbnail, or a gradient + contour-line placeholder. */
export function MapThumbnail({ map, className, showIcon = true }: Props) {
    const Icon = ICONS[map.source];

    return (
        <div
            className={cn(
                'relative aspect-video w-full overflow-hidden bg-muted',
                className,
            )}
        >
            {map.thumbnail_url ? (
                <img
                    src={map.thumbnail_url}
                    alt={`Preview of ${map.name}`}
                    loading="lazy"
                    className="absolute inset-0 size-full object-cover"
                />
            ) : (
                <div
                    className={cn(
                        'absolute inset-0 bg-gradient-to-br',
                        GRADIENTS[map.source],
                    )}
                >
                    <TopoLines
                        seed={map.id}
                        className="absolute inset-0 size-full text-teal-900/25 dark:text-teal-100/20"
                    />
                    {showIcon && (
                        <Icon
                            aria-hidden="true"
                            className="absolute right-3 bottom-3 size-5 text-teal-950/40 dark:text-white/40"
                        />
                    )}
                </div>
            )}
        </div>
    );
}
