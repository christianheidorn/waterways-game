import { Head, useForm } from '@inertiajs/react';
import type {
    FoliageCollision,
    FoliageKind,
    FoliageType,
} from '@game/shared/types';
import {
    Box,
    Leaf,
    Package,
    Pencil,
    Plus,
    Trash2,
    Upload,
    Wand2,
    X,
} from 'lucide-react';
import type { FormEvent, ReactNode } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { AiCreditsBadge } from '@/components/ai-credits';
import { ColorField } from '@/components/color-field';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { FoliagePreview } from '@/components/foliage-preview';
import { FoliageAiPlanDialog } from '@/components/foliage/ai-plan-dialog';
import { AssetLibrary, BakeStatus } from '@/components/foliage/asset-library';
import { FoliageGenerateDialog } from '@/components/foliage/generate-dialog';
import { FoliageUploadDialog } from '@/components/foliage/upload-dialog';
import { MaterialThumb } from '@/components/materials/material-thumb';
import Heading from '@/components/heading';
import InputError from '@/components/input-error';
import { SliderField } from '@/components/slider-field';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetFooter,
    SheetHeader,
    SheetTitle,
} from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useFoliageBakeQueue } from '@/hooks/use-foliage-bake-queue';
import {
    FOLIAGE_ICONS,
    assetSourceLabel,
    formatMetres,
    formatTriangles,
} from '@/lib/foliage';
import { formatNumber } from '@/lib/format';
import foliage from '@/routes/foliage';
import type { FoliageAssetStudio, FoliageMapOption } from '@/types';

type Kind = { value: FoliageKind; label: string };

type Props = {
    foliageTypes: FoliageType[];
    kinds: Kind[];
    assets: FoliageAssetStudio[];
    maps: FoliageMapOption[];
    proceduralHeights: Record<FoliageKind, number>;
    ai: {
        configured: boolean;
        image_model: string;
        text_model: string;
        meshy_configured: boolean;
    };
};

type FoliageForm = Omit<FoliageType, 'id' | 'model_url' | 'asset'> & {
    foliage_asset_id: number | null;
    tint: string;
};

const NEW_FOLIAGE: FoliageForm = {
    name: '',
    kind: 'broadleaf',
    color: '#3f6b2a',
    color_secondary: '#5a3d22',
    min_scale: 0.8,
    max_scale: 1.3,
    density: 1,
    min_slope: 0,
    max_slope: 35,
    min_height: null,
    max_height: null,
    align_to_normal: false,
    random_yaw: true,
    cast_shadows: true,
    cull_distance: 400,
    allow_underwater: false,
    collision: 'auto',
    collision_radius: null,
    foliage_asset_id: null,
    tint: '#ffffff',
};

function toForm(type: FoliageType): FoliageForm {
    const { id: _id, model_url: _model, asset: _asset, ...rest } = type;

    return {
        ...rest,
        foliage_asset_id: type.foliage_asset_id ?? null,
        tint: type.tint ?? '#ffffff',
    };
}

const COLLISION_OPTIONS: { value: FoliageCollision; label: string }[] = [
    { value: 'auto', label: 'Automatic (by kind)' },
    { value: 'trunk', label: 'Trunk' },
    { value: 'bounds', label: 'Footprint (bounds)' },
    { value: 'none', label: 'None' },
];

type Tab = 'types' | 'assets';

