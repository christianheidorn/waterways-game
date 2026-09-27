import {
    ArrowRight,
    Download,
    Library,
    Palette,
    Pencil,
    RotateCcw,
    Sparkles,
    TriangleAlert,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useId, useState } from 'react';
import { ColorField } from '@/components/color-field';
import { MaterialPicker } from '@/components/materials/material-picker';
import { MaterialThumb } from '@/components/materials/material-thumb';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { MATERIAL_SOURCE_LABELS } from '@/lib/materials';
import { cn } from '@/lib/utils';
import type {
    CategoryOption,
    MaterialStudio,
    PlanAction,
    PlanLayer,
    PlanMaterial,
    PlanSettings,
} from '@/types';

/** Reviewable state of one plan row. */
export type PlanRowState = {
    original: PlanLayer;
    draft: PlanLayer;
    include: boolean;
};

export const ACTION_STYLES: Record<
    PlanAction,
    { label: string; className: string }
> = {
    keep: {
        label: 'Keep',
        className: 'border-transparent bg-muted text-muted-foreground',
    },
    change: {
        label: 'Change',
        className:
            'border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-300',
    },
    add: {
        label: 'Add',
        className:
            'border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
    },
    remove: {
        label: 'Remove',
        className:
            'border-transparent bg-red-500/15 text-red-700 dark:text-red-300',
    },
};

const SOURCE_NAMES: Record<string, string> = {
    polyhaven: 'Poly Haven',
    ambientcg: 'ambientCG',
};

export function sameMaterial(
    a: PlanMaterial | null | undefined,
    b: PlanMaterial | null | undefined,
): boolean {
    if (!a || !b || a.type !== b.type) {
        return !a && !b;
    }

    if (a.type === 'library' && b.type === 'library') {
        return a.material_id === b.material_id;
    }

    if (a.type === 'import' && b.type === 'import') {
        return a.source === b.source && a.ref === b.ref;
    }

    if (a.type === 'generate' && b.type === 'generate') {
        return a.prompt === b.prompt;
    }

    return true;
}

function fmt(value: number, digits = 2): string {
    return String(Number(value.toFixed(digits)));
}

function range(
    min: number | null,
    max: number | null,
    unit: string,
): string | null {
    if (min === null && max === null) {
        return null;
    }

    const f = (v: number) => `${Math.round(v)}${unit}`;

    if (min !== null && max !== null) {
        return `${f(min)}–${f(max)}`;
    }

    return min !== null ? `≥ ${f(min)}` : `≤ ${f(max as number)}`;
}

export function rulesLabel(s: PlanSettings): string {
    const parts = [
        range(s.auto_min_height, s.auto_max_height, ' m'),
        range(s.auto_min_slope, s.auto_max_slope, '°'),
    ].filter(Boolean);

    return `${parts.length ? parts.join(' · ') : 'Anywhere'} · P${s.auto_priority}`;
}

type SettingChip = {
    key: string;
    label: string;
    from: ReactNode;
    to: ReactNode;
    changed: boolean;
};

function Swatch({ color }: { color: string }) {
    return (
        <span
            className="inline-block size-3 shrink-0 rounded-sm border align-middle"
            style={{ backgroundColor: color }}
            aria-label={color}
        />
    );
}

/** Settings shown for a row, with what changed compared to the current layer. */
export function settingChips(
    current: PlanSettings | null,
    next: PlanSettings,
): SettingChip[] {
    const rulesFrom = current ? rulesLabel(current) : null;
    const rulesTo = rulesLabel(next);

    const chip = (
        key: string,
        label: string,
        from: ReactNode,
        to: ReactNode,
        changed: boolean,
    ): SettingChip => ({ key, label, from, to, changed });

    return [
        chip(
            'tile',
            'Tile',
            current ? `${fmt(current.texture_scale)} m` : null,
            `${fmt(next.texture_scale)} m`,
            !current ||
                Math.abs(current.texture_scale - next.texture_scale) > 1e-6,
        ),
        chip(
            'tint',
            'Tint',
            current ? <Swatch color={current.tint} /> : null,
            <Swatch color={next.tint} />,
            !current || current.tint.toLowerCase() !== next.tint.toLowerCase(),
        ),
        chip(
            'rough',
            'Rough',
            current ? `×${fmt(current.roughness_scale)}` : null,
            `×${fmt(next.roughness_scale)}`,
            !current ||
                Math.abs(current.roughness_scale - next.roughness_scale) > 1e-6,
        ),
        chip(
            'normal',
            'Normal',
            current ? `×${fmt(current.normal_strength)}` : null,
            `×${fmt(next.normal_strength)}`,
            !current ||
                Math.abs(current.normal_strength - next.normal_strength) > 1e-6,
        ),
        chip('rules', 'Rules', rulesFrom, rulesTo, rulesFrom !== rulesTo),
    ];
}

