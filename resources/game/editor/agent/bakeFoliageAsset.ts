import type { FoliageKind } from '../../shared/types';

/** What the server sends with a 'bake_foliage_asset' command (see App\Mcp\Assets\EditorBakes). */
export type FoliageBakeJob = {
    asset_id: number;
    kind: FoliageKind;
    source_type: 'model' | 'card';
    source_url: string;
    target_height: number | null;
    key_background?: boolean;
    key_color?: string;
    bake_url: string;
    failed_url: string;
};

/** Bakes run one after another: each builds its own WebGL renderer and can be heavy. */
let queue: Promise<void> = Promise.resolve();

/**
 * Optimises ("bakes") a foliage asset in this tab, like the studio's foliage page does, so assets an
 * agent imports or generates become usable without that page: the game's FoliageBaker builds the LODs,
 * impostor and thumbnail, and the result is uploaded to the library. Runs in the background; the
 * server watches the asset's status. `onBaked` runs after a successful upload (e.g. to reload the
 * foliage types that use the asset).
 */
export function bakeFoliageAssetInBackground(
    job: FoliageBakeJob,
    onBaked: () => Promise<void>,
): void {
    queue = queue.then(() => bake(job, onBaked)).catch(() => undefined);
}

async function bake(
    job: FoliageBakeJob,
    onBaked: () => Promise<void>,
): Promise<void> {
    try {
        const { bakeFoliageAsset } = await import('../../tools/FoliageBaker');
        const result = await bakeFoliageAsset({
            kind: job.kind,
            source:
                job.source_type === 'card'
                    ? {
                          type: 'card',
                          url: job.source_url,
                          keyBackground: !!job.key_background,
                          keyColor: job.key_color,
                      }
                    : { type: 'model', url: job.source_url },
            targetHeight: job.target_height,
        });

        const body = new FormData();
        body.append('model', result.glb, 'model.glb');
        body.append('thumbnail', result.thumbnail, 'thumbnail.png');
        body.append('meta', JSON.stringify(result.meta));
        const response = await fetch(job.bake_url, {
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
        const message = error instanceof Error ? error.message : String(error);
        await fetch(job.failed_url, {
            method: 'POST',
            body: JSON.stringify({ message: message.slice(0, 900) }),
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            credentials: 'same-origin',
        }).catch(() => undefined);

        return;
    }

    await onBaked();
}
