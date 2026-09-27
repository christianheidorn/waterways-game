import { useForm } from '@inertiajs/react';
import { Sparkles, WandSparkles } from 'lucide-react';
import type { FormEvent } from 'react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import InputError from '@/components/input-error';
import { CategorySelect, Segmented } from '@/components/materials/fields';
import { NotConfigured } from '@/components/materials/material-detail';
import { useAiModels } from '@/components/materials/use-ai-models';
import { SliderField } from '@/components/slider-field';
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
import { apiFetch, errorMessage } from '@/lib/api';
import { materialApi } from '@/lib/materials';
import materials from '@/routes/materials';
import type { AiConfig, AiImageResolution, CategoryOption } from '@/types';

type Props = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    categories: CategoryOption[];
    ai: AiConfig;
    /** Pre-filled prompt / category (e.g. from an AI layer suggestion). */
    initialPrompt?: string;
    initialCategory?: string;
};

type GenerateForm = {
    prompt: string;
    category: string;
    tile_size: number;
    variants: number;
    model: string;
    resolution: AiImageResolution;
    enhance: boolean;
};

export const PROMPT_EXAMPLES: { prompt: string; category: string }[] = [
    { prompt: 'wet river gravel with moss', category: 'gravel' },
    {
        prompt: 'sun-baked red desert sand with small pebbles',
        category: 'sand',
    },
    { prompt: 'alpine meadow grass with tiny flowers', category: 'grass' },
    { prompt: 'dark volcanic basalt rock', category: 'rock' },
    {
        prompt: 'muddy forest floor with pine needles and cones',
        category: 'forest',
    },
];

