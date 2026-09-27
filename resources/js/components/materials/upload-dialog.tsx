import { useForm } from '@inertiajs/react';
import { FileImage, Upload, X } from 'lucide-react';
import type { DragEvent, FormEvent } from 'react';
import { useId, useRef, useState } from 'react';
import InputError from '@/components/input-error';
import { CategorySelect } from '@/components/materials/fields';
import { SliderField } from '@/components/slider-field';
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
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { DETECTED_LABELS, detectMapType } from '@/lib/materials';
import { cn } from '@/lib/utils';
import materials from '@/routes/materials';
import type { CategoryOption } from '@/types';

type Props = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    categories: CategoryOption[];
};

type UploadForm = {
    name: string;
    category: string;
    tile_size: number;
    make_seamless: boolean;
    files: File[];
};

const ACCEPT = 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp';

const MAP_TOKEN =
    /^(albedo|basecolou?r|base|diffuse|diff|colou?r|col|normal(gl|dx)?|nor|nrm|gl|dx|rough(ness)?|ao|ambient|occlusion|ambientocclusion|height|disp(lacement)?|bump|arm|orm|\d+k)$/i;

/** "river_rock_diff_2k.jpg" → "River Rock"; "Ground054_1K-JPG_Color.jpg" → "Ground054". */
function nameFromFile(file: File): string {
    const tokens = file.name
        .replace(/\.[a-z0-9]+$/i, '')
        .split(/[_\-. ]+/)
        .filter(Boolean);
    const cut = tokens.findIndex((t) => MAP_TOKEN.test(t));
    const kept = cut > 0 ? tokens.slice(0, cut) : tokens;

    return kept
        .join(' ')
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .slice(0, 120);
}

