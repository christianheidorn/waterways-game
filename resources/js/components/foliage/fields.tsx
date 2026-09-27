import type { FoliageKind } from '@game/shared/types';
import { Layers } from 'lucide-react';
import { useId } from 'react';
import { Label } from '@/components/ui/label';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { kindIcon } from '@/lib/foliage';
import { cn } from '@/lib/utils';

export type KindOption = { value: FoliageKind; label: string };

export function KindSelect({
    kinds,
    value,
    onChange,
    allowAll = false,
    exclude = [],
    label,
    className,
    id,
}: {
    kinds: KindOption[];
    value: string;
    onChange: (value: string) => void;
    allowAll?: boolean;
    exclude?: FoliageKind[];
    label?: string;
    className?: string;
    id?: string;
}) {
    const fallbackId = useId();
    const selectId = id ?? fallbackId;
    const select = (
        <Select value={value} onValueChange={onChange}>
            <SelectTrigger
                id={selectId}
                className={cn('w-full', !label && className)}
                aria-label={label ? undefined : 'Kind'}
            >
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                {allowAll && (
                    <SelectItem value="all">
                        <Layers />
                        All kinds
                    </SelectItem>
                )}
                {kinds
                    .filter((k) => !exclude.includes(k.value))
                    .map((kind) => {
                        const Icon = kindIcon(kind.value);

                        return (
                            <SelectItem key={kind.value} value={kind.value}>
                                <Icon />
                                {kind.label}
                            </SelectItem>
                        );
                    })}
            </SelectContent>
        </Select>
    );

    if (!label) {
        return select;
    }

    return (
        <div className={cn('grid gap-2', className)}>
            <Label htmlFor={selectId}>{label}</Label>
            {select}
        </div>
    );
}

/** 0 = photoreal … 100 = stylized. */
export function styleLabel(style: number): string {
    if (style <= 20) {
        return 'Photoreal';
    }

    if (style <= 45) {
        return 'Realistic';
    }

    if (style <= 70) {
        return 'Semi-stylized';
    }

    return 'Stylized';
}

export function StyleSlider({
    value,
    onChange,
    label = 'Look',
    description,
}: {
    value: number;
    onChange: (value: number) => void;
    label?: string;
    description?: string;
}) {
    const id = useId();

    return (
        <div className="grid gap-2">
            <div className="flex items-center justify-between gap-2">
                <Label htmlFor={id}>{label}</Label>
                <span className="text-sm font-medium tabular-nums">
                    {styleLabel(value)}
                </span>
            </div>
            <Slider
                id={id}
                value={[value]}
                min={0}
                max={100}
                step={5}
                onValueChange={([v]) => onChange(v)}
                aria-label={label}
            />
            <div className="flex justify-between text-[11px] text-muted-foreground">
                <span>Realistic</span>
                <span>In between</span>
                <span>Stylized</span>
            </div>
            {description && (
                <p className="text-xs text-muted-foreground">{description}</p>
            )}
        </div>
    );
}
