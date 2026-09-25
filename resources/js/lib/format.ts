import type { MapSource, TerrainStatus } from '@game/shared/types';

/** "2.05 km" / "512 m" for a length in metres. */
export function formatKm(metres: number): string {
    if (metres < 1000) {
        return `${Math.round(metres)} m`;
    }

    const km = metres / 1000;

    return `${km.toFixed(km < 10 ? 2 : 1).replace(/\.?0+$/, '')} km`;
}

/** Metres between two height samples, e.g. "4.0 m". */
export function metresPerSample(size: number, resolution: number): number {
    return size / Math.max(1, resolution - 1);
}

export function formatMetresPerSample(
    size: number,
    resolution: number,
): string {
    return `${metresPerSample(size, resolution).toFixed(1)} m`;
}

/** "12–245 m". */
export function formatHeightRange(min: number, max: number): string {
    return `${Math.round(min)}–${Math.round(max)} m`;
}

export function formatNumber(value: number, maxFractionDigits = 2): string {
    return new Intl.NumberFormat(undefined, {
        maximumFractionDigits: maxFractionDigits,
    }).format(value);
}

export function formatCoordinate(value: number, axis: 'lat' | 'lng'): string {
    const hemisphere =
        axis === 'lat' ? (value >= 0 ? 'N' : 'S') : value >= 0 ? 'E' : 'W';

    return `${Math.abs(value).toFixed(4)}° ${hemisphere}`;
}

/** Hours (0-24, fractional) → "HH:MM". */
export function formatTimeOfDay(hours: number): string {
    const totalMinutes = Math.round(hours * 60) % (24 * 60);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;

    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function formatDateTime(iso: string | null | undefined): string {
    if (!iso) {
        return '—';
    }

    return new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
    }).format(new Date(iso));
}

export function formatRelative(iso: string | null | undefined): string {
    if (!iso) {
        return '—';
    }

    const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    const units: [Intl.RelativeTimeFormatUnit, number][] = [
        ['year', 31_536_000],
        ['month', 2_592_000],
        ['week', 604_800],
        ['day', 86_400],
        ['hour', 3_600],
        ['minute', 60],
    ];

    for (const [unit, secondsInUnit] of units) {
        if (Math.abs(seconds) >= secondsInUnit) {
            return rtf.format(Math.round(seconds / secondsInUnit), unit);
        }
    }

    return 'just now';
}

export const SOURCE_LABELS: Record<MapSource, string> = {
    procedural: 'Procedural',
    real_world: 'Real world',
    flat: 'Flat',
};

export const STATUS_LABELS: Record<TerrainStatus, string> = {
    ready: 'Ready',
    queued: 'Queued',
    importing: 'Generating',
    failed: 'Failed',
};

export function isPendingStatus(status: TerrainStatus): boolean {
    return status === 'queued' || status === 'importing';
}
