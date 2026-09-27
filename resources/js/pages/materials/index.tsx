import { Head, useForm } from '@inertiajs/react';
import {
    ChevronDown,
    Globe,
    Layers,
    Plus,
    RefreshCw,
    Search,
    Sparkles,
    TriangleAlert,
    Upload,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import Heading from '@/components/heading';
import { BrowseDialog } from '@/components/materials/browse-dialog';
import { GenerateDialog } from '@/components/materials/generate-dialog';
import { MaterialDetail } from '@/components/materials/material-detail';
import {
    MaterialThumb,
    materialImage,
} from '@/components/materials/material-thumb';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from '@/components/ui/tooltip';
import { UploadDialog } from '@/components/materials/upload-dialog';
import { usePendingPoll } from '@/hooks/use-pending-poll';
import { formatNumber } from '@/lib/format';
import { categoryLabel, MATERIAL_SOURCE_LABELS } from '@/lib/materials';
import { cn } from '@/lib/utils';
import materials from '@/routes/materials';
import type {
    AiConfig,
    BrowseSource,
    CategoryOption,
    MaterialSource,
    MaterialStudio,
} from '@/types';

type Props = {
    materials: MaterialStudio[];
    categories: CategoryOption[];
    ai: AiConfig;
};

type Dialogs = 'upload' | 'generate' | BrowseSource | null;

export default function MaterialsIndex({
    materials: library,
    categories,
    ai,
}: Props) {
    const [dialog, setDialog] = useState<Dialogs>(null);
    const [selectedId, setSelectedId] = useState<number | null>(null);
    const [sheetOpen, setSheetOpen] = useState(false);
    const [category, setCategory] = useState('all');
    const [source, setSource] = useState<'all' | MaterialSource>('all');
    const [query, setQuery] = useState('');
    const selected = library.find((m) => m.id === selectedId) ?? null;

    usePendingPoll(
        library.some((m) => m.status === 'processing'),
        ['materials'],
        3000,
    );

    const counts = useMemo(() => {
        const map = new Map<string, number>();
        library.forEach((m) =>
            map.set(m.category, (map.get(m.category) ?? 0) + 1),
        );

        return map;
    }, [library]);

    const visible = useMemo(() => {
        const q = query.trim().toLowerCase();

        return library.filter(
            (m) =>
                (category === 'all' || m.category === category) &&
                (source === 'all' || m.source === source) &&
                (!q ||
                    m.name.toLowerCase().includes(q) ||
                    m.tags.some((t) => t.toLowerCase().includes(q)) ||
                    (m.ai_prompt ?? '').toLowerCase().includes(q)),
        );
    }, [library, category, source, query]);

    const open = (id: number) => {
        setSelectedId(id);
        setSheetOpen(true);
    };

    const browseSource =
        dialog === 'polyhaven' || dialog === 'ambientcg' ? dialog : null;

    return (
        <>
            <Head title="Materials" />
            <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 p-4 sm:p-6">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <Heading
                        title="Material library"
                        description="Physically based terrain materials (albedo, normal, roughness, AO, height) you can assign to the terrain layers of any map."
                    />
                    <AddMenu onSelect={setDialog} />
                </div>

                {library.length === 0 ? (
                    <EmptyState onSelect={setDialog} />
                ) : (
                    <>
                        <div className="flex flex-col gap-3">
                            <div className="flex flex-col gap-2 sm:flex-row">
                                <div className="relative flex-1">
                                    <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                                    <Input
                                        type="search"
                                        value={query}
                                        onChange={(e) =>
                                            setQuery(e.target.value)
                                        }
                                        placeholder="Search by name, tag or prompt…"
                                        aria-label="Search materials"
                                        className="pl-8"
                                    />
                                </div>
                                <Select
                                    value={source}
                                    onValueChange={(v) =>
                                        setSource(v as 'all' | MaterialSource)
                                    }
                                >
                                    <SelectTrigger
                                        className="sm:w-44"
                                        aria-label="Source"
                                    >
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="all">
                                            All sources
                                        </SelectItem>
                                        {(
                                            Object.keys(
                                                MATERIAL_SOURCE_LABELS,
                                            ) as MaterialSource[]
                                        ).map((s) => (
                                            <SelectItem key={s} value={s}>
                                                {MATERIAL_SOURCE_LABELS[s]}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                            <div
                                className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0"
                                role="radiogroup"
                                aria-label="Category"
                            >
                                <Chip
                                    active={category === 'all'}
                                    onClick={() => setCategory('all')}
                                    count={library.length}
                                >
                                    All
                                </Chip>
                                {categories
                                    .filter((c) => counts.has(c.value))
                                    .map((c) => (
                                        <Chip
                                            key={c.value}
                                            active={category === c.value}
                                            onClick={() => setCategory(c.value)}
                                            count={counts.get(c.value) ?? 0}
                                        >
                                            {c.label}
                                        </Chip>
                                    ))}
                            </div>
                        </div>

                        {visible.length === 0 ? (
                            <p className="rounded-xl border border-dashed py-12 text-center text-sm text-muted-foreground">
                                No materials match these filters.
                            </p>
                        ) : (
                            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 xl:grid-cols-5">
                                {visible.map((m) => (
                                    <MaterialCard
                                        key={m.id}
                                        material={m}
                                        categoryName={categoryLabel(
                                            categories,
                                            m.category,
                                        )}
                                        onOpen={() => open(m.id)}
                                    />
                                ))}
                            </div>
                        )}
                    </>
                )}
            </div>

            <Sheet open={sheetOpen && !!selected} onOpenChange={setSheetOpen}>
                <SheetContent className="w-full gap-0 sm:max-w-2xl">
                    {selected && (
                        <MaterialDetail
                            key={`${selected.id}-${selected.status}`}
                            material={selected}
                            categories={categories}
                            ai={ai}
                            onClose={() => setSheetOpen(false)}
                        />
                    )}
                </SheetContent>
            </Sheet>

            <UploadDialog
                open={dialog === 'upload'}
                onOpenChange={(o) => setDialog(o ? 'upload' : null)}
                categories={categories}
            />
            <GenerateDialog
                open={dialog === 'generate'}
                onOpenChange={(o) => setDialog(o ? 'generate' : null)}
                categories={categories}
                ai={ai}
            />
            <BrowseDialog
                source={browseSource}
                onOpenChange={(o) => !o && setDialog(null)}
                categories={categories}
                library={library}
            />
        </>
    );
}

function AddMenu({ onSelect }: { onSelect: (d: Dialogs) => void }) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button>
                    <Plus />
                    Add material
                    <ChevronDown className="opacity-70" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                    Free CC0 libraries
                </DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => onSelect('polyhaven')}>
                    <Globe />
                    Browse Poly Haven
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onSelect('ambientcg')}>
                    <Globe />
                    Browse ambientCG
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => onSelect('upload')}>
                    <Upload />
                    Upload texture maps
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onSelect('generate')}>
                    <Sparkles className="text-violet-500" />
                    Generate with AI
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function EmptyState({ onSelect }: { onSelect: (d: Dialogs) => void }) {
    const options = [
        {
            key: 'polyhaven' as const,
            icon: Globe,
            title: 'Poly Haven',
            text: 'Scanned ground, rock and forest textures (CC0).',
        },
        {
            key: 'ambientcg' as const,
            icon: Globe,
            title: 'ambientCG',
            text: 'Thousands of free PBR materials (CC0).',
        },
        {
            key: 'upload' as const,
            icon: Upload,
            title: 'Upload',
            text: 'Your own albedo, normal, roughness… maps.',
        },
        {
            key: 'generate' as const,
            icon: Sparkles,
            title: 'Generate with AI',
            text: 'Describe a surface and let the AI paint it.',
        },
    ];

    return (
        <div className="flex flex-col items-center gap-6 rounded-2xl border border-dashed px-6 py-14 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-muted">
                <Layers className="size-6 text-muted-foreground" />
            </div>
            <div className="space-y-1">
                <h2 className="font-semibold">No materials yet</h2>
                <p className="max-w-md text-sm text-muted-foreground">
                    Import a few realistic ground materials to replace the
                    procedural terrain colours.
                </p>
            </div>
            <div className="grid w-full max-w-3xl gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {options.map((o) => (
                    <button
                        key={o.key}
                        type="button"
                        onClick={() => onSelect(o.key)}
                        className="flex flex-col items-start gap-2 rounded-xl border bg-card p-4 text-left shadow-xs transition-colors outline-none hover:border-foreground/30 focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                        <o.icon
                            className={cn(
                                'size-5 text-muted-foreground',
                                o.key === 'generate' && 'text-violet-500',
                            )}
                        />
                        <span className="text-sm font-medium">{o.title}</span>
                        <span className="text-xs text-muted-foreground">
                            {o.text}
                        </span>
                    </button>
                ))}
            </div>
        </div>
    );
}

