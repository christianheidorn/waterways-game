/**
 * Unreal-style scalability for the graphics settings.
 *
 * - `antialias` (legacy MSAA boolean) is derived from `anti_aliasing` by `syncLegacy`.
 * - Presets (Low … Cinematic) are complete value sets for every *quality* field of GraphicsSettings, like
 *   UE's `sg.*` = 0..4 "Overall quality" presets. Artistic fields (bloom intensity, saturation, contrast,
 *   vignette) and device / frame-rate fields (dynamic resolution, target / max fps) are never touched.
 * - Scalability groups (View distance, Anti-aliasing, …) are subsets of those fields that can be set to a
 *   level independently, like UE's `sg.ViewDistanceQuality`, `sg.ShadowQuality`, ….
 *
 * Shared by the studio settings page (resources/js/components/game-settings) and the in-game graphics menu.
 */
import type { GraphicsSettings, QualityLevel, QualityPreset } from './types';

export type PresetName = Exclude<QualityPreset, 'custom'>;

/** Fields a preset controls (everything except the artistic / frame-rate / bookkeeping ones). */
export type PresetKey = Exclude<
    keyof GraphicsSettings,
    | 'quality_preset'
    | 'antialias'
    | 'bloom_intensity'
    | 'saturation'
    | 'contrast'
    | 'vignette'
    | 'dynamic_resolution'
    | 'target_fps'
    | 'max_fps'
>;

export type PresetValues = Pick<GraphicsSettings, PresetKey>;

export const PRESET_NAMES: PresetName[] = [
    'low',
    'medium',
    'high',
    'epic',
    'cinematic',
];

export const QUALITY_LEVELS: QualityLevel[] = ['low', 'medium', 'high', 'epic'];

export const PRESET_INFO: Record<
    PresetName,
    { label: string; description: string; performance: string }
> = {
    low: {
        label: 'Low',
        description:
            'Integrated GPUs and laptops on battery. Short view distance, sparse foliage, 70% resolution with sharpening.',
        performance: '≈ 2.5× faster than High',
    },
    medium: {
        label: 'Medium',
        description:
            'Older discrete GPUs. Reduced shadows and foliage, FXAA, 85% resolution.',
        performance: '≈ 1.6× faster than High',
    },
    high: {
        label: 'High',
        description:
            'The project default. Full resolution, SMAA, bloom, 1K terrain textures.',
        performance: 'Baseline',
    },
    epic: {
        label: 'Epic',
        description:
            'Fast desktop GPUs. Ambient occlusion, 2K textures, long view, shadow and foliage distances.',
        performance: '≈ 1.5× slower than High',
    },
    cinematic: {
        label: 'Cinematic',
        description:
            'Screenshots and trailers. 1.25× supersampling with MSAA, maximum distances and AO quality.',
        performance: '≈ 3× slower than High — not for real-time play',
    },
};

