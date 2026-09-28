import {
    applyGroupLevel,
    applyPreset,
    detectGroupLevel,
    detectPreset,
    PRESET_INFO,
    PRESET_NAMES,
    QUALITY_LEVELS,
    SCALABILITY_GROUPS,
    syncLegacy,
} from '@game/shared/graphicsPresets';
import type {
    PresetName,
    ScalabilityGroupKey,
} from '@game/shared/graphicsPresets';
import type { GraphicsSettings, QualityLevel } from '@game/shared/types';
import { useForm } from '@inertiajs/react';
import type { LucideIcon } from 'lucide-react';
import {
    Aperture,
    Clapperboard,
    Gauge,
    Grid2x2,
    Layers,
    Leaf,
    Mountain,
    Sparkles,
    SunDim,
    Wand2,
} from 'lucide-react';
import type { FormEvent, ReactNode } from 'react';
import { SettingInput } from '@/components/settings-form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import type { SettingGroup, SettingValue, SettingValues } from '@/types';

type Section = {
    title: string;
    description: string;
    icon: LucideIcon;
    /** Scalability groups the section's Low…Epic switch sets. */
    groups: ScalabilityGroupKey[];
    fields: string[];
};

/** Unreal-like grouping of the graphics fields. */
const SECTIONS: Section[] = [
    {
        title: 'View distance',
        description:
            'How far the camera sees and how long the terrain keeps full detail.',
        icon: Mountain,
        groups: ['view_distance'],
        fields: ['draw_distance', 'terrain_lod_bias'],
    },
    {
        title: 'Anti-aliasing',
        description:
            'Smooths jagged edges. TAA looks best and removes foliage shimmer; SMAA is sharp and cheap; FXAA is cheapest.',
        icon: Grid2x2,
        groups: ['anti_aliasing'],
        fields: ['anti_aliasing'],
    },
    {
        title: 'Post-processing',
        description:
            'Bloom and ambient occlusion follow the quality level; grading values are artistic and never changed by presets.',
        icon: Aperture,
        groups: ['post_processing'],
        fields: [
            'bloom',
            'bloom_intensity',
            'ambient_occlusion',
            'ao_quality',
            'saturation',
            'contrast',
            'vignette',
        ],
    },
    {
        title: 'Cinematic effects',
        description:
            'Eye adaptation, film looks, light shafts, depth of field, motion blur and lens effects. How strong each looks is set per map (Environment → Camera & look).',
        icon: Clapperboard,
        groups: ['post_processing'],
        fields: [
            'auto_exposure',
            'color_grading_lut',
            'god_rays',
            'depth_of_field',
            'motion_blur',
            'lens_effects',
        ],
    },
    {
        title: 'Shadows',
        description: 'Sun shadow map resolution and how far shadows reach.',
        icon: SunDim,
        groups: ['shadows'],
        fields: ['shadow_quality', 'shadow_distance', 'contact_shadows'],
    },
    {
        title: 'Textures',
        description: 'Terrain material resolution and texture filtering.',
        icon: Layers,
        groups: ['textures'],
        fields: ['terrain_texture_resolution', 'anisotropy'],
    },
    {
        title: 'Effects & weather',
        description:
            'Particles, lightning, clouds, water and screen-space reflections.',
        icon: Sparkles,
        groups: ['effects', 'shading'],
        fields: ['effects_quality', 'cloud_quality', 'water_quality', 'ssr'],
    },
    {
        title: 'Foliage',
        description:
            'Density, draw distance, shadows and level of detail of vegetation.',
        icon: Leaf,
        groups: ['foliage'],
        fields: [
            'foliage_density',
            'foliage_distance',
            'foliage_shadow_distance',
            'foliage_lod_bias',
        ],
    },
    {
        title: 'Resolution & frame rate',
        description:
            'Render scale and sharpening follow the quality level; dynamic resolution and frame rate limits are left as set.',
        icon: Gauge,
        groups: ['resolution'],
        fields: [
            'render_scale',
            'sharpen',
            'dynamic_resolution',
            'target_fps',
            'max_fps',
        ],
    },
];

/** Managed by the preset picker / derived, not shown as inputs. */
const HIDDEN = new Set(['quality_preset', 'antialias']);

const LEVEL_LABEL: Record<QualityLevel, string> = {
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    epic: 'Epic',
};

type Props = {
    group: SettingGroup;
    values: SettingValues;
    action: { url: string; method: 'put' | 'patch' | 'post' };
    actions?: ReactNode;
};

/**
 * Graphics settings with an Unreal-style quality preset picker and per-section scalability levels.
 * Presets come from resources/game/shared/graphicsPresets.ts (shared with the in-game F10 menu).
 */
export function GraphicsSettingsForm(props: Props) {
    return (
        <GraphicsSettingsFormInner
            key={JSON.stringify(props.values)}
            {...props}
        />
    );
}

