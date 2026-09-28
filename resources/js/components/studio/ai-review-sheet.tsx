import type { ShellToGameMessage } from '@game/shared/protocol';
import { Link } from '@inertiajs/react';
import {
    Camera,
    Check,
    CheckCheck,
    RefreshCw,
    Sparkles,
    TriangleAlert,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { GameScreenshot } from '@/components/studio/use-game-bridge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
} from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { apiFetch, errorMessage, isAiNotConfigured } from '@/lib/api';
import { materialApi } from '@/lib/materials';
import { cn } from '@/lib/utils';
import aiSettings from '@/routes/ai-settings';
import type {
    AiAppliedChanges,
    AiChanges,
    AiReview,
    AiReviewSuggestion,
} from '@/types';

type Props = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    mapSlug: string;
    ready: boolean;
    captureScreenshot: () => Promise<GameScreenshot>;
    send: (message: ShellToGameMessage) => void;
};

type Phase = 'idle' | 'capturing' | 'reviewing' | 'done' | 'error';

/** Merges several suggestion change sets into one (later ones win per key / slot). */
function mergeChanges(list: AiChanges[]): AiChanges {
    const environment: Record<string, unknown> = {};
    const layers = new Map<number, NonNullable<AiChanges['layers']>[number]>();

    list.forEach((c) => {
        Object.assign(environment, c.environment ?? {});
        c.layers?.forEach((l) =>
            layers.set(l.slot, { ...layers.get(l.slot), ...l }),
        );
    });

    return {
        ...(Object.keys(environment).length
            ? { environment: environment as AiChanges['environment'] }
            : {}),
        ...(layers.size ? { layers: [...layers.values()] } : {}),
    };
}

function describeChanges(changes: AiChanges): string[] {
    const out: string[] = [];

    Object.entries(changes.environment ?? {}).forEach(([k, v]) =>
        out.push(`${k.replace(/_/g, ' ')} → ${formatValue(v)}`),
    );
    changes.layers?.forEach((l) => {
        const { slot, ...rest } = l;
        Object.entries(rest).forEach(([k, v]) =>
            out.push(
                `layer ${slot + 1} ${k.replace(/_/g, ' ')} → ${formatValue(v)}`,
            ),
        );
    });

    return out;
}

function formatValue(v: unknown): string {
    if (typeof v === 'number') {
        return String(Number(v.toPrecision(Math.abs(v) < 1 ? 2 : 4)));
    }

    if (v === null) {
        return 'none';
    }

    if (typeof v === 'object') {
        return JSON.stringify(v);
    }

    return String(v as string | boolean | undefined);
}

