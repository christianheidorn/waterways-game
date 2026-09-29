import { Head, router, useForm } from '@inertiajs/react';
import type {
    BiomeSummary,
    GroundCoverEntry,
    TerrainLayer,
} from '@game/shared/types';
import {
    Box,
    ChevronRight,
    EyeOff,
    ImageUp,
    Layers,
    Palette,
    Plus,
    RotateCcw,
    Save,
    Sprout,
    Trash2,
    WandSparkles,
    X,
} from 'lucide-react';
import type { FormEvent } from 'react';
import { useId, useRef, useState } from 'react';
import { ColorField } from '@/components/color-field';
import { ConfirmDialog } from '@/components/confirm-dialog';
import InputError from '@/components/input-error';
import { MapTabs } from '@/components/map-tabs';
import { AiSuggestCard } from '@/components/materials/ai-suggest-card';
import { MaterialPicker } from '@/components/materials/material-picker';
import { MaterialPreview } from '@/components/materials/material-preview';
import { MaterialThumb } from '@/components/materials/material-thumb';
import { MaterialSwatch } from '@/components/material-swatch';
import { SliderField } from '@/components/slider-field';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from '@/components/ui/collapsible';
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
import { DEFAULT_CATEGORIES } from '@/lib/materials';
import { cn } from '@/lib/utils';
import biomesRoutes from '@/routes/biomes';
import maps from '@/routes/maps';
import type {
    AiConfig,
    CategoryOption,
    MapSummary,
    MaterialStudio,
} from '@/types';

type FoliageOption = { id: number; name: string; kind: string };

type Props = {
    map: MapSummary;
    layers: TerrainLayer[];
    biomes?: BiomeSummary[];
    foliageTypes?: FoliageOption[];
    maxLayers: number;
    /** Material library for the picker (may be an optional / lazy prop). */
    materials?: MaterialStudio[];
    categories?: CategoryOption[];
    ai?: Pick<AiConfig, 'configured'>;
};

type LayerForm = Omit<
    TerrainLayer,
    'id' | 'slot' | 'texture_url' | 'material' | 'material_id'
>;

const NEW_LAYER: LayerForm = {
    name: 'New layer',
    color: '#7c7462',
    color_secondary: '#9a917c',
    roughness: 0.9,
    noise_scale: 5,
    variation: 0.5,
    bump: 0.4,
    texture_scale: 4,
    tint: '#ffffff',
    roughness_scale: 1,
    normal_strength: 1,
    auto_min_height: null,
    auto_max_height: null,
    auto_min_slope: null,
    auto_max_slope: null,
    auto_priority: 0,
    ground_cover: [],
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
        tint: layer.tint ?? '#ffffff',
        roughness_scale: layer.roughness_scale ?? 1,
        normal_strength: layer.normal_strength ?? 1,
        auto_min_height: layer.auto_min_height,
        auto_max_height: layer.auto_max_height,
        auto_min_slope: layer.auto_min_slope,
        auto_max_slope: layer.auto_max_slope,
        auto_priority: layer.auto_priority,
        ground_cover: layer.ground_cover ?? [],
    };
}

