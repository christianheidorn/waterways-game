import { Head, Link, useForm } from '@inertiajs/react';
import {
    CheckCircle2,
    Image,
    Info,
    PersonStanding,
    RefreshCw,
    Sparkles,
    Trash2,
    TriangleAlert,
    Upload,
    UserCheck,
} from 'lucide-react';
import type { FormEvent } from 'react';
import { useId, useRef, useState } from 'react';
import { AiCreditsBadge, refreshAiCredits } from '@/components/ai-credits';
import { CharacterPreview } from '@/components/characters/character-preview';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { StyleSlider } from '@/components/foliage/fields';
import Heading from '@/components/heading';
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
import { usePendingPoll } from '@/hooks/use-pending-poll';
import { cn } from '@/lib/utils';
import aiSettings from '@/routes/ai-settings';
import characters from '@/routes/characters';
import type { CharacterStudio } from '@/types';

type Props = {
    characters: CharacterStudio[];
    ai: { configured: boolean; meshy_configured: boolean; image_model: string };
    extraClips: string[];
};

export default function CharactersIndex({
    characters: list,
    ai,
    extraClips,
}: Props) {
    const [dialog, setDialog] = useState<'generate' | 'upload' | null>(null);
    const [openId, setOpenId] = useState<number | null>(null);
    const open = list.find((c) => c.id === openId) ?? null;
    const deactivate = useForm({});
    const active = list.find((c) => c.active) ?? null;

    usePendingPoll(
        list.some((c) => c.status === 'queued' || c.status === 'processing'),
        ['characters'],
        4000,
    );

    return (
        <>
            <Head title="Characters" />
            <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 p-4 sm:p-6">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <Heading
                        title="Characters"
                        description="Playable characters, rigged and animated. Generate them with Meshy or upload a rigged GLB, then pick the player."
                    />
                    <div className="flex flex-wrap gap-2">
                        <Button
                            variant="outline"
                            onClick={() => setDialog('upload')}
                        >
                            <Upload />
                            Upload GLB
                        </Button>
                        <Button onClick={() => setDialog('generate')}>
                            <Sparkles />
                            Generate with Meshy
                        </Button>
                    </div>
                </div>

                <div className="-mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border p-3 text-sm">
                    <span className="flex items-center gap-2">
                        <UserCheck className="size-4 text-muted-foreground" />
                        Player:{' '}
                        <strong>
                            {active ? active.name : 'Default character'}
                        </strong>
                        {active && (
                            <Button
                                size="sm"
                                variant="ghost"
                                disabled={deactivate.processing}
                                onClick={() =>
                                    deactivate.submit(characters.deactivate(), {
                                        preserveScroll: true,
                                    })
                                }
                            >
                                Use default
                            </Button>
                        )}
                    </span>
                    <AiCreditsBadge />
                </div>

                {list.length === 0 ? (
                    <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed px-6 py-16 text-center">
                        <div className="flex size-12 items-center justify-center rounded-full bg-muted">
                            <PersonStanding className="size-6 text-muted-foreground" />
                        </div>
                        <div className="max-w-md space-y-1">
                            <h2 className="font-semibold">No characters yet</h2>
                            <p className="text-sm text-muted-foreground">
                                Describe a character and Meshy builds a textured
                                model, rigs it and animates idle, walk, run,
                                jump and swim — ready to play.
                            </p>
                        </div>
                        <Button onClick={() => setDialog('generate')}>
                            <Sparkles />
                            Generate a character
                        </Button>
                    </div>
                ) : (
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                        {list.map((c) => (
                            <CharacterCard
                                key={c.id}
                                character={c}
                                onOpen={() => setOpenId(c.id)}
                            />
                        ))}
                    </div>
                )}
            </div>

            <GenerateDialog
                open={dialog === 'generate'}
                onOpenChange={(o) => setDialog(o ? 'generate' : null)}
                ai={ai}
                extraClips={extraClips}
            />
            <UploadDialog
                open={dialog === 'upload'}
                onOpenChange={(o) => setDialog(o ? 'upload' : null)}
            />
            <Dialog
                open={open !== null}
                onOpenChange={(o) => !o && setOpenId(null)}
            >
                <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
                    {open && (
                        <CharacterDetail
                            key={open.id}
                            character={open}
                            onClose={() => setOpenId(null)}
                        />
                    )}
                </DialogContent>
            </Dialog>
        </>
    );
}

