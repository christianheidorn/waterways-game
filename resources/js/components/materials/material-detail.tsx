import { useForm } from '@inertiajs/react';
import {
    Copy,
    ExternalLink,
    RefreshCw,
    Save,
    Sparkles,
    Trash2,
    TriangleAlert,
} from 'lucide-react';
import type { FormEvent } from 'react';
import { useId, useState } from 'react';
import { ColorField } from '@/components/color-field';
import { ConfirmDialog } from '@/components/confirm-dialog';
import InputError from '@/components/input-error';
import { CategorySelect, Segmented } from '@/components/materials/fields';
import { MaterialPreview } from '@/components/materials/material-preview';
import {
    MaterialThumb,
    materialImage,
} from '@/components/materials/material-thumb';
import { SliderField } from '@/components/slider-field';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
    SheetDescription,
    SheetFooter,
    SheetHeader,
    SheetTitle,
} from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { MATERIAL_MAPS, MATERIAL_SOURCE_LABELS } from '@/lib/materials';
import materials from '@/routes/materials';
import type { AiConfig, CategoryOption, MaterialStudio } from '@/types';
import { Link } from '@inertiajs/react';
import aiSettings from '@/routes/ai-settings';

type Props = {
    material: MaterialStudio;
    categories: CategoryOption[];
    ai: AiConfig;
    onClose: () => void;
};

type DetailForm = {
    name: string;
    category: string;
    tile_size: number;
    tint: string;
    roughness_scale: number;
    normal_strength: number;
    height_contrast: number;
    tags: string[];
};

function toForm(m: MaterialStudio): DetailForm {
    return {
        name: m.name,
        category: m.category,
        tile_size: m.tile_size,
        tint: m.tint,
        roughness_scale: m.roughness_scale,
        normal_strength: m.normal_strength,
        height_contrast: m.height_contrast,
        tags: m.tags,
    };
}

