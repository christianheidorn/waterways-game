import { useForm } from '@inertiajs/react';
import type { FoliageKind } from '@game/shared/types';
import {
    Check,
    Download,
    ExternalLink,
    Search,
    TriangleAlert,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { KindSelect } from '@/components/foliage/fields';
import { MaterialThumb } from '@/components/materials/material-thumb';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { apiFetch, errorMessage } from '@/lib/api';
import { foliageApi, formatTriangles, kindIcon } from '@/lib/foliage';
import foliage from '@/routes/foliage';
import type {
    FoliageAssetStudio,
    FoliageBrowseItem,
    FoliageBrowseResponse,
} from '@/types';

type Props = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    library: FoliageAssetStudio[];
    kinds: { value: FoliageKind; label: string }[];
};

/** Search Poly Haven's CC0 plant, tree and rock models and import them into the asset library. */
export function FoliageBrowseDialog({
    open,
    onOpenChange,
    library,
    kinds,
}: Props) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="flex max-h-[92vh] flex-col gap-0 p-0 sm:max-w-5xl">
                {open && <BrowseBody library={library} kinds={kinds} />}
            </DialogContent>
        </Dialog>
    );
}

function BrowseBody({
    library,
    kinds,
}: {
    library: FoliageAssetStudio[];
    kinds: { value: FoliageKind; label: string }[];
}) {
    const [query, setQuery] = useState('');
    const [debounced, setDebounced] = useState('');
    const [kind, setKind] = useState<string>('all');
    const [items, setItems] = useState<FoliageBrowseItem[]>([]);
    const [page, setPage] = useState(1);
    const [total, setTotal] = useState(0);
    const [hasMore, setHasMore] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const request = useRef<AbortController | null>(null);

    useEffect(() => {
        const t = window.setTimeout(() => setDebounced(query.trim()), 350);

        return () => window.clearTimeout(t);
    }, [query]);

    const load = (nextPage: number) => {
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        const params = new URLSearchParams({ page: String(nextPage) });

        if (debounced) {
            params.set('q', debounced);
        }

        if (kind !== 'all') {
            params.set('kind', kind);
        }

        setLoading(true);
        setError(null);
        apiFetch<FoliageBrowseResponse>(`${foliageApi.browse()}?${params}`, {
            signal: controller.signal,
        })
            .then((res) => {
                setItems((prev) =>
                    nextPage === 1 ? res.items : [...prev, ...res.items],
                );
                setPage(res.page);
                setHasMore(res.has_more);
                setTotal(res.total);
                setLoading(false);
            })
            .catch((e: unknown) => {
                if (controller.signal.aborted) {
                    return;
                }

                setError(errorMessage(e));
                setLoading(false);
            });
    };

    useEffect(() => {
        load(1);

        return () => request.current?.abort();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [debounced, kind]);

    const imported = new Set(
        library
            .filter(
                (a) =>
                    a.source === 'polyhaven' &&
                    a.source_ref &&
                    a.status !== 'failed',
            )
            .map((a) => a.source_ref as string),
    );

    return (
        <>
            <DialogHeader className="border-b p-4 sm:p-6">
                <DialogTitle>Browse Poly Haven models</DialogTitle>
                <DialogDescription>
                    Photoscanned plants, trees and rocks, free under CC0.
                    Imports are downloaded to your library and then optimised in
                    this browser (LODs, impostor, texture size) so they run well
                    as instanced foliage.{' '}
                    <a
                        href="https://polyhaven.com/models"
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-0.5 font-medium text-sky-700 hover:underline dark:text-sky-400"
                    >
                        Visit Poly Haven
                        <ExternalLink className="size-3" />
                    </a>
                </DialogDescription>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                    <div className="relative flex-1">
                        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            type="search"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Search trees, shrubs, grass, rocks…"
                            aria-label="Search Poly Haven models"
                            className="pl-8"
                        />
                    </div>
                    <KindSelect
                        kinds={kinds}
                        value={kind}
                        onChange={setKind}
                        allowAll
                        className="sm:w-48"
                    />
                </div>
            </DialogHeader>

            <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
                {error && (
                    <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-700 dark:text-red-300">
                        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                        <div className="flex-1">
                            Could not load Poly Haven: {error}
                        </div>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => load(page)}
                        >
                            Retry
                        </Button>
                    </div>
                )}

                {!loading && !error && total > 0 && (
                    <p className="mb-3 text-xs text-muted-foreground">
                        {total} models
                    </p>
                )}

                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                    {items.map((item) => (
                        <BrowseCard
                            key={item.ref}
                            item={item}
                            imported={imported.has(item.ref)}
                            kindLabel={
                                kinds.find((k) => k.value === item.kind)
                                    ?.label ?? item.kind
                            }
                        />
                    ))}
                    {loading &&
                        Array.from({ length: items.length ? 4 : 8 }).map(
                            (_, i) => (
                                <div
                                    key={`s${i}`}
                                    className="overflow-hidden rounded-xl border"
                                >
                                    <Skeleton className="aspect-square rounded-none" />
                                    <div className="grid gap-2 p-3">
                                        <Skeleton className="h-4 w-3/4" />
                                        <Skeleton className="h-3 w-1/2" />
                                        <Skeleton className="h-8 w-full" />
                                    </div>
                                </div>
                            ),
                        )}
                </div>

                {!loading && !error && items.length === 0 && (
                    <p className="py-12 text-center text-sm text-muted-foreground">
                        No models match your search.
                    </p>
                )}

                {hasMore && !loading && (
                    <div className="mt-6 flex justify-center">
                        <Button
                            variant="outline"
                            onClick={() => load(page + 1)}
                        >
                            Load more
                        </Button>
                    </div>
                )}
            </div>
        </>
    );
}