function CharacterCard({
    character: c,
    onOpen,
}: {
    character: CharacterStudio;
    onOpen: () => void;
}) {
    const pending = c.status === 'queued' || c.status === 'processing';

    return (
        <article
            className={cn(
                'flex flex-col overflow-hidden rounded-xl border bg-card shadow-xs',
                c.active && 'ring-2 ring-primary',
            )}
        >
            <button
                type="button"
                onClick={onOpen}
                className="relative block text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                aria-label={`Open ${c.name}`}
            >
                <MaterialThumb
                    src={c.thumbnail_url}
                    alt={c.name}
                    className="aspect-square"
                />
                {c.active && (
                    <Badge className="absolute top-2 left-2 bg-primary text-primary-foreground">
                        <CheckCircle2 />
                        Player
                    </Badge>
                )}
                {pending && (
                    <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-background/90 p-2 text-[11px] backdrop-blur">
                        <Spinner className="size-3" />
                        <span className="truncate">
                            {c.status_message ?? 'Working…'}
                        </span>
                    </div>
                )}
                {c.status === 'failed' && (
                    <div className="absolute inset-x-0 bottom-0 flex items-start gap-1.5 bg-red-600/90 p-2 text-[11px] text-white">
                        <TriangleAlert className="mt-px size-3 shrink-0" />
                        <span className="line-clamp-2">{c.status_message}</span>
                    </div>
                )}
            </button>
            <div className="grid gap-1 p-3">
                <h3 className="truncate text-sm font-medium" title={c.name}>
                    {c.name}
                </h3>
                <p className="truncate text-xs text-muted-foreground">
                    {c.source === 'meshy' ? 'Meshy' : 'Upload'} ·{' '}
                    {c.height.toFixed(2)} m
                    {c.clips.length ? ` · ${c.clips.join(', ')}` : ''}
                </p>
            </div>
        </article>
    );
}

function CharacterDetail({
    character: c,
    onClose,
}: {
    character: CharacterStudio;
    onClose: () => void;
}) {
    const id = useId();
    const form = useForm({ name: c.name, height: c.height });
    const action = useForm({});
    const remove = useForm({});
    const ready = c.status === 'ready';

    return (
        <div className="grid gap-5">
            <DialogHeader>
                <DialogTitle>{c.name}</DialogTitle>
                <DialogDescription>
                    {c.source === 'meshy'
                        ? `Generated with ${c.ai_model ?? 'Meshy'}${c.meta.meshy_credits ? ` · ${c.meta.meshy_credits} credits` : ''}`
                        : 'Uploaded GLB'}
                </DialogDescription>
            </DialogHeader>

            {ready ? (
                <CharacterPreview character={c} />
            ) : (
                <div className="flex aspect-[4/3] flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
                    {c.status === 'failed' ? (
                        <>
                            <TriangleAlert className="size-6 text-red-500" />
                            <p className="text-red-600 dark:text-red-400">
                                {c.status_message}
                            </p>
                        </>
                    ) : (
                        <>
                            <Spinner />
                            <p>{c.status_message ?? 'Working…'}</p>
                        </>
                    )}
                </div>
            )}

            {c.prompt && (
                <p className="rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground">
                    {c.prompt}
                </p>
            )}

            <form
                className="grid gap-4 sm:grid-cols-[1fr_10rem_auto] sm:items-end"
                onSubmit={(e) => {
                    e.preventDefault();
                    form.submit(characters.update(c.id), {
                        preserveScroll: true,
                        preserveState: true,
                    });
                }}
            >
                <div className="grid gap-2">
                    <Label htmlFor={`${id}-name`}>Name</Label>
                    <Input
                        id={`${id}-name`}
                        value={form.data.name}
                        maxLength={60}
                        required
                        onChange={(e) => form.setData('name', e.target.value)}
                    />
                </div>
                <div className="grid gap-2">
                    <Label htmlFor={`${id}-height`}>Height (m)</Label>
                    <Input
                        id={`${id}-height`}
                        type="number"
                        step="0.01"
                        min={0.5}
                        max={4}
                        value={form.data.height}
                        onChange={(e) =>
                            form.setData('height', Number(e.target.value))
                        }
                    />
                </div>
                <Button
                    type="submit"
                    variant="outline"
                    disabled={form.processing || !form.isDirty}
                >
                    Save
                </Button>
            </form>

            <DialogFooter className="flex-wrap gap-2 sm:justify-between">
                <div className="flex gap-2">
                    <ConfirmDialog
                        trigger={
                            <Button
                                variant="ghost"
                                className="text-red-600 hover:bg-red-500/10 hover:text-red-700 dark:text-red-400"
                            >
                                <Trash2 />
                                Delete
                            </Button>
                        }
                        title={`Delete ${c.name}?`}
                        description="The model and its animations are removed. If it is the player, the default character is used again."
                        confirmLabel="Delete"
                        destructive
                        processing={remove.processing}
                        onConfirm={(close) =>
                            remove.submit(characters.destroy(c.id), {
                                onSuccess: () => {
                                    close();
                                    onClose();
                                },
                            })
                        }
                    />
                    {c.status === 'failed' && c.source === 'meshy' && (
                        <Button
                            variant="outline"
                            disabled={action.processing}
                            onClick={() =>
                                action.submit(characters.retry(c.id), {
                                    preserveScroll: true,
                                    onSuccess: refreshAiCredits,
                                })
                            }
                        >
                            <RefreshCw />
                            Retry
                        </Button>
                    )}
                </div>
                {ready && !c.active && (
                    <Button
                        disabled={action.processing}
                        onClick={() =>
                            action.submit(characters.activate(c.id), {
                                preserveScroll: true,
                            })
                        }
                    >
                        <UserCheck />
                        Use as player
                    </Button>
                )}
                {c.active && <Badge>Current player character</Badge>}
            </DialogFooter>
        </div>
    );
}