/** Generate new seamless PBR materials from a text prompt via OpenRouter. */
export function GenerateDialog({
    open,
    onOpenChange,
    categories,
    ai,
    initialPrompt = '',
    initialCategory,
}: Props) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
                {open && (
                    <GenerateBody
                        categories={categories}
                        ai={ai}
                        initialPrompt={initialPrompt}
                        initialCategory={initialCategory}
                        onDone={() => onOpenChange(false)}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}

function GenerateBody({
    categories,
    ai,
    initialPrompt,
    initialCategory,
    onDone,
}: {
    categories: CategoryOption[];
    ai: AiConfig;
    initialPrompt: string;
    initialCategory?: string;
    onDone: () => void;
}) {
    const id = useId();
    const { models, loading: modelsLoading } = useAiModels(ai.configured);
    const [enhancing, setEnhancing] = useState(false);
    const form = useForm<GenerateForm>({
        prompt: initialPrompt,
        category: initialCategory ?? 'other',
        tile_size: 2,
        variants: 2,
        model: ai.image_model,
        resolution: ai.image_resolution,
        enhance: true,
    });
    const errors = form.errors as Partial<Record<string, string>>;

    const imageModels = models?.image ?? [];
    const selectedModel = imageModels.find((m) => m.id === form.data.model);
    const modelOptions =
        selectedModel || !form.data.model
            ? imageModels
            : [...imageModels, { id: form.data.model, name: form.data.model }];
    const resolutions = selectedModel?.resolutions?.length
        ? selectedModel.resolutions
        : ['1K', '2K'];

    const improvePrompt = async () => {
        if (!form.data.prompt.trim()) {
            return;
        }

        setEnhancing(true);

        try {
            const res = await apiFetch<{ prompt: string }>(
                materialApi.enhancePrompt(),
                {
                    method: 'POST',
                    body: {
                        prompt: form.data.prompt,
                        category: form.data.category,
                    },
                },
            );
            form.setData('prompt', res.prompt);
        } catch (e) {
            toast.error(`Could not improve the prompt: ${errorMessage(e)}`);
        } finally {
            setEnhancing(false);
        }
    };

    const submit = (e: FormEvent) => {
        e.preventDefault();
        form.transform((data) => ({
            ...data,
            model: data.model || undefined,
        }));
        form.submit(materials.generate(), {
            preserveScroll: true,
            onSuccess: onDone,
        });
    };

    return (
        <form onSubmit={submit} className="grid gap-6">
            <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                    <Sparkles className="size-4 text-violet-500" />
                    Generate with AI
                </DialogTitle>
                <DialogDescription>
                    Describe a ground surface. The AI paints a seamless albedo
                    texture; normal, roughness, AO and height maps are derived
                    from it.
                </DialogDescription>
            </DialogHeader>

            {!ai.configured ? (
                <NotConfigured />
            ) : (
                <>
                    <div className="grid gap-2">
                        <div className="flex items-center justify-between gap-2">
                            <Label htmlFor={`${id}-prompt`}>Prompt</Label>
                            <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="h-7 text-violet-700 hover:text-violet-800 dark:text-violet-300"
                                disabled={enhancing || !form.data.prompt.trim()}
                                onClick={improvePrompt}
                            >
                                {enhancing ? <Spinner /> : <WandSparkles />}
                                Improve prompt
                            </Button>
                        </div>
                        <Textarea
                            id={`${id}-prompt`}
                            value={form.data.prompt}
                            onChange={(e) =>
                                form.setData('prompt', e.target.value)
                            }
                            rows={4}
                            maxLength={1000}
                            required
                            placeholder="Describe the surface, e.g. wet river gravel with moss"
                            aria-invalid={errors.prompt ? true : undefined}
                        />
                        <InputError message={errors.prompt ?? errors.ai} />
                        <div
                            className="flex flex-wrap gap-1.5"
                            aria-label="Example prompts"
                        >
                            {PROMPT_EXAMPLES.map((ex) => (
                                <button
                                    key={ex.prompt}
                                    type="button"
                                    onClick={() =>
                                        form.setData((prev) => ({
                                            ...prev,
                                            prompt: ex.prompt,
                                            category: categories.some(
                                                (c) => c.value === ex.category,
                                            )
                                                ? ex.category
                                                : prev.category,
                                        }))
                                    }
                                    className="rounded-full border bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                                >
                                    {ex.prompt}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                        <CategorySelect
                            categories={categories}
                            value={form.data.category}
                            onChange={(v) => form.setData('category', v)}
                            error={errors.category}
                        />
                        <Segmented
                            label="Variants"
                            value={form.data.variants}
                            options={[1, 2, 3, 4].map((n) => ({
                                value: n,
                                label: String(n),
                            }))}
                            onChange={(v) => form.setData('variants', v)}
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
                        description="Real-world size of one texture repeat."
                        error={errors.tile_size}
                    />

                    <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
                        <div className="grid content-start gap-2">
                            <Label htmlFor={`${id}-model`}>Image model</Label>
                            <Select
                                value={form.data.model}
                                onValueChange={(v) => form.setData('model', v)}
                                disabled={modelsLoading && !models}
                            >
                                <SelectTrigger
                                    id={`${id}-model`}
                                    className="w-full"
                                >
                                    {modelsLoading && !models ? (
                                        <span className="flex items-center gap-2 text-muted-foreground">
                                            <Spinner /> Loading models…
                                        </span>
                                    ) : (
                                        <SelectValue placeholder="Default model" />
                                    )}
                                </SelectTrigger>
                                <SelectContent>
                                    {modelOptions.map((m) => (
                                        <SelectItem key={m.id} value={m.id}>
                                            {m.name}
                                            {'resolutions' in m &&
                                                m.resolutions?.length && (
                                                    <span className="text-xs text-muted-foreground">
                                                        {m.resolutions.join(
                                                            ' / ',
                                                        )}
                                                    </span>
                                                )}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <InputError message={errors.model} />
                        </div>
                        <Segmented
                            label="Resolution"
                            value={form.data.resolution}
                            options={(['1K', '2K'] as const)
                                .filter((r) => resolutions.includes(r))
                                .map((r) => ({ value: r, label: r }))}
                            onChange={(v) => form.setData('resolution', v)}
                            className="sm:w-32"
                        />
                    </div>

                    <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
                        <div className="space-y-1">
                            <Label htmlFor={`${id}-enhance`}>
                                Enhance prompt automatically
                            </Label>
                            <p className="text-xs text-muted-foreground">
                                Adds texture-specific instructions (top-down,
                                evenly lit, seamless) before sending it to the
                                image model.
                            </p>
                        </div>
                        <Switch
                            id={`${id}-enhance`}
                            checked={form.data.enhance}
                            onCheckedChange={(v) => form.setData('enhance', v)}
                        />
                    </div>

                    <p className="text-xs text-muted-foreground">
                        Costs are charged to your OpenRouter credits
                        {selectedModel?.pricing
                            ? ` (${formatPricing(selectedModel.pricing)} per image)`
                            : ''}
                        .
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
                    className="bg-violet-600 text-white hover:bg-violet-600/90 dark:bg-violet-500 dark:hover:bg-violet-500/90"
                >
                    {form.processing ? <Spinner /> : <Sparkles />}
                    Generate {form.data.variants > 1 ? form.data.variants : ''}
                </Button>
            </DialogFooter>
        </form>
    );
}

function formatPricing(
    pricing: Record<string, string | number> | string,
): string {
    if (typeof pricing === 'string') {
        return pricing;
    }

    const value =
        pricing.image ?? pricing.per_image ?? Object.values(pricing)[0];

    if (value === undefined) {
        return '';
    }

    const n = Number(value);

    return Number.isFinite(n) ? `~$${n.toFixed(3)}` : String(value);
}
