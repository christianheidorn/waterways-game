/**
 * Data contracts shared between the Laravel studio (React) and the game (Three.js).
 *
 * The PHP side produces these shapes in App\Support\GameManifest. Keep both in sync.
 *
 * World conventions
 * -----------------
 * - Units are metres. +X points east, +Y up, +Z points south (row 0 of every grid is the north edge).
 * - A map is a square of `size` metres centred on the origin.
 * - Grids (heightmap, water, splat) are `resolution x resolution` samples, row-major (z rows, x columns).
 *   Sample (col, row) sits at world (-size/2 + col * cell, -size/2 + row * cell) with cell = size / (resolution - 1).
 */

export type MapSource = 'flat' | 'procedural' | 'real_world';

export type TerrainStatus = 'ready' | 'queued' | 'importing' | 'failed';

export type EnvironmentSettings = {
    /** Hours, 0-24. */
    time_of_day: number;
    /** Degrees the sun path is rotated around the vertical axis. */
    sun_azimuth: number;
    /** Exponential fog density. */
    fog_density: number;
    /** 0 (clear) - 1 (overcast). */
    cloud_coverage: number;
    /** Sky turbidity (Preetham). */
    turbidity: number;
    exposure: number;
    wind_strength: number;
    water_shallow_color: string;
    water_deep_color: string;
    /** Metres of water after which the deep colour dominates. */
    water_clarity: number;
    water_roughness: number;
    water_reflectivity: number;
    water_refraction: number;
    wave_scale: number;
    wave_strength: number;
    wave_speed: number;
    wave_height: number;
    flow_speed: number;
    shore_foam: boolean;
    foam_width: number;
    foam_intensity: number;
    rapids_foam: boolean;
    ocean_enabled: boolean;
    sea_level: number;
    // ---- Weather (see resources/game/world/Weather.ts) ----
    weather: WeatherKind;
    /** 0-1 rain / snow amount (0 = none). */
    precipitation: number;
    /** Lightning strikes per minute (storms). */
    lightning_frequency: number;
    thunder_volume: number;
    /** Degrees, direction the wind blows towards (0 = north, 90 = east). */
    wind_direction: number;
    /** Extra fog that pools below this altitude above sea level (m); 0 disables height fog. */
    height_fog_height: number;
    height_fog_density: number;
    /** 0-1 how wet surfaces look (darker, glossier ground). */
    wetness: number;
};

export type WeatherKind =
    | 'clear'
    | 'cloudy'
    | 'overcast'
    | 'fog'
    | 'rain'
    | 'storm'
    | 'snow';

export type PlayerSettings = {
    walk_speed: number;
    run_speed: number;
    swim_speed: number;
    jump_velocity: number;
    gravity: number;
    character_height: number;
    max_slope: number;
    camera_distance: number;
    camera_height: number;
    fov: number;
    mouse_sensitivity: number;
    invert_y: boolean;
    character_color: string;
    character_model_url: string | null;
    /** Studio character library entry used as the player (App\\Models\\Character), null = procedural / URL. */
    character_id?: number | null;
};

/** A playable character from the studio's character library (App\\Models\\Character::toGameArray). */
export type CharacterRef = {
    id: number;
    name: string;
    model_url: string;
    /** Extra animation GLBs (same skeleton) per clip; clips inside model_url are also used. */
    animations: Partial<
        Record<'idle' | 'walk' | 'run' | 'jump' | 'swim', string>
    >;
    height: number;
};

export type ShadowQuality = 'off' | 'low' | 'medium' | 'high' | 'ultra';

export type QualityPreset =
    | 'low'
    | 'medium'
    | 'high'
    | 'epic'
    | 'cinematic'
    | 'custom';

export type QualityLevel = 'low' | 'medium' | 'high' | 'epic';

/**
 * Unreal-style scalability. `quality_preset` is informational (the studio / in-game menu fill every
 * field from resources/game/shared/graphicsPresets.ts); the game always reads the individual fields.
 */
export type GraphicsSettings = {
    quality_preset: QualityPreset;
    shadow_quality: ShadowQuality;
    shadow_distance: number;
    render_scale: number;
    draw_distance: number;
    terrain_lod_bias: number;
    foliage_density: number;
    foliage_distance: number;
    water_quality: 'low' | 'medium' | 'high';
    terrain_texture_resolution: '512' | '1024' | '2048';
    /** Legacy MSAA switch; `anti_aliasing` wins when present. */
    antialias: boolean;
    anti_aliasing: 'off' | 'fxaa' | 'smaa' | 'msaa';
    /** Texture anisotropic filtering (1-16). */
    anisotropy: number;
    bloom: boolean;
    bloom_intensity: number;
    ambient_occlusion: boolean;
    ao_quality: 'low' | 'medium' | 'high';
    /** Post-process colour grading. */
    sharpen: number;
    vignette: number;
    saturation: number;
    contrast: number;
    /** Lower render scale automatically to hold `target_fps`. */
    dynamic_resolution: boolean;
    target_fps: number;
    /** Frame rate cap, 0 = unlimited (vsync). */
    max_fps: number;
    /** Foliage beyond this distance (m) casts no shadows. */
    foliage_shadow_distance: number;
    /** > 1 keeps detailed foliage LODs further away. */
    foliage_lod_bias: number;
    /** Weather particles, lightning, splashes. */
    effects_quality: QualityLevel;
    cloud_quality: 'off' | 'low' | 'medium' | 'high';
};

export type EditorSettings = {
    autosave_minutes: number;
    undo_steps: number;
    fly_speed: number;
    show_stats: boolean;
};

