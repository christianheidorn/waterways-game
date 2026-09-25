import type { ReactNode } from 'react';
import { useId, useState } from 'react';
import InputError from '@/components/input-error';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

const HEX = /^#[0-9a-fA-F]{6}$/;

type Props = {
    label: string;
    value: string;
    onChange: (value: string) => void;
    description?: string;
    error?: string;
    disabled?: boolean;
    /** Rendered at the end of the label row (e.g. a reset button). */
    labelAction?: ReactNode;
    id?: string;
    className?: string;
};

/** Native colour picker swatch + hex text input. */
export function ColorField({
    label,
    value,
    onChange,
    description,
    error,
    disabled,
    labelAction,
    id,
    className,
}: Props) {
    const generatedId = useId();
    const inputId = id ?? generatedId;
    const [draft, setDraft] = useState<string | null>(null);
    const safe = HEX.test(value) ? value : '#000000';

    const commit = () => {
        if (draft === null) {
            return;
        }

        const normalised = draft.startsWith('#') ? draft : `#${draft}`;

        if (HEX.test(normalised)) {
            onChange(normalised.toLowerCase());
        }

        setDraft(null);
    };

    return (
        <div className={cn('grid gap-2', className)}>
            <div className="flex min-h-6 items-center justify-between gap-2">
                <Label htmlFor={inputId}>{label}</Label>
                {labelAction}
            </div>
            <div className="flex items-center gap-2">
                <label
                    className={cn(
                        'relative size-9 shrink-0 cursor-pointer overflow-hidden rounded-md border shadow-xs focus-within:ring-[3px] focus-within:ring-ring/50',
                        disabled && 'pointer-events-none opacity-50',
                    )}
                    style={{ backgroundColor: safe }}
                >
                    <span className="sr-only">Pick {label}</span>
                    <input
                        type="color"
                        value={safe}
                        disabled={disabled}
                        onChange={(e) => onChange(e.target.value.toLowerCase())}
                        className="absolute inset-0 size-full cursor-pointer opacity-0"
                    />
                </label>
                <Input
                    id={inputId}
                    value={draft ?? value}
                    disabled={disabled}
                    maxLength={7}
                    spellCheck={false}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            commit();
                        }
                    }}
                    aria-invalid={error ? true : undefined}
                    className="font-mono text-sm uppercase"
                />
            </div>
            {description && (
                <p className="text-xs text-muted-foreground">{description}</p>
            )}
            <InputError message={error} />
        </div>
    );
}
