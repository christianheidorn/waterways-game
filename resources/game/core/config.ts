import type { GameMode } from '../shared/protocol';

export type BootConfig = {
    mapSlug: string;
    manifestUrl: string;
    statusUrl: string;
    mode: GameMode;
    embedded: boolean;
    studioUrl: string;
    csrfToken: string;
};

declare global {
    interface Window {
        __WATERWAYS__?: BootConfig;
    }
}

export function readBootConfig(): BootConfig {
    const config = window.__WATERWAYS__;

    if (!config) {
        throw new Error('Missing game boot configuration.');
    }

    return config;
}
