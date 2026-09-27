import { Head, useForm } from '@inertiajs/react';
import {
    CircleCheck,
    CircleDashed,
    ExternalLink,
    Eye,
    EyeOff,
    KeyRound,
    PlugZap,
    Save,
    Trash2,
} from 'lucide-react';
import type { FormEvent } from 'react';
import { useId, useState } from 'react';
import { AiCreditsBadge, refreshAiCredits } from '@/components/ai-credits';
import { ConfirmDialog } from '@/components/confirm-dialog';
import Heading from '@/components/heading';
import InputError from '@/components/input-error';
import { Segmented } from '@/components/materials/fields';
import { useAiModels } from '@/components/materials/use-ai-models';
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
import { Spinner } from '@/components/ui/spinner';
import aiSettings from '@/routes/ai-settings';
import gameSettings from '@/routes/game-settings';
import type { AiImageResolution, AiSettings } from '@/types';

type Props = {
    settings: AiSettings;
};

type AiForm = {
    openrouter_api_key: string;
    clear_key: boolean;
    meshy_api_key: string;
    image_model: string;
    text_model: string;
    image_resolution: AiImageResolution;
};

const USES = [
    'Generate seamless PBR ground materials from a text prompt',
    'Edit existing materials ("make it wetter", "add autumn leaves")',
    'Suggest a terrain layer set for a map from its location and elevation',
    'Review a screenshot of your world and propose lighting and material tweaks',
    'Suggest a region-specific foliage palette and paint plant cards (OpenRouter)',
    'Generate textured 3D trees, shrubs and rocks (Meshy)',
];