/** Complete value sets per preset. `high` equals the schema defaults (App\Support\GameSettingsSchema). */
export const PRESETS: Record<PresetName, PresetValues> = {
    low: {
        draw_distance: 4000,
        terrain_lod_bias: 0.5,
        anti_aliasing: 'fxaa',
        bloom: false,
        ambient_occlusion: false,
        ao_quality: 'low',
        shadow_quality: 'low',
        shadow_distance: 90,
        terrain_texture_resolution: '512',
        anisotropy: 2,
        effects_quality: 'low',
        cloud_quality: 'low',
        water_quality: 'low',
        foliage_density: 0.4,
        foliage_distance: 0.5,
        foliage_shadow_distance: 0,
        foliage_lod_bias: 0.5,
        render_scale: 0.7,
        sharpen: 0.4,
    },
    medium: {
        draw_distance: 7000,
        terrain_lod_bias: 0.75,
        anti_aliasing: 'fxaa',
        bloom: true,
        ambient_occlusion: false,
        ao_quality: 'low',
        shadow_quality: 'medium',
        shadow_distance: 150,
        terrain_texture_resolution: '1024',
        anisotropy: 4,
        effects_quality: 'medium',
        cloud_quality: 'low',
        water_quality: 'medium',
        foliage_density: 0.7,
        foliage_distance: 0.75,
        foliage_shadow_distance: 60,
        foliage_lod_bias: 0.75,
        render_scale: 0.85,
        sharpen: 0.25,
    },
    high: {
        draw_distance: 12000,
        terrain_lod_bias: 1,
        anti_aliasing: 'smaa',
        bloom: true,
        ambient_occlusion: false,
        ao_quality: 'medium',
        shadow_quality: 'high',
        shadow_distance: 220,
        terrain_texture_resolution: '1024',
        anisotropy: 8,
        effects_quality: 'high',
        cloud_quality: 'medium',
        water_quality: 'medium',
        foliage_density: 1,
        foliage_distance: 1,
        foliage_shadow_distance: 120,
        foliage_lod_bias: 1,
        render_scale: 1,
        sharpen: 0,
    },
    epic: {
        draw_distance: 20000,
        terrain_lod_bias: 1.5,
        anti_aliasing: 'smaa',
        bloom: true,
        ambient_occlusion: true,
        ao_quality: 'medium',
        shadow_quality: 'ultra',
        shadow_distance: 400,
        terrain_texture_resolution: '2048',
        anisotropy: 16,
        effects_quality: 'epic',
        cloud_quality: 'high',
        water_quality: 'high',
        foliage_density: 1,
        foliage_distance: 1.5,
        foliage_shadow_distance: 250,
        foliage_lod_bias: 1.5,
        render_scale: 1,
        sharpen: 0,
    },
    cinematic: {
        draw_distance: 30000,
        terrain_lod_bias: 2.5,
        anti_aliasing: 'msaa',
        bloom: true,
        ambient_occlusion: true,
        ao_quality: 'high',
        shadow_quality: 'ultra',
        shadow_distance: 700,
        terrain_texture_resolution: '2048',
        anisotropy: 16,
        effects_quality: 'epic',
        cloud_quality: 'high',
        water_quality: 'high',
        foliage_density: 1,
        foliage_distance: 2,
        foliage_shadow_distance: 350,
        foliage_lod_bias: 1.8,
        render_scale: 1.25,
        sharpen: 0,
    },
};

export const PRESET_KEYS = Object.keys(PRESETS.high) as PresetKey[];

export type ScalabilityGroupKey =
    | 'view_distance'
    | 'anti_aliasing'
    | 'post_processing'
    | 'shadows'
    | 'textures'
    | 'effects'
    | 'foliage'
    | 'shading'
    | 'resolution';

export type ScalabilityGroup = {
    key: ScalabilityGroupKey;
    label: string;
    /** Unreal console variable this mirrors, for reference. */
    ue: string;
    description: string;
    keys: PresetKey[];
};

/** Like UE's sg.* groups; every preset key belongs to exactly one group. */
export const SCALABILITY_GROUPS: ScalabilityGroup[] = [
    {
        key: 'view_distance',
        label: 'View distance',
        ue: 'sg.ViewDistanceQuality',
        description: 'Camera far plane and terrain level of detail.',
        keys: ['draw_distance', 'terrain_lod_bias'],
    },
    {
        key: 'anti_aliasing',
        label: 'Anti-aliasing',
        ue: 'sg.AntiAliasingQuality',
        description: 'Edge smoothing method.',
        keys: ['anti_aliasing'],
    },
    {
        key: 'post_processing',
        label: 'Post-processing',
        ue: 'sg.PostProcessQuality',
        description: 'Bloom and ambient occlusion.',
        keys: ['bloom', 'ambient_occlusion', 'ao_quality'],
    },
    {
        key: 'shadows',
        label: 'Shadows',
        ue: 'sg.ShadowQuality',
        description: 'Shadow map resolution and distance.',
        keys: ['shadow_quality', 'shadow_distance'],
    },
    {
        key: 'textures',
        label: 'Textures',
        ue: 'sg.TextureQuality',
        description: 'Terrain texture resolution and anisotropic filtering.',
        keys: ['terrain_texture_resolution', 'anisotropy'],
    },
    {
        key: 'effects',
        label: 'Effects',
        ue: 'sg.EffectsQuality',
        description: 'Weather particles, lightning and clouds.',
        keys: ['effects_quality', 'cloud_quality'],
    },
    {
        key: 'foliage',
        label: 'Foliage',
        ue: 'sg.FoliageQuality',
        description: 'Density, cull distance, shadows and LODs of vegetation.',
        keys: [
            'foliage_density',
            'foliage_distance',
            'foliage_shadow_distance',
            'foliage_lod_bias',
        ],
    },
    {
        key: 'shading',
        label: 'Shading',
        ue: 'sg.ShadingQuality',
        description: 'Water refraction and reflection quality.',
        keys: ['water_quality'],
    },
    {
        key: 'resolution',
        label: 'Resolution',
        ue: 'sg.ResolutionQuality',
        description: 'Render scale and sharpening.',
        keys: ['render_scale', 'sharpen'],
    },
];