/** Sheet body: live preview, maps, editable defaults and actions for one material. */
export function MaterialDetail({ material, categories, ai, onClose }: Props) {
    const id = useId();
    const form = useForm<DetailForm>(toForm(material));
    const duplicateForm = useForm({});
    const deleteForm = useForm({});
    const retryForm = useForm({});
    const [tagDraft, setTagDraft] = useState(material.tags.join(', '));

    const set = <K extends keyof DetailForm>(key: K, value: DetailForm[K]) =>
        form.setData((prev) => ({ ...prev, [key]: value }));

    const errors = form.errors as Partial<Record<string, string>>;
    const ready = material.status === 'ready' && !!material.maps.albedo;
    const usedBy = material.layers_count ?? 0;

    const submit = (e: FormEvent) => {
        e.preventDefault();
        form.submit(materials.update(material.id), {
            preserveScroll: true,
            onSuccess: () => form.setDefaults(),
        });
    };

    const commitTags = (raw: string) => {
        const tags = Array.from(
            new Set(
                raw
                    .split(',')
                    .map((t) => t.trim().toLowerCase())
                    .filter(Boolean),
            ),
        ).slice(0, 20);
        set('tags', tags);
    };

    return (
        <form
            onSubmit={submit}
            className="flex min-h-0 flex-1 flex-col"
            aria-labelledby={`${id}-title`}
        >
            <SheetHeader className="border-b pr-12">
                <SheetTitle id={`${id}-title`} className="truncate">
                    {material.name}
                </SheetTitle>
                <SheetDescription asChild>
                    <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="secondary">
                            {categories.find(
                                (c) => c.value === material.category,
                            )?.label ?? material.category}
                        </Badge>
                        <Badge variant="outline">
                            {MATERIAL_SOURCE_LABELS[material.source]}
                        </Badge>
                        {material.resolution && (
                            <Badge variant="outline" className="tabular-nums">
                                {material.resolution} px
                            </Badge>
                        )}
                        <span className="text-xs">
                            {usedBy > 0
                                ? `Used by ${usedBy} terrain ${usedBy === 1 ? 'layer' : 'layers'}`
                                : 'Not used on any map yet'}
                        </span>
                    </div>
                </SheetDescription>
            </SheetHeader>

            <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="grid gap-6 p-4">
                    {material.status === 'processing' && (
                        <Alert>
                            <Spinner />
                            <AlertTitle>Processing…</AlertTitle>
                            <AlertDescription>
                                {material.status_message ??
                                    'The texture maps are being prepared. This page updates automatically.'}
                            </AlertDescription>
                        </Alert>
                    )}
                    {material.status === 'failed' && (
                        <Alert variant="destructive">
                            <TriangleAlert />
                            <AlertTitle>Processing failed</AlertTitle>
                            <AlertDescription>
                                <p>
                                    {material.status_message ??
                                        'Something went wrong while preparing this material.'}
                                </p>
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    className="mt-2"
                                    disabled={retryForm.processing}
                                    onClick={() =>
                                        retryForm.submit(
                                            materials.retry(material.id),
                                            { preserveScroll: true },
                                        )
                                    }
                                >
                                    {retryForm.processing ? (
                                        <Spinner />
                                    ) : (
                                        <RefreshCw />
                                    )}
                                    Retry
                                </Button>
                            </AlertDescription>
                        </Alert>
                    )}

                    {ready ? (
                        <MaterialPreview
                            material={material}
                            options={{
                                tileSize: form.data.tile_size,
                                tint: form.data.tint,
                                roughnessScale: form.data.roughness_scale,
                                normalStrength: form.data.normal_strength,
                            }}
                        />
                    ) : (
                        <MaterialThumb
                            src={materialImage(material)}
                            alt={material.name}
                            className="aspect-[16/10] rounded-xl border"
                        />
                    )}

                    <section aria-label="Texture maps" className="grid gap-2">
                        <h3 className="text-sm font-medium">Texture maps</h3>
                        <div className="grid grid-cols-5 gap-2">
                            {MATERIAL_MAPS.map((m) => {
                                const url = material.maps[m.key];

                                return (
                                    <figure key={m.key} className="grid gap-1">
                                        {url ? (
                                            <a
                                                href={url}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                                            >
                                                <MaterialThumb
                                                    src={url}
                                                    alt={`${m.label} map`}
                                                    className="aspect-square rounded-md border"
                                                />
                                            </a>
                                        ) : (
                                            <div className="flex aspect-square items-center justify-center rounded-md border border-dashed text-[10px] text-muted-foreground">
                                                none
                                            </div>
                                        )}
                                        <figcaption className="truncate text-center text-xs text-muted-foreground">
                                            {m.label}
                                        </figcaption>
                                    </figure>
                                );
                            })}
                        </div>
                    </section>

                    <section className="grid gap-5" aria-label="Defaults">
                        <div>
                            <h3 className="text-sm font-medium">Defaults</h3>
                            <p className="text-xs text-muted-foreground">
                                Used when the material is assigned to a terrain
                                layer. Each layer can override tint, tiling and
                                strength.
                            </p>
                        </div>
                        <div className="grid gap-4 sm:grid-cols-2">
                            <div className="grid content-start gap-2">
                                <Label htmlFor={`${id}-name`}>Name</Label>
                                <Input
                                    id={`${id}-name`}
                                    value={form.data.name}
                                    onChange={(e) =>
                                        set('name', e.target.value)
                                    }
                                    maxLength={120}
                                    required
                                    aria-invalid={
                                        errors.name ? true : undefined
                                    }
                                />
                                <InputError message={errors.name} />
                            </div>
                            <CategorySelect
                                categories={categories}
                                value={form.data.category}
                                onChange={(v) => set('category', v)}
                                error={errors.category}
                            />
                        </div>
                        <SliderField
                            label="Tile size"
                            value={form.data.tile_size}
                            onChange={(v) => set('tile_size', v)}
                            min={0.25}
                            max={50}
                            step={0.05}
                            unit="m"
                            description="Real-world size of one texture repeat."
                            error={errors.tile_size}
                        />
                        <div className="grid gap-5 sm:grid-cols-2">
                            <ColorField
                                label="Tint"
                                value={form.data.tint}
                                onChange={(v) => set('tint', v)}
                                description="Multiplied onto the albedo; white keeps the original colours."
                                error={errors.tint}
                            />
                            <SliderField
                                label="Roughness scale"
                                value={form.data.roughness_scale}
                                onChange={(v) => set('roughness_scale', v)}
                                min={0}
                                max={2}
                                step={0.01}
                                unit="×"
                                error={errors.roughness_scale}
                            />
                            <SliderField
                                label="Normal strength"
                                value={form.data.normal_strength}
                                onChange={(v) => set('normal_strength', v)}
                                min={0}
                                max={3}
                                step={0.01}
                                unit="×"
                                error={errors.normal_strength}
                            />
                            <SliderField
                                label="Height contrast"
                                value={form.data.height_contrast}
                                onChange={(v) => set('height_contrast', v)}
                                min={0}
                                max={3}
                                step={0.01}
                                unit="×"
                                description="Sharpens height-based blending with neighbouring layers."
                                error={errors.height_contrast}
                            />
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor={`${id}-tags`}>Tags</Label>
                            <Input
                                id={`${id}-tags`}
                                value={tagDraft}
                                onChange={(e) => setTagDraft(e.target.value)}
                                onBlur={() => commitTags(tagDraft)}
                                placeholder="wet, mossy, riverbank"
                            />
                            {form.data.tags.length > 0 && (
                                <div className="flex flex-wrap gap-1">
                                    {form.data.tags.map((t) => (
                                        <Badge key={t} variant="secondary">
                                            {t}
                                        </Badge>
                                    ))}
                                </div>
                            )}
                            <InputError message={errors.tags} />
                        </div>
                    </section>

                    <SourceInfo material={material} />
                </div>
            </div>

            <SheetFooter className="flex-row flex-wrap items-center gap-2 border-t bg-muted/30">
                <Button
                    type="submit"
                    size="sm"
                    disabled={form.processing || !form.isDirty}
                    onMouseDown={() => commitTags(tagDraft)}
                >
                    {form.processing ? <Spinner /> : <Save />}
                    Save
                </Button>
                {form.recentlySuccessful && !form.isDirty && (
                    <span className="text-xs text-muted-foreground">Saved</span>
                )}
                <div className="flex-1" />
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={duplicateForm.processing}
                    onClick={() =>
                        duplicateForm.submit(materials.duplicate(material.id), {
                            preserveScroll: true,
                        })
                    }
                >
                    {duplicateForm.processing ? <Spinner /> : <Copy />}
                    Duplicate
                </Button>
                <AiEditDialog material={material} ai={ai} />
                <ConfirmDialog
                    trigger={
                        <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="text-red-600 hover:bg-red-500/10 hover:text-red-700 dark:text-red-400"
                        >
                            <Trash2 />
                            Delete
                        </Button>
                    }
                    title={`Delete ${material.name}?`}
                    description={
                        usedBy > 0
                            ? `It is used by ${usedBy} terrain ${usedBy === 1 ? 'layer' : 'layers'}; those layers fall back to their procedural colours. The texture files are removed permanently.`
                            : 'The material and its texture files are removed permanently.'
                    }
                    confirmLabel="Delete material"
                    destructive
                    processing={deleteForm.processing}
                    onConfirm={(close) =>
                        deleteForm.submit(materials.destroy(material.id), {
                            preserveScroll: true,
                            onSuccess: () => {
                                close();
                                onClose();
                            },
                        })
                    }
                />
            </SheetFooter>
        </form>
    );
}