/** Thumbnail + name + source badge of a plan material. */
export function PlanMaterialCell({
    material,
    fallbackColors,
    muted,
    generationNote,
}: {
    material: PlanMaterial | null;
    /** Procedural colours of the layer (for the swatch). */
    fallbackColors?: [string, string];
    muted?: boolean;
    generationNote?: string;
}) {
    const box = 'size-11 shrink-0 rounded-md border';

    if (!material) {
        return (
            <span className="text-xs text-muted-foreground italic">
                No layer
            </span>
        );
    }

    let image: ReactNode;
    let title: ReactNode;
    let badge: ReactNode;
    let extra: ReactNode = null;

    switch (material.type) {
        case 'library':
            image = (
                <MaterialThumb
                    src={material.thumbnail_url}
                    alt=""
                    className={box}
                    iconClassName="size-3.5"
                />
            );
            title = material.name;
            badge = (
                <Badge variant="outline" className="gap-1 font-normal">
                    <Library />
                    {material.status === 'processing'
                        ? 'Library · processing'
                        : `Library · ${MATERIAL_SOURCE_LABELS[material.source] ?? material.source}`}
                </Badge>
            );
            break;
        case 'import':
            image = (
                <MaterialThumb
                    src={material.thumbnail_url}
                    alt=""
                    className={box}
                    iconClassName="size-3.5"
                />
            );
            title = material.name;
            badge = (
                <Badge className="gap-1 border-transparent bg-sky-500/15 font-normal text-sky-700 dark:text-sky-300">
                    <Download />
                    Import from {SOURCE_NAMES[material.source]} (CC0)
                </Badge>
            );
            break;
        case 'generate':
            image = (
                <div
                    className={cn(
                        box,
                        'flex items-center justify-center bg-gradient-to-br from-violet-500/20 to-fuchsia-500/10 text-violet-600 dark:text-violet-300',
                    )}
                >
                    <Sparkles className="size-4" />
                </div>
            );
            title = (
                <span className="line-clamp-2 font-normal whitespace-normal">
                    {material.prompt}
                </span>
            );
            badge = (
                <Badge className="gap-1 border-transparent bg-violet-500/15 font-normal text-violet-700 dark:text-violet-300">
                    <Sparkles />
                    AI generation
                </Badge>
            );
            extra = generationNote ? (
                <span className="text-[11px] text-muted-foreground">
                    {generationNote}
                </span>
            ) : null;
            break;
        default:
            image = (
                <div
                    className={cn(box, 'flex items-center justify-center')}
                    style={{
                        background: fallbackColors
                            ? `linear-gradient(135deg, ${fallbackColors[0]}, ${fallbackColors[1]})`
                            : 'linear-gradient(135deg,#6b8f4e,#8a7a55)',
                    }}
                >
                    <Palette className="size-4 text-white/90 drop-shadow" />
                </div>
            );
            title = 'Procedural colours';
            badge = (
                <Badge variant="outline" className="font-normal">
                    No texture
                </Badge>
            );
    }

    return (
        <div
            className={cn(
                'flex min-w-0 items-center gap-2.5',
                muted && 'opacity-60',
            )}
        >
            {image}
            <div className="grid min-w-0 gap-1">
                <span className="truncate text-sm font-medium">{title}</span>
                <div className="flex flex-wrap items-center gap-1">
                    {badge}
                    {extra}
                </div>
            </div>
        </div>
    );
}

type RowProps = {
    row: PlanRowState;
    threshold: number;
    generationNote: string;
    library: MaterialStudio[] | undefined;
    categories: CategoryOption[];
    onNeedLibrary: () => void;
    onChange: (row: PlanRowState) => void;
};

