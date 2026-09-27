import { Link, useForm } from '@inertiajs/react';
import { Check, Sparkles, TriangleAlert, WandSparkles, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import {
    MaterialThumb,
    materialImage,
} from '@/components/materials/material-thumb';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Spinner } from '@/components/ui/spinner';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table';
import { apiFetch, errorMessage, isAiNotConfigured } from '@/lib/api';
import { materialApi } from '@/lib/materials';
import aiSettings from '@/routes/ai-settings';
import maps from '@/routes/maps';
import type {
    MapSummary,
    MaterialStudio,
    MaterialSuggestion,
    SuggestedLayer,
} from '@/types';

type Props = {
    map: MapSummary;
    materials: MaterialStudio[] | undefined;
    /** false → show a link to the AI settings instead of the button. */
    aiConfigured?: boolean;
};

function range(
    min: number | null,
    max: number | null,
    unit: string,
): string | null {
    if (min === null && max === null) {
        return null;
    }

    const fmt = (v: number) => `${Math.round(v)}${unit}`;

    if (min !== null && max !== null) {
        return `${fmt(min)}–${fmt(max)}`;
    }

    return min !== null ? `≥ ${fmt(min)}` : `≤ ${fmt(max as number)}`;
}

/** "Suggest materials with AI": proposes a full layer set, reviewed row by row before applying. */
export function AiSuggestCard({ map, materials, aiConfigured }: Props) {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notConfigured, setNotConfigured] = useState(aiConfigured === false);
    const [suggestion, setSuggestion] = useState<MaterialSuggestion | null>(
        null,
    );
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const applyForm = useForm<{ layers: SuggestedLayer[] }>({ layers: [] });

    const suggest = async () => {
        setLoading(true);
        setError(null);

        try {
            const result = await apiFetch<MaterialSuggestion>(
                materialApi.suggestMaterials(map.slug),
                { method: 'POST' },
            );
            setSuggestion(result);
            setSelected(new Set(result.layers.map((l) => l.slot)));
        } catch (e) {
            if (isAiNotConfigured(e)) {
                setNotConfigured(true);
            }

            setError(errorMessage(e));
        } finally {
            setLoading(false);
        }
    };

    const apply = () => {
        if (!suggestion) {
            return;
        }

        const layers = suggestion.layers.filter((l) => selected.has(l.slot));
        applyForm.transform(() => ({ layers }));
        applyForm.submit(maps.ai.applySuggestion(map.slug), {
            preserveScroll: true,
            onSuccess: () => {
                const generating = layers.filter(
                    (l) => !l.material_id && l.generate_prompt,
                ).length;
                toast.success(`Applied ${layers.length} layers`, {
                    description: generating
                        ? `${generating} new ${generating === 1 ? 'material is' : 'materials are'} being generated.`
                        : undefined,
                });
                setSuggestion(null);
            },
        });
    };

    const toggle = (slot: number, on: boolean) =>
        setSelected((prev) => {
            const next = new Set(prev);

            if (on) {
                next.add(slot);
            } else {
                next.delete(slot);
            }

            return next;
        });

    return (
        <section className="overflow-hidden rounded-xl border bg-gradient-to-br from-violet-500/5 via-card to-sky-500/5 shadow-xs">
            <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:p-5">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
                    <Sparkles className="size-5" />
                </div>
                <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-semibold">
                        Suggest materials with AI
                    </h3>
                    <p className="text-sm text-muted-foreground">
                        Proposes layers, materials and auto-paint rules that fit
                        this map&apos;s location, climate and elevation. You
                        review every row before anything changes.
                    </p>
                </div>
                {notConfigured ? (
                    <Button asChild variant="outline">
                        <Link href={aiSettings.edit()}>Set up AI</Link>
                    </Button>
                ) : (
                    <Button
                        onClick={suggest}
                        disabled={loading}
                        variant={suggestion ? 'outline' : 'default'}
                    >
                        {loading ? <Spinner /> : <WandSparkles />}
                        {loading
                            ? 'Thinking…'
                            : suggestion
                              ? 'Suggest again'
                              : 'Suggest'}
                    </Button>
                )}
            </div>

            {error && (
                <div className="mx-4 mb-4 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-700 sm:mx-5 dark:text-red-300">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                    {error}
                </div>
            )}

            {suggestion && (
                <div className="border-t bg-card">
                    {suggestion.summary && (
                        <p className="px-4 pt-4 text-sm sm:px-5">
                            {suggestion.summary}
                        </p>
                    )}
                    <div className="overflow-x-auto">
                        <Table className="mt-2">
                            <TableHeader>
                                <TableRow>
                                    <TableHead className="w-10 pl-4 sm:pl-5">
                                        <Checkbox
                                            checked={
                                                selected.size ===
                                                suggestion.layers.length
                                                    ? true
                                                    : selected.size === 0
                                                      ? false
                                                      : 'indeterminate'
                                            }
                                            onCheckedChange={(v) =>
                                                setSelected(
                                                    v === true
                                                        ? new Set(
                                                              suggestion.layers.map(
                                                                  (l) => l.slot,
                                                              ),
                                                          )
                                                        : new Set(),
                                                )
                                            }
                                            aria-label="Select all"
                                        />
                                    </TableHead>
                                    <TableHead>Channel</TableHead>
                                    <TableHead>Layer</TableHead>
                                    <TableHead>Material</TableHead>
                                    <TableHead>Rules</TableHead>
                                    <TableHead className="min-w-56">
                                        Why
                                    </TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {suggestion.layers.map((l) => (
                                    <SuggestionRow
                                        key={l.slot}
                                        layer={l}
                                        material={materials?.find(
                                            (m) => m.id === l.material_id,
                                        )}
                                        checked={selected.has(l.slot)}
                                        onCheckedChange={(v) =>
                                            toggle(l.slot, v)
                                        }
                                    />
                                ))}
                            </TableBody>
                        </Table>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 border-t bg-muted/30 px-4 py-3 sm:px-5">
                        <Button
                            size="sm"
                            onClick={apply}
                            disabled={
                                applyForm.processing || selected.size === 0
                            }
                        >
                            {applyForm.processing ? <Spinner /> : <Check />}
                            Apply {selected.size}{' '}
                            {selected.size === 1 ? 'layer' : 'layers'}
                        </Button>
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setSuggestion(null)}
                        >
                            <X />
                            Dismiss
                        </Button>
                        <span className="text-xs text-muted-foreground">
                            Selected channels are overwritten; painted weights
                            stay. Materials marked “generate” are created with
                            AI (charged to your OpenRouter credits).
                        </span>
                    </div>
                </div>
            )}
        </section>
    );
}