export default function MapLayers({
    map,
    layers,
    biomes = [],
    foliageTypes = [],
    maxLayers,
    materials,
    categories = DEFAULT_CATEGORIES,
    ai,
}: Props) {
    const addForm = useForm<LayerForm>({ ...NEW_LAYER });
    const resetForm = useForm({});
    const full = layers.length >= maxLayers;
    // Only one live WebGL preview at a time (browsers cap WebGL contexts).
    const [previewLayerId, setPreviewLayerId] = useState<number | null>(null);
    const [libraryRequested, setLibraryRequested] = useState(false);
    // Bumped after an AI plan or a biome is applied so the layer forms pick up the new values.
    const [planApplied, setPlanApplied] = useState(0);

    const ensureLibrary = () => {
        if (materials !== undefined || libraryRequested) {
            return;
        }

        router.reload({
            only: ['materials', 'categories'],
            onFinish: () => setLibraryRequested(true),
        });
    };

    const library =
        materials ?? (libraryRequested ? ([] as MaterialStudio[]) : undefined);

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
                            terrain. Each layer occupies one splat channel and
                            uses a PBR material from the library, or procedural
                            colours.{' '}
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

                <AiSuggestCard
                    map={map}
                    library={library}
                    categories={categories}
                    onNeedLibrary={ensureLibrary}
                    onApplied={() => setPlanApplied((n) => n + 1)}
                    aiConfigured={ai?.configured}
                />

                <BiomeLibrary biomes={biomes} />

                <div className="grid gap-6 xl:grid-cols-2">
                    {layers.map((layer) => (
                        <LayerCard
                            key={`${layer.id}-${layer.material_id ?? 0}-${planApplied}`}
                            map={map}
                            layer={layer}
                            biomes={biomes}
                            onBiomeApplied={() => setPlanApplied((n) => n + 1)}
                            foliageTypes={foliageTypes}
                            canDelete={layers.length > 1}
                            library={library}
                            categories={categories}
                            onNeedLibrary={ensureLibrary}
                            previewing={previewLayerId === layer.id}
                            onPreviewChange={(on) =>
                                setPreviewLayerId(on ? layer.id : null)
                            }
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
    biomes,
    onBiomeApplied,
    foliageTypes,
    canDelete,
    library,
    categories,
    onNeedLibrary,
    previewing,
    onPreviewChange,
}: {
    map: MapSummary;
    layer: TerrainLayer;
    biomes: BiomeSummary[];
    onBiomeApplied: () => void;
    foliageTypes: FoliageOption[];
    canDelete: boolean;
    library: MaterialStudio[] | undefined;
    categories: CategoryOption[];
    onNeedLibrary: () => void;
    previewing: boolean;
    onPreviewChange: (on: boolean) => void;
}) {
    const id = useId();
    const form = useForm<LayerForm>(toForm(layer));
    const deleteForm = useForm({});
    const materialForm = useForm<{ material_id: number | null }>({
        material_id: layer.material_id,
    });
    const [pickerOpen, setPickerOpen] = useState(false);
    const [savingChoice, setSavingChoice] = useState<number | 'none' | null>(
        null,
    );
    const material = layer.material;
    const libraryEntry = library?.find((m) => m.id === layer.material_id);
    const pendingMaterial =
        layer.material_id !== null && !material ? libraryEntry : undefined;

    const set = <K extends keyof LayerForm>(key: K, value: LayerForm[K]) =>
        form.setData((prev) => ({ ...prev, [key]: value }));

    const submit = (e: FormEvent) => {
        e.preventDefault();
        form.submit(maps.layers.update({ map: map.slug, layer: layer.id }), {
            preserveScroll: true,
            onSuccess: () => form.setDefaults(),
        });
    };

    const chooseMaterial = (materialId: number | null) => {
        if (materialId === layer.material_id) {
            setPickerOpen(false);

            return;
        }

        setSavingChoice(materialId ?? 'none');
        materialForm.transform(() => ({ material_id: materialId }));
        materialForm.submit(
            maps.layers.material({ map: map.slug, layer: layer.id }),
            {
                preserveScroll: true,
                onSuccess: () => setPickerOpen(false),
                onFinish: () => setSavingChoice(null),
            },
        );
    };

    const openPicker = () => {
        onNeedLibrary();
        setPickerOpen(true);
    };

    const errors = form.errors as Partial<Record<keyof LayerForm, string>>;

    return (
        <form
            onSubmit={submit}
            className="flex flex-col overflow-hidden rounded-xl border bg-card shadow-xs"
            aria-labelledby={`${id}-title`}
        >
            <div className="relative h-28 border-b">
                {material ? (
                    <>
                        <MaterialThumb
                            src={
                                libraryEntry?.thumbnail_url ??
                                material.maps.albedo
                            }
                            alt=""
                            className="absolute inset-0"
                        />
                        <div
                            className="absolute inset-0 mix-blend-multiply"
                            style={{ backgroundColor: form.data.tint }}
                            aria-hidden
                        />
                    </>
                ) : (
                    <MaterialSwatch
                        color={form.data.color}
                        colorSecondary={form.data.color_secondary}
                        variation={form.data.variation}
                        noiseScale={form.data.noise_scale}
                        bump={form.data.bump}
                        textureUrl={layer.texture_url}
                        seed={layer.slot + 1}
                        className="absolute inset-0"
                    />
                )}
                <Badge
                    variant="secondary"
                    className="absolute top-2 right-2 bg-background/85 tabular-nums backdrop-blur"
                >
                    Channel {layer.slot + 1}
                </Badge>
            </div>

            <div className="grid gap-6 p-4 sm:p-5">
                <div className="grid gap-2">
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
                    <InputError message={errors.name} />
                </div>

                <BiomeFields
                    map={map}
                    layer={layer}
                    biomes={biomes}
                    dirty={form.isDirty}
                    onApplied={onBiomeApplied}
                />

                <section
                    aria-label="Material"
                    className="grid gap-4 rounded-lg border p-4"
                >
                    <div className="flex items-center gap-3">
                        {material ? (
                            <MaterialThumb
                                src={
                                    libraryEntry?.thumbnail_url ??
                                    material.maps.albedo
                                }
                                alt=""
                                className="size-12 shrink-0 rounded-md border"
                            />
                        ) : (
                            <div className="flex size-12 shrink-0 items-center justify-center rounded-md border border-dashed text-muted-foreground">
                                <Palette className="size-5" />
                            </div>
                        )}
                        <div className="min-w-0 flex-1">
                            <div className="text-xs text-muted-foreground">
                                Material
                            </div>
                            <div className="truncate text-sm font-medium">
                                {material
                                    ? material.name
                                    : pendingMaterial
                                      ? `${pendingMaterial.name} (not ready yet)`
                                      : 'None — procedural colours'}
                            </div>
                        </div>
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={openPicker}
                            disabled={materialForm.processing}
                        >
                            {materialForm.processing ? <Spinner /> : <Layers />}
                            {material ? 'Change' : 'Choose material'}
                        </Button>
                    </div>
                    <InputError
                        message={
                            (materialForm.errors as Record<string, string>)
                                .material_id
                        }
                    />

                    {material && (
                        <>
                            {previewing ? (
                                <div className="grid gap-2">
                                    <MaterialPreview
                                        material={material}
                                        initialShape="terrain"
                                        options={{
                                            tileSize: form.data.texture_scale,
                                            tint: form.data.tint,
                                            roughnessScale:
                                                form.data.roughness_scale,
                                            normalStrength:
                                                form.data.normal_strength,
                                        }}
                                    />
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="ghost"
                                        className="justify-self-start"
                                        onClick={() => onPreviewChange(false)}
                                    >
                                        <EyeOff />
                                        Hide 3D preview
                                    </Button>
                                </div>
                            ) : (
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="secondary"
                                    className="justify-self-start"
                                    onClick={() => onPreviewChange(true)}
                                >
                                    <Box />
                                    Show 3D preview
                                </Button>
                            )}

                            <div className="grid gap-5 sm:grid-cols-2">
                                <ColorField
                                    label="Tint"
                                    value={form.data.tint}
                                    onChange={(v) => set('tint', v)}
                                    error={errors.tint}
                                    labelAction={
                                        form.data.tint.toLowerCase() !==
                                            material.tint.toLowerCase() && (
                                            <ResetButton
                                                onClick={() =>
                                                    set('tint', material.tint)
                                                }
                                            />
                                        )
                                    }
                                />
                                <SliderField
                                    label="Tiling size"
                                    value={form.data.texture_scale}
                                    onChange={(v) => set('texture_scale', v)}
                                    min={0.1}
                                    max={200}
                                    step={0.1}
                                    unit="m"
                                    description={`World metres per repeat. Material default ${material.tile_size} m.`}
                                    error={errors.texture_scale}
                                    labelAction={
                                        form.data.texture_scale !==
                                            material.tile_size && (
                                            <ResetButton
                                                onClick={() =>
                                                    set(
                                                        'texture_scale',
                                                        material.tile_size,
                                                    )
                                                }
                                            />
                                        )
                                    }
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
                            </div>
                        </>
                    )}
                </section>

                <ProceduralFallback
                    map={map}
                    layer={layer}
                    form={form.data}
                    errors={errors}
                    set={set}
                    defaultOpen={!material && layer.material_id === null}
                    hasMaterial={!!material}
                />

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

                <GroundCoverFields
                    value={form.data.ground_cover ?? []}
                    onChange={(v) => set('ground_cover', v)}
                    foliageTypes={foliageTypes}
                    error={
                        (form.errors as Record<string, string | undefined>)
                            .ground_cover
                    }
                />
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

            <MaterialPicker
                open={pickerOpen}
                onOpenChange={setPickerOpen}
                materials={library}
                categories={categories}
                value={layer.material_id}
                onSelect={chooseMaterial}
                saving={savingChoice}
                layerName={form.data.name || layer.name}
            />
        </form>
    );
}

/** Apply a library biome to this layer, or save the layer as a new biome. */
function BiomeFields({
    map,
    layer,
    biomes,
    dirty,
    onApplied,
}: {
    map: MapSummary;
    layer: TerrainLayer;
    biomes: BiomeSummary[];
    dirty: boolean;
    onApplied: () => void;
}) {
    const applyForm = useForm<{ biome_id: number | null }>({ biome_id: null });
    const saveForm = useForm({
        layer_id: layer.id,
        name: layer.name,
        description: '',
    });
    const [saveOpen, setSaveOpen] = useState(false);

    const apply = (biomeId: number) => {
        applyForm.transform(() => ({ biome_id: biomeId }));
        applyForm.submit(
            maps.layers.biome({ map: map.slug, layer: layer.id }),
            { preserveScroll: true, onSuccess: onApplied },
        );
    };

    return (
        <div className="grid gap-2">
            <Label>Biome</Label>
            <div className="flex flex-wrap items-center gap-2">
                <Select
                    value=""
                    onValueChange={(v) => apply(Number(v))}
                    disabled={applyForm.processing || biomes.length === 0}
                >
                    <SelectTrigger className="min-w-0 flex-1">
                        <SelectValue
                            placeholder={
                                biomes.length
                                    ? 'Apply a biome…'
                                    : 'No biomes in the library'
                            }
                        />
                    </SelectTrigger>
                    <SelectContent>
                        {biomes.map((b) => (
                            <SelectItem key={b.id} value={String(b.id)}>
                                {b.name}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                        saveForm.setData('name', layer.name);
                        setSaveOpen(true);
                    }}
                    disabled={dirty}
                    title={
                        dirty
                            ? 'Save the layer first'
                            : 'Add this layer’s look and ground cover to the biome library'
                    }
                >
                    <Sprout />
                    Save as biome
                </Button>
                {applyForm.processing && <Spinner />}
            </div>
            <p className="text-xs text-muted-foreground">
                A biome is a ground material plus everything that grows on it.
                Applying one replaces this layer’s look and ground cover;
                painted areas keep their paint.
            </p>
            <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Save as biome</DialogTitle>
                        <DialogDescription>
                            Stores this layer’s material, colours and ground
                            cover in the library, for any map.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-4">
                        <div className="grid gap-2">
                            <Label htmlFor={`biome-name-${layer.id}`}>
                                Name
                            </Label>
                            <Input
                                id={`biome-name-${layer.id}`}
                                value={saveForm.data.name}
                                maxLength={60}
                                onChange={(e) =>
                                    saveForm.setData('name', e.target.value)
                                }
                            />
                            <InputError message={saveForm.errors.name} />
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor={`biome-desc-${layer.id}`}>
                                Description
                            </Label>
                            <Input
                                id={`biome-desc-${layer.id}`}
                                value={saveForm.data.description}
                                maxLength={200}
                                placeholder="Optional"
                                onChange={(e) =>
                                    saveForm.setData(
                                        'description',
                                        e.target.value,
                                    )
                                }
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button
                            type="button"
                            disabled={
                                saveForm.processing ||
                                !saveForm.data.name.trim()
                            }
                            onClick={() =>
                                saveForm.submit(biomesRoutes.store(), {
                                    preserveScroll: true,
                                    onSuccess: () => setSaveOpen(false),
                                })
                            }
                        >
                            {saveForm.processing ? <Spinner /> : <Save />}
                            Save biome
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}

/** The biome library: what each biome grows, delete, restore the starters. */
function BiomeLibrary({ biomes }: { biomes: BiomeSummary[] }) {
    const startersForm = useForm({});
    const deleteForm = useForm({});

    return (
        <Collapsible className="rounded-xl border bg-card shadow-xs">
            <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-xl px-4 py-3 text-left text-sm font-medium outline-none hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50">
                <ChevronRight className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
                <Sprout className="size-4 text-muted-foreground" />
                Biome library
                <span className="text-xs font-normal text-muted-foreground tabular-nums">
                    {biomes.length}
                </span>
            </CollapsibleTrigger>
            <CollapsibleContent className="grid gap-4 border-t p-4">
                <p className="text-sm text-muted-foreground">
                    Reusable layers: a ground material plus the grass, flowers,
                    rocks and trees that grow on it. Apply one to a layer below
                    (or in the editor’s Paint tool), then paint that layer to
                    paint the whole biome.
                </p>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {biomes.map((b) => (
                        <div
                            key={b.id}
                            className="flex gap-3 rounded-lg border p-3"
                        >
                            {b.material?.thumbnail_url ? (
                                <MaterialThumb
                                    src={b.material.thumbnail_url}
                                    alt=""
                                    className="size-12 shrink-0 rounded-md border"
                                />
                            ) : (
                                <div
                                    className="size-12 shrink-0 rounded-md border"
                                    style={{
                                        background: `linear-gradient(135deg, ${b.color}, ${b.color_secondary})`,
                                    }}
                                    aria-hidden
                                />
                            )}
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                    <span className="truncate text-sm font-medium">
                                        {b.name}
                                    </span>
                                    {b.starter && (
                                        <Badge variant="secondary">
                                            Starter
                                        </Badge>
                                    )}
                                </div>
                                {b.description && (
                                    <p className="line-clamp-2 text-xs text-muted-foreground">
                                        {b.description}
                                    </p>
                                )}
                                <p className="mt-1 text-xs text-muted-foreground">
                                    {b.ground_cover.length
                                        ? b.ground_cover
                                              .map((e) => e.name)
                                              .filter(Boolean)
                                              .join(' · ')
                                        : 'No ground cover'}
                                </p>
                            </div>
                            <ConfirmDialog
                                trigger={
                                    <Button
                                        type="button"
                                        size="icon"
                                        variant="ghost"
                                        aria-label={`Delete ${b.name}`}
                                    >
                                        <Trash2 />
                                    </Button>
                                }
                                title={`Delete ${b.name}?`}
                                description="Layers it was applied to keep their look and ground cover."
                                confirmLabel="Delete biome"
                                destructive
                                processing={deleteForm.processing}
                                onConfirm={(close) =>
                                    deleteForm.submit(
                                        biomesRoutes.destroy(b.id),
                                        {
                                            preserveScroll: true,
                                            onSuccess: close,
                                        },
                                    )
                                }
                            />
                        </div>
                    ))}
                </div>
                <div>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={startersForm.processing}
                        onClick={() =>
                            startersForm.submit(biomesRoutes.starters(), {
                                preserveScroll: true,
                            })
                        }
                    >
                        {startersForm.processing ? <Spinner /> : <Plus />}
                        Add starter biomes
                    </Button>
                </div>
            </CollapsibleContent>
        </Collapsible>
    );
}

const SMALL_KINDS = new Set(['grass', 'flower', 'reed', 'bush', 'rock']);

/** Foliage types that grow by themselves wherever this layer is painted. */
function GroundCoverFields({
    value,
    onChange,
    foliageTypes,
    error,
}: {
    value: GroundCoverEntry[];
    onChange: (value: GroundCoverEntry[]) => void;
    foliageTypes: FoliageOption[];
    error?: string;
}) {
    const patch = (index: number, change: Partial<GroundCoverEntry>) =>
        onChange(value.map((e, i) => (i === index ? { ...e, ...change } : e)));
    const available = foliageTypes
        .filter((t) => !value.some((e) => e.foliage_type_id === t.id))
        .sort(
            (a, b) =>
                Number(SMALL_KINDS.has(b.kind)) -
                    Number(SMALL_KINDS.has(a.kind)) ||
                a.name.localeCompare(b.name),
        );

    return (
        <fieldset className="grid gap-4 rounded-lg border p-4">
            <legend className="flex items-center gap-1.5 px-1 text-sm font-medium">
                <Sprout className="size-4 text-muted-foreground" />
                Ground cover
            </legend>
            <p className="-mt-1 text-xs text-muted-foreground">
                Grass, flowers, rocks or trees that grow by themselves wherever
                this layer is painted, following the paint and each type’s
                slope, altitude and water rules. Nothing is placed by hand:
                repaint the layer and it regrows. Density multiplies the type’s
                own density; Groves gathers plants into patches and clearings;
                Min spacing keeps them apart. Also editable live in the editor’s
                Paint tool.
            </p>
            {value.map((entry, index) => {
                const type = foliageTypes.find(
                    (t) => t.id === entry.foliage_type_id,
                );

                return (
                    <div
                        key={entry.foliage_type_id}
                        className="flex items-end gap-2"
                    >
                        <div className="grid flex-1 gap-3">
                            <SliderField
                                label={
                                    type?.name ??
                                    `Type ${entry.foliage_type_id}`
                                }
                                value={entry.density}
                                onChange={(v) => patch(index, { density: v })}
                                min={0}
                                max={4}
                                step={0.05}
                                unit="×"
                            />
                            <div className="grid grid-cols-2 gap-3">
                                <SliderField
                                    label="Groves"
                                    value={entry.clustering ?? 0}
                                    onChange={(v) =>
                                        patch(index, { clustering: v })
                                    }
                                    min={0}
                                    max={1}
                                    step={0.05}
                                    formatValue={(v) =>
                                        v < 0.05
                                            ? 'even'
                                            : `${Math.round(v * 100)}%`
                                    }
                                />
                                <SliderField
                                    label="Min spacing"
                                    value={entry.spacing ?? 0}
                                    onChange={(v) =>
                                        patch(index, { spacing: v })
                                    }
                                    min={0}
                                    max={30}
                                    step={0.5}
                                    unit="m"
                                />
                            </div>
                        </div>
                        <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            aria-label={`Remove ${type?.name ?? 'type'}`}
                            onClick={() =>
                                onChange(value.filter((_e, i) => i !== index))
                            }
                        >
                            <X />
                        </Button>
                    </div>
                );
            })}
            {available.length > 0 && value.length < 8 && (
                <Select
                    value=""
                    onValueChange={(v) =>
                        onChange([
                            ...value,
                            { foliage_type_id: Number(v), density: 1 },
                        ])
                    }
                >
                    <SelectTrigger className="w-full">
                        <SelectValue placeholder="Add foliage type…" />
                    </SelectTrigger>
                    <SelectContent>
                        {available.map((t) => (
                            <SelectItem key={t.id} value={String(t.id)}>
                                {t.name}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            )}
            {foliageTypes.length === 0 && (
                <p className="text-xs text-muted-foreground">
                    No foliage types yet — create some under Foliage.
                </p>
            )}
            <InputError message={error} />
        </fieldset>
    );
}

function ResetButton({ onClick }: { onClick: () => void }) {
    return (
        <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground"
            onClick={onClick}
            title="Reset to material default"
            aria-label="Reset to material default"
        >
            <RotateCcw className="size-3.5" />
        </Button>
    );
}

function ProceduralFallback({
    map,
    layer,
    form,
    errors,
    set,
    defaultOpen,
    hasMaterial,
}: {
    map: MapSummary;
    layer: TerrainLayer;
    form: LayerForm;
    errors: Partial<Record<keyof LayerForm, string>>;
    set: <K extends keyof LayerForm>(key: K, value: LayerForm[K]) => void;
    defaultOpen: boolean;
    hasMaterial: boolean;
}) {
    const id = useId();
    const [open, setOpen] = useState(defaultOpen);
    const textureForm = useForm<{ texture: File | null }>({ texture: null });
    const removeTextureForm = useForm({});
    const fileRef = useRef<HTMLInputElement>(null);

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

    return (
        <Collapsible
            open={open}
            onOpenChange={setOpen}
            className="rounded-lg border"
        >
            <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-lg px-4 py-3 text-left text-sm font-medium outline-none hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50">
                <ChevronRight
                    className={cn(
                        'size-4 text-muted-foreground transition-transform',
                        open && 'rotate-90',
                    )}
                />
                <Palette className="size-4 text-muted-foreground" />
                <span className="flex-1">
                    {hasMaterial ? 'Procedural fallback' : 'Procedural colours'}
                </span>
                <span className="flex gap-1" aria-hidden>
                    {[form.color, form.color_secondary].map((c, i) => (
                        <span
                            key={i}
                            className="size-3.5 rounded-full border shadow-xs"
                            style={{ backgroundColor: c }}
                        />
                    ))}
                </span>
            </CollapsibleTrigger>
            <CollapsibleContent className="grid gap-6 border-t p-4">
                {hasMaterial && (
                    <p className="-mb-2 text-xs text-muted-foreground">
                        Used when material textures are unavailable (e.g. low
                        graphics settings or while they load).
                    </p>
                )}
                <div className="grid gap-4 sm:grid-cols-2">
                    <ColorField
                        label="Primary colour"
                        value={form.color}
                        onChange={(v) => set('color', v)}
                        error={errors.color}
                    />
                    <ColorField
                        label="Secondary colour"
                        value={form.color_secondary}
                        onChange={(v) => set('color_secondary', v)}
                        error={errors.color_secondary}
                    />
                </div>

                <div className="grid gap-5 sm:grid-cols-2">
                    <SliderField
                        label="Variation"
                        value={form.variation}
                        onChange={(v) => set('variation', v)}
                        min={0}
                        max={1}
                        step={0.01}
                        error={errors.variation}
                    />
                    <SliderField
                        label="Noise scale"
                        value={form.noise_scale}
                        onChange={(v) => set('noise_scale', v)}
                        min={0.1}
                        max={500}
                        step={0.1}
                        unit="m"
                        error={errors.noise_scale}
                    />
                    <SliderField
                        label="Roughness"
                        value={form.roughness}
                        onChange={(v) => set('roughness', v)}
                        min={0}
                        max={1}
                        step={0.01}
                        error={errors.roughness}
                    />
                    <SliderField
                        label="Bump"
                        value={form.bump}
                        onChange={(v) => set('bump', v)}
                        min={0}
                        max={2}
                        step={0.01}
                        error={errors.bump}
                    />
                </div>

                {!hasMaterial && (
                    <div className="grid gap-3 rounded-lg border p-4">
                        <div className="flex items-center justify-between gap-3">
                            <div>
                                <h3 className="text-sm font-medium">
                                    Albedo texture
                                </h3>
                                <p className="text-xs text-muted-foreground">
                                    Optional JPG, PNG or WebP (max 8 MB), tinted
                                    by the colours above. For full PBR, choose a
                                    material instead.
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
                                {textureForm.processing ? (
                                    <Spinner />
                                ) : (
                                    <ImageUp />
                                )}
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
                            value={form.texture_scale}
                            onChange={(v) => set('texture_scale', v)}
                            min={0.1}
                            max={200}
                            step={0.1}
                            unit="m"
                            description="World metres covered by one texture repeat."
                            error={errors.texture_scale}
                        />
                    </div>
                )}
            </CollapsibleContent>
        </Collapsible>
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
