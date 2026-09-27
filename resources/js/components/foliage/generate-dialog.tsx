import { Link, useForm } from '@inertiajs/react';
import type { FoliageKind } from '@game/shared/types';
import { Box, Image, Info, Sparkles, SquareStack } from 'lucide-react';
import type { FormEvent, ReactNode } from 'react';
import { useId } from 'react';
import { AiCreditsBadge, refreshAiCredits } from '@/components/ai-credits';
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
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { KIND_HEIGHT } from '@/lib/foliage';
import { cn } from '@/lib/utils';
import aiSettings from '@/routes/ai-settings';
import foliage from '@/routes/foliage';

type Engine = 'meshy_text' | 'meshy_image' | 'card';

type GenerateForm = {
    engine: Engine;
    prompt: string;
    name: string;
    kind: FoliageKind;
    style: number;
    /** '' = let Meshy estimate the real size. */
    target_height: string;
    variants: number;
    meshy_model: string;
};

const EXAMPLES: Record<FoliageKind, string> = {
    grass: 'Dry golden steppe grass with seed heads',
    flower: 'Purple heather in bloom',
    reed: 'Common reed (Phragmites) with feathery brown plumes',
    bush: 'Mediterranean rosemary shrub with small blue flowers',
    broadleaf: 'Mature English oak with a broad crown and furrowed bark',
    conifer: 'Scots pine with orange upper bark and a flat crown',
    palm: 'Date palm with a dense crown of grey-green fronds',
    rock: 'Weathered granite boulder with patches of lichen',
};

/** Meshy models per engine with their approximate cost (textured model). */
const MESHY_MODELS: Record<
    'meshy_text' | 'meshy_image',
    { value: string; label: string; credits: number }[]
> = {
    meshy_text: [
        { value: 'meshy-6', label: 'Meshy 6 — best quality', credits: 30 },
        { value: 'meshy-5', label: 'Meshy 5 — cheaper', credits: 15 },
    ],
    meshy_image: [
        {
            value: 'latest',
            label: 'Meshy 7 (latest) — best quality',
            credits: 30,
        },
        { value: 'meshy-6', label: 'Meshy 6', credits: 30 },
        { value: 'meshy-5', label: 'Meshy 5 — cheaper', credits: 15 },
    ],
};

const ENGINES: {
    value: Engine;
    icon: typeof Box;
    title: string;
    blurb: string;
}[] = [
    {
        value: 'meshy_text',
        icon: Box,
        title: 'Meshy 3D',
        blurb: 'Text → textured 3D model. Trees, shrubs, rocks.',
    },
    {
        value: 'meshy_image',
        icon: Image,
        title: 'Concept → Meshy 3D',
        blurb: 'OpenRouter paints a concept, Meshy builds it. More control.',
    },
    {
        value: 'card',
        icon: SquareStack,
        title: 'Plant card',
        blurb: 'One image as crossed cards. Grass, flowers, reeds.',
    },
];

/**
 * AI foliage generation: Meshy 3D models (from text, or from an OpenRouter concept image) or flat
 * plant "cards" from one OpenRouter image. Every result is optimised in the browser afterwards.
 */
