import { Link, useForm } from '@inertiajs/react';
import {
    ArrowRight,
    Check,
    Info,
    Map as MapIcon,
    Sparkles,
    TriangleAlert,
    X,
} from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { PlanRow } from '@/components/materials/layer-plan';
import type { PlanRowState } from '@/components/materials/layer-plan';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { apiFetch, errorMessage, isAiNotConfigured } from '@/lib/api';
import { LANDCOVER_CLASSES, materialApi } from '@/lib/materials';
import { cn } from '@/lib/utils';
import aiSettings from '@/routes/ai-settings';
import maps from '@/routes/maps';
import type {
    CategoryOption,
    LayerPlan,
    MapSummary,
    MaterialStudio,
    PlanAction,
    PlanMaterial,
    PlanSettings,
    RepaintMode,
} from '@/types';

type Props = {
    map: MapSummary;
    /** Library for the material picker (undefined until loaded). */
    library: MaterialStudio[] | undefined;
    categories: CategoryOption[];
    onNeedLibrary: () => void;
    /** Called after the plan was applied (layer forms should reset). */
    onApplied?: () => void;
    /** false → show a link to the AI settings instead of the button. */
    aiConfigured?: boolean;
};

type MaterialPayload = {
    type: PlanMaterial['type'];
    material_id?: number;
    source?: string;
    ref?: string;
    resolution?: string;
    name?: string;
    category?: string;
    tile_size?: number | null;
    aerial?: boolean;
    prompt?: string;
};

type ApplyRow = {
    slot: number;
    action: PlanAction;
    name?: string;
    material?: MaterialPayload;
    settings?: PlanSettings | null;
};

type ApplyPayload = {
    layers: ApplyRow[];
    landcover_mapping: Record<string, number> | null;
    repaint: RepaintMode;
};

function initialRows(plan: LayerPlan): PlanRowState[] {
    return plan.layers.map((layer) => ({
        original: layer,
        draft: layer,
        include:
            layer.action === 'keep'
                ? false
                : layer.action === 'remove'
                  ? (layer.current?.coverage ?? 0) <= plan.painted_threshold
                  : true,
    }));
}

function materialPayload(m: PlanMaterial | null): MaterialPayload {
    switch (m?.type) {
        case 'library':
            return { type: 'library', material_id: m.material_id };
        case 'import':
            return {
                type: 'import',
                source: m.source,
                ref: m.ref,
                resolution: m.resolution,
                name: m.name,
                category: m.category,
                tile_size: m.tile_size,
                aerial: m.aerial,
            };
        case 'generate':
            return { type: 'generate', prompt: m.prompt, category: m.category };
        default:
            return { type: 'procedural' };
    }
}

function mappingChanges(plan: LayerPlan, rows: PlanRowState[]) {
    if (!plan.landcover_mapping) {
        return [];
    }

    const current = plan.current_landcover_mapping ?? {};
    const nameOf = (slot: number | undefined, proposed: boolean) => {
        if (slot === undefined) {
            return '—';
        }

        const row = rows.find((r) => r.draft.slot === slot);
        const name = proposed
            ? row?.draft.name
            : (row?.draft.current?.name ?? row?.draft.name);

        return `${name ?? 'Layer'} (${slot + 1})`;
    };

    return LANDCOVER_CLASSES.filter(
        (c) =>
            plan.landcover_mapping?.[c.code] !== undefined &&
            plan.landcover_mapping[c.code] !== current[c.code],
    ).map((c) => ({
        ...c,
        from: nameOf(current[c.code], false),
        to: nameOf(plan.landcover_mapping?.[c.code], true),
    }));
}