/** One slot of the plan: current vs proposed, settings diff, reason, include + edit. */
export function PlanRow({
    row,
    threshold,
    generationNote,
    library,
    categories,
    onNeedLibrary,
    onChange,
}: RowProps) {
    const [editing, setEditing] = useState(false);
    const { draft, original } = row;
    const current = draft.current;
    const action = draft.action;
    const style = ACTION_STYLES[action];
    const coverage = current?.coverage ?? null;
    const heavilyPainted =
        action === 'remove' && coverage !== null && coverage > threshold;
    const edited =
        JSON.stringify({
            n: draft.name,
            m: draft.material,
            s: draft.settings,
        }) !==
        JSON.stringify({
            n: original.name,
            m: original.material,
            s: original.settings,
        });
    const procedural: [string, string] | undefined = current
        ? [current.color, current.color_secondary]
        : undefined;
    const chips =
        draft.settings && action !== 'remove'
            ? settingChips(current?.settings ?? null, draft.settings)
            : [];
    const materialChanged =
        action !== 'keep' &&
        action !== 'remove' &&
        !sameMaterial(current?.material, draft.material);

    const update = (patch: Partial<PlanLayer>) => {
        const next = { ...draft, ...patch };

        // Editing a "keep" row turns it into a change the user opted into.
        if (next.action === 'keep') {
            next.action = 'change';
        }

        onChange({ ...row, draft: next, include: true });
    };

    return (
        <li
            className={cn(
                'grid gap-x-4 gap-y-3 px-4 py-4 sm:grid-cols-[1.25rem_6.5rem_minmax(0,1fr)_auto] sm:px-5',
                !row.include && action !== 'keep' && 'bg-muted/30',
            )}
            data-slot-row={draft.slot}
        >
            <div className="pt-0.5">
                {action === 'keep' ? (
                    <span
                        className="block w-4 text-center text-muted-foreground"
                        aria-label="Nothing to apply"
                    >
                        –
                    </span>
                ) : (
                    <Checkbox
                        checked={row.include}
                        onCheckedChange={(v) =>
                            onChange({ ...row, include: v === true })
                        }
                        aria-label={`Apply ${style.label.toLowerCase()} of channel ${draft.slot + 1}`}
                    />
                )}
            </div>

            <div className="flex flex-row flex-wrap items-center gap-1.5 sm:flex-col sm:items-start">
                <span className="text-xs font-medium text-muted-foreground tabular-nums">
                    Channel {draft.slot + 1}
                </span>
                <Badge className={cn('font-semibold', style.className)}>
                    {style.label}
                </Badge>
                {edited && (
                    <Badge variant="outline" className="font-normal">
                        Edited
                    </Badge>
                )}
                {coverage !== null && (
                    <span
                        className={cn(
                            'text-[11px] text-muted-foreground tabular-nums',
                            heavilyPainted &&
                                'font-medium text-amber-700 dark:text-amber-400',
                        )}
                        title="Share of the terrain currently painted with this channel"
                    >
                        {coverage}% painted
                    </span>
                )}
            </div>

            <div className="grid min-w-0 gap-3">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span
                        className={cn(
                            'text-sm font-semibold',
                            action === 'remove' &&
                                'text-muted-foreground line-through',
                        )}
                    >
                        {action === 'remove'
                            ? (current?.name ?? draft.name)
                            : draft.name}
                    </span>
                    {current &&
                        action !== 'remove' &&
                        current.name !== draft.name && (
                            <span className="text-xs text-muted-foreground">
                                was “{current.name}”
                            </span>
                        )}
                </div>

                <div className="grid items-center gap-2 md:grid-cols-[minmax(0,1fr)_1rem_minmax(0,1fr)]">
                    {action === 'add' ? (
                        <span className="text-xs text-muted-foreground italic">
                            Free channel
                        </span>
                    ) : (
                        <PlanMaterialCell
                            material={current?.material ?? null}
                            fallbackColors={procedural}
                            muted={action === 'remove' || materialChanged}
                        />
                    )}
                    <ArrowRight
                        className="hidden size-4 text-muted-foreground md:block"
                        aria-hidden
                    />
                    {action === 'remove' ? (
                        <span className="text-xs text-red-700 dark:text-red-300">
                            Layer removed — frees a GPU channel
                        </span>
                    ) : action === 'keep' ? (
                        <span className="text-xs text-muted-foreground">
                            Unchanged
                        </span>
                    ) : (
                        <div
                            className={cn(
                                'rounded-lg',
                                materialChanged &&
                                    'bg-sky-500/5 ring-1 ring-sky-500/20 ring-inset',
                                materialChanged && 'p-1.5',
                            )}
                        >
                            <PlanMaterialCell
                                material={draft.material}
                                fallbackColors={procedural}
                                generationNote={generationNote}
                            />
                        </div>
                    )}
                </div>

                {chips.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                        {chips.map((c) => (
                            <span
                                key={c.key}
                                className={cn(
                                    'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] tabular-nums',
                                    c.changed && action !== 'keep'
                                        ? 'border-sky-500/30 bg-sky-500/10 text-foreground'
                                        : 'text-muted-foreground',
                                )}
                            >
                                <span className="text-muted-foreground">
                                    {c.label}
                                </span>
                                {c.changed &&
                                action !== 'keep' &&
                                c.from !== null ? (
                                    <>
                                        <span className="text-muted-foreground line-through decoration-muted-foreground/60">
                                            {c.from}
                                        </span>
                                        <ArrowRight className="size-2.5 text-muted-foreground" />
                                        <span className="font-medium">
                                            {c.to}
                                        </span>
                                    </>
                                ) : (
                                    <span>{c.to}</span>
                                )}
                            </span>
                        ))}
                    </div>
                )}

                {draft.reason && (
                    <p className="text-xs text-muted-foreground">
                        {draft.reason}
                    </p>
                )}

                {heavilyPainted && (
                    <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                        This channel is painted on {coverage}% of the terrain,
                        so it is not ticked. Removing it lets the other layers
                        show there — tick it if you want that.
                    </p>
                )}

                {editing && draft.settings && (
                    <RowEditor
                        row={row}
                        library={library}
                        categories={categories}
                        onNeedLibrary={onNeedLibrary}
                        update={update}
                    />
                )}
            </div>

            <div className="flex items-start gap-1 sm:flex-col sm:items-end">
                {action !== 'remove' && (
                    <Button
                        size="sm"
                        variant={editing ? 'secondary' : 'ghost'}
                        onClick={() => setEditing((v) => !v)}
                        aria-expanded={editing}
                    >
                        <Pencil />
                        {editing ? 'Done' : 'Edit'}
                    </Button>
                )}
                {edited && (
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                            onChange({ ...row, draft: row.original })
                        }
                        title="Back to the AI proposal"
                    >
                        <RotateCcw />
                        Reset
                    </Button>
                )}
            </div>
        </li>
    );
}

