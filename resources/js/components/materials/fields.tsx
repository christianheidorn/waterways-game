import { useId } from 'react';
import InputError from '@/components/input-error';
import { Label } from '@/components/ui/label';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { CategoryOption } from '@/types';

/** Labelled select of material categories. */
export function CategorySelect({
    categories,
    value,
    onChange,
    error,
    label = 'Category',
    allowAll = false,
    allLabel = 'All categories',
    className,
}: {
    categories: CategoryOption[];
    value: string;
    onChange: (value: string) => void;
    error?: string;
    label?: string | null;
    allowAll?: boolean;
    allLabel?: string;
    className?: string;
}) {
    const id = useId();

    return (
        <div className={cn('grid content-start gap-2', className)}>
            {label && <Label htmlFor={id}>{label}</Label>}
            <Select value={value} onValueChange={onChange}>
                <SelectTrigger
                    id={id}
                    className="w-full"
                    aria-label={label ?? 'Category'}
                >
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {allowAll && (
                        <SelectItem value="all">{allLabel}</SelectItem>
                    )}
                    {categories.map((c) => (
                        <SelectItem key={c.value} value={c.value}>
                            {c.label}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
            <InputError message={error} />
        </div>
    );
}

/** Pick one of a few short options as a segmented control. */
export function Segmented<T extends string | number>({
    label,
    value,
    options,
    onChange,
    className,
}: {
    label: string;
    value: T;
    options: { value: T; label: string; hint?: string }[];
    onChange: (value: T) => void;
    className?: string;
}) {
    return (
        <div className={cn('grid content-start gap-2', className)}>
            <span className="text-sm leading-none font-medium">{label}</span>
            <div
                role="radiogroup"
                aria-label={label}
                className="flex rounded-md border bg-muted/40 p-0.5"
            >
                {options.map((o) => (
                    <button
                        key={String(o.value)}
                        type="button"
                        role="radio"
                        aria-checked={o.value === value}
                        title={o.hint}
                        onClick={() => onChange(o.value)}
                        className={cn(
                            'h-7 flex-1 rounded-[5px] px-2 text-sm font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50',
                            o.value === value &&
                                'bg-background text-foreground shadow-xs',
                        )}
                    >
                        {o.label}
                    </button>
                ))}
            </div>
        </div>
    );
}