export type GameSettings = {
    player: PlayerSettings;
    graphics: GraphicsSettings;
    editor: EditorSettings;
};

export type TerrainLayer = {
    id: number;
    /** Splat channel 0-7. */
    slot: number;
    name: string;
    color: string;
    color_secondary: string;
    roughness: number;
    /** World metres per noise repetition. */
    noise_scale: number;
    /** 0-1, how strongly the two colours are mixed by noise. */
    variation: number;
    bump: number;
    texture_url: string | null;
    /** Metres per texture repeat (defaults to the material's tile size when a material is assigned). */
    texture_scale: number;
    material_id: number | null;
    /** PBR material from the studio library; null → procedural colours above. */
    material: TerrainMaterialRef | null;
    /** Multiplied onto the material albedo. */
    tint: string;
    roughness_scale: number;
    normal_strength: number;
    /** Automatic painting rules (used by "Auto paint" and for fresh maps). */
    auto_min_height: number | null;
    auto_max_height: number | null;
    /** Degrees. */
    auto_min_slope: number | null;
    auto_max_slope: number | null;
    auto_priority: number;
};

export type MaterialMapName =
    | 'albedo'
    | 'normal'
    | 'roughness'
    | 'ao'
    | 'height';

/** A PBR material from the studio library (App\Models\Material::toGameArray). */
export type TerrainMaterialRef = {
    id: number;
    name: string;
    /** Root-relative image URLs; only albedo is guaranteed. Normal maps use the OpenGL (+Y) convention. */
    maps: Record<MaterialMapName, string | null>;
    /** Small preview image (falls back to the albedo map). */
    thumbnail_url?: string | null;
    tile_size: number;
    tint: string;
    roughness_scale: number;
    normal_strength: number;
    height_contrast: number;
};

export type FoliageKind =
    | 'conifer'
    | 'broadleaf'
    | 'palm'
    | 'bush'
    | 'grass'
    | 'flower'
    | 'reed'
    | 'rock';

export type FoliageAssetStyle = 'realistic' | 'stylized';

/**
 * A baked foliage model from the studio's foliage asset library (App\Models\FoliageAsset::toGameArray).
 *
 * Baked GLBs (see resources/game/tools/FoliageBaker.ts) contain top-level nodes named "LOD0", "LOD1", …
 * ordered from most to least detailed; the last one is usually a crossed-card impostor. Units are metres,
 * the pivot sits at the base of the model (y = 0) and +Y is up.
 */
export type FoliageAssetRef = {
    id: number;
    name: string;
    style: FoliageAssetStyle;
    model_url: string | null;
    thumbnail_url: string | null;
    /** Real-world height of the baked model in metres (before per-instance scale). */
    height: number | null;
    /** Triangles per LOD. */
    triangles: number[];
    /** Fraction of cull distance where each LOD starts (LOD0 = 0). */
    lod_distances: number[];
};

export type FoliageType = {
    id: number;
    name: string;
    kind: FoliageKind;
    color: string;
    color_secondary: string;
    /** Model to render (the asset's baked GLB when an asset is linked, else a legacy uploaded GLB). */
    model_url: string | null;
    foliage_asset_id?: number | null;
    asset?: FoliageAssetRef | null;
    /** Multiplied onto model materials (white = unchanged). */
    tint?: string;
    min_scale: number;
    max_scale: number;
    /** Instances per 100 m² when painting at full strength. */
    density: number;
    min_slope: number;
    max_slope: number;
    min_height: number | null;
    max_height: number | null;
    align_to_normal: boolean;
    random_yaw: boolean;
    cast_shadows: boolean;
    cull_distance: number;
    /** Whether instances may be placed under water (e.g. reeds, rocks). */
    allow_underwater: boolean;
};

export type MapInfo = {
    id: number;
    name: string;
    slug: string;
    source: MapSource;
    resolution: number;
    size: number;
    center_lat: number | null;
    center_lng: number | null;
    min_height: number;
    max_height: number;
    spawn: { x: number; z: number; yaw: number } | null;
    terrain_status: TerrainStatus;
    revision: number;
};

export type MapAssets = {
    heightmap: string;
    splatmap: string | null;
    water: string | null;
    foliage: string | null;
    /** ESA WorldCover class per heightmap sample (Uint8, resolution²), real-world maps only. */
    landcover: string | null;
};

export type GameManifest = {
    map: MapInfo;
    environment: EnvironmentSettings;
    settings: GameSettings;
    layers: TerrainLayer[];
    foliage_types: FoliageType[];
    /** The player character from the studio library (settings.player.character_id), if any. */
    character?: CharacterRef | null;
    assets: MapAssets;
    endpoints: {
        save_heightmap: string;
        save_splatmap: string;
        save_water: string;
        save_foliage: string;
        save_meta: string;
        save_thumbnail: string;
        /** PATCH a foliage type's settings from the in-game editor: `${update_foliage_type}/{id}`. */
        update_foliage_type?: string;
    };
};

/** Serialized foliage file (maps/{id}/foliage.json). */
export type FoliageFile = {
    version: 1;
    /** foliage type id → flat list of [x, y, z, yaw, scale, tiltX, tiltZ] per instance. */
    instances: Record<string, number[]>;
};

export const FOLIAGE_STRIDE = 7;

/** Sentinel written into the water grid where there is no water. */
export const NO_WATER = -100000;

/** Number of splat channels (two RGBA8 textures). */
export const SPLAT_CHANNELS = 8;