function SourceInfo({ material }: { material: MaterialStudio }) {
    const rows: [string, string | null][] = [
        ['Source', MATERIAL_SOURCE_LABELS[material.source]],
        ['Author', material.author],
        ['Licence', material.license],
        ['AI model', material.ai_model],
    ];

    return (
        <section
            aria-label="Source"
            className="grid gap-3 rounded-lg border p-4 text-sm"
        >
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
                {rows
                    .filter(([, v]) => v)
                    .map(([k, v]) => (
                        <div key={k} className="min-w-0">
                            <dt className="text-xs text-muted-foreground">
                                {k}
                            </dt>
                            <dd className="truncate font-medium">{v}</dd>
                        </div>
                    ))}
            </dl>
            {material.ai_prompt && (
                <div>
                    <div className="text-xs text-muted-foreground">Prompt</div>
                    <p className="mt-0.5 text-sm">{material.ai_prompt}</p>
                </div>
            )}
            {material.source_url && (
                <a
                    href={material.source_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex w-fit items-center gap-1 text-xs font-medium text-sky-700 hover:underline dark:text-sky-400"
                >
                    View original
                    <ExternalLink className="size-3" />
                </a>
            )}
        </section>
    );
}

function AiEditDialog({
    material,
    ai,
}: {
    material: MaterialStudio;
    ai: AiConfig;
}) {
    const id = useId();
    const [open, setOpen] = useState(false);
    const form = useForm({ prompt: '', variants: 1 });
    const errors = form.errors as Partial<Record<string, string>>;

    const submit = (e: FormEvent) => {
        e.preventDefault();
        e.stopPropagation();
        form.submit(materials.aiEdit(material.id), {
            preserveScroll: true,
            onSuccess: () => {
                setOpen(false);
                form.reset();
            },
        });
    };

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={material.status !== 'ready'}
                >
                    <Sparkles />
                    AI edit
                </Button>
            </DialogTrigger>
            <DialogContent>
                <form onSubmit={submit} className="grid gap-5">
                    <DialogHeader>
                        <DialogTitle>Edit with AI</DialogTitle>
                        <DialogDescription>
                            Creates new materials derived from {material.name}.
                            The original stays unchanged.
                        </DialogDescription>
                    </DialogHeader>
                    {!ai.configured ? (
                        <NotConfigured />
                    ) : (
                        <>
                            <div className="grid gap-2">
                                <Label htmlFor={`${id}-prompt`}>
                                    What should change?
                                </Label>
                                <Textarea
                                    id={`${id}-prompt`}
                                    value={form.data.prompt}
                                    onChange={(e) =>
                                        form.setData('prompt', e.target.value)
                                    }
                                    rows={3}
                                    maxLength={1000}
                                    required
                                    placeholder="make it wetter with darker soil and small puddles"
                                />
                                <InputError
                                    message={errors.prompt ?? errors.ai}
                                />
                            </div>
                            <Segmented
                                label="Variants"
                                value={form.data.variants}
                                options={[1, 2, 3, 4].map((n) => ({
                                    value: n,
                                    label: String(n),
                                }))}
                                onChange={(v) => form.setData('variants', v)}
                            />
                            <p className="text-xs text-muted-foreground">
                                Costs are charged to your OpenRouter credits.
                            </p>
                        </>
                    )}
                    <DialogFooter className="gap-2">
                        <DialogClose asChild>
                            <Button type="button" variant="secondary">
                                Cancel
                            </Button>
                        </DialogClose>
                        <Button
                            type="submit"
                            disabled={
                                !ai.configured ||
                                form.processing ||
                                !form.data.prompt.trim()
                            }
                        >
                            {form.processing ? <Spinner /> : <Sparkles />}
                            Generate
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/** Hint shown in AI dialogs when no OpenRouter key is configured. */
export function NotConfigured() {
    return (
        <Alert>
            <Sparkles />
            <AlertTitle>AI is not set up yet</AlertTitle>
            <AlertDescription>
                <p>
                    Add an OpenRouter API key to generate and edit materials
                    with AI.
                </p>
                <Button asChild size="sm" variant="outline" className="mt-2">
                    <Link href={aiSettings.edit()}>Open AI settings</Link>
                </Button>
            </AlertDescription>
        </Alert>
    );
}
