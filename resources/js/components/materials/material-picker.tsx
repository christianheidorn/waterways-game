import { Link } from '@inertiajs/react';
import { Check, Palette, Plus, Search, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
    MaterialThumb,
    materialImage,
} from '@/components/materials/material-thumb';
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
import { categoryLabel } from '@/lib/materials';
import { cn } from '@/lib/utils';
import materialRoutes from '@/routes/materials';
import type { CategoryOption, MaterialStudio } from '@/types';

type Props = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** undefined while the library is loading. */
    materials: MaterialStudio[] | undefined;
    categories: CategoryOption[];
    value: number | null;
    onSelect: (materialId: number | null) => void;
    /** id (or 'none') of the choice currently being saved. */
    saving?: number | 'none' | null;
    layerName: string;
};

/** Grid picker of library materials for a terrain layer. */
export function MaterialPicker({
    open,
    onOpenChange,
    materials,
    categories,
    value,
    onSelect,
    saving = null,
    layerName,
}: Props) {
    const [query, setQuery] = useState('');
    const [category, setCategory] = useState('all');

    const usable = useMemo(
        () => (materials ?? []).filter((m) => m.status !== 'failed'),
        [materials],
    );
    const presentCategories = categories.filter((c) =>
        usable.some((m) => m.category === c.value),
    );
    const visible = usable.filter((m) => {
        const q = query.trim().toLowerCase();

        return (
            (category === 'all' || m.category === category) &&
            (!q ||
                m.name.toLowerCase().includes(q) ||
                m.tags.some((t) => t.includes(q)))
        );
    });

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="flex max-h-[90vh] flex-col gap-0 p-0 sm:max-w-4xl">
                <DialogHeader className="gap-3 border-b p-4 sm:p-6">
                    <div>
                        <DialogTitle>Material for {layerName}</DialogTitle>
                        <DialogDescription>
                            Pick a PBR material from your library. The layer
                            keeps its paint; only its look changes.
                        </DialogDescription>
                    </div>
                    <div className="relative">
                        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            type="search"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Search materials…"
                            aria-label="Search materials"
                            className="pl-8"
                        />
                    </div>
                    {presentCategories.length > 1 && (
                        <div
                            className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-0.5"
                            role="radiogroup"
                            aria-label="Category"
                        >
                            {[
                                { value: 'all', label: 'All' },
                                ...presentCategories,
                            ].map((c) => (
                                <button
                                    key={c.value}
                                    type="button"
                                    role="radio"
                                    aria-checked={category === c.value}
                                    onClick={() => setCategory(c.value)}
                                    className={cn(
                                        'h-7 shrink-0 rounded-full border px-2.5 text-xs font-medium text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50',
                                        category === c.value &&
                                            'border-foreground bg-foreground text-background hover:bg-foreground/90 hover:text-background',
                                    )}
                                >
                                    {c.label}
                                </button>
                            ))}
                        </div>
                    )}
                </DialogHeader>

                <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
                        <PickerTile
                            selected={value === null}
                            saving={saving === 'none'}
                            onClick={() => onSelect(null)}
                            title="None"
                            subtitle="Procedural colours"
                        >
                            <div className="flex aspect-square items-center justify-center bg-[linear-gradient(135deg,#6b8f4e,#8a7a55)]">
                                <Palette className="size-6 text-white/90 drop-shadow" />
                            </div>
                        </PickerTile>

                        {materials === undefined &&
                            Array.from({ length: 9 }).map((_, i) => (
                                <div
                                    key={i}
                                    className="overflow-hidden rounded-lg border"
                                >
                                    <Skeleton className="aspect-square rounded-none" />
                                    <div className="grid gap-1.5 p-2">
                                        <Skeleton className="h-3.5 w-3/4" />
                                        <Skeleton className="h-3 w-1/2" />
                                    </div>
                                </div>
                            ))}

                        {visible.map((m) => (
                            <PickerTile
                                key={m.id}
                                selected={value === m.id}
                                saving={saving === m.id}
                                disabled={m.status !== 'ready'}
                                onClick={() => onSelect(m.id)}
                                title={m.name}
                                subtitle={
                                    m.status === 'processing'
                                        ? 'Processing…'
                                        : `${categoryLabel(categories, m.category)} · ${m.tile_size} m`
                                }
                            >
                                <MaterialThumb
                                    src={materialImage(m)}
                                    alt=""
                                    className="aspect-square"
                                />
                            </PickerTile>
                        ))}

                        <Link
                            href={materialRoutes.index()}
                            className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground transition-colors outline-none hover:border-foreground/30 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                        >
                            <div className="flex gap-1">
                                <Plus className="size-4" />
                                <Sparkles className="size-4 text-violet-500" />
                            </div>
                            Add, import or generate materials
                        </Link>
                    </div>

                    {materials !== undefined && visible.length === 0 && (
                        <p className="mt-4 text-center text-sm text-muted-foreground">
                            {usable.length === 0
                                ? 'Your material library is empty.'
                                : 'No materials match your search.'}
                        </p>
                    )}
                </div>

                <div className="flex justify-end border-t bg-muted/30 px-4 py-3 sm:px-6">
                    <Button
                        variant="secondary"
                        onClick={() => onOpenChange(false)}
                    >
                        Close
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function PickerTile({
    selected,
    saving,
    disabled,
    onClick,
    title,
    subtitle,
    children,
}: {
    selected: boolean;
    saving: boolean;
    disabled?: boolean;
    onClick: () => void;
    title: string;
    subtitle: string;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            aria-pressed={selected}
            className={cn(
                'group relative flex flex-col overflow-hidden rounded-lg border bg-card text-left shadow-xs transition-all outline-none hover:border-foreground/30 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
                selected &&
                    'border-sky-500 ring-2 ring-sky-500 hover:border-sky-500',
            )}
        >
            {children}
            {(selected || saving) && (
                <span className="absolute top-1.5 right-1.5 flex size-6 items-center justify-center rounded-full bg-sky-500 text-white shadow">
                    {saving ? (
                        <Spinner className="size-3.5" />
                    ) : (
                        <Check className="size-3.5" />
                    )}
                </span>
            )}
            <span className="grid gap-0.5 p-2">
                <span className="truncate text-sm font-medium">{title}</span>
                <span className="truncate text-xs text-muted-foreground">
                    {subtitle}
                </span>
            </span>
        </button>
    );
}