export default function AiSettingsPage({ settings }: Props) {
    const id = useId();
    const [showKey, setShowKey] = useState(false);
    const [modelsKey, setModelsKey] = useState(0);
    const form = useForm<AiForm>({
        openrouter_api_key: '',
        clear_key: false,
        meshy_api_key: '',
        image_model: settings.image_model,
        text_model: settings.text_model,
        image_resolution: settings.image_resolution,
    });
    const clearForm = useForm({ clear_key: true });
    const clearMeshyForm = useForm({ clear_meshy_key: true });
    const [showMeshyKey, setShowMeshyKey] = useState(false);
    const testForm = useForm({});
    const { models, loading, error } = useAiModels(
        settings.configured,
        modelsKey,
    );
    const errors = form.errors as Partial<Record<keyof AiForm, string>>;

    const submit = (e: FormEvent) => {
        e.preventDefault();
        form.submit(aiSettings.update(), {
            preserveScroll: true,
            onSuccess: () => {
                form.setData((d) => ({
                    ...d,
                    openrouter_api_key: '',
                    meshy_api_key: '',
                }));
                form.setDefaults();
                refreshAiCredits();
                setModelsKey((k) => k + 1);
            },
        });
    };

    return (
        <>
            <Head title="AI settings" />
            <h1 className="sr-only">AI settings</h1>

            <div className="space-y-6">
                <Heading
                    variant="small"
                    title="AI (OpenRouter & Meshy)"
                    description="Optional. Connect OpenRouter (text and images) and Meshy (3D models) to use AI features in the studio."
                />

                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border p-3">
                    <span className="text-sm font-medium">Credits left</span>
                    <AiCreditsBadge />
                </div>

                <div className="rounded-xl border bg-muted/30 p-4 text-sm">
                    <p className="font-medium">What AI is used for</p>
                    <ul className="mt-2 grid gap-1.5 text-muted-foreground">
                        {USES.map((u) => (
                            <li key={u} className="flex gap-2">
                                <span
                                    aria-hidden
                                    className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground"
                                />
                                {u}
                            </li>
                        ))}
                    </ul>
                    <p className="mt-3 text-xs text-muted-foreground">
                        Requests go from this server to OpenRouter / Meshy and
                        are billed to your credits there. Nothing is sent unless
                        you use an AI feature.
                    </p>
                </div>

                <form onSubmit={submit} className="grid gap-6">
                    <div className="grid gap-2">
                        <div className="flex items-center justify-between gap-2">
                            <Label htmlFor={`${id}-key`}>
                                OpenRouter API key
                            </Label>
                            <a
                                href="https://openrouter.ai/keys"
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-xs font-medium text-sky-700 hover:underline dark:text-sky-400"
                            >
                                Get a key
                                <ExternalLink className="size-3" />
                            </a>
                        </div>
                        <div className="flex items-center gap-2 text-sm">
                            {settings.configured ? (
                                <Badge
                                    variant="outline"
                                    className="border-emerald-500/40 text-emerald-700 dark:text-emerald-400"
                                >
                                    <CircleCheck />
                                    Configured
                                </Badge>
                            ) : (
                                <Badge variant="outline">
                                    <CircleDashed />
                                    Not configured
                                </Badge>
                            )}
                            {settings.key_hint && (
                                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                                    {settings.key_hint}
                                </code>
                            )}
                            {settings.key_source && (
                                <span className="text-xs text-muted-foreground">
                                    {settings.key_source === 'env'
                                        ? 'from OPENROUTER_API_KEY in .env'
                                        : 'saved in the studio'}
                                </span>
                            )}
                        </div>
                        <div className="relative">
                            <KeyRound className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                id={`${id}-key`}
                                type={showKey ? 'text' : 'password'}
                                autoComplete="off"
                                spellCheck={false}
                                value={form.data.openrouter_api_key}
                                onChange={(e) =>
                                    form.setData(
                                        'openrouter_api_key',
                                        e.target.value,
                                    )
                                }
                                placeholder={
                                    settings.configured
                                        ? 'Leave empty to keep the current key'
                                        : 'sk-or-v1-…'
                                }
                                className="pr-10 pl-8 font-mono"
                                aria-invalid={
                                    errors.openrouter_api_key ? true : undefined
                                }
                            />
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="absolute top-1/2 right-0.5 size-8 -translate-y-1/2"
                                onClick={() => setShowKey((s) => !s)}
                                aria-label={showKey ? 'Hide key' : 'Show key'}
                            >
                                {showKey ? <EyeOff /> : <Eye />}
                            </Button>
                        </div>
                        <InputError message={errors.openrouter_api_key} />
                        {settings.key_source === 'env' && (
                            <p className="text-xs text-muted-foreground">
                                A key saved here takes precedence over the
                                environment variable.
                            </p>
                        )}
                    </div>

                    <div className="grid gap-2">
                        <div className="flex items-center justify-between gap-2">
                            <Label htmlFor={`${id}-meshy`}>Meshy API key</Label>
                            <a
                                href="https://www.meshy.ai/api"
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-xs font-medium text-sky-700 hover:underline dark:text-sky-400"
                            >
                                Get a key
                                <ExternalLink className="size-3" />
                            </a>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                            {settings.meshy.configured ? (
                                <Badge
                                    variant="outline"
                                    className="border-emerald-500/40 text-emerald-700 dark:text-emerald-400"
                                >
                                    <CircleCheck />
                                    Configured
                                </Badge>
                            ) : (
                                <Badge variant="outline">
                                    <CircleDashed />
                                    Not configured
                                </Badge>
                            )}
                            {settings.meshy.key_hint && (
                                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                                    {settings.meshy.key_hint}
                                </code>
                            )}
                            {settings.meshy.key_source && (
                                <span className="text-xs text-muted-foreground">
                                    {settings.meshy.key_source === 'env'
                                        ? 'from MESHY_API_KEY in .env'
                                        : 'saved in the studio'}
                                </span>
                            )}
                            {settings.meshy.key_source === 'studio' && (
                                <ConfirmDialog
                                    trigger={
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            className="ml-auto text-red-600 hover:bg-red-500/10 hover:text-red-700 dark:text-red-400"
                                        >
                                            <Trash2 />
                                            Remove
                                        </Button>
                                    }
                                    title="Remove the Meshy key?"
                                    description="3D generation stops working until you add a key again. Generated models are kept."
                                    confirmLabel="Remove key"
                                    destructive
                                    processing={clearMeshyForm.processing}
                                    onConfirm={(close) =>
                                        clearMeshyForm.submit(
                                            aiSettings.update(),
                                            {
                                                preserveScroll: true,
                                                onSuccess: () => {
                                                    close();
                                                    refreshAiCredits();
                                                },
                                            },
                                        )
                                    }
                                />
                            )}
                        </div>
                        <div className="relative">
                            <KeyRound className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                id={`${id}-meshy`}
                                type={showMeshyKey ? 'text' : 'password'}
                                autoComplete="off"
                                spellCheck={false}
                                value={form.data.meshy_api_key}
                                onChange={(e) =>
                                    form.setData(
                                        'meshy_api_key',
                                        e.target.value,
                                    )
                                }
                                placeholder={
                                    settings.meshy.configured
                                        ? 'Leave empty to keep the current key'
                                        : 'msy_…'
                                }
                                className="pr-10 pl-8 font-mono"
                                aria-invalid={
                                    errors.meshy_api_key ? true : undefined
                                }
                            />
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="absolute top-1/2 right-0.5 size-8 -translate-y-1/2"
                                onClick={() => setShowMeshyKey((s) => !s)}
                                aria-label={
                                    showMeshyKey
                                        ? 'Hide Meshy key'
                                        : 'Show Meshy key'
                                }
                            >
                                {showMeshyKey ? <EyeOff /> : <Eye />}
                            </Button>
                        </div>
                        <InputError message={errors.meshy_api_key} />
                        <p className="text-xs text-muted-foreground">
                            Used for textured 3D foliage models (about 30 Meshy
                            credits per model).
                        </p>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                        <ModelField
                            label="Image model"
                            description="Paints material textures."
                            value={form.data.image_model}
                            onChange={(v) => form.setData('image_model', v)}
                            options={(models?.image ?? []).map((m) => ({
                                id: m.id,
                                name: m.name,
                                hint: m.resolutions?.join(' / '),
                            }))}
                            loading={loading}
                            error={errors.image_model}
                        />
                        <ModelField
                            label="Text model"
                            description="Prompts, layer suggestions and reviews. Pick a vision model for reviews."
                            value={form.data.text_model}
                            onChange={(v) => form.setData('text_model', v)}
                            options={(models?.text ?? []).map((m) => ({
                                id: m.id,
                                name: m.name,
                                hint: m.vision ? 'vision' : undefined,
                            }))}
                            loading={loading}
                            error={errors.text_model}
                        />
                    </div>
                    {error && settings.configured && (
                        <p className="-mt-3 text-xs text-amber-700 dark:text-amber-400">
                            Could not load the model list ({error}). You can
                            still type a model id.
                        </p>
                    )}

                    <Segmented
                        label="Default image resolution"
                        value={form.data.image_resolution}
                        options={[
                            { value: '1K', label: '1K' },
                            {
                                value: '2K',
                                label: '2K',
                                hint: 'Sharper, slower and usually more expensive',
                            },
                        ]}
                        onChange={(v) => form.setData('image_resolution', v)}
                        className="max-w-48"
                    />

                    <div className="flex flex-wrap items-center gap-2">
                        <Button
                            type="submit"
                            disabled={form.processing || !form.isDirty}
                        >
                            {form.processing ? <Spinner /> : <Save />}
                            Save
                        </Button>
                        <Button
                            type="button"
                            variant="outline"
                            disabled={
                                testForm.processing ||
                                (!settings.configured &&
                                    !form.data.openrouter_api_key)
                            }
                            onClick={() =>
                                testForm.submit(aiSettings.test(), {
                                    preserveScroll: true,
                                })
                            }
                        >
                            {testForm.processing ? <Spinner /> : <PlugZap />}
                            Test connection
                        </Button>
                        {form.recentlySuccessful && (
                            <span className="text-sm text-muted-foreground">
                                Saved
                            </span>
                        )}
                        {settings.key_source === 'studio' && (
                            <div className="ml-auto">
                                <ConfirmDialog
                                    trigger={
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            className="text-red-600 hover:bg-red-500/10 hover:text-red-700 dark:text-red-400"
                                        >
                                            <Trash2 />
                                            Remove OpenRouter key
                                        </Button>
                                    }
                                    title="Remove the OpenRouter key?"
                                    description="AI features stop working until you add a key again. Existing materials are kept."
                                    confirmLabel="Remove key"
                                    destructive
                                    processing={clearForm.processing}
                                    onConfirm={(close) => {
                                        clearForm.transform(() => ({
                                            openrouter_api_key: '',
                                            meshy_api_key: '',
                                            clear_key: true,
                                            image_model: settings.image_model,
                                            text_model: settings.text_model,
                                            image_resolution:
                                                settings.image_resolution,
                                        }));
                                        clearForm.submit(aiSettings.update(), {
                                            preserveScroll: true,
                                            onSuccess: close,
                                        });
                                    }}
                                />
                            </div>
                        )}
                    </div>
                </form>
            </div>
        </>
    );
}