function GraphicsSettingsFormInner({ group, values, action, actions }: Props) {
    const form = useForm<SettingValues>({ ...values });
    const fieldsByKey = new Map(group.fields.map((f) => [f.key, f]));
    const graphics = form.data as unknown as GraphicsSettings;
    const preset = detectPreset(graphics);
    const errors = form.errors as Record<string, string | undefined>;

    const replace = (next: GraphicsSettings) =>
        form.setData(next as unknown as SettingValues);

    const setValue = (key: string, value: SettingValue) => {
        const next = syncLegacy({
            ...graphics,
            [key]: value,
        } as GraphicsSettings);
        replace({ ...next, quality_preset: detectPreset(next) });
    };

    const setSectionLevel = (section: Section, level: QualityLevel) => {
        let next = graphics;

        for (const key of section.groups) {
            next = applyGroupLevel(next, key, level);
        }

        replace(next);
    };

    const sectionLevel = (section: Section): QualityLevel | 'custom' => {
        const levels = section.groups.map((key) =>
            detectGroupLevel(
                graphics,
                SCALABILITY_GROUPS.find((g) => g.key === key)!,
            ),
        );

        return levels.every((l) => l === levels[0]) ? levels[0] : 'custom';
    };

    const submit = (e: FormEvent) => {
        e.preventDefault();
        form.transform((data) => ({
            ...data,
            quality_preset: detectPreset(data as unknown as GraphicsSettings),
        }));
        form.submit(action, { preserveScroll: true });
    };

    const listed = new Set(SECTIONS.flatMap((s) => s.fields));
    const rest = group.fields
        .map((f) => f.key)
        .filter((key) => !listed.has(key) && !HIDDEN.has(key));

    return (
        <form onSubmit={submit} className="space-y-8">
            <section className="rounded-xl border bg-card p-4 shadow-xs sm:p-6">
                <header className="mb-4 flex items-start gap-3">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                        <Wand2 className="size-4" />
                    </div>
                    <div className="flex-1 space-y-0.5">
                        <h3 className="flex items-center gap-2 text-sm font-semibold">
                            Quality preset
                            {preset === 'custom' && (
                                <Badge variant="secondary">Custom</Badge>
                            )}
                        </h3>
                        <p className="text-sm text-muted-foreground">
                            Fills every quality field below, like Unreal's
                            scalability levels. Editing any value switches to
                            Custom. Players can override these per device with
                            the in-game graphics menu (F10).
                        </p>
                    </div>
                </header>
                <div
                    className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5"
                    role="radiogroup"
                    aria-label="Quality preset"
                >
                    {PRESET_NAMES.map((name) => (
                        <PresetCard
                            key={name}
                            name={name}
                            active={preset === name}
                            onSelect={() =>
                                replace(applyPreset(name, graphics))
                            }
                        />
                    ))}
                </div>
            </section>

            {SECTIONS.map((section) => {
                const level = sectionLevel(section);

                return (
                    <section
                        key={section.title}
                        className="rounded-xl border bg-card p-4 shadow-xs sm:p-6"
                    >
                        <header className="mb-5 flex flex-wrap items-start gap-3">
                            <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                                <section.icon className="size-4" />
                            </div>
                            <div className="min-w-48 flex-1 space-y-0.5">
                                <h3 className="text-sm font-semibold">
                                    {section.title}
                                </h3>
                                <p className="text-sm text-muted-foreground">
                                    {section.description}
                                </p>
                            </div>
                            <ToggleGroup
                                type="single"
                                variant="outline"
                                size="sm"
                                value={level === 'custom' ? '' : level}
                                onValueChange={(v) =>
                                    v &&
                                    setSectionLevel(section, v as QualityLevel)
                                }
                                aria-label={`${section.title} quality`}
                            >
                                {QUALITY_LEVELS.map((l) => (
                                    <ToggleGroupItem
                                        key={l}
                                        value={l}
                                        className="px-2.5 text-xs"
                                    >
                                        {LEVEL_LABEL[l]}
                                    </ToggleGroupItem>
                                ))}
                            </ToggleGroup>
                        </header>
                        <div className="grid gap-6">
                            {section.fields.map((key) => {
                                const field = fieldsByKey.get(key);

                                return field ? (
                                    <SettingInput
                                        key={key}
                                        field={field}
                                        value={form.data[key] ?? field.default}
                                        onChange={(v) => setValue(key, v)}
                                        onReset={() =>
                                            setValue(key, field.default)
                                        }
                                        error={errors[key]}
                                    />
                                ) : null;
                            })}
                        </div>
                    </section>
                );
            })}

            {rest.length > 0 && (
                <section className="rounded-xl border bg-card p-4 shadow-xs sm:p-6">
                    <h3 className="mb-5 text-sm font-semibold">Other</h3>
                    <div className="grid gap-6">
                        {rest.map((key) => {
                            const field = fieldsByKey.get(key)!;

                            return (
                                <SettingInput
                                    key={key}
                                    field={field}
                                    value={form.data[key] ?? field.default}
                                    onChange={(v) => setValue(key, v)}
                                    onReset={() => setValue(key, field.default)}
                                    error={errors[key]}
                                />
                            );
                        })}
                    </div>
                </section>
            )}

            <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center gap-3 border-t bg-background/85 px-1 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/70">
                <Button type="submit" disabled={form.processing}>
                    {form.processing && <Spinner />}
                    Save changes
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
                        ? `Unsaved changes · ${preset === 'custom' ? 'Custom' : PRESET_INFO[preset].label}`
                        : form.recentlySuccessful
                          ? 'Saved'
                          : ''}
                </span>
            </div>
        </form>
    );
}

function PresetCard({
    name,
    active,
    onSelect,
}: {
    name: PresetName;
    active: boolean;
    onSelect: () => void;
}) {
    const info = PRESET_INFO[name];

    return (
        <button
            type="button"
            role="radio"
            aria-checked={active}
            onClick={onSelect}
            className={cn(
                'flex flex-col gap-1.5 rounded-lg border p-3 text-left transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                active && 'border-primary bg-primary/5 ring-1 ring-primary',
            )}
        >
            <span className="text-sm font-semibold">{info.label}</span>
            <span className="text-xs leading-snug text-muted-foreground">
                {info.description}
            </span>
            <span
                className={cn(
                    'mt-auto pt-1 text-[11px] font-medium',
                    name === 'cinematic'
                        ? 'text-amber-600 dark:text-amber-400'
                        : 'text-muted-foreground',
                )}
            >
                {info.performance}
            </span>
        </button>
    );
}