function BrowseCard({
    item,
    imported,
    kindLabel,
}: {
    item: FoliageBrowseItem;
    imported: boolean;
    kindLabel: string;
}) {
    const form = useForm({ refs: [item.ref], kind: item.kind });
    const [done, setDone] = useState(false);
    const errors = form.errors as Partial<Record<string, string>>;
    const error = errors.refs ?? errors['refs.0'] ?? errors.kind;
    const Icon = kindIcon(item.kind);
    const inLibrary = imported || done;

    return (
        <article className="flex flex-col overflow-hidden rounded-xl border bg-card shadow-xs">
            <div className="relative">
                <MaterialThumb
                    src={item.thumbnail_url}
                    alt={item.name}
                    className="aspect-square"
                />
                {inLibrary && (
                    <Badge className="absolute top-2 left-2 bg-emerald-600 text-white">
                        <Check />
                        In library
                    </Badge>
                )}
                <Badge
                    variant="secondary"
                    className="absolute right-2 bottom-2 bg-background/85 backdrop-blur"
                >
                    <Icon />
                    {kindLabel}
                </Badge>
            </div>
            <div className="flex flex-1 flex-col gap-2 p-3">
                <div className="min-w-0">
                    <h3
                        className="truncate text-sm font-medium"
                        title={item.name}
                    >
                        <a
                            href={item.source_url}
                            target="_blank"
                            rel="noreferrer"
                            className="hover:underline"
                        >
                            {item.name}
                        </a>
                    </h3>
                    <p className="truncate text-xs text-muted-foreground">
                        {formatTriangles(item.polycount)} triangles ·{' '}
                        {[item.author, item.license]
                            .filter(Boolean)
                            .join(' · ')}
                    </p>
                </div>
                {item.too_heavy ? (
                    <p className="mt-auto rounded-md bg-amber-500/10 p-2 text-[11px] text-amber-800 dark:text-amber-300">
                        Too heavy for real-time foliage (
                        {formatTriangles(item.polycount)} triangles).
                    </p>
                ) : (
                    <Button
                        size="sm"
                        className="mt-auto"
                        variant={inLibrary ? 'outline' : 'default'}
                        disabled={form.processing || inLibrary}
                        onClick={() =>
                            form.submit(foliage.assets.import(), {
                                preserveScroll: true,
                                preserveState: true,
                                onSuccess: () => setDone(true),
                            })
                        }
                    >
                        {form.processing ? <Spinner /> : <Download />}
                        {inLibrary ? 'Imported' : 'Import'}
                    </Button>
                )}
                {error && (
                    <p className="text-xs text-red-600 dark:text-red-400">
                        {error}
                    </p>
                )}
            </div>
        </article>
    );
}
