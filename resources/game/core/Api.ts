import type { FoliageFile, GameManifest, MapInfo } from '../shared/types';
import type { BootConfig } from './config';

/**
 * HTTP client for the Laravel map data API.
 */
export class Api {
    constructor(private readonly config: BootConfig) {}

    async manifest(): Promise<GameManifest> {
        return this.json<GameManifest>(this.config.manifestUrl);
    }

    async status(): Promise<{
        status: string;
        progress: number;
        message: string | null;
        revision: number;
    }> {
        return this.json(this.config.statusUrl);
    }

    async binary(
        url: string,
        onProgress?: (fraction: number) => void,
    ): Promise<ArrayBuffer> {
        const response = await fetch(url, { credentials: 'same-origin' });

        if (!response.ok) {
            throw new Error(`Failed to load ${url} (${response.status})`);
        }

        const total = Number(response.headers.get('Content-Length')) || 0;

        if (!onProgress || !response.body || !total) {
            return response.arrayBuffer();
        }

        const reader = response.body.getReader();
        const out = new Uint8Array(total);
        let received = 0;

        for (;;) {
            const { done, value } = await reader.read();

            if (done) {
                break;
            }

            out.set(value, received);
            received += value.length;
            onProgress(received / total);
        }

        return out.buffer;
    }

    async foliage(url: string): Promise<FoliageFile> {
        return this.json<FoliageFile>(url);
    }

    /** Uploads a binary asset, gzip-compressed when the browser supports CompressionStream. */
    async putBinary(
        url: string,
        data: ArrayBufferView | string,
        headers: Record<string, string> = {},
    ): Promise<{ revision: number }> {
        const raw: BlobPart =
            typeof data === 'string' ? data : (data as Uint8Array<ArrayBuffer>);
        let body: BodyInit = new Blob([raw]);
        const extra: Record<string, string> = { ...headers };

        if (typeof CompressionStream !== 'undefined') {
            const stream = new Blob([raw])
                .stream()
                .pipeThrough(new CompressionStream('gzip'));
            body = await new Response(stream).blob();
            extra['X-Payload-Encoding'] = 'gzip';
        }

        return this.request(url, 'PUT', body, {
            'Content-Type': 'application/octet-stream',
            ...extra,
        });
    }

    async patchJson<T>(url: string, payload: unknown): Promise<T> {
        return this.request(url, 'PATCH', JSON.stringify(payload), {
            'Content-Type': 'application/json',
        });
    }

    async postJson<T>(url: string, payload: unknown): Promise<T> {
        return this.request(url, 'POST', JSON.stringify(payload), {
            'Content-Type': 'application/json',
        });
    }

    async saveSpawn(url: string, spawn: MapInfo['spawn']): Promise<void> {
        await this.patchJson(url, { spawn });
    }

    private async json<T>(url: string): Promise<T> {
        const response = await fetch(url, {
            credentials: 'same-origin',
            headers: { Accept: 'application/json' },
        });

        if (!response.ok) {
            throw new Error(`Request to ${url} failed (${response.status})`);
        }

        return (await response.json()) as T;
    }

    private async request<T>(
        url: string,
        method: string,
        body: BodyInit,
        headers: Record<string, string>,
    ): Promise<T> {
        const response = await fetch(url, {
            method,
            body,
            credentials: 'same-origin',
            headers: {
                Accept: 'application/json',
                'X-CSRF-TOKEN': this.config.csrfToken,
                ...headers,
            },
        });

        if (!response.ok) {
            let message = `${method} ${url} failed (${response.status})`;

            try {
                const json = (await response.json()) as { message?: string };
                message = json.message ?? message;
            } catch {
                // Non-JSON error body.
            }

            throw new Error(message);
        }

        return (await response.json()) as T;
    }
}
