import { Link, router } from '@inertiajs/react';
import type { FoliageKind } from '@game/shared/types';
import {
    ArrowRight,
    Box,
    Download,
    Info,
    Lightbulb,
    MapPin,
    Shapes,
    Sparkles,
    TriangleAlert,
    Wand2,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useId, useState } from 'react';
import { StyleSlider } from '@/components/foliage/fields';
import { ACTION_STYLES } from '@/components/materials/layer-plan';
import { MaterialThumb } from '@/components/materials/material-thumb';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { apiFetch, errorMessage, isAiNotConfigured } from '@/lib/api';
import { foliageApi, formatMetres, kindIcon } from '@/lib/foliage';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import aiSettings from '@/routes/ai-settings';
import foliage from '@/routes/foliage';
import type {
    FoliageMapOption,
    FoliagePlan,
    FoliagePlanAsset,
    FoliagePlanRow,
    FoliagePlanSettings,
} from '@/types';

type Brief = {
    map_id: string;
    region: string;
    style: number;
    direction: string;
    allow_generation: boolean;
};

type RowState = {
    row: FoliagePlanRow;
    include: boolean;
    /** 'suggested' = the plan's model, 'procedural' / 'current' = user override. */
    assetChoice: 'suggested' | 'procedural' | 'current';
    name: string;
};

const REGION_EXAMPLES =
    'e.g. Scottish Highlands, Tuscany in late summer, Hokkaido birch forest, Kalahari';

/**
 * AI foliage palette: describe a place (or pick a real-world map) and a look; the AI proposes
 * which foliage types to keep, change, remove and add — with models (library, Poly Haven, AI cards
 * or procedural) and realistic sizes. Nothing changes until the ticked rows are applied.
 */