const MODELS: Record<'text' | 'image', { value: string; label: string }[]> = {
    text: [
        { value: 'meshy-6', label: 'Meshy 6 — best quality' },
        { value: 'meshy-5', label: 'Meshy 5 — cheaper' },
    ],
    image: [
        { value: 'latest', label: 'Meshy 7 (latest) — best quality' },
        { value: 'meshy-6', label: 'Meshy 6' },
        { value: 'meshy-5', label: 'Meshy 5 — cheaper' },
    ],
};

function GenerateDialog({
    open,
    onOpenChange,
    ai,
    extraClips,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    ai: Props['ai'];
    extraClips: string[];
}) {
    const id = useId();
    const form = useForm({
        prompt: '',
        name: '',
        style: 30,
        height: 1.8,
        route: 'text' as 'text' | 'image',
        model: 'meshy-6',
        extra_clips: true,
    });
    const errors = form.errors as Partial<Record<string, string>>;
    const missing = !ai.meshy_configured
        ? 'Meshy'
        : form.data.route === 'image' && !ai.configured
          ? 'OpenRouter'
          : null;
    const cheap = form.data.model === 'meshy-5';
    const credits =
        (cheap ? 15 : 30) +
        5 +
        (form.data.extra_clips ? extraClips.length * 3 : 0);

    const submit = (e: FormEvent) => {
        e.preventDefault();
        form.submit(characters.generate(), {
            preserveScroll: true,
            onSuccess: () => {
                form.reset('prompt', 'name');
                refreshAiCredits();
                onOpenChange(false);
            },
        });
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[94vh] overflow-y-auto sm:max-w-xl">
                <form onSubmit={submit} className="grid gap-5">
                    <DialogHeader>
                        <DialogTitle>Generate a character</DialogTitle>
                        <DialogDescription>
                            Meshy builds a textured model in an A-pose, rigs a
                            skeleton (walk and run included) and adds idle, jump
                            and swim animations. Takes about 5–10 minutes.
                        </DialogDescription>
                    </DialogHeader>

                    {missing && (
                        <div className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
                            <Info className="mt-0.5 size-4 shrink-0 text-amber-600" />
                            <p>
                                Add a {missing} API key under{' '}
                                <Link
                                    href={aiSettings.edit()}
                                    className="font-medium underline underline-offset-2"
                                >
                                    Settings → AI
                                </Link>
                                .
                            </p>
                        </div>
                    )}

                    <div className="grid gap-2">
                        <Label htmlFor={`${id}-prompt`}>
                            Describe the character
                        </Label>
                        <Textarea
                            id={`${id}-prompt`}
                            rows={3}
                            maxLength={500}
                            required
                            value={form.data.prompt}
                            onChange={(e) =>
                                form.setData('prompt', e.target.value)
                            }
                            placeholder="A river guide in a waxed green jacket, rolled-up trousers and rubber boots, short beard"
                        />
                        <InputError message={errors.prompt ?? errors.ai} />
                    </div>

                    <StyleSlider
                        value={form.data.style}
                        onChange={(v) => form.setData('style', v)}
                    />

                    <div className="grid gap-4 sm:grid-cols-2">
                        <div className="grid gap-2">
                            <Label htmlFor={`${id}-name`}>
                                Name (optional)
                            </Label>
                            <Input
                                id={`${id}-name`}
                                maxLength={60}
                                value={form.data.name}
                                onChange={(e) =>
                                    form.setData('name', e.target.value)
                                }
                            />
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor={`${id}-height`}>Height (m)</Label>
                            <Input
                                id={`${id}-height`}
                                type="number"
                                step="0.01"
                                min={0.5}
                                max={4}
                                value={form.data.height}
                                onChange={(e) =>
                                    form.setData(
                                        'height',
                                        Number(e.target.value),
                                    )
                                }
                            />
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor={`${id}-route`}>Built from</Label>
                            <Select
                                value={form.data.route}
                                onValueChange={(v) =>
                                    form.setData((d) => ({
                                        ...d,
                                        route: v as 'text' | 'image',
                                        model: MODELS[v as 'text' | 'image'][0]
                                            .value,
                                    }))
                                }
                            >
                                <SelectTrigger id={`${id}-route`}>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="text">
                                        <Sparkles />
                                        Text → 3D (Meshy)
                                    </SelectItem>
                                    <SelectItem value="image">
                                        <Image />
                                        Concept image → 3D
                                    </SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor={`${id}-model`}>Meshy model</Label>
                            <Select
                                value={form.data.model}
                                onValueChange={(v) => form.setData('model', v)}
                            >
                                <SelectTrigger id={`${id}-model`}>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {MODELS[form.data.route].map((m) => (
                                        <SelectItem
                                            key={m.value}
                                            value={m.value}
                                        >
                                            {m.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    </div>

                    <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
                        <div className="space-y-1">
                            <Label htmlFor={`${id}-clips`}>
                                Extra animations ({extraClips.join(', ')})
                            </Label>
                            <p className="text-xs text-muted-foreground">
                                Walk and run come with the rig. The extras cost
                                about 3 credits each; without them the game
                                reuses the closest clip.
                            </p>
                        </div>
                        <Switch
                            id={`${id}-clips`}
                            checked={form.data.extra_clips}
                            onCheckedChange={(v) =>
                                form.setData('extra_clips', v)
                            }
                        />
                    </div>

                    <DialogFooter className="flex-wrap items-center gap-2 sm:justify-between">
                        <div className="grid gap-1 text-xs text-muted-foreground">
                            <span>
                                Cost: ≈{credits} Meshy credits
                                {form.data.route === 'image'
                                    ? ` + 1 image from ${ai.image_model}`
                                    : ''}
                            </span>
                            <AiCreditsBadge
                                providers={
                                    form.data.route === 'image'
                                        ? ['meshy', 'openrouter']
                                        : ['meshy']
                                }
                            />
                        </div>
                        <Button
                            type="submit"
                            disabled={form.processing || missing !== null}
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

function UploadDialog({
    open,
    onOpenChange,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const id = useId();
    const fileRef = useRef<HTMLInputElement>(null);
    const form = useForm<{ model: File | null; name: string; height: number }>({
        model: null,
        name: '',
        height: 1.8,
    });
    const errors = form.errors as Partial<Record<string, string>>;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <form
                    className="grid gap-5"
                    onSubmit={(e) => {
                        e.preventDefault();
                        form.submit(characters.upload(), {
                            forceFormData: true,
                            onSuccess: () => {
                                form.reset();
                                onOpenChange(false);
                            },
                        });
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>Upload a character</DialogTitle>
                        <DialogDescription>
                            A rigged binary glTF (.glb). Animation clips named
                            idle, walk, run, jump and swim are used; missing
                            ones fall back to the closest clip.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-2">
                        <input
                            ref={fileRef}
                            type="file"
                            accept=".glb,model/gltf-binary"
                            className="sr-only"
                            aria-label="Choose a .glb"
                            onChange={(e) => {
                                const file = e.target.files?.[0] ?? null;
                                form.setData((d) => ({
                                    ...d,
                                    model: file,
                                    name:
                                        d.name ||
                                        (file?.name.replace(/\.glb$/i, '') ??
                                            ''),
                                }));
                            }}
                        />
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => fileRef.current?.click()}
                        >
                            <Upload />
                            {form.data.model?.name ?? 'Choose .glb'}
                        </Button>
                        <InputError message={errors.model} />
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                        <div className="grid gap-2">
                            <Label htmlFor={`${id}-name`}>Name</Label>
                            <Input
                                id={`${id}-name`}
                                required
                                maxLength={60}
                                value={form.data.name}
                                onChange={(e) =>
                                    form.setData('name', e.target.value)
                                }
                            />
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor={`${id}-height`}>Height (m)</Label>
                            <Input
                                id={`${id}-height`}
                                type="number"
                                step="0.01"
                                min={0.5}
                                max={4}
                                value={form.data.height}
                                onChange={(e) =>
                                    form.setData(
                                        'height',
                                        Number(e.target.value),
                                    )
                                }
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button
                            type="submit"
                            disabled={form.processing || !form.data.model}
                        >
                            {form.processing ? <Spinner /> : <Upload />}
                            Upload
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

CharactersIndex.layout = {
    breadcrumbs: [{ title: 'Characters', href: characters.index() }],
};