/** Upload one or more texture maps as a new library material. */
export function UploadDialog({ open, onOpenChange, categories }: Props) {
    const id = useId();
    const inputRef = useRef<HTMLInputElement>(null);
    const [dragging, setDragging] = useState(false);
    const form = useForm<UploadForm>({
        name: '',
        category: 'other',
        tile_size: 2,
        make_seamless: false,
        files: [],
    });
    const errors = form.errors as Partial<Record<string, string>>;
    const fileError = Object.entries(errors).find(([k]) =>
        k.startsWith('files'),
    )?.[1];

    const addFiles = (list: FileList | null) => {
        if (!list?.length) {
            return;
        }

        const incoming = Array.from(list).filter((f) =>
            /\.(jpe?g|png|webp)$/i.test(f.name),
        );
        form.setData((prev) => {
            const names = new Set(prev.files.map((f) => f.name));
            const files = [
                ...prev.files,
                ...incoming.filter((f) => !names.has(f.name)),
            ].slice(0, 8);

            return {
                ...prev,
                files,
                name: prev.name || (files[0] ? nameFromFile(files[0]) : ''),
            };
        });
    };

    const removeFile = (name: string) =>
        form.setData((prev) => ({
            ...prev,
            files: prev.files.filter((f) => f.name !== name),
        }));

    const onDrop = (e: DragEvent) => {
        e.preventDefault();
        setDragging(false);
        addFiles(e.dataTransfer.files);
    };

    const detected = form.data.files.map((f) => ({
        file: f,
        ...detectMapType(f.name),
    }));
    const hasAlbedo =
        detected.some((d) => d.map === 'albedo') ||
        (detected.length === 1 && detected[0].map === null);

    const submit = (e: FormEvent) => {
        e.preventDefault();
        form.submit(materials.upload(), {
            forceFormData: true,
            preserveScroll: true,
            onSuccess: () => {
                form.reset();
                onOpenChange(false);
            },
        });
    };

    return (
        <Dialog
            open={open}
            onOpenChange={(o) => {
                if (!form.processing) {
                    onOpenChange(o);
                }
            }}
        >
            <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
                <form onSubmit={submit} className="grid gap-6">
                    <DialogHeader>
                        <DialogTitle>Upload material</DialogTitle>
                        <DialogDescription>
                            Drop the texture maps of one material. Map types are
                            detected from the file names (e.g.{' '}
                            <code className="text-xs">rock_diff.jpg</code>,{' '}
                            <code className="text-xs">rock_nor_gl.png</code>,{' '}
                            <code className="text-xs">rock_arm.jpg</code>). A
                            single image is used as albedo; missing maps are
                            derived from it.
                        </DialogDescription>
                    </DialogHeader>

                    <div className="grid gap-3">
                        <label
                            htmlFor={`${id}-files`}
                            onDragOver={(e) => {
                                e.preventDefault();
                                setDragging(true);
                            }}
                            onDragLeave={() => setDragging(false)}
                            onDrop={onDrop}
                            className={cn(
                                'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors focus-within:ring-[3px] focus-within:ring-ring/50 hover:border-foreground/30 hover:bg-muted/40',
                                dragging &&
                                    'border-sky-500 bg-sky-500/5 hover:border-sky-500',
                            )}
                        >
                            <div className="flex size-10 items-center justify-center rounded-full bg-muted">
                                <Upload className="size-5 text-muted-foreground" />
                            </div>
                            <div className="text-sm font-medium">
                                Drop images here or click to choose
                            </div>
                            <div className="text-xs text-muted-foreground">
                                JPG, PNG or WebP · up to 8 files, 20 MB each
                            </div>
                            <input
                                ref={inputRef}
                                id={`${id}-files`}
                                type="file"
                                multiple
                                accept={ACCEPT}
                                className="sr-only"
                                onChange={(e) => {
                                    addFiles(e.target.files);
                                    e.target.value = '';
                                }}
                            />
                        </label>

                        {detected.length > 0 && (
                            <ul className="divide-y rounded-lg border">
                                {detected.map(({ file, map, directX }) => (
                                    <li
                                        key={file.name}
                                        className="flex items-center gap-3 px-3 py-2 text-sm"
                                    >
                                        <FileImage className="size-4 shrink-0 text-muted-foreground" />
                                        <span className="min-w-0 flex-1 truncate">
                                            {file.name}
                                        </span>
                                        <span className="hidden text-xs text-muted-foreground tabular-nums sm:inline">
                                            {(file.size / 1024 / 1024).toFixed(
                                                1,
                                            )}{' '}
                                            MB
                                        </span>
                                        {map ? (
                                            <Badge variant="secondary">
                                                {DETECTED_LABELS[map]}
                                                {map === 'normal' &&
                                                    (directX
                                                        ? ' (DirectX)'
                                                        : ' (OpenGL)')}
                                            </Badge>
                                        ) : (
                                            <Badge
                                                variant="outline"
                                                className="text-amber-700 dark:text-amber-400"
                                                title="Rename the file (e.g. _albedo, _normal, _rough) so it can be detected"
                                            >
                                                {detected.length === 1
                                                    ? 'Albedo'
                                                    : 'Unknown'}
                                            </Badge>
                                        )}
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon"
                                            className="size-7"
                                            onClick={() =>
                                                removeFile(file.name)
                                            }
                                            aria-label={`Remove ${file.name}`}
                                        >
                                            <X />
                                        </Button>
                                    </li>
                                ))}
                            </ul>
                        )}
                        {detected.length > 1 && !hasAlbedo && (
                            <p className="text-xs text-amber-700 dark:text-amber-400">
                                No albedo / base colour map detected.
                            </p>
                        )}
                        <InputError message={fileError} />
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                        <div className="grid content-start gap-2">
                            <Label htmlFor={`${id}-name`}>Name</Label>
                            <Input
                                id={`${id}-name`}
                                value={form.data.name}
                                onChange={(e) =>
                                    form.setData('name', e.target.value)
                                }
                                maxLength={120}
                                required
                                placeholder="Mossy river stones"
                            />
                            <InputError message={errors.name} />
                        </div>
                        <CategorySelect
                            categories={categories}
                            value={form.data.category}
                            onChange={(v) => form.setData('category', v)}
                            error={errors.category}
                        />
                    </div>

                    <SliderField
                        label="Tile size"
                        value={form.data.tile_size}
                        onChange={(v) => form.setData('tile_size', v)}
                        min={0.25}
                        max={50}
                        step={0.05}
                        unit="m"
                        description="Real-world size covered by one repeat of the texture."
                        error={errors.tile_size}
                    />

                    <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
                        <div className="space-y-1">
                            <Label htmlFor={`${id}-seamless`}>
                                Make seamless
                            </Label>
                            <p className="text-xs text-muted-foreground">
                                Blend the edges so photos without tiling repeat
                                without visible seams.
                            </p>
                        </div>
                        <Switch
                            id={`${id}-seamless`}
                            checked={form.data.make_seamless}
                            onCheckedChange={(v) =>
                                form.setData('make_seamless', v)
                            }
                        />
                    </div>

                    {form.progress && (
                        <Progress value={form.progress.percentage ?? 0} />
                    )}

                    <DialogFooter className="gap-2">
                        <DialogClose asChild>
                            <Button
                                type="button"
                                variant="secondary"
                                disabled={form.processing}
                            >
                                Cancel
                            </Button>
                        </DialogClose>
                        <Button
                            type="submit"
                            disabled={
                                form.processing ||
                                form.data.files.length === 0 ||
                                !form.data.name.trim()
                            }
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