function ModelField({
    label,
    description,
    value,
    onChange,
    options,
    loading,
    error,
}: {
    label: string;
    description: string;
    value: string;
    onChange: (value: string) => void;
    options: { id: string; name: string; hint?: string }[];
    loading: boolean;
    error?: string;
}) {
    const id = useId();
    const [custom, setCustom] = useState(false);
    const known = options.some((o) => o.id === value);
    const useText = custom || options.length === 0;

    return (
        <div className="grid content-start gap-2">
            <div className="flex items-center justify-between gap-2">
                <Label htmlFor={id}>{label}</Label>
                {options.length > 0 && (
                    <button
                        type="button"
                        className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                        onClick={() => setCustom((c) => !c)}
                    >
                        {useText ? 'Pick from list' : 'Enter model id'}
                    </button>
                )}
            </div>
            {useText ? (
                <div className="relative">
                    <Input
                        id={id}
                        value={value}
                        onChange={(e) => onChange(e.target.value)}
                        placeholder="provider/model-name"
                        spellCheck={false}
                        className="font-mono text-sm"
                    />
                    {loading && (
                        <Spinner className="absolute top-1/2 right-2.5 -translate-y-1/2 text-muted-foreground" />
                    )}
                </div>
            ) : (
                <Select value={value} onValueChange={onChange}>
                    <SelectTrigger id={id} className="w-full">
                        <SelectValue placeholder="Choose a model" />
                    </SelectTrigger>
                    <SelectContent>
                        {!known && value && (
                            <SelectItem value={value}>{value}</SelectItem>
                        )}
                        {options.map((o) => (
                            <SelectItem key={o.id} value={o.id}>
                                {o.name}
                                {o.hint && (
                                    <span className="text-xs text-muted-foreground">
                                        {o.hint}
                                    </span>
                                )}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            )}
            <p className="text-xs text-muted-foreground">{description}</p>
            <InputError message={error} />
        </div>
    );
}

AiSettingsPage.layout = {
    breadcrumbs: [
        { title: 'Settings', href: gameSettings.edit('player') },
        { title: 'AI (OpenRouter)', href: aiSettings.edit() },
    ],
};
