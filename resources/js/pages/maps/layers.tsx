import { Head, useForm } from '@inertiajs/react';
import type { TerrainLayer } from '@game/shared/types';
import {
    ImageUp,
    Plus,
    RotateCcw,
    Save,
    Trash2,
    WandSparkles,
    X,
} from 'lucide-react';
import type { FormEvent } from 'react';
import { useId, useRef } from 'react';
import { ColorField } from '@/components/color-field';
import { ConfirmDialog } from '@/components/confirm-dialog';
import InputError from '@/components/input-error';
import { MapTabs } from '@/components/map-tabs';
import { MaterialSwatch } from '@/components/material-swatch';
import { SliderField } from '@/components/slider-field';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import maps from '@/routes/maps';
import type { MapSummary } from '@/types';

type Props = {
    map: MapSummary;
    layers: TerrainLayer[];
    maxLayers: number;
};

type LayerForm = Omit<TerrainLayer, 'id' | 'slot' | 'texture_url'>;

const NEW_LAYER: LayerForm = {
    name: 'New layer',
    color: '#7c7462',
    color_secondary: '#9a917c',
    roughness: 0.9,
    noise_scale: 5,
    variation: 0.5,
    bump: 0.4,
    texture_scale: 4,
    auto_min_height: null,
    auto_max_height: null,
    auto_min_slope: null,
    auto_max_slope: null,
    auto_priority: 0,
};

function toForm(layer: TerrainLayer): LayerForm {
    return {
        name: layer.name,
        color: layer.color,
        color_secondary: layer.color_secondary,
        roughness: layer.roughness,
        noise_scale: layer.noise_scale,
        variation: layer.variation,
        bump: layer.bump,
        texture_scale: layer.texture_scale,
        auto_min_height: layer.auto_min_height,
        auto_max_height: layer.auto_max_height,
        auto_min_slope: layer.auto_min_slope,
        auto_max_slope: layer.auto_max_slope,
        auto_priority: layer.auto_priority,
    };
}

export default function MapLayers({ map, layers, maxLayers }: Props) {
    const addForm = useForm<LayerForm>({ ...NEW_LAYER });
    const resetForm = useForm({});
    const full = layers.length >= maxLayers;

    return (
        <>
            <Head title={`${map.name} · Terrain layers`} />
            <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 p-4 sm:p-6">
                <MapTabs map={map} />

                <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                    <div className="space-y-1">
                        <h2 className="text-lg font-semibold tracking-tight">
                            Terrain layers
                        </h2>
                        <p className="max-w-2xl text-sm text-muted-foreground">
                            Up to {maxLayers} materials you can paint onto the
                            terrain. Each layer occupies one splat channel.{' '}
                            <span className="tabular-nums">
                                {layers.length} / {maxLayers}
                            </span>{' '}
                            in use.
                        </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <ConfirmDialog
                            trigger={
                                <Button variant="outline">
                                    <RotateCcw />
                                    Reset to defaults
                                </Button>
                            }
                            title="Reset terrain layers?"
                            description="All layers are replaced with the default palette (grass, meadow, forest floor, rock, sand, mud, gravel, snow). Painted weights are kept per channel, so painted areas will show the default material of that channel."
                            confirmLabel="Reset layers"
                            destructive
                            processing={resetForm.processing}
                            onConfirm={(close) =>
                                resetForm.submit(maps.layers.reset(map.slug), {
                                    preserveScroll: true,
                                    onSuccess: close,
                                })
                            }
                        />
                        <Button
                            disabled={full || addForm.processing}
                            onClick={() =>
                                addForm.submit(maps.layers.store(map.slug), {
                                    preserveScroll: true,
                                })
                            }
                            title={
                                full
                                    ? `All ${maxLayers} channels are in use`
                                    : undefined
                            }
                        >
                            {addForm.processing ? <Spinner /> : <Plus />}
                            Add layer
                        </Button>
                    </div>
                </div>

                <div className="grid gap-6 xl:grid-cols-2">
                    {layers.map((layer) => (
                        <LayerCard
                            key={layer.id}
                            map={map}
                            layer={layer}
                            canDelete={layers.length > 1}
                        />
                    ))}
                </div>
            </div>
        </>
    );
}