export function FoliageAiPlanDialog({
    open,
    onOpenChange,
    maps,
    aiConfigured,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    maps: FoliageMapOption[];
    aiConfigured: boolean;
}) {
    const [brief, setBrief] = useState<Brief>({
        map_id: maps.find((m) => m.real_world)
            ? String(maps.find((m) => m.real_world)!.id)
            : 'none',
        region: '',
        style: 15,
        direction: '',
        allow_generation: true,
    });
    const [plan, setPlan] = useState<FoliagePlan | null>(null);
    const [rows, setRows] = useState<RowState[]>([]);
    const [loading, setLoading] = useState(false);
    const [applying, setApplying] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notConfigured, setNotConfigured] = useState(false);

    const suggest = () => {
        setLoading(true);
        setError(null);
        apiFetch<FoliagePlan>(foliageApi.plan(), {
            method: 'POST',
            body: {
                map_id: brief.map_id === 'none' ? null : Number(brief.map_id),
                region: brief.region.trim() || null,
                style: brief.style,
                direction: brief.direction.trim() || null,
                allow_generation: brief.allow_generation,
            },
        })
            .then((p) => {
                setPlan(p);
                setRows(
                    p.types.map((row) => ({
                        row,
                        include:
                            row.action !== 'keep' &&
                            !(
                                row.action === 'remove' &&
                                (row.usage?.instances ?? 0) > 0
                            ),
                        assetChoice: 'suggested',
                        name: row.name,
                    })),
                );
            })
            .catch((e: unknown) => {
                setNotConfigured(isAiNotConfigured(e));
                setError(errorMessage(e));
            })
            .finally(() => setLoading(false));
    };

    const apply = () => {
        if (!plan) {
            return;
        }

        const selected = rows.filter(
            (r) => r.include && r.row.action !== 'keep',
        );
        setApplying(true);
        router.post(
            foliage.ai.apply.url(),
            {
                style: plan.brief.style,
                types: selected.map((r) => ({
                    action: r.row.action,
                    type_id: r.row.type_id,
                    name: r.name,
                    kind: r.row.kind,
                    asset:
                        r.assetChoice === 'procedural'
                            ? { type: 'procedural' }
                            : r.assetChoice === 'current'
                              ? { type: 'current' }
                              : r.row.asset,
                    settings: r.row.settings,
                })),
            },
            {
                preserveScroll: true,
                onSuccess: () => {
                    onOpenChange(false);
                    setPlan(null);
                },
                onFinish: () => setApplying(false),
            },
        );
    };

    const selectedCount = rows.filter(
        (r) => r.include && r.row.action !== 'keep',
    ).length;
    const selectedGenerations = rows.filter(
        (r) =>
            r.include &&
            r.assetChoice === 'suggested' &&
            r.row.asset?.type === 'generate' &&
            (r.row.action === 'add' || r.row.action === 'change'),
    ).length;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="flex max-h-[94vh] flex-col gap-0 p-0 sm:max-w-4xl">
                <DialogHeader className="border-b p-4 sm:p-6">
                    <DialogTitle className="flex items-center gap-2">
                        <Wand2 className="size-5" />
                        AI foliage palette
                    </DialogTitle>
                    <DialogDescription>
                        Get a vegetation palette for a place on Earth and a
                        look: which trees, shrubs, grasses, flowers and rocks to
                        keep, change, remove or add. Imports are preferred over
                        generation; you approve every row.
                    </DialogDescription>
                </DialogHeader>

                <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
                    {!plan ? (
                        <BriefForm
                            brief={brief}
                            setBrief={setBrief}
                            maps={maps}
                        />
                    ) : (
                        <PlanReview plan={plan} rows={rows} setRows={setRows} />
                    )}

                    {error && (
                        <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-700 dark:text-red-300">
                            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                            <div>
                                {error}
                                {notConfigured && (
                                    <>
                                        {' '}
                                        <Link
                                            href={aiSettings.edit()}
                                            className="font-medium underline underline-offset-2"
                                        >
                                            Open AI settings
                                        </Link>
                                    </>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                <DialogFooter className="flex-wrap items-center gap-2 border-t p-4 sm:justify-between">
                    {plan ? (
                        <>
                            <Button
                                variant="ghost"
                                onClick={() => setPlan(null)}
                                disabled={applying}
                            >
                                Back to brief
                            </Button>
                            <div className="flex flex-wrap items-center gap-2">
                                {selectedGenerations > 0 && (
                                    <span className="text-xs text-muted-foreground">
                                        {selectedGenerations} AI{' '}
                                        {selectedGenerations === 1
                                            ? 'generation'
                                            : 'generations'}{' '}
                                        · {plan.estimate.generation_note}
                                    </span>
                                )}
                                <Button
                                    variant="outline"
                                    onClick={suggest}
                                    disabled={loading || applying}
                                >
                                    {loading ? <Spinner /> : <Sparkles />}
                                    Suggest again
                                </Button>
                                <Button
                                    onClick={apply}
                                    disabled={applying || selectedCount === 0}
                                >
                                    {applying && <Spinner />}
                                    Apply {selectedCount}{' '}
                                    {selectedCount === 1 ? 'change' : 'changes'}
                                </Button>
                            </div>
                        </>
                    ) : (
                        <>
                            <p className="text-xs text-muted-foreground">
                                Uses your OpenRouter text model; nothing changes
                                until you apply.
                            </p>
                            <Button
                                onClick={suggest}
                                disabled={
                                    loading ||
                                    !aiConfigured ||
                                    (brief.map_id === 'none' &&
                                        brief.region.trim() === '')
                                }
                            >
                                {loading ? <Spinner /> : <Sparkles />}
                                {loading ? 'Planning…' : 'Suggest palette'}
                            </Button>
                        </>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function BriefForm({
    brief,
    setBrief,
    maps,
}: {
    brief: Brief;
    setBrief: (fn: (b: Brief) => Brief) => void;
    maps: FoliageMapOption[];
}) {
    const id = useId();
    const map = maps.find((m) => String(m.id) === brief.map_id);

    return (
        <div className="grid gap-6">
            <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                    <Label htmlFor={`${id}-map`}>Map</Label>
                    <Select
                        value={brief.map_id}
                        onValueChange={(v) =>
                            setBrief((b) => ({ ...b, map_id: v }))
                        }
                    >
                        <SelectTrigger id={`${id}-map`} className="w-full">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="none">
                                No map — describe a region
                            </SelectItem>
                            {maps.map((m) => (
                                <SelectItem key={m.id} value={String(m.id)}>
                                    {m.real_world && <MapPin />}
                                    {m.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                        {map
                            ? map.real_world
                                ? 'Uses its coordinates, height range, water and ESA land cover.'
                                : 'Uses its height range and water; add a region for the species.'
                            : 'The palette is global; a map only adds context.'}
                    </p>
                </div>
                <div className="grid gap-2">
                    <Label htmlFor={`${id}-region`}>
                        Region {map?.real_world ? '(optional)' : ''}
                    </Label>
                    <Input
                        id={`${id}-region`}
                        value={brief.region}
                        maxLength={200}
                        placeholder={REGION_EXAMPLES}
                        onChange={(e) =>
                            setBrief((b) => ({ ...b, region: e.target.value }))
                        }
                    />
                    <p className="text-xs text-muted-foreground">
                        Place, biome or season — drives the species.
                    </p>
                </div>
            </div>

            <StyleSlider
                value={brief.style}
                onChange={(v) => setBrief((b) => ({ ...b, style: v }))}
                description={
                    brief.style <= 35
                        ? 'Prefers photoscanned Poly Haven models and realistic library assets.'
                        : brief.style <= 65
                          ? 'Mixes realistic trees and rocks with painterly AI cards or procedural ground cover.'
                          : 'Prefers procedural low-poly meshes, stylized library assets and stylized AI cards.'
                }
            />

            <div className="grid gap-2">
                <Label htmlFor={`${id}-direction`}>
                    Extra direction (optional)
                </Label>
                <Textarea
                    id={`${id}-direction`}
                    rows={2}
                    maxLength={600}
                    value={brief.direction}
                    placeholder="e.g. autumn colours, sparse dry look, no palms, keep my boulders"
                    onChange={(e) =>
                        setBrief((b) => ({ ...b, direction: e.target.value }))
                    }
                />
            </div>

            <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
                <div className="space-y-1">
                    <Label htmlFor={`${id}-gen`}>Allow AI generation</Label>
                    <p className="text-xs text-muted-foreground">
                        Lets the plan generate plant cards when nothing in the
                        library or on Poly Haven fits (costs OpenRouter
                        credits).
                    </p>
                </div>
                <Switch
                    id={`${id}-gen`}
                    checked={brief.allow_generation}
                    onCheckedChange={(v) =>
                        setBrief((b) => ({ ...b, allow_generation: v }))
                    }
                />
            </div>
        </div>
    );
}

function PlanReview({
    plan,
    rows,
    setRows,
}: {
    plan: FoliagePlan;
    rows: RowState[];
    setRows: (fn: (rows: RowState[]) => RowState[]) => void;
}) {
    const update = (i: number, patch: Partial<RowState>) =>
        setRows((prev) =>
            prev.map((r, j) => (j === i ? { ...r, ...patch } : r)),
        );
    const order = { add: 0, change: 1, remove: 2, keep: 3 };
    const indexed = rows
        .map((r, i) => ({ r, i }))
        .sort((a, b) => order[a.r.row.action] - order[b.r.row.action]);

    return (
        <div className="grid gap-5">
            <div className="grid gap-2 rounded-xl bg-muted/50 p-4">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {plan.brief.map_name && (
                        <Badge variant="outline">
                            <MapPin />
                            {plan.brief.map_name}
                        </Badge>
                    )}
                    {plan.brief.region && (
                        <Badge variant="outline">{plan.brief.region}</Badge>
                    )}
                    <Badge variant="outline">
                        Style {plan.brief.style}/100
                    </Badge>
                </div>
                {plan.summary && <p className="text-sm">{plan.summary}</p>}
                {plan.notes.length > 0 && (
                    <ul className="grid gap-1 text-xs text-muted-foreground">
                        {plan.notes.map((n, i) => (
                            <li key={i} className="flex gap-1.5">
                                <Lightbulb className="mt-px size-3.5 shrink-0" />
                                {n}
                            </li>
                        ))}
                    </ul>
                )}
                {plan.unavailable_sources.length > 0 && (
                    <p className="flex gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                        <Info className="mt-px size-3.5 shrink-0" />
                        {plan.unavailable_sources.join(', ')} could not be
                        reached, so its models were not considered.
                    </p>
                )}
            </div>

            <ul className="grid gap-3">
                {indexed.map(({ r, i }) => (
                    <PlanRowItem
                        key={i}
                        state={r}
                        onChange={(patch) => update(i, patch)}
                    />
                ))}
            </ul>
        </div>
    );
}

function PlanRowItem({
    state,
    onChange,
}: {
    state: RowState;
    onChange: (patch: Partial<RowState>) => void;
}) {
    const { row } = state;
    const style = ACTION_STYLES[row.action];
    const Icon = kindIcon(row.kind);
    const keep = row.action === 'keep';
    const inUse = (row.usage?.instances ?? 0) > 0;
    const id = useId();
    const asset: FoliagePlanAsset | null =
        state.assetChoice === 'procedural'
            ? { type: 'procedural' }
            : state.assetChoice === 'current'
              ? (row.current?.asset ?? null)
              : row.asset;

    return (
        <li
            className={cn(
                'grid gap-3 rounded-xl border p-3 transition',
                !keep && !state.include && 'opacity-60',
                keep && 'bg-muted/30',
            )}
        >
            <div className="flex items-start gap-3">
                {!keep ? (
                    <Checkbox
                        id={id}
                        checked={state.include}
                        onCheckedChange={(v) =>
                            onChange({ include: v === true })
                        }
                        className="mt-1"
                        aria-label={`Apply: ${style.label} ${row.name}`}
                    />
                ) : (
                    <span className="size-4" />
                )}
                <div
                    className="flex size-9 shrink-0 items-center justify-center rounded-lg text-white"
                    style={{
                        background: row.settings
                            ? `linear-gradient(135deg, ${row.settings.color}, ${row.settings.color_secondary})`
                            : row.current
                              ? `linear-gradient(135deg, ${row.current.settings.color}, ${row.current.settings.color_secondary})`
                              : undefined,
                    }}
                >
                    <Icon className="size-4 drop-shadow" />
                </div>
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <Badge className={style.className}>{style.label}</Badge>
                        {row.action === 'add' || row.action === 'change' ? (
                            <Input
                                value={state.name}
                                maxLength={60}
                                onChange={(e) =>
                                    onChange({ name: e.target.value })
                                }
                                className="h-7 w-auto min-w-40 flex-1 font-medium"
                                aria-label="Name"
                            />
                        ) : (
                            <span className="font-medium">{row.name}</span>
                        )}
                        {row.current && row.current.name !== state.name && (
                            <span className="text-xs text-muted-foreground">
                                was {row.current.name}
                            </span>
                        )}
                    </div>
                    {row.reason && (
                        <p className="mt-1 text-sm text-muted-foreground">
                            {row.reason}
                        </p>
                    )}
                    {row.action === 'remove' && inUse && (
                        <p className="mt-1 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                            <TriangleAlert className="mt-px size-3.5 shrink-0" />
                            Placed {formatNumber(row.usage!.instances, 0)} times
                            on {row.usage!.maps} map
                            {row.usage!.maps === 1 ? '' : 's'} — those instances
                            disappear. Left unticked for you to decide.
                        </p>
                    )}
                </div>
            </div>

            {(row.action === 'add' || row.action === 'change') &&
                row.settings && (
                    <div className="grid gap-3 pl-7 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
                        <AssetBox
                            asset={asset}
                            suggested={row.asset}
                            choice={state.assetChoice}
                            canKeepCurrent={row.action === 'change'}
                            kind={row.kind}
                            onChoice={(c) => onChange({ assetChoice: c })}
                        />
                        <SettingsDiff
                            next={row.settings}
                            current={row.current?.settings ?? null}
                        />
                    </div>
                )}
        </li>
    );
}

function AssetBox({
    asset,
    suggested,
    choice,
    canKeepCurrent,
    kind,
    onChoice,
}: {
    asset: FoliagePlanAsset | null;
    suggested: FoliagePlanAsset | null;
    choice: RowState['assetChoice'];
    canKeepCurrent: boolean;
    kind: FoliageKind;
    onChoice: (choice: RowState['assetChoice']) => void;
}) {
    let thumb: string | null = null;
    let title: ReactNode = 'Procedural mesh';
    let detail: ReactNode = 'Built-in low-poly mesh, tinted by the colours.';
    let icon: ReactNode = <Shapes className="size-3.5" />;

    switch (asset?.type) {
        case 'library':
            thumb = asset.thumbnail_url;
            title = asset.name;
            detail = `Library · ${asset.style}${asset.height ? ` · ${formatMetres(asset.height)}` : ''}${asset.status !== 'ready' ? ` · ${asset.status.replace('_', ' ')}` : ''}`;
            icon = <Box className="size-3.5" />;
            break;
        case 'import':
            thumb = asset.thumbnail_url;
            title = (
                <a
                    href={asset.source_url}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:underline"
                >
                    {asset.name}
                </a>
            );
            detail = 'Import from Poly Haven (CC0), optimised in your browser';
            icon = <Download className="size-3.5" />;
            break;
        case 'generate':
            title = 'AI generated card';
            detail = asset.prompt;
            icon = <Sparkles className="size-3.5" />;
            break;
        case 'current':
            title = 'Current model';
            detail = 'Unchanged.';
            icon = <Box className="size-3.5" />;
            break;
        case 'upload':
            title = 'Uploaded model';
            detail = 'Unchanged.';
            icon = <Box className="size-3.5" />;
            break;
    }

    const options: { value: RowState['assetChoice']; label: string }[] = [
        {
            value: 'suggested',
            label:
                suggested?.type === 'import'
                    ? 'Suggested: import'
                    : suggested?.type === 'generate'
                      ? 'Suggested: AI card'
                      : suggested?.type === 'library'
                        ? 'Suggested: library'
                        : suggested?.type === 'current'
                          ? 'Suggested: keep model'
                          : 'Suggested: procedural',
        },
        ...(suggested?.type !== 'procedural'
            ? [{ value: 'procedural' as const, label: 'Procedural mesh' }]
            : []),
        ...(canKeepCurrent && suggested?.type !== 'current'
            ? [{ value: 'current' as const, label: 'Keep current model' }]
            : []),
    ];

    return (
        <div className="flex gap-3 rounded-lg border p-2">
            <MaterialThumb
                src={thumb}
                alt=""
                className="size-16 shrink-0 rounded-md"
                iconClassName="size-4"
            />
            <div className="grid min-w-0 flex-1 content-start gap-1">
                <div className="flex items-center gap-1.5 text-sm font-medium">
                    {icon}
                    <span className="truncate">{title}</span>
                </div>
                <p className="line-clamp-2 text-xs text-muted-foreground">
                    {detail}
                </p>
                {options.length > 1 && (
                    <Select
                        value={choice}
                        onValueChange={(v) =>
                            onChoice(v as RowState['assetChoice'])
                        }
                    >
                        <SelectTrigger
                            size="sm"
                            className="h-7 w-full text-xs"
                            aria-label={`Model for this ${kind}`}
                        >
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {options.map((o) => (
                                <SelectItem key={o.value} value={o.value}>
                                    {o.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                )}
            </div>
        </div>
    );
}

function SettingsDiff({
    next,
    current,
}: {
    next: FoliagePlanSettings;
    current: FoliagePlanSettings | null;
}) {
    const range = (a: number | null, b: number | null, unit: string) =>
        a === null && b === null
            ? 'any'
            : `${a === null ? '…' : formatNumber(a, 0)}–${b === null ? '…' : formatNumber(b, 0)}${unit}`;
    const items: { label: string; now: string; was: string | null }[] = [
        {
            label: 'Size',
            now: `${formatMetres(next.size_min_m)}–${formatMetres(next.size_max_m)}`,
            was: current
                ? `${formatMetres(current.size_min_m)}–${formatMetres(current.size_max_m)}`
                : null,
        },
        {
            label: 'Density',
            now: `${formatNumber(next.density)}/100 m²`,
            was: current ? `${formatNumber(current.density)}/100 m²` : null,
        },
        {
            label: 'Slope',
            now: range(next.min_slope, next.max_slope, '°'),
            was: current
                ? range(current.min_slope, current.max_slope, '°')
                : null,
        },
        {
            label: 'Altitude',
            now: range(next.min_height, next.max_height, ' m'),
            was: current
                ? range(current.min_height, current.max_height, ' m')
                : null,
        },
        {
            label: 'Cull',
            now: `${formatNumber(next.cull_distance, 0)} m`,
            was: current ? `${formatNumber(current.cull_distance, 0)} m` : null,
        },
    ];

    return (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs sm:grid-cols-3">
            {items.map((item) => {
                const changed = item.was !== null && item.was !== item.now;

                return (
                    <div key={item.label} className="min-w-0">
                        <dt className="text-muted-foreground">{item.label}</dt>
                        <dd
                            className={cn(
                                'flex flex-wrap items-center gap-1 font-medium tabular-nums',
                                changed && 'text-sky-700 dark:text-sky-300',
                            )}
                        >
                            {changed && (
                                <>
                                    <span className="font-normal text-muted-foreground line-through">
                                        {item.was}
                                    </span>
                                    <ArrowRight className="size-3" />
                                </>
                            )}
                            {item.now}
                        </dd>
                    </div>
                );
            })}
            <div className="min-w-0">
                <dt className="text-muted-foreground">Colours</dt>
                <dd className="flex items-center gap-1">
                    {[next.color, next.color_secondary, next.tint].map(
                        (c, i) => (
                            <span
                                key={i}
                                title={i === 2 ? `Model tint ${c}` : c}
                                className="size-3.5 rounded-full border"
                                style={{ backgroundColor: c }}
                            />
                        ),
                    )}
                </dd>
            </div>
        </dl>
    );
}
