import { router } from '@inertiajs/react';
import { useEffect, useRef, useState } from 'react';
import { usePendingPoll } from '@/hooks/use-pending-poll';
import { apiFetch, errorMessage } from '@/lib/api';
import { foliageApi, PENDING_STATUSES } from '@/lib/foliage';
import type { FoliageAssetStudio } from '@/types';

export type BakeState = {
    assetId: number;
    name: string;
    stage: string;
    fraction: number;
};

function webglAvailable(): boolean {
    try {
        const canvas = document.createElement('canvas');

        return !!canvas.getContext('webgl2');
    } catch {
        return false;
    }
}

/**
 * Optimises ("bakes") downloaded, uploaded and AI generated foliage assets in this browser, one at
 * a time: LODs, an impostor and a thumbnail are built with the game's FoliageBaker and uploaded.
 * Also polls the library while imports / generations are running on the server.
 */
export function useFoliageBakeQueue(assets: FoliageAssetStudio[]): {
    current: BakeState | null;
    waiting: number;
    supported: boolean;
} {
    const [current, setCurrent] = useState<BakeState | null>(null);
    const [supported] = useState(webglAvailable);
    const attempted = useRef(new Set<string>());
    const busy = useRef(false);

    const serverPending = assets.some(
        (a) => a.status === 'queued' || a.status === 'processing',
    );
    const waiting = assets.filter((a) => a.status === 'awaiting_bake');

    usePendingPoll(serverPending, ['assets', 'foliageTypes'], 2500);

    // A bake attempt is keyed by asset + last update, so a "re-bake" is picked up again.
    const next = waiting.find(
        (a) => !attempted.current.has(`${a.id}:${a.updated_at}`),
    );

    useEffect(() => {
        if (!supported || busy.current || !next || !next.source_file_url) {
            return;
        }

        const asset = next;
        attempted.current.add(`${asset.id}:${asset.updated_at}`);
        busy.current = true;
        setCurrent({
            assetId: asset.id,
            name: asset.name,
            stage: 'Loading optimiser…',
            fraction: 0,
        });

        void (async () => {
            try {
                const { bakeFoliageAsset } =
                    await import('@game/tools/FoliageBaker');
                const result = await bakeFoliageAsset(
                    {
                        kind: asset.kind,
                        source:
                            asset.source_type === 'card'
                                ? {
                                      type: 'card',
                                      url: asset.source_file_url!,
                                      keyBackground:
                                          !!asset.bake_options.key_background,
                                  }
                                : {
                                      type: 'model',
                                      url: asset.source_file_url!,
                                  },
                        targetHeight: asset.target_height,
                    },
                    (stage, fraction) =>
                        setCurrent({
                            assetId: asset.id,
                            name: asset.name,
                            stage,
                            fraction,
                        }),
                );

                setCurrent({
                    assetId: asset.id,
                    name: asset.name,
                    stage: 'Uploading…',
                    fraction: 1,
                });
                const body = new FormData();
                body.append('model', result.glb, 'model.glb');
                body.append('thumbnail', result.thumbnail, 'thumbnail.png');
                body.append('meta', JSON.stringify(result.meta));
                const response = await fetch(foliageApi.bake(asset.id), {
                    method: 'POST',
                    body,
                    headers: { Accept: 'application/json' },
                    credentials: 'same-origin',
                });

                if (!response.ok) {
                    const data = (await response.json().catch(() => ({}))) as {
                        message?: string;
                    };
                    throw new Error(
                        data.message ?? `Upload failed (${response.status})`,
                    );
                }
            } catch (error) {
                console.error('Foliage bake failed', error);
                await apiFetch(foliageApi.bakeFailed(asset.id), {
                    method: 'POST',
                    body: { message: errorMessage(error).slice(0, 900) },
                }).catch(() => undefined);
            } finally {
                busy.current = false;
                setCurrent(null);
                router.reload({ only: ['assets', 'foliageTypes'] });
            }
        })();
    }, [next, supported]);

    return {
        current,
        waiting: waiting.length,
        supported,
    };
}

export function isPending(asset: FoliageAssetStudio): boolean {
    return PENDING_STATUSES.includes(asset.status);
}
