import type { FoliageKind } from '@game/shared/types';
import {
    Flower,
    Leaf,
    Mountain,
    Palmtree,
    Shrub,
    Sprout,
    TreePine,
    Trees,
    Wheat,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { FoliageAssetSource, FoliageAssetStatus } from '@/types';

export const FOLIAGE_ICONS: Record<FoliageKind, LucideIcon> = {
    conifer: TreePine,
    broadleaf: Trees,
    palm: Palmtree,
    bush: Shrub,
    grass: Sprout,
    flower: Flower,
    reed: Wheat,
    rock: Mountain,
};

export function kindIcon(kind: FoliageKind): LucideIcon {
    return FOLIAGE_ICONS[kind] ?? Leaf;
}

export const FOLIAGE_SOURCE_LABELS: Record<FoliageAssetSource, string> = {
    polyhaven: 'Poly Haven',
    upload: 'Upload',
    ai: 'AI',
};

/** "Meshy 3D", "AI card", "Upload", … for one asset. */
export function assetSourceLabel(asset: {
    source: FoliageAssetSource;
    source_type?: 'model' | 'card';
    bake_options?: { generator?: string };
}): string {
    if (asset.source === 'ai') {
        return asset.bake_options?.generator === 'meshy' ||
            asset.source_type === 'model'
            ? 'Meshy 3D'
            : 'AI card';
    }

    return FOLIAGE_SOURCE_LABELS[asset.source];
}

export const PENDING_STATUSES: FoliageAssetStatus[] = [
    'queued',
    'processing',
    'awaiting_bake',
];

/** Typical real-world height (m) per kind (mirrors FoliageLibrary::KIND_HEIGHT). */
export const KIND_HEIGHT: Record<FoliageKind, number> = {
    conifer: 14,
    broadleaf: 11,
    palm: 9,
    bush: 1.5,
    grass: 0.6,
    flower: 0.5,
    reed: 1.6,
    rock: 1,
};

export const foliageApi = {
    show: (id: number) => `/api/foliage/assets/${id}`,
    bake: (id: number) => `/api/foliage/assets/${id}/bake`,
    bakeFailed: (id: number) => `/api/foliage/assets/${id}/bake-failed`,
    plan: () => '/api/foliage/ai/plan',
};

/** "12.4k" style triangle counts. */
export function formatTriangles(n: number | null | undefined): string {
    if (n === null || n === undefined) {
        return '–';
    }

    if (n >= 1_000_000) {
        return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
    }

    if (n >= 1000) {
        return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
    }

    return String(n);
}

/** Metres with a sensible precision (0.35 m, 2.4 m, 18 m). */
export function formatMetres(m: number | null | undefined): string {
    if (m === null || m === undefined) {
        return '–';
    }

    const digits = m < 1 ? 2 : m < 10 ? 1 : 0;

    return `${m.toFixed(digits)} m`;
}
