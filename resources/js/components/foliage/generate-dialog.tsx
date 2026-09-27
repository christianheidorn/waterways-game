import { Link, useForm } from '@inertiajs/react';
import type { FoliageKind } from '@game/shared/types';
import { Info, Sparkles } from 'lucide-react';
import type { FormEvent } from 'react';
import { useId } from 'react';
import { KindSelect, StyleSlider } from '@/components/foliage/fields';
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
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { KIND_HEIGHT } from '@/lib/foliage';
import aiSettings from '@/routes/ai-settings';
import foliage from '@/routes/foliage';

type GenerateForm = {
    prompt: string;
    name: string;
    kind: FoliageKind;
    style: number;
    target_height: number;
    variants: number;
};

const EXAMPLES: Partial<Record<FoliageKind, string>> = {
    grass: 'Dry golden steppe grass with seed heads',
    flower: 'Purple heather in bloom',
    reed: 'Common reed (Phragmites) with feathery brown plumes',
    bush: 'Mediterranean rosemary shrub with small blue flowers',
    broadleaf: 'Young silver birch with white bark and light green leaves',
    conifer: 'Slender Scots pine with orange upper bark',
    palm: 'Date palm with a dense crown of grey-green fronds',
};

/**
 * Generate foliage "cards" with an OpenRouter image model: one plant image, baked into crossed
 * alpha-tested quads — the classic technique for grass, flowers and shrubs.
 */
export function FoliageGenerateDialog({
    open,
    onOpenChange,
    kinds,
    aiConfigured,
    imageModel,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    kinds: KindOption[];
    aiConfigured: boolean;
    imageModel: string;
}) {
    const id = useId();
    const form = useForm<GenerateForm>({
        prompt: '',
        name: '',
        kind: 'grass',
        style: 20,
        target_height: KIND_HEIGHT.grass,
        variants: 1,
    });
    const errors = form.errors as Partial<Record<string, string>>;

    const submit = (e: FormEvent) => {
        e.preventDefault();
        form.submit(foliage.assets.generate(), {
            preserveScroll: true,
            onSuccess: () => {
                form.reset('prompt', 'name');
                onOpenChange(false);
            },
        });
    };

    const tree = ['broadleaf', 'conifer', 'palm'].includes(form.data.kind);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <form onSubmit={submit} className="grid gap-5">
                    <DialogHeader>
                        <DialogTitle>Generate foliage with AI</DialogTitle>
                        <DialogDescription>
                            An image model paints one plant, which is cut out
                            and baked into crossed cards: the classic game
                            technique for grass, flowers, reeds and shrubs.
                        </DialogDescription>
                    </DialogHeader>

                    {!aiConfigured && (
                        <div className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
                            <Info className="mt-0.5 size-4 shrink-0 text-amber-600" />
                            <p>
                                Add an OpenRouter API key under{' '}
                                <Link
                                    href={aiSettings.edit()}
                                    className="font-medium underline underline-offset-2"
                                >
                                    Settings → AI
                                </Link>{' '}
                                first.
                            </p>
                        </div>
                    )}

                    <div className="grid gap-4 sm:grid-cols-2">
                        <KindSelect
                            label="Kind"
                            kinds={kinds}
                            exclude={['rock']}
                            value={form.data.kind}
                            onChange={(v) => {
                                const kind = v as FoliageKind;
                                form.setData((d) => ({
                                    ...d,
                                    kind,
                                    target_height: KIND_HEIGHT[kind],
                                }));
                            }}
                        />
                        <div className="grid gap-2">
                            <Label htmlFor={`${id}-height`}>Real height</Label>
                            <div className="relative">
                                <Input
                                    id={`${id}-height`}
                                    type="number"
                                    step="any"
                                    min={0.05}
                                    max={80}
                                    required
                                    value={form.data.target_height}
                                    onChange={(e) =>
                                        form.setData(
                                            'target_height',
                                            Number(e.target.value),
                                        )
                                    }
                                    className="pr-8 tabular-nums"
                                />
                                <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs text-muted-foreground">
                                    m
                                </span>
                            </div>
                            <InputError message={errors.target_height} />
                        </div>
                    </div>
                    <InputError message={errors.kind} />

                    <div className="grid gap-2">
                        <Label htmlFor={`${id}-prompt`}>
                            Describe the plant
                        </Label>
                        <Textarea
                            id={`${id}-prompt`}
                            value={form.data.prompt}
                            onChange={(e) =>
                                form.setData('prompt', e.target.value)
                            }
                            required
                            rows={3}
                            maxLength={1000}
                            placeholder={EXAMPLES[form.data.kind]}
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
                                value={form.data.name}
                                maxLength={80}
                                onChange={(e) =>
                                    form.setData('name', e.target.value)
                                }
                                placeholder="From the description"
                            />
                        </div>
                        <div className="grid gap-2">
                            <Label>Variants</Label>
                            <ToggleGroup
                                type="single"
                                variant="outline"
                                value={String(form.data.variants)}
                                onValueChange={(v) =>
                                    v && form.setData('variants', Number(v))
                                }
                                className="w-full"
                            >
                                {[1, 2, 3, 4].map((n) => (
                                    <ToggleGroupItem
                                        key={n}
                                        value={String(n)}
                                        className="flex-1"
                                    >
                                        {n}
                                    </ToggleGroupItem>
                                ))}
                            </ToggleGroup>
                        </div>
                    </div>

                    <p className="rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground">
                        {tree
                            ? 'Card trees look good from a distance and in stylized worlds, but flat up close. For hero trees prefer a 3D model (Poly Haven or an upload). '
                            : ''}
                        Each variant is one image from {imageModel}, charged to
                        your OpenRouter credits. Models that support transparent
                        backgrounds are cut out perfectly; for the others a
                        plain white background is keyed out.
                    </p>

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
                            disabled={form.processing || !aiConfigured}
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
