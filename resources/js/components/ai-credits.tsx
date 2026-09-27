import { Link } from '@inertiajs/react';
import { Box, Coins, RefreshCw, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from '@/components/ui/tooltip';
import { apiFetch, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import aiSettings from '@/routes/ai-settings';
import type { AiCredits as Credits } from '@/types';

type State = { data: Credits | null; loading: boolean; error: string | null };

// One shared request for every mounted badge.
let cache: { at: number; data: Credits } | null = null;
let inflight: Promise<Credits> | null = null;
const listeners = new Set<(data: Credits) => void>();

function load(fresh: boolean): Promise<Credits> {
    if (!fresh && cache && Date.now() - cache.at < 30_000) {
        return Promise.resolve(cache.data);
    }

    if (!inflight) {
        inflight = apiFetch<Credits>(
            `/api/ai/credits${fresh ? '?fresh=1' : ''}`,
        )
            .then((data) => {
                cache = { at: Date.now(), data };
                listeners.forEach((l) => l(data));

                return data;
            })
            .finally(() => {
                inflight = null;
            });
    }

    return inflight;
}

/** Reload the credit badges (e.g. after starting a paid generation). */
export function refreshAiCredits(): void {
    void load(true).catch(() => undefined);
}

export function useAiCredits(): State & { refresh: () => void } {
    const [state, setState] = useState<State>({
        data: cache?.data ?? null,
        loading: !cache,
        error: null,
    });

    const run = useCallback((fresh: boolean) => {
        setState((s) => ({ ...s, loading: true, error: null }));
        load(fresh)
            .then((data) => setState({ data, loading: false, error: null }))
            .catch((e: unknown) =>
                setState((s) => ({
                    ...s,
                    loading: false,
                    error: errorMessage(e),
                })),
            );
    }, []);

    useEffect(() => {
        const listener = (data: Credits) =>
            setState({ data, loading: false, error: null });
        listeners.add(listener);
        run(false);

        return () => {
            listeners.delete(listener);
        };
    }, [run]);

    return { ...state, refresh: () => run(true) };
}

export function formatUsd(value: number): string {
    return `$${value.toFixed(value < 10 ? 2 : 0)}`;
}

/**
 * Remaining OpenRouter and Meshy credits as compact pills with a refresh button.
 * `providers` limits which ones are shown.
 */
export function AiCreditsBadge({
    providers = ['openrouter', 'meshy'],
    className,
}: {
    providers?: ('openrouter' | 'meshy')[];
    className?: string;
}) {
    const { data, loading, error, refresh } = useAiCredits();
    const pills: {
        key: string;
        icon: typeof Coins;
        label: string;
        title: string;
        warn: boolean;
    }[] = [];

    if (data && providers.includes('openrouter')) {
        const o = data.openrouter;
        const value = o.remaining ?? o.key_limit_remaining ?? null;
        pills.push({
            key: 'openrouter',
            icon: Coins,
            label: !o.configured
                ? 'OpenRouter: no key'
                : o.error
                  ? 'OpenRouter: ?'
                  : value !== null
                    ? `OpenRouter ${formatUsd(value)}`
                    : 'OpenRouter',
            title: !o.configured
                ? 'Add an OpenRouter key under Settings → AI'
                : (o.error ??
                      [
                          o.remaining !== null && o.remaining !== undefined
                              ? `${formatUsd(o.remaining)} of ${formatUsd(o.total ?? 0)} account credits left`
                              : null,
                          o.key_limit_remaining !== null &&
                          o.key_limit_remaining !== undefined
                              ? `this key's limit: ${formatUsd(o.key_limit_remaining)} left`
                              : null,
                      ]
                          .filter(Boolean)
                          .join(' · ')) ||
                  'OpenRouter credits',
            warn: !o.configured || !!o.error || (value !== null && value < 1),
        });
    }

    if (data && providers.includes('meshy')) {
        const m = data.meshy;
        pills.push({
            key: 'meshy',
            icon: Box,
            label: !m.configured
                ? 'Meshy: no key'
                : m.error
                  ? 'Meshy: ?'
                  : `Meshy ${(m.balance ?? 0).toLocaleString()} credits`,
            title: !m.configured
                ? 'Add a Meshy key under Settings → AI'
                : (m.error ??
                  'Meshy credits left (a textured model uses about 30)'),
            warn: !m.configured || !!m.error || (m.balance ?? 0) < 30,
        });
    }

    return (
        <div
            className={cn(
                'flex flex-wrap items-center gap-1.5 text-xs',
                className,
            )}
            aria-live="polite"
        >
            {pills.map((p) => {
                const Icon = p.icon;
                const pill = (
                    <span
                        className={cn(
                            'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 tabular-nums',
                            p.warn
                                ? 'border-amber-500/40 text-amber-800 dark:text-amber-300'
                                : 'text-muted-foreground',
                        )}
                    >
                        {p.warn ? (
                            <TriangleAlert className="size-3" />
                        ) : (
                            <Icon className="size-3" />
                        )}
                        {p.label}
                    </span>
                );

                return (
                    <Tooltip key={p.key}>
                        <TooltipTrigger asChild>
                            {p.label.endsWith('no key') ? (
                                <Link href={aiSettings.edit()}>{pill}</Link>
                            ) : (
                                pill
                            )}
                        </TooltipTrigger>
                        <TooltipContent>{p.title}</TooltipContent>
                    </Tooltip>
                );
            })}
            {error && (
                <span className="text-amber-700 dark:text-amber-400">
                    Credits unavailable
                </span>
            )}
            <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6"
                onClick={refresh}
                disabled={loading}
                aria-label="Refresh credits"
            >
                <RefreshCw
                    className={cn('size-3', loading && 'animate-spin')}
                />
            </Button>
        </div>
    );
}
