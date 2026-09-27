import { useForm } from '@inertiajs/react';
import type { FoliageType } from '@game/shared/types';
import {
    Box,
    Cpu,
    Download,
    ExternalLink,
    ImageOff,
    Package,
    RefreshCw,
    Sparkles,
    Trash2,
    TriangleAlert,
    Upload,
} from 'lucide-react';
import type { FormEvent, ReactNode } from 'react';
import { useId, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { FoliagePreview } from '@/components/foliage-preview';
import { KindSelect } from '@/components/foliage/fields';
import type { KindOption } from '@/components/foliage/fields';
import InputError from '@/components/input-error';
import { MaterialThumb } from '@/components/materials/material-thumb';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { BakeState } from '@/hooks/use-foliage-bake-queue';
import {
    FOLIAGE_SOURCE_LABELS,
    formatMetres,
    formatTriangles,
    kindIcon,
    PENDING_STATUSES,
} from '@/lib/foliage';
import { cn } from '@/lib/utils';
import foliage from '@/routes/foliage';
import type { FoliageAssetStudio } from '@/types';

type Props = {
    assets: FoliageAssetStudio[];
    kinds: KindOption[];
    bake: BakeState | null;
    bakeSupported: boolean;
    onBrowse: () => void;
    onUpload: () => void;
    onGenerate: () => void;
};

/** Grid of library assets with import / bake status. */
export function AssetLibrary({
    assets,
    kinds,
    bake,
    bakeSupported,
    onBrowse,
    onUpload,
    onGenerate,
}: Props) {
    const [openId, setOpenId] = useState<number | null>(null);
    const open = assets.find((a) => a.id === openId) ?? null;
    const [filter, setFilter] = useState<string>('all');
    const shown =
        filter === 'all' ? assets : assets.filter((a) => a.kind === filter);

    return (
        <div className="grid gap-4">
            {!bakeSupported &&
                assets.some((a) => a.status === 'awaiting_bake') && (
                    <div className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
                        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
                        This browser has no WebGL 2, so assets cannot be
                        optimised here. Open the studio in a current desktop
                        browser.
                    </div>
                )}

            {assets.length === 0 ? (
                <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed px-6 py-14 text-center">
                    <div className="flex size-12 items-center justify-center rounded-full bg-muted">
                        <Package className="size-6 text-muted-foreground" />
                    </div>
                    <div className="max-w-md space-y-1">
                        <h2 className="font-semibold">No foliage assets yet</h2>
                        <p className="text-sm text-muted-foreground">
                            Import free CC0 plant, tree and rock scans from Poly
                            Haven, upload glTF models or whole nature kits, or
                            generate plant cards with AI. Assets are optimised
                            for the game (LODs and impostors) right in this
                            browser.
                        </p>
                    </div>
                    <div className="flex flex-wrap justify-center gap-2">
                        <Button onClick={onBrowse}>
                            <Download />
                            Browse Poly Haven
                        </Button>
                        <Button variant="outline" onClick={onUpload}>
                            <Upload />
                            Upload models
                        </Button>
                        <Button variant="outline" onClick={onGenerate}>
                            <Sparkles />
                            Generate with AI
                        </Button>
                    </div>
                </div>
            ) : (
                <>
                    <div className="flex flex-wrap items-center gap-2">
                        <KindSelect
                            kinds={kinds}
                            value={filter}
                            onChange={setFilter}
                            allowAll
                            className="w-44"
                        />
                        <span className="text-sm text-muted-foreground">
                            {shown.length} of {assets.length}
                        </span>
                        <div className="ml-auto flex flex-wrap gap-2">
                            <Button size="sm" onClick={onBrowse}>
                                <Download />
                                Poly Haven
                            </Button>
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={onUpload}
                            >
                                <Upload />
                                Upload
                            </Button>
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={onGenerate}
                            >
                                <Sparkles />
                                Generate
                            </Button>
                        </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                        {shown.map((asset) => (
                            <AssetCard
                                key={asset.id}
                                asset={asset}
                                kinds={kinds}
                                bake={bake?.assetId === asset.id ? bake : null}
                                onOpen={() => setOpenId(asset.id)}
                            />
                        ))}
                    </div>
                </>
            )}

            <AssetDialog
                asset={open}
                kinds={kinds}
                onOpenChange={(o) => !o && setOpenId(null)}
            />
        </div>
    );
}

function statusText(
    asset: FoliageAssetStudio,
    bake: BakeState | null,
): string | null {
    if (bake) {
        return bake.stage;
    }

    switch (asset.status) {
        case 'queued':
        case 'processing':
            return asset.status_message ?? 'Working…';
        case 'awaiting_bake':
            return 'Waiting to be optimised…';
        case 'failed':
            return asset.status_message ?? 'Failed';
        default:
            return null;
    }
}

function AssetCard({
    asset,
    kinds,
    bake,
    onOpen,
}: {
    asset: FoliageAssetStudio;
    kinds: KindOption[];
    bake: BakeState | null;
    onOpen: () => void;
}) {
    const Icon = kindIcon(asset.kind);
    const pending = PENDING_STATUSES.includes(asset.status);
    const status = statusText(asset, bake);

    return (
        <article className="flex flex-col overflow-hidden rounded-xl border bg-card shadow-xs">
            <button
                type="button"
                onClick={onOpen}
                className="relative block text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                aria-label={`Open ${asset.name}`}
            >
                <MaterialThumb
                    src={asset.thumbnail_url}
                    alt={asset.name}
                    className="aspect-square"
                />
                <Badge
                    variant="secondary"
                    className="absolute top-2 left-2 bg-background/85 backdrop-blur"
                >
                    <Icon />
                    {kinds.find((k) => k.value === asset.kind)?.label ??
                        asset.kind}
                </Badge>
                {asset.style === 'stylized' && (
                    <Badge className="absolute top-2 right-2 bg-fuchsia-600 text-white">
                        Stylized
                    </Badge>
                )}
                {(pending || bake) && (
                    <div className="absolute inset-x-0 bottom-0 grid gap-1 bg-background/90 p-2 backdrop-blur">
                        <div className="flex items-center gap-1.5 text-[11px]">
                            <Spinner className="size-3" />
                            <span className="truncate">{status}</span>
                        </div>
                        {bake && (
                            <Progress
                                value={Math.round(bake.fraction * 100)}
                                className="h-1"
                            />
                        )}
                    </div>
                )}
                {asset.status === 'failed' && (
                    <div className="absolute inset-x-0 bottom-0 flex items-start gap-1.5 bg-red-600/90 p-2 text-[11px] text-white">
                        <TriangleAlert className="mt-px size-3 shrink-0" />
                        <span className="line-clamp-2">{status}</span>
                    </div>
                )}
            </button>
            <div className="grid gap-1 p-3">
                <h3 className="truncate text-sm font-medium" title={asset.name}>
                    {asset.name}
                </h3>
                <p className="truncate text-xs text-muted-foreground">
                    {FOLIAGE_SOURCE_LABELS[asset.source]}
                    {asset.status === 'ready' && (
                        <>
                            {' · '}
                            {formatMetres(asset.height)} ·{' '}
                            {formatTriangles(asset.triangles[0])} tris
                        </>
                    )}
                    {asset.types_count ? ` · used by ${asset.types_count}` : ''}
                </p>
            </div>
        </article>
    );
}

type AssetForm = {
    name: string;
    kind: string;
    style: 'realistic' | 'stylized';
    target_height: number | null;
    license: string;
    author: string;
};

function AssetDialog({
    asset,
    kinds,
    onOpenChange,
}: {
    asset: FoliageAssetStudio | null;
    kinds: KindOption[];
    onOpenChange: (open: boolean) => void;
}) {
    return (
        <Dialog open={asset !== null} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
                {asset && (
                    <AssetDetail
                        key={asset.id}
                        asset={asset}
                        kinds={kinds}
                        onClose={() => onOpenChange(false)}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}

function AssetDetail({
    asset,
    kinds,
    onClose,
}: {
    asset: FoliageAssetStudio;
    kinds: KindOption[];
    onClose: () => void;
}) {
    const id = useId();
    const form = useForm<AssetForm>({
        name: asset.name,
        kind: asset.kind,
        style: asset.style,
        target_height: asset.target_height ?? asset.height,
        license: asset.license ?? '',
        author: asset.author ?? '',
    });
    const actionForm = useForm({});
    const deleteForm = useForm({});
    const errors = form.errors as Partial<Record<string, string>>;
    const ready = asset.status === 'ready';

    // Preview the baked model through the game's own foliage renderer.
    const previewType: FoliageType = {
        id: asset.id,
        name: asset.name,
        kind: asset.kind,
        color: '#4c6b2c',
        color_secondary: '#57402b',
        model_url: asset.model_url,
        asset,
        tint: '#ffffff',
        min_scale: 0.9,
        max_scale: 1.1,
        density: asset.kind === 'grass' ? 30 : asset.kind === 'flower' ? 8 : 1,
        min_slope: 0,
        max_slope: 45,
        min_height: null,
        max_height: null,
        align_to_normal: asset.kind === 'rock' || asset.kind === 'grass',
        random_yaw: true,
        cast_shadows: true,
        cull_distance: 800,
        allow_underwater: false,
    };

    const submit = (e: FormEvent) => {
        e.preventDefault();
        form.submit(foliage.assets.update(asset.id), {
            preserveScroll: true,
            preserveState: true,
        });
    };

    return (
        <form onSubmit={submit} className="grid gap-5">
            <DialogHeader>
                <DialogTitle>{asset.name}</DialogTitle>
                <DialogDescription>
                    {FOLIAGE_SOURCE_LABELS[asset.source]}
                    {asset.author ? ` · ${asset.author}` : ''}
                    {asset.license ? ` · ${asset.license}` : ''}
                    {asset.source_url && (
                        <>
                            {' · '}
                            <a
                                href={asset.source_url}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-0.5 underline underline-offset-2"
                            >
                                Source
                                <ExternalLink className="size-3" />
                            </a>
                        </>
                    )}
                </DialogDescription>
            </DialogHeader>

            {ready ? (
                <FoliagePreview type={previewType} />
            ) : (
                <div className="flex aspect-video flex-col items-center justify-center gap-2 rounded-xl border border-dashed text-sm text-muted-foreground">
                    {asset.status === 'failed' ? (
                        <>
                            <TriangleAlert className="size-6 text-red-500" />
                            <p className="max-w-md text-center text-red-600 dark:text-red-400">
                                {asset.status_message}
                            </p>
                        </>
                    ) : PENDING_STATUSES.includes(asset.status) ? (
                        <>
                            <Spinner />
                            <p>{asset.status_message ?? 'Working…'}</p>
                        </>
                    ) : (
                        <>
                            <ImageOff className="size-6" />
                            <p>No preview</p>
                        </>
                    )}
                </div>
            )}

            {ready && (
                <dl className="grid grid-cols-2 gap-3 rounded-lg bg-muted/50 p-3 text-sm sm:grid-cols-4">
                    <Fact label="Height">{formatMetres(asset.height)}</Fact>
                    <Fact label="Width">{formatMetres(asset.meta.width)}</Fact>
                    <Fact label="Triangles per LOD">
                        {asset.triangles.map(formatTriangles).join(' / ') ||
                            '–'}
                    </Fact>
                    <Fact label="Source">
                        {asset.meta.source_triangles
                            ? `${formatTriangles(asset.meta.source_triangles)} tris`
                            : asset.source_type === 'card'
                              ? 'AI image'
                              : '–'}
                        {asset.meta.model_bytes
                            ? ` → ${(asset.meta.model_bytes / 1048576).toFixed(1)} MB`
                            : ''}
                    </Fact>
                </dl>
            )}

            {asset.source === 'ai' && asset.source_file_url && (
                <div className="flex gap-3 rounded-lg border p-3">
                    <MaterialThumb
                        src={asset.source_file_url}
                        alt="Generated image"
                        className="size-20 shrink-0 rounded-md"
                    />
                    <div className="min-w-0 text-xs text-muted-foreground">
                        <div className="mb-1 font-medium text-foreground">
                            Generated with {asset.ai_model ?? 'AI'}
                        </div>
                        <p className="line-clamp-4">{asset.ai_prompt}</p>
                    </div>
                </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                    <Label htmlFor={`${id}-name`}>Name</Label>
                    <Input
                        id={`${id}-name`}
                        value={form.data.name}
                        maxLength={80}
                        required
                        onChange={(e) => form.setData('name', e.target.value)}
                    />
                    <InputError message={errors.name} />
                </div>
                <KindSelect
                    label="Kind"
                    kinds={kinds}
                    value={form.data.kind}
                    onChange={(v) => form.setData('kind', v)}
                />
                <div className="grid gap-2">
                    <Label htmlFor={`${id}-height`}>Real height</Label>
                    <div className="relative">
                        <Input
                            id={`${id}-height`}
                            type="number"
                            step="any"
                            min={0.02}
                            max={150}
                            value={form.data.target_height ?? ''}
                            placeholder="Model size"
                            onChange={(e) =>
                                form.setData(
                                    'target_height',
                                    e.target.value === ''
                                        ? null
                                        : Number(e.target.value),
                                )
                            }
                            className="pr-8 tabular-nums"
                        />
                        <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs text-muted-foreground">
                            m
                        </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                        Changing the height or kind re-optimises the model.
                    </p>
                    <InputError message={errors.target_height} />
                </div>
                <div className="grid gap-2">
                    <Label>Style</Label>
                    <ToggleGroup
                        type="single"
                        variant="outline"
                        value={form.data.style}
                        onValueChange={(v) =>
                            v && form.setData('style', v as AssetForm['style'])
                        }
                        className="w-full"
                    >
                        <ToggleGroupItem value="realistic" className="flex-1">
                            Realistic
                        </ToggleGroupItem>
                        <ToggleGroupItem value="stylized" className="flex-1">
                            Stylized
                        </ToggleGroupItem>
                    </ToggleGroup>
                </div>
                <div className="grid gap-2">
                    <Label htmlFor={`${id}-author`}>Author</Label>
                    <Input
                        id={`${id}-author`}
                        value={form.data.author}
                        maxLength={120}
                        onChange={(e) => form.setData('author', e.target.value)}
                    />
                </div>
                <div className="grid gap-2">
                    <Label htmlFor={`${id}-license`}>Licence</Label>
                    <Input
                        id={`${id}-license`}
                        value={form.data.license}
                        maxLength={120}
                        onChange={(e) =>
                            form.setData('license', e.target.value)
                        }
                    />
                </div>
            </div>

            <DialogFooter className="flex-wrap gap-2 sm:justify-between">
                <div className="flex flex-wrap gap-2">
                    <ConfirmDialog
                        trigger={
                            <Button
                                type="button"
                                variant="ghost"
                                className="text-red-600 hover:bg-red-500/10 hover:text-red-700 dark:text-red-400"
                            >
                                <Trash2 />
                                Delete
                            </Button>
                        }
                        title={`Delete ${asset.name}?`}
                        description={
                            asset.types_count
                                ? `${asset.types_count} foliage type(s) use this asset and will fall back to their procedural mesh.`
                                : 'The asset and its files are removed from the library.'
                        }
                        confirmLabel="Delete"
                        destructive
                        processing={deleteForm.processing}
                        onConfirm={(close) =>
                            deleteForm.submit(
                                foliage.assets.destroy(asset.id),
                                {
                                    preserveScroll: true,
                                    onSuccess: () => {
                                        close();
                                        onClose();
                                    },
                                },
                            )
                        }
                    />
                    {(asset.status === 'failed' || ready) && (
                        <Button
                            type="button"
                            variant="outline"
                            disabled={actionForm.processing}
                            onClick={() =>
                                actionForm.submit(
                                    asset.status === 'failed'
                                        ? foliage.assets.retry(asset.id)
                                        : foliage.assets.rebake(asset.id),
                                    {
                                        preserveScroll: true,
                                        preserveState: true,
                                    },
                                )
                            }
                        >
                            <RefreshCw />
                            {asset.status === 'failed'
                                ? 'Retry'
                                : 'Re-optimise'}
                        </Button>
                    )}
                </div>
                <div className="flex flex-wrap gap-2">
                    {ready && (
                        <Button
                            type="button"
                            variant="outline"
                            disabled={actionForm.processing}
                            onClick={() =>
                                actionForm.submit(
                                    foliage.assets.createType(asset.id),
                                    { onSuccess: onClose },
                                )
                            }
                        >
                            <Box />
                            Create foliage type
                        </Button>
                    )}
                    <Button type="submit" disabled={form.processing}>
                        {form.processing && <Spinner />}
                        Save
                    </Button>
                </div>
            </DialogFooter>
        </form>
    );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="truncate font-medium tabular-nums">{children}</dd>
        </div>
    );
}

/** Small bake status line for the page header. */
export function BakeStatus({
    bake,
    waiting,
    className,
}: {
    bake: BakeState | null;
    waiting: number;
    className?: string;
}) {
    if (!bake && waiting === 0) {
        return null;
    }

    return (
        <div
            className={cn(
                'flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm shadow-xs',
                className,
            )}
            role="status"
        >
            <Cpu className="size-4 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">
                {bake
                    ? `Optimising ${bake.name}: ${bake.stage}`
                    : `${waiting} asset${waiting === 1 ? '' : 's'} waiting to be optimised`}
            </span>
            {bake && (
                <Progress
                    value={Math.round(bake.fraction * 100)}
                    className="h-1.5 w-24"
                />
            )}
            <span className="hidden text-xs text-muted-foreground sm:inline">
                Keep this page open
            </span>
        </div>
    );
}