function LayerCard({
    map,
    layer,
    canDelete,
}: {
    map: MapSummary;
    layer: TerrainLayer;
    canDelete: boolean;
}) {
    const id = useId();
    const form = useForm<LayerForm>(toForm(layer));
    const deleteForm = useForm({});
    const textureForm = useForm<{ texture: File | null }>({ texture: null });
    const removeTextureForm = useForm({});
    const fileRef = useRef<HTMLInputElement>(null);

    const set = <K extends keyof LayerForm>(key: K, value: LayerForm[K]) =>
        form.setData((prev) => ({ ...prev, [key]: value }));

    const submit = (e: FormEvent) => {
        e.preventDefault();
        form.submit(maps.layers.update({ map: map.slug, layer: layer.id }), {
            preserveScroll: true,
            onSuccess: () => form.setDefaults(),
        });
    };

    const upload = (file: File | undefined) => {
        if (!file) {
            return;
        }

        textureForm.transform(() => ({ texture: file }));
        textureForm.submit(
            maps.layers.texture.store({ map: map.slug, layer: layer.id }),
            {
                forceFormData: true,
                preserveScroll: true,
                onFinish: () => {
                    if (fileRef.current) {
                        fileRef.current.value = '';
                    }
                },
            },
        );
    };

    const errors = form.errors as Partial<Record<keyof LayerForm, string>>;

    return (
        <form
            onSubmit={submit}
            className="flex flex-col overflow-hidden rounded-xl border bg-card shadow-xs"
            aria-labelledby={`${id}-title`}
        >
            <MaterialSwatch
                color={form.data.color}
                colorSecondary={form.data.color_secondary}
                variation={form.data.variation}
                noiseScale={form.data.noise_scale}
                bump={form.data.bump}
                textureUrl={layer.texture_url}
                seed={layer.slot + 1}
                className="h-24 border-b"
            />

            <div className="grid gap-6 p-4 sm:p-5">
                <div className="flex items-end gap-3">
                    <div className="grid flex-1 gap-2">
                        <Label htmlFor={`${id}-name`} id={`${id}-title`}>
                            Layer name
                        </Label>
                        <Input
                            id={`${id}-name`}
                            value={form.data.name}
                            onChange={(e) => set('name', e.target.value)}
                            maxLength={60}
                            required
                            aria-invalid={errors.name ? true : undefined}
                        />
                    </div>
                    <Badge variant="secondary" className="mb-2 tabular-nums">
                        Channel {layer.slot + 1}
                    </Badge>
                </div>
                <InputError message={errors.name} className="-mt-4" />

                <div className="grid gap-4 sm:grid-cols-2">
                    <ColorField
                        label="Primary colour"
                        value={form.data.color}
                        onChange={(v) => set('color', v)}
                        error={errors.color}
                    />
                    <ColorField
                        label="Secondary colour"
                        value={form.data.color_secondary}
                        onChange={(v) => set('color_secondary', v)}
                        error={errors.color_secondary}
                    />
                </div>

                <div className="grid gap-5 sm:grid-cols-2">
                    <SliderField
                        label="Variation"
                        value={form.data.variation}
                        onChange={(v) => set('variation', v)}
                        min={0}
                        max={1}
                        step={0.01}
                        error={errors.variation}
                    />
                    <SliderField
                        label="Noise scale"
                        value={form.data.noise_scale}
                        onChange={(v) => set('noise_scale', v)}
                        min={0.1}
                        max={500}
                        step={0.1}
                        unit="m"
                        error={errors.noise_scale}
                    />
                    <SliderField
                        label="Roughness"
                        value={form.data.roughness}
                        onChange={(v) => set('roughness', v)}
                        min={0}
                        max={1}
                        step={0.01}
                        error={errors.roughness}
                    />
                    <SliderField
                        label="Bump"
                        value={form.data.bump}
                        onChange={(v) => set('bump', v)}
                        min={0}
                        max={2}
                        step={0.01}
                        error={errors.bump}
                    />
                </div>

                <div className="grid gap-3 rounded-lg border p-4">
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <h3 className="text-sm font-medium">
                                Albedo texture
                            </h3>
                            <p className="text-xs text-muted-foreground">
                                Optional JPG, PNG or WebP (max 8 MB), tinted by
                                the colours above.
                            </p>
                        </div>
                        {layer.texture_url && (
                            <img
                                src={layer.texture_url}
                                alt={`${layer.name} texture`}
                                className="size-12 shrink-0 rounded-md border object-cover"
                            />
                        )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <input
                            ref={fileRef}
                            id={`${id}-texture`}
                            type="file"
                            accept="image/jpeg,image/png,image/webp"
                            className="sr-only"
                            onChange={(e) => upload(e.target.files?.[0])}
                        />
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={textureForm.processing}
                            onClick={() => fileRef.current?.click()}
                        >
                            {textureForm.processing ? <Spinner /> : <ImageUp />}
                            {layer.texture_url
                                ? 'Replace texture'
                                : 'Upload texture'}
                        </Button>
                        {layer.texture_url && (
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                disabled={removeTextureForm.processing}
                                onClick={() =>
                                    removeTextureForm.submit(
                                        maps.layers.texture.destroy({
                                            map: map.slug,
                                            layer: layer.id,
                                        }),
                                        { preserveScroll: true },
                                    )
                                }
                            >
                                <X />
                                Remove
                            </Button>
                        )}
                        {textureForm.progress && (
                            <span className="text-xs text-muted-foreground tabular-nums">
                                {textureForm.progress.percentage}%
                            </span>
                        )}
                    </div>
                    <InputError
                        message={
                            (textureForm.errors as Record<string, string>)
                                .texture
                        }
                    />
                    <SliderField
                        label="Texture scale"
                        value={form.data.texture_scale}
                        onChange={(v) => set('texture_scale', v)}
                        min={0.1}
                        max={200}
                        step={0.1}
                        unit="m"
                        description="World metres covered by one texture repeat."
                        error={errors.texture_scale}
                    />
                </div>

                <fieldset className="grid gap-4 rounded-lg border p-4">
                    <legend className="flex items-center gap-1.5 px-1 text-sm font-medium">
                        <WandSparkles className="size-4 text-muted-foreground" />
                        Auto-paint rules
                    </legend>
                    <p className="-mt-1 text-xs text-muted-foreground">
                        Used by Auto paint in the studio and for fresh terrain.
                        Leave a bound empty for no limit; the highest priority
                        matching layer wins.
                    </p>
                    <div className="grid grid-cols-2 gap-4">
                        <NullableNumber
                            label="Min height"
                            unit="m"
                            value={form.data.auto_min_height}
                            onChange={(v) => set('auto_min_height', v)}
                            error={errors.auto_min_height}
                        />
                        <NullableNumber
                            label="Max height"
                            unit="m"
                            value={form.data.auto_max_height}
                            onChange={(v) => set('auto_max_height', v)}
                            error={errors.auto_max_height}
                        />
                        <NullableNumber
                            label="Min slope"
                            unit="°"
                            min={0}
                            max={90}
                            value={form.data.auto_min_slope}
                            onChange={(v) => set('auto_min_slope', v)}
                            error={errors.auto_min_slope}
                        />
                        <NullableNumber
                            label="Max slope"
                            unit="°"
                            min={0}
                            max={90}
                            value={form.data.auto_max_slope}
                            onChange={(v) => set('auto_max_slope', v)}
                            error={errors.auto_max_slope}
                        />
                    </div>
                    <SliderField
                        label="Priority"
                        value={form.data.auto_priority}
                        onChange={(v) => set('auto_priority', Math.round(v))}
                        min={0}
                        max={10}
                        step={1}
                        error={errors.auto_priority}
                    />
                </fieldset>
            </div>

            <div className="mt-auto flex items-center gap-2 border-t bg-muted/30 px-4 py-3 sm:px-5">
                <Button
                    type="submit"
                    size="sm"
                    disabled={form.processing || !form.isDirty}
                >
                    {form.processing ? <Spinner /> : <Save />}
                    Save
                </Button>
                {form.isDirty && (
                    <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => form.reset()}
                    >
                        Discard
                    </Button>
                )}
                {form.recentlySuccessful && !form.isDirty && (
                    <span className="text-xs text-muted-foreground">Saved</span>
                )}
                <div className="ml-auto">
                    <ConfirmDialog
                        trigger={
                            <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                disabled={!canDelete}
                                className="text-red-600 hover:bg-red-500/10 hover:text-red-700 dark:text-red-400"
                                title={
                                    canDelete
                                        ? undefined
                                        : 'A map needs at least one layer'
                                }
                            >
                                <Trash2 />
                                Delete
                            </Button>
                        }
                        title={`Delete ${layer.name}?`}
                        description={`Areas painted with channel ${layer.slot + 1} will fall back to the other layers.`}
                        confirmLabel="Delete layer"
                        destructive
                        processing={deleteForm.processing}
                        onConfirm={(close) =>
                            deleteForm.submit(
                                maps.layers.destroy({
                                    map: map.slug,
                                    layer: layer.id,
                                }),
                                { preserveScroll: true, onSuccess: close },
                            )
                        }
                    />
                </div>
            </div>
        </form>
    );
}

function NullableNumber({
    label,
    unit,
    value,
    onChange,
    min,
    max,
    error,
}: {
    label: string;
    unit: string;
    value: number | null;
    onChange: (value: number | null) => void;
    min?: number;
    max?: number;
    error?: string;
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
                    step="any"
                    min={min}
                    max={max}
                    value={value ?? ''}
                    placeholder="Any"
                    onChange={(e) =>
                        onChange(
                            e.target.value === ''
                                ? null
                                : Number(e.target.value),
                        )
                    }
                    aria-invalid={error ? true : undefined}
                    className="h-8 pr-8 tabular-nums"
                />
                <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs text-muted-foreground">
                    {unit}
                </span>
            </div>
            <InputError message={error} />
        </div>
    );
}

MapLayers.layout = (props: Props) => ({
    breadcrumbs: [
        { title: 'Maps', href: maps.index() },
        { title: props.map.name, href: maps.show(props.map.slug) },
        { title: 'Terrain layers', href: maps.layers.index(props.map.slug) },
    ],
});