function same(a: unknown, b: unknown): boolean {
    if (typeof a === 'number' || typeof b === 'number') {
        return Math.abs(Number(a) - Number(b)) < 1e-6;
    }

    // Selects may arrive as numbers or strings ('1024' vs 1024).
    return String(a) === String(b);
}

function matches(
    settings: Partial<GraphicsSettings>,
    values: Partial<PresetValues>,
    keys: PresetKey[],
): boolean {
    return keys.every((key) => same(settings[key], values[key]));
}

/** Values of a preset merged over the current settings (artistic / frame-rate fields are kept). */
export function applyPreset(
    preset: PresetName,
    current: GraphicsSettings,
): GraphicsSettings {
    return syncLegacy({
        ...current,
        ...PRESETS[preset],
        quality_preset: preset,
    });
}

/** Keeps the legacy `antialias` switch in step with `anti_aliasing`. */
export function syncLegacy(settings: GraphicsSettings): GraphicsSettings {
    return { ...settings, antialias: settings.anti_aliasing === 'msaa' };
}

/** The preset every quality field matches, or 'custom' when any value diverges. */
export function detectPreset(
    settings: Partial<GraphicsSettings>,
): QualityPreset {
    return (
        PRESET_NAMES.find((name) =>
            matches(settings, PRESETS[name], PRESET_KEYS),
        ) ?? 'custom'
    );
}

/** Settings with `quality_preset` recomputed from the field values. */
export function withDetectedPreset(
    settings: GraphicsSettings,
): GraphicsSettings {
    return { ...settings, quality_preset: detectPreset(settings) };
}

export function groupValues(
    group: ScalabilityGroup,
    level: QualityLevel,
): Partial<PresetValues> {
    const source = PRESETS[level];

    return Object.fromEntries(
        group.keys.map((key) => [key, source[key]]),
    ) as Partial<PresetValues>;
}

/** The level (low..epic) a group's fields match, or 'custom'. */
export function detectGroupLevel(
    settings: Partial<GraphicsSettings>,
    group: ScalabilityGroup,
): QualityLevel | 'custom' {
    return (
        QUALITY_LEVELS.find((level) =>
            matches(settings, PRESETS[level], group.keys),
        ) ?? 'custom'
    );
}

/** Set one scalability group to a level; `quality_preset` is recomputed. */
export function applyGroupLevel(
    settings: GraphicsSettings,
    group: ScalabilityGroup | ScalabilityGroupKey,
    level: QualityLevel,
): GraphicsSettings {
    const g =
        typeof group === 'string'
            ? SCALABILITY_GROUPS.find((x) => x.key === group)!
            : group;

    return withDetectedPreset(
        syncLegacy({ ...settings, ...groupValues(g, level) }),
    );
}

/**
 * Resolve the anti-aliasing mode, honouring the legacy `antialias` boolean for settings saved before
 * `anti_aliasing` existed.
 */
export function antiAliasingMode(
    settings: Partial<GraphicsSettings>,
): GraphicsSettings['anti_aliasing'] {
    return settings.anti_aliasing ?? (settings.antialias ? 'msaa' : 'off');
}

/** Fills fields missing from older manifests / local overrides with the High preset + neutral grading. */
export function normalizeGraphics(
    settings: Partial<GraphicsSettings>,
): GraphicsSettings {
    return {
        quality_preset: 'custom',
        bloom_intensity: 0.12,
        saturation: 1,
        contrast: 1,
        vignette: 0,
        dynamic_resolution: false,
        target_fps: 60,
        max_fps: 0,
        ...PRESETS.high,
        antialias: false,
        ...settings,
        anti_aliasing:
            settings.anti_aliasing ??
            (settings.antialias === undefined
                ? PRESETS.high.anti_aliasing
                : antiAliasingMode(settings)),
    } as GraphicsSettings;
}
