import type { TerrainStatus } from '@game/shared/types';
import { TriangleAlert, CircleCheck, Clock, LoaderCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { isPendingStatus, STATUS_LABELS } from '@/lib/format';
import { cn } from '@/lib/utils';

const STATUS_CLASSES: Record<TerrainStatus, string> = {
    ready: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    queued: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
    importing: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
    failed: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300',
};

const STATUS_ICONS = {
    ready: CircleCheck,
    queued: Clock,
    importing: LoaderCircle,
    failed: TriangleAlert,
} satisfies Record<TerrainStatus, unknown>;

export function MapStatusBadge({
    status,
    className,
}: {
    status: TerrainStatus;
    className?: string;
}) {
    const Icon = STATUS_ICONS[status];

    return (
        <Badge
            variant="outline"
            className={cn(STATUS_CLASSES[status], className)}
        >
            <Icon
                className={cn(status === 'importing' && 'animate-spin')}
                aria-hidden="true"
            />
            {STATUS_LABELS[status]}
        </Badge>
    );
}

/** Progress bar + message for a map whose terrain is queued / generating / failed. */
export function TerrainProgress({
    status,
    progress,
    message,
    className,
}: {
    status: TerrainStatus;
    progress: number;
    message: string | null;
    className?: string;
}) {
    if (status === 'ready') {
        return null;
    }

    if (status === 'failed') {
        return (
            <p
                className={cn(
                    'text-sm text-red-600 dark:text-red-400',
                    className,
                )}
            >
                {message || 'Terrain generation failed.'}
            </p>
        );
    }

    return (
        <div className={cn('space-y-1.5', className)}>
            <Progress
                value={isPendingStatus(status) ? progress : 100}
                aria-label="Terrain generation progress"
                className="bg-sky-500/15"
                indicatorClassName="bg-sky-500"
            />
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="truncate">
                    {message ||
                        (status === 'queued'
                            ? 'Waiting for a worker…'
                            : 'Generating terrain…')}
                </span>
                <span className="tabular-nums">{Math.round(progress)}%</span>
            </div>
        </div>
    );
}
