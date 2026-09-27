import { useEffect, useState } from 'react';
import { apiFetch, errorMessage } from '@/lib/api';
import { materialApi } from '@/lib/materials';
import type { AiModels } from '@/types';

let cache: Promise<AiModels> | null = null;

/** Loads the OpenRouter model lists once per page load (shared by all dialogs). */
export function useAiModels(enabled = true, reloadKey = 0) {
    const [models, setModels] = useState<AiModels | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!enabled) {
            return;
        }

        let cancelled = false;

        if (reloadKey > 0) {
            cache = null;
        }

        cache ??= apiFetch<AiModels>(materialApi.models());
        setLoading(true);
        setError(null);
        cache
            .then((result) => {
                if (!cancelled) {
                    setModels(result);
                }
            })
            .catch((e: unknown) => {
                cache = null;

                if (!cancelled) {
                    setError(errorMessage(e));
                }
            })
            .finally(() => {
                if (!cancelled) {
                    setLoading(false);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [enabled, reloadKey]);

    return { models, error, loading };
}