function RowEditor({
    row,
    library,
    categories,
    onNeedLibrary,
    update,
}: {
    row: PlanRowState;
    library: MaterialStudio[] | undefined;
    categories: CategoryOption[];
    onNeedLibrary: () => void;
    update: (patch: Partial<PlanLayer>) => void;
}) {
    const [pickerOpen, setPickerOpen] = useState(false);
    const { draft, original } = row;
    const settings = draft.settings as PlanSettings;
    const nameId = useId();
    const promptId = useId();
    const material = draft.material;

    const set = (patch: Partial<PlanSettings>) =>
        update({ settings: { ...settings, ...patch } });

    const pick = (id: number | null) => {
        setPickerOpen(false);

        if (id === null) {
            update({ material: { type: 'procedural' } });

            return;
        }

        const m = library?.find((x) => x.id === id);

        if (!m) {
            return;
        }

        update({
            material: {
                type: 'library',
                material_id: m.id,
                name: m.name,
                category: m.category,
                source: m.source,
                status: m.status,
                tile_size: m.tile_size,
                thumbnail_url: m.thumbnail_url ?? m.maps.albedo,
            },
            // Same default as assigning a material in the layer card.
            settings: { ...settings, texture_scale: m.tile_size },
        });
    };

    return (
        <div className="grid gap-4 rounded-lg border bg-muted/20 p-3 sm:p-4">
            <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                    <Label htmlFor={nameId} className="text-xs">
                        Layer name
                    </Label>
                    <Input
                        id={nameId}
                        value={draft.name}
                        maxLength={60}
                        onChange={(e) => update({ name: e.target.value })}
                        className="h-8"
                    />
                </div>
                <div className="grid gap-1.5">
                    <span className="text-xs font-medium">Material</span>
                    <div className="flex flex-wrap gap-2">
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => {
                                onNeedLibrary();
                                setPickerOpen(true);
                            }}
                        >
                            <Library />
                            Choose from library…
                        </Button>
                        {!sameMaterial(material, original.material) &&
                            original.material && (
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    onClick={() =>
                                        update({
                                            material: original.material,
                                            settings: {
                                                ...settings,
                                                texture_scale:
                                                    original.settings
                                                        ?.texture_scale ??
                                                    settings.texture_scale,
                                            },
                                        })
                                    }
                                >
                                    <RotateCcw />
                                    AI proposal
                                </Button>
                            )}
                    </div>
                </div>
            </div>

            {material?.type === 'generate' && (
                <div className="grid gap-1.5">
                    <Label htmlFor={promptId} className="text-xs">
                        Generation prompt
                    </Label>
                    <Textarea
                        id={promptId}
                        value={material.prompt}
                        maxLength={500}
                        rows={2}
                        onChange={(e) =>
                            update({
                                material: {
                                    ...material,
                                    prompt: e.target.value,
                                },
                            })
                        }
                    />
                </div>
            )}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <NumberField
                    label="Tile size"
                    unit="m"
                    value={settings.texture_scale}
                    min={0.1}
                    max={200}
                    onChange={(v) => set({ texture_scale: v ?? 2 })}
                />
                <ColorField
                    label="Tint"
                    value={settings.tint}
                    onChange={(tint) => set({ tint })}
                />
                <NumberField
                    label="Roughness"
                    unit="×"
                    value={settings.roughness_scale}
                    min={0}
                    max={3}
                    onChange={(v) => set({ roughness_scale: v ?? 1 })}
                />
                <NumberField
                    label="Normal"
                    unit="×"
                    value={settings.normal_strength}
                    min={0}
                    max={3}
                    onChange={(v) => set({ normal_strength: v ?? 1 })}
                />
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                <NumberField
                    label="Min height"
                    unit="m"
                    nullable
                    value={settings.auto_min_height}
                    onChange={(v) => set({ auto_min_height: v })}
                />
                <NumberField
                    label="Max height"
                    unit="m"
                    nullable
                    value={settings.auto_max_height}
                    onChange={(v) => set({ auto_max_height: v })}
                />
                <NumberField
                    label="Min slope"
                    unit="°"
                    nullable
                    min={0}
                    max={90}
                    value={settings.auto_min_slope}
                    onChange={(v) => set({ auto_min_slope: v })}
                />
                <NumberField
                    label="Max slope"
                    unit="°"
                    nullable
                    min={0}
                    max={90}
                    value={settings.auto_max_slope}
                    onChange={(v) => set({ auto_max_slope: v })}
                />
                <NumberField
                    label="Priority"
                    unit="0–10"
                    min={0}
                    max={10}
                    step={1}
                    value={settings.auto_priority}
                    onChange={(v) =>
                        set({
                            auto_priority: Math.max(
                                0,
                                Math.min(10, Math.round(v ?? 0)),
                            ),
                        })
                    }
                />
            </div>

            <MaterialPicker
                open={pickerOpen}
                onOpenChange={setPickerOpen}
                materials={library}
                categories={categories}
                value={
                    material?.type === 'library' ? material.material_id : null
                }
                onSelect={pick}
                layerName={draft.name}
            />
        </div>
    );
}

function NumberField({
    label,
    unit,
    value,
    onChange,
    min,
    max,
    step = 'any',
    nullable,
}: {
    label: string;
    unit: string;
    value: number | null;
    onChange: (value: number | null) => void;
    min?: number;
    max?: number;
    step?: number | 'any';
    nullable?: boolean;
}) {
    const id = useId();

    return (
        <div className="grid gap-1.5">
            <Label htmlFor={id} className="text-xs">
                {label}
            </Label>
            <div className="relative">
                <Input
                    id={id}
                    type="number"
                    inputMode="decimal"
                    step={step}
                    min={min}
                    max={max}
                    value={value ?? ''}
                    placeholder={nullable ? 'Any' : undefined}
                    onChange={(e) =>
                        onChange(
                            e.target.value === ''
                                ? null
                                : Number(e.target.value),
                        )
                    }
                    className="h-8 pr-10 tabular-nums"
                />
                <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs text-muted-foreground">
                    {unit}
                </span>
            </div>
        </div>
    );
}
