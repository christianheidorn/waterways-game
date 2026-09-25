import { useForm } from '@inertiajs/react';
import type { LucideIcon } from 'lucide-react';
import { RotateCcw } from 'lucide-react';
import type { FormEvent, ReactNode } from 'react';
import { useId } from 'react';
import { ColorField } from '@/components/color-field';
import InputError from '@/components/input-error';
import { SliderField } from '@/components/slider-field';
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
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import type {
    SettingField,
    SettingGroup,
    SettingValue,
    SettingValues,
} from '@/types';

export type SettingsSection = {
    title: string;
    description?: string;
    icon?: LucideIcon;
    /** Field keys rendered in this section, in order. */
    fields: string[];
};

export type SettingsFormProps = {
    group: SettingGroup;
    values: SettingValues;
    /** Wayfinder route definition (url + method), e.g. `gameSettings.update('player')`. */
    action: { url: string; method: 'put' | 'patch' | 'post' };
    /** Optional visual grouping; fields not listed end up in a trailing "Other" section. */
    sections?: SettingsSection[];
    /** Pretty-printers shown next to a number field's label, keyed by field key. */
    formatters?: Record<string, (value: number) => string>;
    submitLabel?: string;
    /** Rendered next to the save button (e.g. a "Reset to defaults" button). */
    actions?: ReactNode;
    className?: string;
};

/**
 * Renders any schema-driven settings group (see App\Support\SettingGroup) and saves it via Inertia.
 * Remounts whenever the server values change so a reset / reload is always reflected.
 */
export function SettingsForm(props: SettingsFormProps) {
    return <SettingsFormInner key={JSON.stringify(props.values)} {...props} />;
}

function SettingsFormInner({
    group,
    values,
    action,
    sections,
    formatters = {},
    submitLabel = 'Save changes',
    actions,
    className,
}: SettingsFormProps) {
    const form = useForm<SettingValues>({ ...values });
    const fieldsByKey = new Map(group.fields.map((f) => [f.key, f]));

    const resolvedSections: SettingsSection[] = (() => {
        if (!sections?.length) {
            return [{ title: '', fields: group.fields.map((f) => f.key) }];
        }

        const listed = new Set(sections.flatMap((s) => s.fields));
        const rest = group.fields
            .map((f) => f.key)
            .filter((key) => !listed.has(key));

        return rest.length
            ? [...sections, { title: 'Other', fields: rest }]
            : sections;
    })();

    const setValue = (key: string, value: SettingValue) =>
        form.setData((prev) => ({ ...prev, [key]: value }));

    const submit = (e: FormEvent) => {
        e.preventDefault();

        form.transform((data) => {
            const out: SettingValues = { ...data };

            for (const field of group.fields) {
                if (field.type === 'text' && out[field.key] === '') {
                    out[field.key] = null;
                }
            }

            return out;
        });

        form.submit(action, { preserveScroll: true });
    };

    const errors = form.errors as Record<string, string | undefined>;

    return (
        <form onSubmit={submit} className={cn('space-y-8', className)}>
            {resolvedSections.map((section) => (
                <section
                    key={section.title || 'fields'}
                    className={cn(
                        section.title &&
                            'rounded-xl border bg-card p-4 shadow-xs sm:p-6',
                    )}
                >
                    {section.title && (
                        <header className="mb-5 flex items-start gap-3">
                            {section.icon && (
                                <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                                    <section.icon className="size-4" />
                                </div>
                            )}
                            <div className="space-y-0.5">
                                <h3 className="text-sm font-semibold">
                                    {section.title}
                                </h3>
                                {section.description && (
                                    <p className="text-sm text-muted-foreground">
                                        {section.description}
                                    </p>
                                )}
                            </div>
                        </header>
                    )}
                    <div className="grid gap-6">
                        {section.fields.map((key) => {
                            const field = fieldsByKey.get(key);

                            if (!field) {
                                return null;
                            }

                            return (
                                <SettingInput
                                    key={key}
                                    field={field}
                                    value={form.data[key] ?? field.default}
                                    onChange={(v) => setValue(key, v)}
                                    onReset={() => setValue(key, field.default)}
                                    error={errors[key]}
                                    format={formatters[key]}
                                />
                            );
                        })}
                    </div>
                </section>
            ))}

            <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center gap-3 border-t bg-background/85 px-1 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/70">
                <Button type="submit" disabled={form.processing}>
                    {form.processing && <Spinner />}
                    {submitLabel}
                </Button>
                {form.isDirty && (
                    <Button
                        type="button"
                        variant="ghost"
                        onClick={() => form.reset()}
                        disabled={form.processing}
                    >
                        Discard
                    </Button>
                )}
                {actions}
                <span
                    className="ml-auto text-sm text-muted-foreground"
                    aria-live="polite"
                >
                    {form.isDirty
                        ? 'Unsaved changes'
                        : form.recentlySuccessful
                          ? 'Saved'
                          : ''}
                </span>
            </div>
        </form>
    );
}

