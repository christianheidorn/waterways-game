import { useForm } from '@inertiajs/react';
import { FileArchive, Upload, X } from 'lucide-react';
import type { FormEvent } from 'react';
import { useId, useRef } from 'react';
import { KindSelect } from '@/components/foliage/fields';
import type { KindOption } from '@/components/foliage/fields';
import InputError from '@/components/input-error';
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
import foliage from '@/routes/foliage';

type UploadForm = {
    files: File[];
    kind: string;
    style: 'realistic' | 'stylized';
    target_height: string;
    license: string;
};

/** Upload .glb / .gltf models or a .zip nature kit (e.g. Quaternius, Kenney). */
export function FoliageUploadDialog({
    open,
    onOpenChange,
    kinds,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    kinds: KindOption[];
}) {
    const id = useId();
    const fileRef = useRef<HTMLInputElement>(null);
    const form = useForm<UploadForm>({
        files: [],
        kind: 'auto',
        style: 'realistic',
        target_height: '',
        license: '',
    });
    const errors = form.errors as Partial<Record<string, string>>;
    const fileError =
        errors.files ??
        Object.entries(errors).find(([k]) => k.startsWith('files.'))?.[1];
    const single =
        form.data.files.length === 1 &&
        !form.data.files[0].name.toLowerCase().endsWith('.zip');

    const submit = (e: FormEvent) => {
        e.preventDefault();
        form.transform((data) => ({
            files: data.files,
            kind: data.kind === 'auto' ? '' : data.kind,
            style: data.style,
            target_height: data.target_height,
            license: data.license,
        }));
        form.submit(foliage.assets.upload(), {
            forceFormData: true,
            preserveScroll: true,
            onSuccess: () => {
                form.reset();
                onOpenChange(false);
            },
        });
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <form onSubmit={submit} className="grid gap-5">
                    <DialogHeader>
                        <DialogTitle>Upload foliage models</DialogTitle>
                        <DialogDescription>
                            Binary glTF (.glb), self-contained .gltf, or a .zip
                            containing many glTF / GLB models, such as the free
                            CC0 nature kits from{' '}
                            <a
                                href="https://quaternius.com"
                                target="_blank"
                                rel="noreferrer"
                                className="font-medium underline underline-offset-2"
                            >
                                Quaternius
                            </a>{' '}
                            or{' '}
                            <a
                                href="https://kenney.nl/assets/nature-kit"
                                target="_blank"
                                rel="noreferrer"
                                className="font-medium underline underline-offset-2"
                            >
                                Kenney
                            </a>
                            . Every model becomes a library asset and is then
                            optimised in this browser.
                        </DialogDescription>
                    </DialogHeader>

                    <div className="grid gap-2">
                        <input
                            ref={fileRef}
                            type="file"
                            multiple
                            accept=".glb,.gltf,.zip,model/gltf-binary,model/gltf+json,application/zip"
                            className="sr-only"
                            aria-label="Choose model files"
                            onChange={(e) =>
                                form.setData(
                                    'files',
                                    Array.from(e.target.files ?? []),
                                )
                            }
                        />
                        <button
                            type="button"
                            onClick={() => fileRef.current?.click()}
                            className="flex flex-col items-center gap-2 rounded-xl border border-dashed p-6 text-center text-sm transition hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        >
                            <FileArchive className="size-6 text-muted-foreground" />
                            {form.data.files.length === 0 ? (
                                <span>
                                    Choose .glb, .gltf or .zip files (max 300 MB
                                    each)
                                </span>
                            ) : (
                                <span className="font-medium">
                                    {form.data.files.length === 1
                                        ? form.data.files[0].name
                                        : `${form.data.files.length} files`}
                                </span>
                            )}
                        </button>
                        {form.data.files.length > 0 && (
                            <ul className="grid max-h-28 gap-1 overflow-y-auto text-xs text-muted-foreground">
                                {form.data.files.map((f, i) => (
                                    <li
                                        key={`${f.name}-${i}`}
                                        className="flex items-center gap-2"
                                    >
                                        <span className="flex-1 truncate">
                                            {f.name}
                                        </span>
                                        <span className="tabular-nums">
                                            {(f.size / 1048576).toFixed(1)} MB
                                        </span>
                                        <button
                                            type="button"
                                            aria-label={`Remove ${f.name}`}
                                            onClick={() =>
                                                form.setData(
                                                    'files',
                                                    form.data.files.filter(
                                                        (_, j) => j !== i,
                                                    ),
                                                )
                                            }
                                        >
                                            <X className="size-3.5" />
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                        <InputError message={fileError} />
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                        <KindSelect
                            label="Kind"
                            kinds={[
                                {
                                    value: 'auto' as never,
                                    label: 'Detect from name',
                                },
                                ...kinds,
                            ]}
                            value={form.data.kind}
                            onChange={(v) => form.setData('kind', v)}
                        />
                        <div className="grid gap-2">
                            <Label>Style</Label>
                            <ToggleGroup
                                type="single"
                                variant="outline"
                                value={form.data.style}
                                onValueChange={(v) =>
                                    v &&
                                    form.setData(
                                        'style',
                                        v as UploadForm['style'],
                                    )
                                }
                                className="w-full"
                            >
                                <ToggleGroupItem
                                    value="realistic"
                                    className="flex-1"
                                >
                                    Realistic
                                </ToggleGroupItem>
                                <ToggleGroupItem
                                    value="stylized"
                                    className="flex-1"
                                >
                                    Stylized
                                </ToggleGroupItem>
                            </ToggleGroup>
                        </div>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                        <div className="grid gap-2">
                            <Label htmlFor={`${id}-height`}>
                                Real height (optional)
                            </Label>
                            <div className="relative">
                                <Input
                                    id={`${id}-height`}
                                    type="number"
                                    step="any"
                                    min={0.02}
                                    max={150}
                                    inputMode="decimal"
                                    placeholder={
                                        single
                                            ? 'Keep model size'
                                            : 'Keep each size'
                                    }
                                    value={form.data.target_height}
                                    onChange={(e) =>
                                        form.setData(
                                            'target_height',
                                            e.target.value,
                                        )
                                    }
                                    className="pr-8"
                                />
                                <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs text-muted-foreground">
                                    m
                                </span>
                            </div>
                            <InputError message={errors.target_height} />
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor={`${id}-license`}>
                                Licence (optional)
                            </Label>
                            <Input
                                id={`${id}-license`}
                                value={form.data.license}
                                maxLength={120}
                                placeholder="e.g. CC0"
                                onChange={(e) =>
                                    form.setData('license', e.target.value)
                                }
                            />
                        </div>
                    </div>

                    {form.progress && (
                        <Progress value={form.progress.percentage} />
                    )}

                    <DialogFooter>
                        <Button
                            type="button"
                            variant="ghost"
                            onClick={() => onOpenChange(false)}
                        >
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            disabled={
                                form.processing || form.data.files.length === 0
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
