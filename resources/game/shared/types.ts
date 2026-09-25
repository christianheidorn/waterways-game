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
    ocean_enabled: boolean;
    sea_level: number;
};

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
};

export type ShadowQuality = 'off' | 'low' | 'medium' | 'high' | 'ultra';

export type GraphicsSettings = {
    shadow_quality: ShadowQuality;
    shadow_distance: number;
    render_scale: number;
    draw_distance: number;
    terrain_lod_bias: number;
    foliage_density: number;
    foliage_distance: number;
    antialias: boolean;
    bloom: boolean;
    ambient_occlusion: boolean;
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
    texture_scale: number;
    /** Automatic painting rules (used by "Auto paint" and for fresh maps). */
    auto_min_height: number | null;
    auto_max_height: number | null;
    /** Degrees. */
    auto_min_slope: number | null;
    auto_max_slope: number | null;
    auto_priority: number;
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

export type FoliageType = {
    id: number;
    name: string;
    kind: FoliageKind;
    color: string;
    color_secondary: string;
    model_url: string | null;
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
};

export type GameManifest = {
    map: MapInfo;
    environment: EnvironmentSettings;
    settings: GameSettings;
    layers: TerrainLayer[];
    foliage_types: FoliageType[];
    assets: MapAssets;
    endpoints: {
        save_heightmap: string;
        save_splatmap: string;
        save_water: string;
        save_foliage: string;
        save_meta: string;
        save_thumbnail: string;
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