function SuggestionRow({
    layer,
    material,
    checked,
    onCheckedChange,
}: {
    layer: SuggestedLayer;
    material: MaterialStudio | undefined;
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
}) {
    const rules = [
        range(layer.auto_min_height, layer.auto_max_height, ' m'),
        range(layer.auto_min_slope, layer.auto_max_slope, '°'),
    ].filter(Boolean);

    return (
        <TableRow data-state={checked ? 'selected' : undefined}>
            <TableCell className="pl-4 sm:pl-5">
                <Checkbox
                    checked={checked}
                    onCheckedChange={(v) => onCheckedChange(v === true)}
                    aria-label={`Apply ${layer.name}`}
                />
            </TableCell>
            <TableCell className="tabular-nums">{layer.slot + 1}</TableCell>
            <TableCell>
                <div className="flex items-center gap-2 font-medium">
                    <span
                        className="size-3 shrink-0 rounded-full border"
                        style={{ backgroundColor: layer.tint }}
                        aria-hidden
                    />
                    {layer.name}
                </div>
            </TableCell>
            <TableCell>
                {layer.material_id ? (
                    <div className="flex items-center gap-2">
                        {material && (
                            <MaterialThumb
                                src={materialImage(material)}
                                alt=""
                                className="size-8 shrink-0 rounded"
                                iconClassName="size-3"
                            />
                        )}
                        <span className="max-w-40 truncate">
                            {material?.name ?? `Material #${layer.material_id}`}
                        </span>
                    </div>
                ) : layer.generate_prompt ? (
                    <div className="flex max-w-56 items-start gap-1.5 text-xs whitespace-normal">
                        <Sparkles className="mt-0.5 size-3.5 shrink-0 text-violet-500" />
                        <span>
                            <span className="font-medium">Generate:</span>{' '}
                            {layer.generate_prompt}
                        </span>
                    </div>
                ) : (
                    <span className="text-xs text-muted-foreground">
                        Procedural colours
                    </span>
                )}
            </TableCell>
            <TableCell className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                {rules.length ? rules.join(' · ') : 'Anywhere'}
                <div>Priority {layer.auto_priority}</div>
            </TableCell>
            <TableCell className="text-xs whitespace-normal text-muted-foreground">
                {layer.reason}
            </TableCell>
        </TableRow>
    );
}