export function FoliageGenerateDialog({
    open,
    onOpenChange,
    kinds,
    aiConfigured,
    meshyConfigured,
    imageModel,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    kinds: KindOption[];
    aiConfigured: boolean;
    meshyConfigured: boolean;
    imageModel: string;
}) {
    const id = useId();
    const form = useForm<GenerateForm>({
        engine: meshyConfigured ? 'meshy_text' : 'card',
        prompt: '',
        name: '',
        kind: 'broadleaf',
        style: 20,
        target_height: String(KIND_HEIGHT.broadleaf),
        variants: 1,
        meshy_model: 'meshy-6',
    });
    const errors = form.errors as Partial<Record<string, string>>;
    const { engine } = form.data;
    const meshy = engine !== 'card';
    const models = meshy ? MESHY_MODELS[engine] : [];
    const model = models.find((m) => m.value === form.data.meshy_model);
    const missing =
        (meshy && !meshyConfigured
            ? 'Meshy'
            : engine !== 'meshy_text' && !aiConfigured
              ? 'OpenRouter'
              : null) ?? null;

    const setEngine = (value: Engine) =>
        form.setData((d) => ({
            ...d,
            engine: value,
            kind: value === 'card' && d.kind === 'rock' ? 'grass' : d.kind,
            meshy_model:
                value === 'card'
                    ? d.meshy_model
                    : MESHY_MODELS[value].some((m) => m.value === d.meshy_model)
                      ? d.meshy_model
                      : MESHY_MODELS[value][0].value,
        }));

    const submit = (e: FormEvent) => {
        e.preventDefault();
        form.transform((d) => ({
            ...d,
            target_height:
                d.target_height === '' ? null : Number(d.target_height),
            meshy_model: meshy ? d.meshy_model : null,
        }));
        form.submit(foliage.assets.generate(), {
            preserveScroll: true,
            onSuccess: () => {
                form.reset('prompt', 'name');
                refreshAiCredits();
                onOpenChange(false);
            },
        });
    };

    const cost = meshy
        ? `≈${(model?.credits ?? 30) * form.data.variants} Meshy credits${engine === 'meshy_image' ? ` + ${form.data.variants} OpenRouter image${form.data.variants > 1 ? 's' : ''}` : ''}`
        : `${form.data.variants} image${form.data.variants > 1 ? 's' : ''} from ${imageModel} (OpenRouter)`;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[94vh] overflow-y-auto sm:max-w-2xl">
                <form onSubmit={submit} className="grid gap-5">
                    <DialogHeader>
                        <DialogTitle>Generate foliage with AI</DialogTitle>
                        <DialogDescription>
                            Results land in the asset library and are optimised
                            for the game (LODs, impostor) in this browser.
                        </DialogDescription>
                    </DialogHeader>

                    <div
                        role="radiogroup"
                        aria-label="Generator"
                        className="grid gap-2 sm:grid-cols-3"
                    >
                        {ENGINES.map((e) => {
                            const Icon = e.icon;
                            const selected = engine === e.value;

                            return (
                                <button
                                    key={e.value}
                                    type="button"
                                    role="radio"
                                    aria-checked={selected}
                                    onClick={() => setEngine(e.value)}
                                    className={cn(
                                        'grid gap-1 rounded-xl border p-3 text-left text-sm transition hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                                        selected &&
                                            'border-primary bg-primary/5 ring-1 ring-primary',
                                    )}
                                >
                                    <span className="flex items-center gap-1.5 font-medium">
                                        <Icon className="size-4" />
                                        {e.title}
                                    </span>
                                    <span className="text-xs text-muted-foreground">
                                        {e.blurb}
                                    </span>
                                </button>
                            );
                        })}
                    </div>

                    {missing && (
                        <Notice>
                            Add a {missing} API key under{' '}
                            <Link
                                href={aiSettings.edit()}
                                className="font-medium underline underline-offset-2"
                            >
                                Settings → AI
                            </Link>{' '}
                            to use this generator.
                        </Notice>
                    )}

                    <div className="grid gap-4 sm:grid-cols-2">
                        <KindSelect
                            label="Kind"
                            kinds={kinds}
                            exclude={engine === 'card' ? ['rock'] : []}
                            value={form.data.kind}
                            onChange={(v) => {
                                const kind = v as FoliageKind;
                                form.setData((d) => ({
                                    ...d,
                                    kind,
                                    target_height:
                                        d.engine === 'card' ||
                                        d.target_height !== ''
                                            ? String(KIND_HEIGHT[kind])
                                            : '',
                                }));
                            }}
                        />
                        <div className="grid gap-2">
                            <Label htmlFor={`${id}-height`}>
                                Real height {meshy && '(optional)'}
                            </Label>
                            <div className="relative">
                                <Input
                                    id={`${id}-height`}
                                    type="number"
                                    step="any"
                                    min={0.05}
                                    max={80}
                                    required={!meshy}
                                    placeholder={
                                        meshy ? 'Estimated by Meshy' : undefined
                                    }
                                    value={form.data.target_height}
                                    onChange={(e) =>
                                        form.setData(
                                            'target_height',
                                            e.target.value,
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
                            Describe the {meshy ? 'model' : 'plant'}
                        </Label>
                        <Textarea
                            id={`${id}-prompt`}
                            value={form.data.prompt}
                            onChange={(e) =>
                                form.setData('prompt', e.target.value)
                            }
                            required
                            rows={3}
                            maxLength={600}
                            placeholder={EXAMPLES[form.data.kind]}
                        />
                        <InputError
                            message={
                                errors.prompt ?? errors.ai ?? errors.engine
                            }
                        />
                    </div>

                    <StyleSlider
                        value={form.data.style}
                        onChange={(v) => form.setData('style', v)}
                    />

                    <div className="grid gap-4 sm:grid-cols-2">
                        {meshy ? (
                            <div className="grid gap-2">
                                <Label htmlFor={`${id}-model`}>
                                    Meshy model
                                </Label>
                                <Select
                                    value={form.data.meshy_model}
                                    onValueChange={(v) =>
                                        form.setData('meshy_model', v)
                                    }
                                >
                                    <SelectTrigger
                                        id={`${id}-model`}
                                        className="w-full"
                                    >
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {models.map((m) => (
                                            <SelectItem
                                                key={m.value}
                                                value={m.value}
                                            >
                                                {m.label} · ≈{m.credits} credits
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                        ) : (
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
                        )}
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
                    {meshy && (
                        <div className="grid gap-2">
                            <Label htmlFor={`${id}-name2`}>
                                Name (optional)
                            </Label>
                            <Input
                                id={`${id}-name2`}
                                value={form.data.name}
                                maxLength={80}
                                onChange={(e) =>
                                    form.setData('name', e.target.value)
                                }
                                placeholder="From the description"
                            />
                        </div>
                    )}

                    <p className="rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground">
                        {meshy
                            ? 'Meshy builds a textured, game-ready mesh in 2–5 minutes; the studio then adds LODs and an impostor. Thin grass blades come out chunky in 3D — use plant cards for grass and flowers.'
                            : 'Cards look great for grass, flowers and reeds, but flat up close for trees — use Meshy 3D for trees, shrubs and rocks.'}
                    </p>

                    <DialogFooter className="flex-wrap items-center gap-2 sm:justify-between">
                        <div className="grid gap-1 text-xs text-muted-foreground">
                            <span>Cost: {cost}</span>
                            <AiCreditsBadge
                                providers={
                                    engine === 'meshy_text'
                                        ? ['meshy']
                                        : engine === 'card'
                                          ? ['openrouter']
                                          : ['meshy', 'openrouter']
                                }
                            />
                        </div>
                        <div className="flex gap-2">
                            <Button
                                type="button"
                                variant="ghost"
                                onClick={() => onOpenChange(false)}
                            >
                                Cancel
                            </Button>
                            <Button
                                type="submit"
                                disabled={form.processing || missing !== null}
                            >
                                {form.processing ? <Spinner /> : <Sparkles />}
                                Generate
                            </Button>
                        </div>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function Notice({ children }: { children: ReactNode }) {
    return (
        <div className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
            <Info className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <p>{children}</p>
        </div>
    );
}