/** AI review of the current game view, with one-click application of suggestions. */
export function AiReviewSheet({
    open,
    onOpenChange,
    mapSlug,
    ready,
    captureScreenshot,
    send,
}: Props) {
    const [phase, setPhase] = useState<Phase>('idle');
    const [shot, setShot] = useState<GameScreenshot | null>(null);
    const [review, setReview] = useState<AiReview | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [notConfigured, setNotConfigured] = useState(false);
    const [applied, setApplied] = useState<Set<number>>(new Set());
    const [applying, setApplying] = useState<number | 'all' | null>(null);

    const run = async () => {
        setPhase('capturing');
        setError(null);
        setNotConfigured(false);
        setReview(null);
        setApplied(new Set());

        try {
            const capture = await captureScreenshot();
            setShot(capture);
            setPhase('reviewing');
            const result = await apiFetch<AiReview>(
                materialApi.review(mapSlug),
                {
                    method: 'POST',
                    body: {
                        image: capture.dataUrl,
                        mode: capture.mode,
                        camera: capture.camera,
                    },
                },
            );
            setReview(result);
            setPhase('done');
        } catch (e) {
            if (isAiNotConfigured(e)) {
                setNotConfigured(true);
            }

            setError(errorMessage(e));
            setPhase('error');
        }
    };

    const apply = async (
        changes: AiChanges,
        indices: number[],
        key: number | 'all',
    ) => {
        setApplying(key);

        try {
            const result = await apiFetch<AiAppliedChanges>(
                materialApi.applyChanges(mapSlug),
                { method: 'POST', body: { changes } },
            );

            if (result.environment) {
                send({
                    type: 'updateEnvironment',
                    environment: result.environment,
                });
            }

            if (result.layers) {
                send({ type: 'updateLayers', layers: result.layers });
            }

            setApplied((prev) => new Set([...prev, ...indices]));
            toast.success(
                indices.length > 1
                    ? `Applied ${indices.length} suggestions`
                    : 'Suggestion applied',
                { description: 'Saved to the map and updated in the game.' },
            );
        } catch (e) {
            toast.error(`Could not apply: ${errorMessage(e)}`);
        } finally {
            setApplying(null);
        }
    };

    const pendingIndices =
        review?.suggestions
            .map((_, i) => i)
            .filter(
                (i) =>
                    !applied.has(i) &&
                    describeChanges(review.suggestions[i].changes).length > 0,
            ) ?? [];

    const busy = phase === 'capturing' || phase === 'reviewing';

    return (
        <Sheet modal={false} open={open} onOpenChange={onOpenChange}>
            <SheetContent
                overlay={false}
                onInteractOutside={(e) => e.preventDefault()}
                className="dark w-full gap-0 overflow-y-auto border-white/10 bg-neutral-900 text-neutral-100 sm:max-w-lg"
            >
                <SheetHeader className="border-b border-white/10">
                    <SheetTitle className="flex items-center gap-2">
                        <Sparkles className="size-4 text-violet-400" />
                        AI review
                    </SheetTitle>
                    <SheetDescription>
                        Sends a screenshot of the current view to your
                        OpenRouter vision model and suggests lighting,
                        atmosphere and material tweaks.
                    </SheetDescription>
                </SheetHeader>

                <div className="grid gap-5 p-4">
                    {phase === 'idle' && (
                        <div className="grid gap-3 rounded-lg border border-dashed border-white/15 p-5 text-center text-sm text-neutral-400">
                            <Camera className="mx-auto size-6" />
                            Frame the view you want reviewed, then start. Editor
                            overlays are hidden in the screenshot.
                        </div>
                    )}

                    {shot && (
                        <figure className="relative overflow-hidden rounded-lg border border-white/10">
                            <img
                                src={shot.dataUrl}
                                alt="Screenshot sent for review"
                                className={cn(
                                    'block aspect-video w-full object-cover',
                                    busy && 'opacity-60',
                                )}
                            />
                            {review && (
                                <ScoreBadge
                                    score={review.score}
                                    className="absolute top-2 right-2"
                                />
                            )}
                            {busy && (
                                <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm font-medium">
                                    <Spinner />
                                    Reviewing…
                                </div>
                            )}
                        </figure>
                    )}

                    {phase === 'capturing' && !shot && (
                        <div className="flex items-center justify-center gap-2 py-8 text-sm text-neutral-400">
                            <Spinner />
                            Capturing screenshot…
                        </div>
                    )}

                    {phase === 'error' && error && (
                        <div className="grid gap-3 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
                            <div className="flex gap-2">
                                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                                {error}
                            </div>
                            {notConfigured && (
                                <Button
                                    asChild
                                    size="sm"
                                    variant="outline"
                                    className="justify-self-start"
                                >
                                    <Link href={aiSettings.edit()}>
                                        Open AI settings
                                    </Link>
                                </Button>
                            )}
                        </div>
                    )}

                    {review && (
                        <>
                            <p className="text-sm leading-relaxed text-neutral-200">
                                {review.summary}
                            </p>
                            <div className="grid gap-3">
                                {review.suggestions.map((s, i) => (
                                    <SuggestionCard
                                        key={i}
                                        suggestion={s}
                                        applied={applied.has(i)}
                                        applying={
                                            applying === i || applying === 'all'
                                        }
                                        disabled={applying !== null}
                                        onApply={() => apply(s.changes, [i], i)}
                                    />
                                ))}
                                {review.suggestions.length === 0 && (
                                    <p className="text-sm text-neutral-400">
                                        No changes suggested — looks good!
                                    </p>
                                )}
                            </div>
                        </>
                    )}

                    <div className="flex flex-wrap gap-2 border-t border-white/10 pt-4">
                        <Button
                            onClick={run}
                            disabled={busy || !ready}
                            className="bg-violet-600 text-white hover:bg-violet-500"
                            title={
                                ready ? undefined : 'Wait for the game to load'
                            }
                        >
                            {busy ? (
                                <Spinner />
                            ) : review || error ? (
                                <RefreshCw />
                            ) : (
                                <Sparkles />
                            )}
                            {review || error
                                ? 'Review again'
                                : 'Review this view'}
                        </Button>
                        {review && pendingIndices.length > 1 && (
                            <Button
                                variant="outline"
                                disabled={applying !== null}
                                onClick={() =>
                                    apply(
                                        mergeChanges(
                                            pendingIndices.map(
                                                (i) =>
                                                    review.suggestions[i]
                                                        .changes,
                                            ),
                                        ),
                                        pendingIndices,
                                        'all',
                                    )
                                }
                            >
                                {applying === 'all' ? (
                                    <Spinner />
                                ) : (
                                    <CheckCheck />
                                )}
                                Apply all ({pendingIndices.length})
                            </Button>
                        )}
                    </div>
                    <p className="-mt-2 text-xs text-neutral-500">
                        Costs are charged to your OpenRouter credits. Applied
                        changes are saved to the map right away.
                    </p>
                </div>
            </SheetContent>
        </Sheet>
    );
}