function isDefault(field: SettingField, value: SettingValue): boolean {
    if (field.type === 'number') {
        return Math.abs(Number(value) - Number(field.default)) < 1e-9;
    }

    return (
        (value ?? null) === (field.default ?? null) ||
        (field.type === 'text' && !value && !field.default)
    );
}

function ResetButton({
    field,
    onReset,
}: {
    field: SettingField;
    onReset: () => void;
}) {
    return (
        <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground"
            onClick={onReset}
            title={`Reset ${field.label} to default`}
        >
            <RotateCcw className="size-3.5" />
            <span className="sr-only">Reset {field.label} to default</span>
        </Button>
    );
}

function SettingInput({
    field,
    value,
    onChange,
    onReset,
    error,
    format,
}: {
    field: SettingField;
    value: SettingValue;
    onChange: (value: SettingValue) => void;
    onReset: () => void;
    error?: string;
    format?: (value: number) => string;
}) {
    const id = useId();
    const changed = !isDefault(field, value);
    const reset = changed ? (
        <ResetButton field={field} onReset={onReset} />
    ) : null;

    switch (field.type) {
        case 'number':
            return (
                <SliderField
                    id={id}
                    label={field.label}
                    value={Number(value)}
                    onChange={onChange}
                    min={field.min ?? 0}
                    max={field.max ?? 100}
                    step={field.step ?? 0.1}
                    unit={field.unit}
                    description={field.description}
                    error={error}
                    formatValue={format}
                    labelAction={reset}
                />
            );

        case 'boolean':
            return (
                <div className="grid gap-2">
                    <div className="flex items-start justify-between gap-4">
                        <div className="space-y-1">
                            <Label htmlFor={id}>{field.label}</Label>
                            {field.description && (
                                <p className="text-xs text-muted-foreground">
                                    {field.description}
                                </p>
                            )}
                        </div>
                        <div className="flex items-center gap-1">
                            {reset}
                            <Switch
                                id={id}
                                checked={Boolean(value)}
                                onCheckedChange={(checked) => onChange(checked)}
                            />
                        </div>
                    </div>
                    <InputError message={error} />
                </div>
            );

        case 'select':
            return (
                <div className="grid gap-2">
                    <div className="flex min-h-6 items-center justify-between gap-2">
                        <Label htmlFor={id}>{field.label}</Label>
                        {reset}
                    </div>
                    <Select
                        value={String(value ?? '')}
                        onValueChange={(v) => onChange(v)}
                    >
                        <SelectTrigger id={id} className="w-full sm:w-64">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {Object.entries(field.options ?? {}).map(
                                ([optionValue, optionLabel]) => (
                                    <SelectItem
                                        key={optionValue}
                                        value={optionValue}
                                    >
                                        {optionLabel}
                                    </SelectItem>
                                ),
                            )}
                        </SelectContent>
                    </Select>
                    {field.description && (
                        <p className="text-xs text-muted-foreground">
                            {field.description}
                        </p>
                    )}
                    <InputError message={error} />
                </div>
            );

        case 'color':
            return (
                <ColorField
                    id={id}
                    label={field.label}
                    value={String(value ?? field.default ?? '#000000')}
                    onChange={onChange}
                    description={field.description}
                    error={error}
                    className="sm:max-w-64"
                    labelAction={reset}
                />
            );

        default:
            return (
                <div className="grid gap-2">
                    <div className="flex min-h-6 items-center justify-between gap-2">
                        <Label htmlFor={id}>{field.label}</Label>
                        {reset}
                    </div>
                    <Input
                        id={id}
                        value={value === null ? '' : String(value)}
                        onChange={(e) => onChange(e.target.value)}
                        aria-invalid={error ? true : undefined}
                    />
                    {field.description && (
                        <p className="text-xs text-muted-foreground">
                            {field.description}
                        </p>
                    )}
                    <InputError message={error} />
                </div>
            );
    }
}
