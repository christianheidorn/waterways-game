import { LOOK_PRESETS, lookPresetFor } from '@/lib/look-presets';
import { cn } from '@/lib/utils';
import type { SettingValues } from '@/types';

/** One-click film looks for Environment → Camera & look (see resources/js/lib/look-presets.ts). */
export function LookPresets({
    values,
    onApply,
    className,
}: {
    values: SettingValues;
    onApply: (values: SettingValues) => void;
    className?: string;
}) {
    const active = lookPresetFor(values);

    return (
        <div
            role="group"
            aria-label="Look presets"
            className={cn('grid grid-cols-2 gap-2 sm:grid-cols-5', className)}
        >
            {Object.entries(LOOK_PRESETS).map(([key, preset]) => (
                <button
                    key={key}
                    type="button"
                    title={preset.description}
                    aria-pressed={active === key}
                    onClick={() => onApply({ ...preset.values })}
                    className={cn(
                        'overflow-hidden rounded-lg border text-left text-xs font-medium transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                        active === key
                            ? 'border-primary ring-1 ring-primary'
                            : 'text-muted-foreground',
                    )}
                >
                    <span
                        aria-hidden
                        className="block h-9"
                        style={{ background: preset.swatch }}
                    />
                    <span className="block px-2 py-1.5">{preset.label}</span>
                </button>
            ))}
        </div>
    );
}