/** "Plan layers with AI": a full layer plan reviewed slot by slot before anything changes. */
export function AiSuggestCard({
    map,
    library,
    categories,
    onNeedLibrary,
    onApplied,
    aiConfigured,
}: Props) {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notConfigured, setNotConfigured] = useState(aiConfigured === false);
    const [direction, setDirection] = useState('');
    const [plan, setPlan] = useState<LayerPlan | null>(null);
    const [rows, setRows] = useState<PlanRowState[]>([]);
    const [includeMapping, setIncludeMapping] = useState(true);
    const [repaint, setRepaint] = useState<RepaintMode>('none');
    const applyForm = useForm<ApplyPayload>({
        layers: [],
        landcover_mapping: null,
        repaint: 'none',
    });
    const directionId = useId();
    const realWorld = map.source === 'real_world';

    const suggest = async () => {
        setLoading(true);
        setError(null);

        try {
            const result = await apiFetch<LayerPlan>(
                materialApi.suggestMaterials(map.slug),
                {
                    method: 'POST',
                    body: { direction: direction.trim() || null },
                },
            );
            setPlan(result);
            setRows(initialRows(result));
            setIncludeMapping(true);
            setRepaint(
                result.landcover_mapping
                    ? 'landcover'
                    : result.layers.some((l) => l.action !== 'keep')
                      ? 'auto_rules'
                      : 'none',
            );
        } catch (e) {
            if (isAiNotConfigured(e)) {
                setNotConfigured(true);
            }

            setError(errorMessage(e));
        } finally {
            setLoading(false);
        }
    };

    const selected = rows.filter((r) => r.include && r.draft.action !== 'keep');
    const active = selected.filter((r) => r.draft.action !== 'remove');
    const counts = {
        changes: active.length,
        removals: selected.length - active.length,
        imports: new Set(
            active
                .map((r) => r.draft.material)
                .filter((m) => m?.type === 'import')
                .map((m) =>
                    m?.type === 'import' ? `${m.source}:${m.ref}` : '',
                ),
        ).size,
        generations: active.filter((r) => r.draft.material?.type === 'generate')
            .length,
    };
    const remaining =
        rows.filter((r) => r.draft.current).length -
        counts.removals +
        active.filter((r) => r.draft.action === 'add').length;
    const mapping = useMemo(
        () => (plan ? mappingChanges(plan, rows) : []),
        [plan, rows],
    );
    const sendMapping = includeMapping && mapping.length > 0;
    const nothing = selected.length === 0 && !sendMapping && repaint === 'none';

    const apply = () => {
        if (!plan) {
            return;
        }

        applyForm.transform(() => ({
            layers: selected.map(({ draft }) =>
                draft.action === 'remove'
                    ? ({ slot: draft.slot, action: 'remove' } as ApplyRow)
                    : {
                          slot: draft.slot,
                          action: draft.action,
                          name: draft.name.trim() || draft.current?.name || '',
                          material: materialPayload(draft.material),
                          settings: draft.settings,
                      },
            ),
            landcover_mapping: sendMapping ? plan.landcover_mapping : null,
            repaint,
        }));
        applyForm.submit(maps.ai.applySuggestion(map.slug), {
            preserveScroll: true,
            onSuccess: () => {
                setPlan(null);
                setRows([]);
                onApplied?.();
            },
        });
    };

    const updateRow = (next: PlanRowState) =>
        setRows((prev) =>
            prev.map((r) => (r.draft.slot === next.draft.slot ? next : r)),
        );

    return (
        <section className="overflow-hidden rounded-xl border bg-gradient-to-br from-violet-500/5 via-card to-sky-500/5 shadow-xs">
            <div className="flex flex-col gap-4 p-4 sm:p-5 lg:flex-row lg:items-center">
                <div className="flex min-w-0 flex-1 gap-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
                        <Sparkles className="size-5" />
                    </div>
                    <div className="min-w-0">
                        <h3 className="text-sm font-semibold">
                            Plan layers with AI
                        </h3>
                        <p className="text-sm text-muted-foreground">
                            Proposes the smallest set of layers for this
                            landscape — keeping, changing, adding or removing
                            channels — with realistic tile sizes and auto-paint
                            rules. It prefers your library, then free CC0
                            imports, and only generates when nothing fits. You
                            review every row before anything changes.
                        </p>
                    </div>
                </div>
                {notConfigured ? (
                    <Button asChild variant="outline" className="self-start">
                        <Link href={aiSettings.edit()}>Set up AI</Link>
                    </Button>
                ) : (
                    <form
                        className="flex w-full flex-col gap-2 sm:flex-row lg:w-auto"
                        onSubmit={(e) => {
                            e.preventDefault();
                            void suggest();
                        }}
                    >
                        <label htmlFor={directionId} className="sr-only">
                            Direction for the AI
                        </label>
                        <Input
                            id={directionId}
                            value={direction}
                            onChange={(e) => setDirection(e.target.value)}
                            maxLength={500}
                            placeholder="Direction (optional), e.g. autumn look, fewer layers"
                            className="sm:w-72"
                            disabled={loading}
                        />
                        <Button
                            type="submit"
                            disabled={loading}
                            variant={plan ? 'outline' : 'default'}
                        >
                            {loading ? <Spinner /> : <Sparkles />}
                            {loading
                                ? 'Planning…'
                                : plan
                                  ? 'Plan again'
                                  : 'Plan layers with AI'}
                        </Button>
                    </form>
                )}
            </div>

            {error && (
                <div className="mx-4 mb-4 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-700 sm:mx-5 dark:text-red-300">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                    {error}
                </div>
            )}

            {loading && <PlanSkeleton />}

            {plan && !loading && (
                <div className="border-t bg-card">
                    <div className="grid gap-2 px-4 pt-4 sm:px-5">
                        {plan.summary && (
                            <p className="text-sm">{plan.summary}</p>
                        )}
                        {plan.notes.length > 0 && (
                            <ul className="grid gap-1 text-xs text-muted-foreground">
                                {plan.notes.map((note) => (
                                    <li key={note} className="flex gap-1.5">
                                        <Info className="mt-0.5 size-3.5 shrink-0" />
                                        {note}
                                    </li>
                                ))}
                            </ul>
                        )}
                        {plan.unavailable_sources.length > 0 && (
                            <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                                {plan.unavailable_sources.join(' and ')} could
                                not be reached, so its materials were not
                                considered.
                            </p>
                        )}
                    </div>

                    <ul className="mt-3 divide-y border-t">
                        {rows.map((row) => (
                            <PlanRow
                                key={row.draft.slot}
                                row={row}
                                threshold={plan.painted_threshold}
                                generationNote={
                                    plan.estimate.generation_note
                                        ? `Uses credits: ${plan.estimate.generation_note}`
                                        : ''
                                }
                                library={library}
                                categories={categories}
                                onNeedLibrary={onNeedLibrary}
                                onChange={updateRow}
                            />
                        ))}

                        {mapping.length > 0 && (
                            <li className="grid gap-x-4 gap-y-3 px-4 py-4 sm:grid-cols-[1.25rem_6.5rem_minmax(0,1fr)] sm:px-5">
                                <div className="pt-0.5">
                                    <Checkbox
                                        checked={includeMapping}
                                        onCheckedChange={(v) =>
                                            setIncludeMapping(v === true)
                                        }
                                        aria-label="Apply the land cover mapping"
                                    />
                                </div>
                                <div className="flex flex-row flex-wrap items-center gap-1.5 sm:flex-col sm:items-start">
                                    <span className="text-xs font-medium text-muted-foreground">
                                        Land cover
                                    </span>
                                    <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-800 dark:text-amber-300">
                                        <MapIcon className="size-3" />
                                        Mapping
                                    </span>
                                </div>
                                <div className="grid gap-2">
                                    <span className="text-sm font-semibold">
                                        Which layer paints each land cover class
                                    </span>
                                    <ul className="grid gap-1 text-xs sm:grid-cols-2">
                                        {mapping.map((c) => (
                                            <li
                                                key={c.code}
                                                className="flex min-w-0 items-center gap-1.5"
                                            >
                                                <span
                                                    className="size-2.5 shrink-0 rounded-sm border"
                                                    style={{
                                                        backgroundColor:
                                                            c.color,
                                                    }}
                                                />
                                                <span className="font-medium">
                                                    {c.label}
                                                </span>
                                                <span className="truncate text-muted-foreground line-through">
                                                    {c.from}
                                                </span>
                                                <ArrowRight className="size-3 shrink-0 text-muted-foreground" />
                                                <span className="truncate">
                                                    {c.to}
                                                </span>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            </li>
                        )}
                    </ul>

                    <div className="grid gap-4 border-t bg-muted/30 px-4 py-4 sm:px-5">
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
                            <span>
                                <strong className="text-foreground">
                                    {counts.changes}
                                </strong>{' '}
                                {counts.changes === 1 ? 'change' : 'changes'}
                            </span>
                            <span>
                                <strong className="text-foreground">
                                    {counts.removals}
                                </strong>{' '}
                                {counts.removals === 1 ? 'removal' : 'removals'}
                            </span>
                            <span>
                                <strong className="text-foreground">
                                    {counts.imports}
                                </strong>{' '}
                                free{' '}
                                {counts.imports === 1 ? 'import' : 'imports'}
                            </span>
                            <span
                                className={cn(
                                    counts.generations > 0 &&
                                        'text-violet-700 dark:text-violet-300',
                                )}
                            >
                                <strong className="text-foreground">
                                    {counts.generations}
                                </strong>{' '}
                                AI{' '}
                                {counts.generations === 1
                                    ? 'generation'
                                    : 'generations'}
                                {counts.generations > 0 &&
                                    ` (${plan.estimate.generation_note})`}
                            </span>
                            <span>
                                {remaining}{' '}
                                {remaining === 1 ? 'layer' : 'layers'} after
                                applying
                            </span>
                        </div>

                        <RepaintChoice
                            value={repaint}
                            onChange={setRepaint}
                            landCover={realWorld}
                        />

                        <div className="flex flex-wrap items-center gap-2">
                            <Button
                                onClick={apply}
                                disabled={applyForm.processing || nothing}
                            >
                                {applyForm.processing ? <Spinner /> : <Check />}
                                Apply selected
                            </Button>
                            <Button
                                variant="ghost"
                                onClick={() => {
                                    setPlan(null);
                                    setRows([]);
                                }}
                            >
                                <X />
                                Discard
                            </Button>
                            <span className="text-xs text-muted-foreground">
                                Unticked rows stay exactly as they are.
                            </span>
                        </div>
                    </div>
                </div>
            )}
        </section>
    );
}

function RepaintChoice({
    value,
    onChange,
    landCover,
}: {
    value: RepaintMode;
    onChange: (value: RepaintMode) => void;
    landCover: boolean;
}) {
    const name = useId();
    const options: { value: RepaintMode; label: string; hint: string }[] = [
        {
            value: 'none',
            label: "Don't repaint",
            hint: 'Keeps the current paint; removed channels fall back to other layers.',
        },
        {
            value: 'auto_rules',
            label: 'Repaint from the new auto-paint rules',
            hint: 'Replaces the current paint the next time the studio opens.',
        },
        ...(landCover
            ? [
                  {
                      value: 'landcover' as const,
                      label: 'Repaint from land cover',
                      hint: 'Replaces the current paint using ESA WorldCover and the mapping.',
                  },
              ]
            : []),
    ];

    return (
        <fieldset className="grid gap-2">
            <legend className="mb-2 text-xs font-medium">Terrain paint</legend>
            <div className="grid gap-2 md:grid-cols-3">
                {options.map((o) => (
                    <label
                        key={o.value}
                        className={cn(
                            'flex cursor-pointer items-start gap-2 rounded-lg border bg-card p-2.5 text-sm transition-colors has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50',
                            value === o.value &&
                                'border-sky-500 ring-1 ring-sky-500',
                        )}
                    >
                        <input
                            type="radio"
                            name={name}
                            value={o.value}
                            checked={value === o.value}
                            onChange={() => onChange(o.value)}
                            className="mt-0.5 accent-sky-600"
                        />
                        <span className="grid gap-0.5">
                            <span className="font-medium">{o.label}</span>
                            <span className="text-xs text-muted-foreground">
                                {o.hint}
                            </span>
                        </span>
                    </label>
                ))}
            </div>
        </fieldset>
    );
}

function PlanSkeleton() {
    return (
        <div className="border-t bg-card" aria-busy="true">
            <p className="flex items-center gap-2 px-4 pt-4 text-sm text-muted-foreground sm:px-5">
                <Spinner className="size-4" />
                Analysing terrain, land cover and the importable catalogues
                (Poly Haven, ambientCG)… this can take up to a minute.
            </p>
            <div className="grid gap-2 px-4 pt-3 sm:px-5">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
            </div>
            <ul className="mt-3 divide-y border-t">
                {Array.from({ length: 5 }).map((_, i) => (
                    <li
                        key={i}
                        className="grid gap-4 px-4 py-4 sm:grid-cols-[1.25rem_6.5rem_minmax(0,1fr)] sm:px-5"
                    >
                        <Skeleton className="size-4" />
                        <div className="grid gap-1.5">
                            <Skeleton className="h-3 w-16" />
                            <Skeleton className="h-5 w-14" />
                        </div>
                        <div className="grid gap-2">
                            <div className="flex items-center gap-3">
                                <Skeleton className="size-11" />
                                <Skeleton className="h-4 w-40" />
                                <Skeleton className="size-11" />
                                <Skeleton className="h-4 w-40" />
                            </div>
                            <Skeleton className="h-3 w-2/3" />
                        </div>
                    </li>
                ))}
            </ul>
        </div>
    );
}
