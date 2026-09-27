import { useForm } from '@inertiajs/react';
import {
    Check,
    Download,
    ExternalLink,
    Search,
    TriangleAlert,
} from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { CategorySelect } from '@/components/materials/fields';
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
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { apiFetch, errorMessage } from '@/lib/api';
import { MATERIAL_SOURCE_LABELS, materialApi } from '@/lib/materials';
import materials from '@/routes/materials';
import type {
    BrowseItem,
    BrowseResponse,
    BrowseSource,
    CategoryOption,
    MaterialStudio,
} from '@/types';

type Props = {
    source: BrowseSource | null;
    onOpenChange: (open: boolean) => void;
    categories: CategoryOption[];
    library: MaterialStudio[];
};

const SITES: Record<BrowseSource, { url: string; blurb: string }> = {
    polyhaven: {
        url: 'https://polyhaven.com/textures',
        blurb: 'High quality scanned textures, free under CC0.',
    },
    ambientcg: {
        url: 'https://ambientcg.com',
        blurb: 'Thousands of free PBR materials, all CC0.',
    },
};

/** Search Poly Haven / ambientCG and import materials into the library. */
export function BrowseDialog({
    source,
    onOpenChange,
    categories,
    library,
}: Props) {
    return (
        <Dialog open={source !== null} onOpenChange={onOpenChange}>
            <DialogContent className="flex max-h-[92vh] flex-col gap-0 p-0 sm:max-w-5xl">
                {source && (
                    <BrowseBody
                        key={source}
                        source={source}
                        categories={categories}
                        library={library}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}

function BrowseBody({
    source,
    categories,
    library,
}: {
    source: BrowseSource;
    categories: CategoryOption[];
    library: MaterialStudio[];
}) {
    const id = useId();
    const [query, setQuery] = useState('');
    const [debounced, setDebounced] = useState('');
    const [category, setCategory] = useState('all');
    const [items, setItems] = useState<BrowseItem[]>([]);
    const [page, setPage] = useState(1);
    const [hasMore, setHasMore] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const request = useRef<AbortController | null>(null);
    const label = MATERIAL_SOURCE_LABELS[source];

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

        if (category !== 'all') {
            params.set('category', category);
        }

        setLoading(true);
        setError(null);
        apiFetch<BrowseResponse>(`${materialApi.browse(source)}?${params}`, {
            signal: controller.signal,
        })
            .then((res) => {
                setItems((prev) =>
                    nextPage === 1 ? res.items : [...prev, ...res.items],
                );
                setPage(res.page);
                setHasMore(res.has_more);
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
    }, [debounced, category, source]);

    const imported = new Set(
        library
            .filter((m) => m.source === source && m.source_ref)
            .map((m) => m.source_ref as string),
    );

    return (
        <>
            <DialogHeader className="border-b p-4 sm:p-6">
                <DialogTitle>Browse {label}</DialogTitle>
                <DialogDescription>
                    {SITES[source].blurb} Imported materials are downloaded to
                    your library with author and licence (CC0) attribution.{' '}
                    <a
                        href={SITES[source].url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-0.5 font-medium text-sky-700 hover:underline dark:text-sky-400"
                    >
                        Visit {label}
                        <ExternalLink className="size-3" />
                    </a>
                </DialogDescription>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                    <div className="relative flex-1">
                        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            id={`${id}-q`}
                            type="search"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder={`Search ${label}…`}
                            aria-label={`Search ${label}`}
                            className="pl-8"
                        />
                    </div>
                    <CategorySelect
                        categories={categories}
                        value={category}
                        onChange={setCategory}
                        allowAll
                        label={null}
                        className="sm:w-52"
                    />
                </div>
            </DialogHeader>

            <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
                {error && (
                    <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-700 dark:text-red-300">
                        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                        <div className="flex-1">
                            Could not load {label}: {error}
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

                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                    {items.map((item) => (
                        <BrowseCard
                            key={item.ref}
                            source={source}
                            item={item}
                            imported={imported.has(item.ref)}
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
                        No materials match your search.
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
    source,
    item,
    imported,
}: {
    source: BrowseSource;
    item: BrowseItem;
    imported: boolean;
}) {
    const form = useForm({
        source,
        ref: item.ref,
        resolution: '1k' as '1k' | '2k' | '4k',
        name: item.name,
    });
    const [done, setDone] = useState(false);
    const errors = form.errors as Partial<Record<string, string>>;
    const error = errors.ref ?? errors.resolution ?? errors.source;

    const importItem = () =>
        form.submit(materials.import(), {
            preserveScroll: true,
            preserveState: true,
            onSuccess: () => setDone(true),
        });

    return (
        <article className="flex flex-col overflow-hidden rounded-xl border bg-card shadow-xs">
            <div className="relative">
                <MaterialThumb
                    src={item.thumbnail_url}
                    alt={item.name}
                    className="aspect-square"
                />
                {(imported || done) && (
                    <Badge className="absolute top-2 left-2 bg-emerald-600 text-white">
                        <Check />
                        In library
                    </Badge>
                )}
            </div>
            <div className="flex flex-1 flex-col gap-2 p-3">
                <div className="min-w-0">
                    <h3
                        className="truncate text-sm font-medium"
                        title={item.name}
                    >
                        {item.name}
                    </h3>
                    <p className="truncate text-xs text-muted-foreground">
                        {[item.author, item.license ?? 'CC0']
                            .filter(Boolean)
                            .join(' · ')}
                    </p>
                </div>
                <div className="mt-auto flex gap-1.5">
                    <Select
                        value={form.data.resolution}
                        onValueChange={(v) =>
                            form.setData('resolution', v as '1k' | '2k' | '4k')
                        }
                    >
                        <SelectTrigger
                            size="sm"
                            className="w-[4.5rem] shrink-0"
                            aria-label={`Resolution for ${item.name}`}
                        >
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="1k">1K</SelectItem>
                            <SelectItem value="2k">2K</SelectItem>
                            <SelectItem value="4k">4K</SelectItem>
                        </SelectContent>
                    </Select>
                    <Button
                        size="sm"
                        className="flex-1"
                        variant={imported || done ? 'outline' : 'default'}
                        disabled={form.processing}
                        onClick={importItem}
                    >
                        {form.processing ? <Spinner /> : <Download />}
                        {imported || done ? 'Again' : 'Import'}
                    </Button>
                </div>
                {form.data.resolution === '4k' && (
                    <p className="text-[11px] text-amber-700 dark:text-amber-400">
                        4K maps are large (≈50–100 MB download) and use a lot of
                        GPU memory.
                    </p>
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