function Chip({
    active,
    onClick,
    count,
    children,
}: {
    active: boolean;
    onClick: () => void;
    count: number;
    children: string;
}) {
    return (
        <button
            type="button"
            role="radio"
            aria-checked={active}
            onClick={onClick}
            className={cn(
                'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm font-medium text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50',
                active &&
                    'border-foreground bg-foreground text-background hover:bg-foreground/90 hover:text-background',
            )}
        >
            {children}
            <span
                className={cn(
                    'text-xs tabular-nums opacity-60',
                    active && 'opacity-80',
                )}
            >
                {count}
            </span>
        </button>
    );
}

const SOURCE_BADGE: Record<MaterialSource, string> = {
    upload: 'bg-slate-900/70 text-white',
    polyhaven: 'bg-sky-700/80 text-white',
    ambientcg: 'bg-teal-700/80 text-white',
    ai: 'bg-violet-600/85 text-white',
};

function MaterialCard({
    material,
    categoryName,
    onOpen,
}: {
    material: MaterialStudio;
    categoryName: string;
    onOpen: () => void;
}) {
    const retryForm = useForm({});
    const usedBy = material.layers_count ?? 0;
    const attribution = [
        material.author && `by ${material.author}`,
        material.license,
    ]
        .filter(Boolean)
        .join(' · ');

    return (
        <article className="group relative flex flex-col overflow-hidden rounded-xl border bg-card shadow-xs transition-shadow focus-within:ring-[3px] focus-within:ring-ring/50 hover:shadow-md">
            <div className="relative">
                <MaterialThumb
                    src={materialImage(material)}
                    alt=""
                    fallbackColor={material.tint}
                    className={cn(
                        'aspect-square transition-transform',
                        material.status !== 'ready' && 'opacity-60',
                    )}
                />
                <Tooltip>
                    <TooltipTrigger asChild>
                        <span
                            className={cn(
                                'absolute top-2 left-2 z-10 rounded-md px-1.5 py-0.5 text-[11px] font-medium backdrop-blur',
                                SOURCE_BADGE[material.source],
                            )}
                        >
                            {material.source === 'ai' && (
                                <Sparkles className="mr-0.5 inline size-3 align-[-2px]" />
                            )}
                            {MATERIAL_SOURCE_LABELS[material.source]}
                        </span>
                    </TooltipTrigger>
                    <TooltipContent>
                        {material.source === 'ai'
                            ? `Generated${material.ai_model ? ` with ${material.ai_model}` : ''}`
                            : attribution || 'Uploaded by you'}
                    </TooltipContent>
                </Tooltip>

                {material.status === 'processing' && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/50 text-xs font-medium backdrop-blur-[2px]">
                        <Spinner className="size-5" />
                        <span className="max-w-[90%] truncate">
                            {material.status_message ?? 'Processing…'}
                        </span>
                    </div>
                )}
                {material.status === 'failed' && (
                    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-red-950/60 p-3 text-center text-xs text-white">
                        <TriangleAlert className="size-5" />
                        <span className="line-clamp-2">
                            {material.status_message ?? 'Failed'}
                        </span>
                        <Button
                            size="sm"
                            variant="secondary"
                            className="h-7"
                            disabled={retryForm.processing}
                            onClick={() =>
                                retryForm.submit(materials.retry(material.id), {
                                    preserveScroll: true,
                                })
                            }
                        >
                            {retryForm.processing ? <Spinner /> : <RefreshCw />}
                            Retry
                        </Button>
                    </div>
                )}
            </div>

            <div className="flex flex-1 flex-col gap-1.5 p-3">
                <h2
                    className="truncate text-sm font-medium"
                    title={material.name}
                >
                    <button
                        type="button"
                        onClick={onOpen}
                        className="outline-none after:absolute after:inset-0 after:content-['']"
                    >
                        {material.name}
                    </button>
                </h2>
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <Badge variant="secondary" className="font-normal">
                        {categoryName}
                    </Badge>
                    <span className="tabular-nums">
                        {formatNumber(material.tile_size)} m
                    </span>
                    {usedBy > 0 && (
                        <span className="ml-auto flex items-center gap-1 tabular-nums">
                            <Layers className="size-3" />
                            {usedBy}
                            <span className="sr-only">layers use this</span>
                        </span>
                    )}
                </div>
            </div>
        </article>
    );
}

MaterialsIndex.layout = {
    breadcrumbs: [{ title: 'Materials', href: materials.index() }],
};
