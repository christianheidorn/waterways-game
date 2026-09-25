import { router } from '@inertiajs/react';
import { RotateCcw, Save } from 'lucide-react';
import { useState } from 'react';
import { ColorField } from '@/components/color-field';
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
import { Switch } from '@/components/ui/switch';
import type { SettingField, SettingGroup, SettingValues } from '@/types';

type Props = {
    group: SettingGroup;
    initial: SettingValues;
    /** Called on every change so the game can preview it immediately. */
    onPreview: (values: SettingValues) => void;
    /** Wayfinder route used to persist the values. */
    action: { url: string; method: 'put' | 'patch' | 'post' };
    formatters?: Record<string, (value: number) => string>;
    /** Only render these keys (in order). */
    only?: string[];
};

/**
 * A compact settings editor for the studio side panel: every change is previewed live in the game,
 * "Save" persists it through the regular Laravel endpoint.
 */
export function LiveSettings({
    group,
    initial,
    onPreview,
    action,
    formatters = {},
    only,
}: Props) {
    const [values, setValues] = useState<SettingValues>(initial);
    const [saved, setSaved] = useState<SettingValues>(initial);
    const [saving, setSaving] = useState(false);
    const dirty = JSON.stringify(values) !== JSON.stringify(saved);
    const fields = only
        ? only
              .map((k) => group.fields.find((f) => f.key === k))
              .filter((f): f is SettingField => !!f)
        : group.fields;

    const update = (key: string, value: SettingValues[string]) => {
        const next = { ...values, [key]: value };
        setValues(next);
        onPreview(next);
    };

    const save = () => {
        setSaving(true);
        router.visit(action.url, {
            method: action.method,
            data: values,
            preserveScroll: true,
            preserveState: true,
            onSuccess: () => setSaved(values),
            onFinish: () => setSaving(false),
        });
    };

    const revert = () => {
        setValues(saved);
        onPreview(saved);
    };

    return (
        <div className="flex flex-col gap-5">
            {fields.map((field) => (
                <FieldControl
                    key={field.key}
                    field={field}
                    value={values[field.key]}
                    format={formatters[field.key]}
                    onChange={(v) => update(field.key, v)}
                />
            ))}
            <div className="sticky bottom-0 -mx-1 flex gap-2 bg-background/95 px-1 py-3 backdrop-blur">
                <Button
                    onClick={save}
                    disabled={!dirty || saving}
                    className="flex-1"
                >
                    <Save /> {saving ? 'Saving…' : 'Save'}
                </Button>
                <Button variant="outline" onClick={revert} disabled={!dirty}>
                    <RotateCcw /> Revert
                </Button>
            </div>
        </div>
    );
}

function FieldControl({
    field,
    value,
    format,
    onChange,
}: {
    field: SettingField;
    value: SettingValues[string];
    format?: (value: number) => string;
    onChange: (value: SettingValues[string]) => void;
}) {
    switch (field.type) {
        case 'number':
            return (
                <SliderField
                    label={field.label}
                    value={Number(value)}
                    onChange={onChange}
                    min={field.min ?? 0}
                    max={field.max ?? 1}
                    step={field.step ?? 0.1}
                    unit={field.unit}
                    formatValue={format}
                    description={field.description}
                />
            );
        case 'boolean':
            return (
                <div className="flex items-center justify-between gap-3">
                    <div className="grid gap-1">
                        <Label>{field.label}</Label>
                        {field.description && (
                            <p className="text-xs text-muted-foreground">
                                {field.description}
                            </p>
                        )}
                    </div>
                    <Switch
                        checked={Boolean(value)}
                        onCheckedChange={(v) => onChange(v)}
                    />
                </div>
            );
        case 'color':
            return (
                <ColorField
                    label={field.label}
                    value={String(value ?? '#000000')}
                    onChange={onChange}
                />
            );
        case 'select':
            return (
                <div className="grid gap-2">
                    <Label>{field.label}</Label>
                    <Select
                        value={String(value)}
                        onValueChange={(v) => onChange(v)}
                    >
                        <SelectTrigger>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {Object.entries(field.options ?? {}).map(
                                ([key, label]) => (
                                    <SelectItem key={key} value={key}>
                                        {label}
                                    </SelectItem>
                                ),
                            )}
                        </SelectContent>
                    </Select>
                </div>
            );
        default:
            return (
                <div className="grid gap-2">
                    <Label>{field.label}</Label>
                    <Input
                        value={String(value ?? '')}
                        onChange={(e) => onChange(e.target.value || null)}
                    />
                    {field.description && (
                        <p className="text-xs text-muted-foreground">
                            {field.description}
                        </p>
                    )}
                </div>
            );
    }
}