export default function FoliageIndex({
    foliageTypes,
    kinds,
    assets,
    maps,
    proceduralHeights,
    ai,
}: Props) {
    const [open, setOpen] = useState(false);
    const [editingId, setEditingId] = useState<number | null>(null);
    const [formKey, setFormKey] = useState(0);
    const [tab, setTab] = useState<Tab>(() => {
        try {
            return (localStorage.getItem('foliage.tab') as Tab) ?? 'types';
        } catch {
            return 'types';
        }
    });
    const [dialog, setDialog] = useState<'upload' | 'generate' | 'plan' | null>(
        null,
    );
    const editing = foliageTypes.find((f) => f.id === editingId) ?? null;
    const bake = useFoliageBakeQueue(assets);

    const openEditor = (id: number | null) => {
        setEditingId(id);
        setFormKey((k) => k + 1);
        setOpen(true);
    };

    const changeTab = (value: string) => {
        setTab(value as Tab);

        try {
            localStorage.setItem('foliage.tab', value);
        } catch {
            // Storage unavailable (private mode): the tab is just not remembered.
        }
    };

    // "Create foliage type" from an asset redirects here with ?type=ID: open its editor.
    useEffect(() => {
        const id = Number(
            new URLSearchParams(window.location.search).get('type'),
        );

        if (id && foliageTypes.some((t) => t.id === id)) {
            changeTab('types');
            openEditor(id);
            window.history.replaceState(null, '', window.location.pathname);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <>
            <Head title="Foliage" />
            <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 p-4 sm:p-6">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <Heading
                        title="Foliage library"
                        description="Trees, plants and rocks you can paint onto any map in the studio. Shared by all maps."
                    />
                    <div className="flex flex-wrap gap-2">
                        <Button
                            variant="outline"
                            onClick={() => setDialog('plan')}
                        >
                            <Wand2 />
                            AI palette
                        </Button>
                        <Button onClick={() => openEditor(null)}>
                            <Plus />
                            New foliage type
                        </Button>
                    </div>
                </div>

                <div className="-mt-3 flex flex-wrap items-center justify-between gap-2">
                    <BakeStatus
                        bake={bake.current}
                        waiting={bake.waiting}
                        className="flex-1"
                    />
                    <AiCreditsBadge className="ml-auto" />
                </div>

                <Tabs value={tab} onValueChange={changeTab} className="gap-4">
                    <TabsList>
                        <TabsTrigger value="types">
                            <Leaf />
                            Foliage types
                            <span className="text-muted-foreground tabular-nums">
                                {foliageTypes.length}
                            </span>
                        </TabsTrigger>
                        <TabsTrigger value="assets">
                            <Package />
                            Asset library
                            <span className="text-muted-foreground tabular-nums">
                                {assets.length}
                            </span>
                        </TabsTrigger>
                    </TabsList>

                    <TabsContent value="assets">
                        <AssetLibrary
                            assets={assets}
                            kinds={kinds}
                            bake={bake.current}
                            bakeSupported={bake.supported}
                            onUpload={() => setDialog('upload')}
                            onGenerate={() => setDialog('generate')}
                        />
                    </TabsContent>

                    <TabsContent value="types">
                        {foliageTypes.length === 0 ? (
                            <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed px-6 py-16 text-center">
                                <div className="flex size-12 items-center justify-center rounded-full bg-muted">
                                    <Leaf className="size-6 text-muted-foreground" />
                                </div>
                                <div className="space-y-1">
                                    <h2 className="font-semibold">
                                        No foliage yet
                                    </h2>
                                    <p className="max-w-sm text-sm text-muted-foreground">
                                        Add a first tree, bush or rock type to
                                        start planting in the studio.
                                    </p>
                                </div>
                                <Button onClick={() => openEditor(null)}>
                                    <Plus />
                                    New foliage type
                                </Button>
                            </div>
                        ) : (
                            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                                {foliageTypes.map((type) => (
                                    <FoliageCard
                                        key={type.id}
                                        type={type}
                                        kindLabel={
                                            kinds.find(
                                                (k) => k.value === type.kind,
                                            )?.label ?? type.kind
                                        }
                                        onEdit={() => openEditor(type.id)}
                                    />
                                ))}
                            </div>
                        )}
                    </TabsContent>
                </Tabs>
            </div>

            <Sheet open={open} onOpenChange={setOpen}>
                <SheetContent className="w-full gap-0 sm:max-w-2xl">
                    <FoliageEditor
                        key={formKey}
                        type={editing}
                        kinds={kinds}
                        assets={assets}
                        proceduralHeights={proceduralHeights}
                        onSaved={() => setOpen(false)}
                    />
                </SheetContent>
            </Sheet>

            <FoliageUploadDialog
                open={dialog === 'upload'}
                onOpenChange={(o) => setDialog(o ? 'upload' : null)}
                kinds={kinds}
            />
            <FoliageGenerateDialog
                open={dialog === 'generate'}
                onOpenChange={(o) => setDialog(o ? 'generate' : null)}
                kinds={kinds}
                aiConfigured={ai.configured}
                meshyConfigured={ai.meshy_configured}
                imageModel={ai.image_model}
            />
            <FoliageAiPlanDialog
                open={dialog === 'plan'}
                onOpenChange={(o) => setDialog(o ? 'plan' : null)}
                maps={maps}
                aiConfigured={ai.configured}
                meshyConfigured={ai.meshy_configured}
            />
        </>
    );
}

function KindIcon({
    type,
    className,
}: {
    type: Pick<FoliageType, 'kind' | 'color' | 'color_secondary'>;
    className?: string;
}) {
    const Icon = FOLIAGE_ICONS[type.kind] ?? Leaf;

    return (
        <div
            className={
                className ??
                'flex size-11 shrink-0 items-center justify-center rounded-xl text-white shadow-sm'
            }
            style={{
                background: `linear-gradient(135deg, ${type.color}, ${type.color_secondary})`,
            }}
        >
            <Icon className="size-5 drop-shadow" />
        </div>
    );
}

function FoliageCard({
    type,
    kindLabel,
    onEdit,
}: {
    type: FoliageType;
    kindLabel: string;
    onEdit: () => void;
}) {
    const deleteForm = useForm({});

    return (
        <article className="flex flex-col rounded-xl border bg-card p-4 shadow-xs">
            <div className="flex items-start gap-3">
                {type.asset?.thumbnail_url ? (
                    <MaterialThumb
                        src={type.asset.thumbnail_url}
                        alt={type.asset.name}
                        className="size-11 shrink-0 rounded-xl"
                    />
                ) : (
                    <KindIcon type={type} />
                )}
                <div className="min-w-0 flex-1">
                    <h2 className="truncate font-semibold">{type.name}</h2>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Badge variant="secondary">{kindLabel}</Badge>
                        {type.asset ? (
                            <Badge variant="outline" title={type.asset.name}>
                                <Package />
                                {type.asset.model_url
                                    ? 'Model'
                                    : 'Model pending'}
                            </Badge>
                        ) : (
                            type.model_url && (
                                <Badge variant="outline">
                                    <Box />
                                    GLB model
                                </Badge>
                            )
                        )}
                    </div>
                </div>
                <div className="flex shrink-0 gap-1" aria-label="Colours">
                    {[type.color, type.color_secondary].map((c, i) => (
                        <span
                            key={i}
                            title={c}
                            className="size-4 rounded-full border shadow-xs"
                            style={{ backgroundColor: c }}
                        />
                    ))}
                </div>
            </div>

            <dl className="mt-4 grid grid-cols-3 gap-2 text-sm">
                <Stat label="Density">
                    {formatNumber(type.density)}
                    <span className="text-xs font-normal text-muted-foreground">
                        {' '}
                        /100 m²
                    </span>
                </Stat>
                <Stat label={type.asset?.height ? 'Size' : 'Scale'}>
                    {type.asset?.height
                        ? `${formatNumber(type.min_scale * type.asset.height, 1)}–${formatNumber(type.max_scale * type.asset.height, 1)} m`
                        : `${formatNumber(type.min_scale)}–${formatNumber(type.max_scale)}×`}
                </Stat>
                <Stat label="Cull">
                    {formatNumber(type.cull_distance, 0)} m
                </Stat>
                <Stat label="Slope">
                    {formatNumber(type.min_slope, 0)}–
                    {formatNumber(type.max_slope, 0)}°
                </Stat>
                <Stat label="Height">
                    {type.min_height === null && type.max_height === null
                        ? 'Any'
                        : `${type.min_height === null ? '…' : formatNumber(type.min_height, 0)}–${type.max_height === null ? '…' : formatNumber(type.max_height, 0)} m`}
                </Stat>
                <Stat label="Underwater">
                    {type.allow_underwater ? 'Yes' : 'No'}
                </Stat>
            </dl>

            <div className="mt-4 flex gap-2 border-t pt-3">
                <Button size="sm" variant="outline" onClick={onEdit}>
                    <Pencil />
                    Edit
                </Button>
                <ConfirmDialog
                    trigger={
                        <Button
                            size="sm"
                            variant="ghost"
                            className="ml-auto text-red-600 hover:bg-red-500/10 hover:text-red-700 dark:text-red-400"
                        >
                            <Trash2 />
                            Delete
                        </Button>
                    }
                    title={`Delete ${type.name}?`}
                    description="Instances already placed on maps will no longer render. This cannot be undone."
                    confirmLabel="Delete"
                    destructive
                    processing={deleteForm.processing}
                    onConfirm={(close) =>
                        deleteForm.submit(foliage.destroy(type.id), {
                            preserveScroll: true,
                            onSuccess: close,
                        })
                    }
                />
            </div>
        </article>
    );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="truncate font-medium tabular-nums">{children}</dd>
        </div>
    );
}

function FoliageEditor({
    type,
    kinds,
    assets,
    proceduralHeights,
    onSaved,
}: {
    type: FoliageType | null;
    kinds: Kind[];
    assets: FoliageAssetStudio[];
    proceduralHeights: Record<FoliageKind, number>;
    onSaved: () => void;
}) {
    const id = useId();
    const form = useForm<FoliageForm>(type ? toForm(type) : { ...NEW_FOLIAGE });
    const errors = form.errors as Partial<Record<keyof FoliageForm, string>>;

    const set = <K extends keyof FoliageForm>(key: K, value: FoliageForm[K]) =>
        form.setData((prev) => ({ ...prev, [key]: value }));
    // The preview follows the unsaved form values; the id seeds the procedural mesh like in-game.
    const asset =
        assets.find((a) => a.id === form.data.foliage_asset_id) ?? null;
    const legacyModel = type && !type.asset ? type.model_url : null;
    const previewType: FoliageType = {
        ...form.data,
        id: type?.id ?? 0,
        asset,
        model_url: asset ? asset.model_url : legacyModel,
    };
    // Metres of the rendered model at scale 1 (asset → baked height, procedural → built-in size).
    const baseHeight = asset
        ? asset.height
        : legacyModel
          ? null
          : proceduralHeights[form.data.kind];

    const submit = (e: FormEvent) => {
        e.preventDefault();
        form.submit(type ? foliage.update(type.id) : foliage.store(), {
            preserveScroll: true,
            onSuccess: onSaved,
        });
    };

    return (
        <form onSubmit={submit} className="flex h-full min-h-0 flex-col">
            <SheetHeader className="border-b">
                <SheetTitle>
                    {type ? `Edit ${type.name}` : 'New foliage type'}
                </SheetTitle>
                <SheetDescription>
                    How this plant or rock looks and where the foliage brush may
                    place it.
                </SheetDescription>
            </SheetHeader>

            <div className="flex-1 space-y-8 overflow-y-auto p-4">
                <FoliagePreview type={previewType} />

                <section className="grid gap-4">
                    <div className="flex items-end gap-3">
                        <KindIcon type={form.data} />
                        <div className="grid flex-1 gap-2">
                            <Label htmlFor={`${id}-name`}>Name</Label>
                            <Input
                                id={`${id}-name`}
                                value={form.data.name}
                                onChange={(e) => set('name', e.target.value)}
                                required
                                maxLength={60}
                                placeholder="e.g. Silver birch"
                                aria-invalid={errors.name ? true : undefined}
                            />
                        </div>
                    </div>
                    <InputError message={errors.name} />

                    <div className="grid gap-2">
                        <Label htmlFor={`${id}-kind`}>Kind</Label>
                        <Select
                            value={form.data.kind}
                            onValueChange={(v) => set('kind', v as FoliageKind)}
                        >
                            <SelectTrigger id={`${id}-kind`} className="w-full">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {kinds.map((kind) => {
                                    const Icon =
                                        FOLIAGE_ICONS[kind.value] ?? Leaf;

                                    return (
                                        <SelectItem
                                            key={kind.value}
                                            value={kind.value}
                                        >
                                            <Icon />
                                            {kind.label}
                                        </SelectItem>
                                    );
                                })}
                            </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">
                            Drives wind, land-cover placement and the procedural
                            mesh used when no model is set.
                        </p>
                        <InputError message={errors.kind} />
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                        <ColorField
                            label={
                                form.data.kind === 'rock'
                                    ? 'Colour'
                                    : 'Foliage colour'
                            }
                            value={form.data.color}
                            onChange={(v) => set('color', v)}
                            error={errors.color}
                        />
                        <ColorField
                            label={
                                form.data.kind === 'rock'
                                    ? 'Secondary colour'
                                    : 'Trunk / accent colour'
                            }
                            value={form.data.color_secondary}
                            onChange={(v) => set('color_secondary', v)}
                            error={errors.color_secondary}
                        />
                    </div>
                </section>

                <EditorSection title="Model">
                    <AssetPicker
                        assets={assets}
                        kind={form.data.kind}
                        value={form.data.foliage_asset_id}
                        onChange={(v) => set('foliage_asset_id', v)}
                        legacyModel={legacyModel}
                    />
                    <InputError message={errors.foliage_asset_id} />
                    {asset && (
                        <ColorField
                            label="Model tint"
                            value={form.data.tint}
                            onChange={(v) => set('tint', v)}
                            error={errors.tint}
                        />
                    )}
                </EditorSection>

                <EditorSection title="Placement">
                    <SliderField
                        label="Density"
                        value={form.data.density}
                        onChange={(v) => set('density', v)}
                        min={0.01}
                        max={500}
                        step={0.01}
                        unit="/100m²"
                        description="Instances per 100 m² when painting at full strength."
                        error={errors.density}
                    />
                    <div className="grid gap-5 sm:grid-cols-2">
                        <SliderField
                            label="Min scale"
                            value={form.data.min_scale}
                            onChange={(v) => set('min_scale', v)}
                            min={0.05}
                            max={20}
                            step={0.05}
                            unit="×"
                            description={
                                baseHeight
                                    ? `≈ ${formatMetres(form.data.min_scale * baseHeight)} tall`
                                    : undefined
                            }
                            error={errors.min_scale}
                        />
                        <SliderField
                            label="Max scale"
                            value={form.data.max_scale}
                            onChange={(v) => set('max_scale', v)}
                            min={0.05}
                            max={20}
                            step={0.05}
                            unit="×"
                            description={
                                baseHeight
                                    ? `≈ ${formatMetres(form.data.max_scale * baseHeight)} tall`
                                    : undefined
                            }
                            error={errors.max_scale}
                        />
                        <SliderField
                            label="Min slope"
                            value={form.data.min_slope}
                            onChange={(v) => set('min_slope', v)}
                            min={0}
                            max={90}
                            step={1}
                            unit="°"
                            error={errors.min_slope}
                        />
                        <SliderField
                            label="Max slope"
                            value={form.data.max_slope}
                            onChange={(v) => set('max_slope', v)}
                            min={0}
                            max={90}
                            step={1}
                            unit="°"
                            error={errors.max_slope}
                        />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        <NullableNumber
                            label="Min height"
                            value={form.data.min_height}
                            onChange={(v) => set('min_height', v)}
                            error={errors.min_height}
                        />
                        <NullableNumber
                            label="Max height"
                            value={form.data.max_height}
                            onChange={(v) => set('max_height', v)}
                            error={errors.max_height}
                        />
                    </div>
                    <ToggleRow
                        label="Allow under water"
                        description="For reeds, rocks and other plants that grow in shallow water."
                        checked={form.data.allow_underwater}
                        onChange={(v) => set('allow_underwater', v)}
                    />
                </EditorSection>

                <EditorSection title="Rendering">
                    <ToggleRow
                        label="Align to terrain normal"
                        description="Tilt instances with the slope (good for rocks and grass)."
                        checked={form.data.align_to_normal}
                        onChange={(v) => set('align_to_normal', v)}
                    />
                    <ToggleRow
                        label="Random rotation"
                        description="Rotate every instance randomly around its vertical axis."
                        checked={form.data.random_yaw}
                        onChange={(v) => set('random_yaw', v)}
                    />
                    <ToggleRow
                        label="Cast shadows"
                        checked={form.data.cast_shadows}
                        onChange={(v) => set('cast_shadows', v)}
                    />
                    <SliderField
                        label="Cull distance"
                        value={form.data.cull_distance}
                        onChange={(v) => set('cull_distance', v)}
                        min={20}
                        max={5000}
                        step={10}
                        unit="m"
                        description="Instances further away than this are not drawn."
                        error={errors.cull_distance}
                    />
                </EditorSection>

                <EditorSection title="Collision">
                    <div className="grid gap-2">
                        <Label htmlFor={`${id}-collision`}>
                            Blocks the player
                        </Label>
                        <Select
                            value={form.data.collision ?? 'auto'}
                            onValueChange={(v) =>
                                set('collision', v as FoliageCollision)
                            }
                        >
                            <SelectTrigger
                                id={`${id}-collision`}
                                className="w-full"
                            >
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {COLLISION_OPTIONS.map((o) => (
                                    <SelectItem key={o.value} value={o.value}>
                                        {o.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">
                            Automatic: trees block with their trunk, rocks with
                            their footprint; bushes, grass, flowers and reeds
                            are walked through. Applies to ground cover too.
                        </p>
                    </div>
                    <NullableNumber
                        label="Collider radius (at scale 1)"
                        placeholder="Measured"
                        value={form.data.collision_radius ?? null}
                        onChange={(v) => set('collision_radius', v)}
                        error={errors.collision_radius}
                    />
                </EditorSection>

                {type && !asset && <ModelUpload type={type} />}
            </div>

            <SheetFooter className="flex-row justify-end gap-2 border-t">
                <Button type="button" variant="ghost" onClick={onSaved}>
                    Cancel
                </Button>
                <Button type="submit" disabled={form.processing}>
                    {form.processing && <Spinner />}
                    {type ? 'Save changes' : 'Create foliage type'}
                </Button>
            </SheetFooter>
        </form>
    );
}

function EditorSection({
    title,
    children,
}: {
    title: string;
    children: ReactNode;
}) {
    return (
        <section className="grid gap-5">
            <h3 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                {title}
            </h3>
            {children}
        </section>
    );
}

function ToggleRow({
    label,
    description,
    checked,
    onChange,
}: {
    label: string;
    description?: string;
    checked: boolean;
    onChange: (value: boolean) => void;
}) {
    const id = useId();

    return (
        <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
                <Label htmlFor={id}>{label}</Label>
                {description && (
                    <p className="text-xs text-muted-foreground">
                        {description}
                    </p>
                )}
            </div>
            <Switch id={id} checked={checked} onCheckedChange={onChange} />
        </div>
    );
}

function NullableNumber({
    label,
    value,
    onChange,
    error,
    placeholder = 'Any',
}: {
    label: string;
    value: number | null;
    onChange: (value: number | null) => void;
    error?: string;
    placeholder?: string;
}) {
    const id = useId();

    return (
        <div className="grid gap-2">
            <Label htmlFor={id}>{label}</Label>
            <div className="relative">
                <Input
                    id={id}
                    type="number"
                    step="any"
                    inputMode="decimal"
                    value={value ?? ''}
                    placeholder={placeholder}
                    onChange={(e) =>
                        onChange(
                            e.target.value === ''
                                ? null
                                : Number(e.target.value),
                        )
                    }
                    aria-invalid={error ? true : undefined}
                    className="pr-8 tabular-nums"
                />
                <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs text-muted-foreground">
                    m
                </span>
            </div>
            <InputError message={error} />
        </div>
    );
}

function ModelUpload({ type }: { type: FoliageType }) {
    const uploadForm = useForm<{ model: File | null }>({ model: null });
    const removeForm = useForm({});
    const fileRef = useRef<HTMLInputElement>(null);

    const upload = (file: File | undefined) => {
        if (!file) {
            return;
        }

        uploadForm.transform(() => ({ model: file }));
        uploadForm.submit(foliage.model.store(type.id), {
            forceFormData: true,
            preserveScroll: true,
            preserveState: true,
            onFinish: () => {
                if (fileRef.current) {
                    fileRef.current.value = '';
                }
            },
        });
    };

    return (
        <EditorSection title="Direct .glb upload">
            <div className="grid gap-3 rounded-lg border p-4">
                <div className="flex items-center gap-3">
                    <div className="flex size-10 items-center justify-center rounded-md bg-muted">
                        <Box className="size-5 text-muted-foreground" />
                    </div>
                    <div className="min-w-0 flex-1 text-sm">
                        {type.model_url ? (
                            <>
                                <div className="font-medium">
                                    Model uploaded
                                </div>
                                <a
                                    href={type.model_url}
                                    className="block truncate text-xs text-muted-foreground underline underline-offset-2"
                                    download
                                >
                                    {type.model_url.split('/').pop()}
                                </a>
                            </>
                        ) : (
                            <>
                                <div className="font-medium">
                                    Procedural mesh
                                </div>
                                <div className="text-xs text-muted-foreground">
                                    Upload a game-ready binary glTF (.glb, max
                                    50 MB) as-is. Prefer the asset library: it
                                    builds LODs and impostors for you.
                                </div>
                            </>
                        )}
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <input
                        ref={fileRef}
                        type="file"
                        accept=".glb,model/gltf-binary"
                        className="sr-only"
                        aria-label="Upload .glb model"
                        onChange={(e) => upload(e.target.files?.[0])}
                    />
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={uploadForm.processing}
                        onClick={() => fileRef.current?.click()}
                    >
                        {uploadForm.processing ? <Spinner /> : <Upload />}
                        {type.model_url ? 'Replace model' : 'Upload .glb'}
                    </Button>
                    {type.model_url && (
                        <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={removeForm.processing}
                            onClick={() =>
                                removeForm.submit(
                                    foliage.model.destroy(type.id),
                                    {
                                        preserveScroll: true,
                                        preserveState: true,
                                    },
                                )
                            }
                        >
                            <X />
                            Remove
                        </Button>
                    )}
                    {uploadForm.progress && (
                        <span className="text-xs text-muted-foreground tabular-nums">
                            {uploadForm.progress.percentage}%
                        </span>
                    )}
                </div>
                <InputError
                    message={
                        (uploadForm.errors as Record<string, string>).model
                    }
                />
            </div>
        </EditorSection>
    );
}

function AssetPicker({
    assets,
    kind,
    value,
    onChange,
    legacyModel,
}: {
    assets: FoliageAssetStudio[];
    kind: FoliageKind;
    value: number | null;
    onChange: (value: number | null) => void;
    legacyModel: string | null;
}) {
    const usable = assets.filter(
        (a) => a.status !== 'failed' || a.id === value,
    );
    // Same kind first, then the rest.
    const sorted = [
        ...usable.filter((a) => a.kind === kind),
        ...usable.filter((a) => a.kind !== kind),
    ];
    const selected = assets.find((a) => a.id === value) ?? null;

    return (
        <div className="grid gap-3">
            <Select
                value={value === null ? 'none' : String(value)}
                onValueChange={(v) => onChange(v === 'none' ? null : Number(v))}
            >
                <SelectTrigger
                    className="h-auto w-full py-2"
                    aria-label="Model"
                >
                    <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-80">
                    <SelectItem value="none">
                        {legacyModel
                            ? 'Uploaded .glb model'
                            : 'Procedural mesh (from kind and colours)'}
                    </SelectItem>
                    {sorted.map((a) => {
                        const Icon = FOLIAGE_ICONS[a.kind] ?? Leaf;

                        return (
                            <SelectItem key={a.id} value={String(a.id)}>
                                <Icon />
                                <span className="truncate">{a.name}</span>
                                <span className="text-xs text-muted-foreground">
                                    {assetSourceLabel(a)}
                                    {a.status === 'ready'
                                        ? ` · ${formatMetres(a.height)}`
                                        : ` · ${a.status.replace('_', ' ')}`}
                                </span>
                            </SelectItem>
                        );
                    })}
                </SelectContent>
            </Select>
            {selected ? (
                <div className="flex items-center gap-3 rounded-lg border p-2">
                    <MaterialThumb
                        src={selected.thumbnail_url}
                        alt={selected.name}
                        className="size-14 shrink-0 rounded-md"
                    />
                    <div className="min-w-0 text-xs text-muted-foreground">
                        <div className="truncate text-sm font-medium text-foreground">
                            {selected.name}
                        </div>
                        {selected.status === 'ready' ? (
                            <>
                                {formatMetres(selected.height)} tall at scale 1
                                · {selected.triangles.length} LODs (
                                {selected.triangles
                                    .map(formatTriangles)
                                    .join(' / ')}{' '}
                                tris)
                            </>
                        ) : (
                            <>
                                Not optimised yet — the procedural mesh is used
                                until it is.
                            </>
                        )}
                        {selected.kind !== kind && (
                            <div className="text-amber-700 dark:text-amber-400">
                                The asset is a {selected.kind}; this type is a{' '}
                                {kind}.
                            </div>
                        )}
                    </div>
                </div>
            ) : (
                assets.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                        Import, upload or generate models in the Asset library
                        tab to use them here.
                    </p>
                )
            )}
        </div>
    );
}

FoliageIndex.layout = {
    breadcrumbs: [{ title: 'Foliage', href: foliage.index() }],
};