function ScoreBadge({
    score,
    className,
}: {
    score: number;
    className?: string;
}) {
    const outOf = score > 10 ? 100 : 10;
    const ratio = score / outOf;

    return (
        <span
            className={cn(
                'rounded-md px-2 py-1 text-sm font-semibold tabular-nums shadow backdrop-blur',
                ratio >= 0.75
                    ? 'bg-emerald-500/85 text-white'
                    : ratio >= 0.5
                      ? 'bg-amber-500/85 text-black'
                      : 'bg-red-500/85 text-white',
                className,
            )}
            title="Overall score"
        >
            {Math.round(score * 10) / 10}
            <span className="text-xs font-normal opacity-80">/{outOf}</span>
        </span>
    );
}

function SuggestionCard({
    suggestion,
    applied,
    applying,
    disabled,
    onApply,
}: {
    suggestion: AiReviewSuggestion;
    applied: boolean;
    applying: boolean;
    disabled: boolean;
    onApply: () => void;
}) {
    const changes = describeChanges(suggestion.changes);

    return (
        <article
            className={cn(
                'grid gap-2 rounded-lg border border-white/10 bg-white/[0.03] p-3',
                applied && 'border-emerald-500/30 bg-emerald-500/5',
            )}
        >
            <div className="flex items-start gap-2">
                <h3 className="flex-1 text-sm font-medium">
                    {suggestion.title}
                </h3>
                {changes.length > 0 &&
                    (applied ? (
                        <Badge className="bg-emerald-600 text-white">
                            <Check />
                            Applied
                        </Badge>
                    ) : (
                        <Button
                            size="sm"
                            variant="secondary"
                            className="h-7"
                            disabled={disabled}
                            onClick={onApply}
                        >
                            {applying ? <Spinner /> : <Check />}
                            Apply
                        </Button>
                    ))}
            </div>
            <p className="text-sm text-neutral-400">{suggestion.detail}</p>
            {changes.length > 0 && (
                <ul className="flex flex-wrap gap-1">
                    {changes.map((c) => (
                        <li
                            key={c}
                            className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[11px] text-neutral-300"
                        >
                            {c}
                        </li>
                    ))}
                </ul>
            )}
        </article>
    );
}
