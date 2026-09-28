import {
    applyPreset,
    detectPreset,
    PRESET_INFO,
    PRESET_NAMES,
} from '@game/shared/graphicsPresets';
import type { GraphicsSettings } from '@game/shared/types';
import { cn } from '@/lib/utils';
import type { SettingValues } from '@/types';

/** Compact Low … Cinematic picker for the editor's live Graphics panel. */
export function QualityPresetPicker({
    values,
    onApply,
}: {
    values: SettingValues;
    onApply: (values: SettingValues) => void;
}) {
    const current = values as unknown as GraphicsSettings;
    const active = detectPreset(current);

    return (
        <div className="grid gap-2">
            <div className="flex items-center justify-between text-xs">
                <span className="font-medium">Quality preset</span>
                <span className="text-muted-foreground">
                    {active === 'custom'
                        ? 'Custom'
                        : PRESET_INFO[active].performance}
                </span>
            </div>
            <div
                role="group"
                aria-label="Quality preset"
                className="grid grid-cols-5 gap-1"
            >
                {PRESET_NAMES.map((name) => (
                    <button
                        key={name}
                        type="button"
                        title={`${PRESET_INFO[name].description}\n${PRESET_INFO[name].performance}`}
                        aria-pressed={active === name}
                        onClick={() =>
                            onApply(
                                applyPreset(
                                    name,
                                    current,
                                ) as unknown as SettingValues,
                            )
                        }
                        className={cn(
                            'rounded-md border px-1 py-1.5 text-xs font-medium transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                            active === name
                                ? 'border-primary bg-primary/15 text-foreground'
                                : 'text-muted-foreground',
                        )}
                    >
                        {PRESET_INFO[name].label}
                    </button>
                ))}
            </div>
        </div>
    );
}
