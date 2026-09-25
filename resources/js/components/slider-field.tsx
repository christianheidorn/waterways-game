import type { ReactNode } from 'react';
import { useId, useState } from 'react';
import InputError from '@/components/input-error';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';

export function decimalsForStep(step: number): number {
    if (!Number.isFinite(step) || step <= 0 || step >= 1) {
        return 0;
    }

    return Math.min(6, Math.ceil(-Math.log10(step) - 1e-9));
}

type Props = {
    label: string;
    value: number;
    onChange: (value: number) => void;
    min: number;
    max: number;
    step?: number;
    unit?: string;
    description?: string;
    error?: string;
    disabled?: boolean;
    /** Optional pretty value shown next to the label (e.g. "15:30"). */
    formatValue?: (value: number) => string;
    /** Rendered at the end of the label row (e.g. a reset button). */
    labelAction?: ReactNode;
    id?: string;
    className?: string;
};

/** A labelled slider paired with a numeric input for exact values. */
export function SliderField({
    label,
    value,
    onChange,
    min,
    max,
    step = 1,
    unit,
    description,
    error,
    disabled,
    formatValue,
    labelAction,
    id,
    className,
}: Props) {
    const generatedId = useId();
    const inputId = id ?? generatedId;
    const decimals = decimalsForStep(step);
    const [draft, setDraft] = useState<string | null>(null);

    const clamp = (v: number) => Math.min(max, Math.max(min, v));

    const commit = () => {
        if (draft === null) {
            return;
        }

        const parsed = Number.parseFloat(draft.replace(',', '.'));

        if (Number.isFinite(parsed)) {
            onChange(clamp(parsed));
        }

        setDraft(null);
    };

    const safeValue = Number.isFinite(value) ? value : min;

    return (
        <div className={cn('grid gap-2', className)}>
            <div className="flex min-h-6 items-center justify-between gap-3">
                <Label htmlFor={inputId}>{label}</Label>
                <div className="flex items-center gap-1">
                    {labelAction}
                    {formatValue && (
                        <span className="text-xs font-medium text-muted-foreground tabular-nums">
                            {formatValue(safeValue)}
                        </span>
                    )}
                </div>
            </div>
            <div className="flex items-center gap-3">
                <Slider
                    value={[safeValue]}
                    min={min}
                    max={max}
                    step={step}
                    disabled={disabled}
                    onValueChange={([v]) => onChange(v)}
                    aria-label={label}
                    className="flex-1"
                />
                <div className="relative w-28 shrink-0 sm:w-32">
                    <Input
                        id={inputId}
                        type="text"
                        inputMode="decimal"
                        disabled={disabled}
                        value={draft ?? safeValue.toFixed(decimals)}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={commit}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                e.preventDefault();
                                commit();
                            }
                        }}
                        aria-invalid={error ? true : undefined}
                        className={cn(
                            'h-8 text-right tabular-nums',
                            unit && (unit.length > 2 ? 'pr-14' : 'pr-9'),
                        )}
                    />
                    {unit && (
                        <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs text-muted-foreground">
                            {unit}
                        </span>
                    )}
                </div>
            </div>
            {description && (
                <p className="text-xs text-muted-foreground">{description}</p>
            )}
            <InputError message={error} />
        </div>
    );
}
