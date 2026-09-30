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
    /** 0-1 amount of leaves blowing through the air (autumn). */
    falling_leaves: number;
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
    // ---- Camera & look: artistic post-processing per map (resources/game/core/PostFx.ts) ----
    /** Colour grade preset, applied as a generated 3D LUT. */
    color_grade: ColorGrade;
    /** 0-1 blend of the LUT over the neutral image. */
    color_grade_intensity: number;
    /** White balance shift: negative = cooler / bluer, positive = warmer. */
    white_balance: number;
    /** Exposure compensation in EV stops on top of `exposure` / auto exposure. */
    exposure_compensation: number;
    /** Auto exposure (eye adaptation) limits in EV around the base exposure, and adaptation speed. */
    auto_exposure_min_ev: number;
    auto_exposure_max_ev: number;
    auto_exposure_speed: number;
    god_ray_intensity: number;
    bloom_threshold: number;
    /** Depth of field: focus distance in metres (0 = autofocus on the screen centre), f-stop, max blur in px. */
    dof_focus_distance: number;
    dof_aperture: number;
    dof_max_blur: number;
    motion_blur_strength: number;
    lens_flare_intensity: number;
    chromatic_aberration: number;
    film_grain: number;
    /** Letterbox bars for cinematic framing (0 = off, else target aspect ratio e.g. 2.39). */
    letterbox: number;
};

export type ColorGrade =
    | 'neutral'
    | 'filmic'
    | 'golden_hour'
    | 'teal_orange'
    | 'cold_storm'
    | 'bleach_bypass'
    | 'vintage'
    | 'noir'
    | 'lush'
    | 'desert';

export type WeatherKind =
    | 'clear'
    | 'cloudy'
    | 'overcast'
    | 'fog'
    | 'rain'
    | 'storm'
    | 'snow'
    | 'autumn';

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
    /** Highest device pixel ratio rendered at (Retina / HiDPI); render_scale applies on top. */
    max_pixel_ratio: number;
    /** Graphics API: WebGPU when available (auto), or force one. Applies on reload. */
    renderer_backend: 'auto' | 'webgpu' | 'webgl';
    draw_distance: number;
    terrain_lod_bias: number;
    foliage_density: number;
    foliage_distance: number;
    water_quality: 'low' | 'medium' | 'high';
    terrain_texture_resolution: '512' | '1024' | '2048';
    /** Legacy MSAA switch; `anti_aliasing` wins when present. */
    antialias: boolean;
    /** 'taa' = temporal AA with camera reprojection (best for foliage shimmer). */
    anti_aliasing: 'off' | 'fxaa' | 'smaa' | 'msaa' | 'taa';
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
    // ---- Cinematic post-processing (quality switches; the artistic amounts live in EnvironmentSettings) ----
    auto_exposure: boolean;
    color_grading_lut: boolean;
    god_rays: 'off' | 'low' | 'medium' | 'high';
    depth_of_field: 'off' | 'low' | 'high';
    motion_blur: 'off' | 'low' | 'high';
    /** Screen-space reflections (wet ground, puddles, glossy surfaces). */
    ssr: 'off' | 'low' | 'high';
    /** Lens flare, chromatic aberration and film grain. */
    lens_effects: boolean;
    /** Screen-space contact shadows for small-scale grounding. */
    contact_shadows: boolean;
};

export type EditorSettings = {
    autosave_minutes: number;
    undo_steps: number;
    /** Automatic snapshots after saves: at most every N minutes (0 = off), the last `keep` are kept. */
    auto_snapshot_minutes?: number;
    auto_snapshot_keep?: number;
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
    /** Foliage that grows by itself wherever this layer is painted (not stored per instance). */
    ground_cover?: GroundCoverEntry[];
};

/** A build request for AI agents (App\\Models\\AgentRequest::toEditorArray). */
export type AgentRequestSummary = {
    id: number;
    status: 'open' | 'in_progress' | 'needs_input' | 'done' | 'dismissed';
    note: string;
    area: { x: number; z: number }[];
    camera: {
        position: { x: number; y: number; z: number };
        direction: { x: number; y: number; z: number };
    } | null;
    screenshot_url: string | null;
    reference_urls: string[];
    result_urls: string[];
    agent_message: string | null;
    created_at: string | null;
    updated_at: string | null;
};

/** A biome of the library (App\\Models\\Biome::toStudioArray). */
export type BiomeSummary = {
    id: number;
    name: string;
    description: string | null;
    starter: boolean;
    color: string;
    color_secondary: string;
    material: { id: number; name: string; thumbnail_url: string | null } | null;
    ground_cover: (Required<GroundCoverEntry> & { name: string | null })[];
};

export type GroundCoverEntry = {
    foliage_type_id: number;
    /** Multiplier on the type's density at full paint weight (0-4). */
    density: number;
    /** 0 = even spread … 1 = groves and clearings (default 0). */
    clustering?: number;
    /** Minimum distance between instances in metres (default 0: from the density alone). */
    spacing?: number;
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
    /** How instances block the player and camera (default auto: trunk for trees, footprint for rocks). */
    collision?: FoliageCollision;
    /** Collider radius at scale 1 (m), overriding the one measured from the model; null = measured. */
    collision_radius?: number | null;
};

/**
 * Foliage collision: `auto` (trees: trunk, rocks: bounds, everything else: none), `none`, `trunk` (a
 * cylinder around the trunk, radius measured from the model) or `bounds` (the model's footprint box).
 */
export type FoliageCollision = 'auto' | 'none' | 'trunk' | 'bounds';

/**
 * Prop collision: `auto` (a few boxes fitted to the model's surface, so doorways and arches stay open),
 * `box` (one box around it), `mesh` (its exact triangles, for walk-in buildings) or `none`.
 */
export type PropCollision = 'auto' | 'box' | 'mesh' | 'none';

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
    /** Placed props (PropsFile JSON). */
    props?: string | null;
    /** Roads and rivers as editable splines (SplinesFile JSON). */
    splines?: string | null;
};

/** A placeable model of the prop library (App\\Models\\PropModel::toGameArray). */
export type PropModelRef = {
    id: number;
    name: string;
    category: string;
    model_url: string | null;
    thumbnail_url: string | null;
    /** Real-world height the model is scaled to (m); null = its own size. */
    target_height: number | null;
    dimensions: { x: number; y: number; z: number } | null;
    /** Triangles, meshes (draws) and materials of one instance, measured on import (null: unknown). */
    triangles?: number | null;
    meshes?: number | null;
    materials?: number | null;
    /** How placed copies block the player and camera (default auto). */
    collision?: PropCollision;
};

/** One placed prop. The height follows the terrain (plus `offset`), so sculpting keeps it grounded. */
export type PropInstance = {
    id: string;
    /** PropModel id. */
    model: number;
    x: number;
    z: number;
    /** Radians, around the vertical axis. */
    yaw: number;
    /** Multiplier on the model's library size. */
    scale: number;
    /** Metres above (+) or into (−) the ground. */
    offset: number;
    /** Tilted to follow the terrain slope under it (default upright). */
    align?: boolean;
};

/** Serialized props file (maps/{id}/props.json). */
export type PropsFile = { version: 1; props: PropInstance[] };

export type GameManifest = {
    map: MapInfo;
    environment: EnvironmentSettings;
    settings: GameSettings;
    layers: TerrainLayer[];
    /** Placeable models (props) ready to use. */
    prop_models?: PropModelRef[];
    /** The biome library (reusable layer look + ground cover). */
    biomes?: BiomeSummary[];
    foliage_types: FoliageType[];
    /** The player character from the studio library (settings.player.character_id), if any. */
    character?: CharacterRef | null;
    assets: MapAssets;
    endpoints: {
        save_heightmap: string;
        save_splatmap: string;
        save_water: string;
        save_foliage: string;
        save_props?: string;
        save_splines?: string;
        save_meta: string;
        save_thumbnail: string;
        /** PATCH a foliage type's settings from the in-game editor: `${update_foliage_type}/{id}`. */
        update_foliage_type?: string;
        /** PATCH a terrain layer's ground cover: `${update_layers}/{id}/ground-cover`. */
        update_layers?: string;
        /** POST a new biome from a layer ({layer_id, name}); apply: `${update_layers}/{id}/biome`. */
        biomes?: string;
        /** Agent bridge: POST `${agent}/poll`, results to `${agent}/commands/{id}`. */
        agent?: string;
        /** Build requests for agents: GET / POST, PATCH / DELETE `${agent_requests}/{id}`. */
        agent_requests?: string;
        /** World tab: GET {group, values}, PATCH changed fields. Layer settings: PATCH `${update_layers}/{id}`. */
        environment?: string;
        /** Ready materials of the library (GET). */
        materials?: string;
        /** GET list, POST take one, POST `${snapshots}/auto` after saves, POST `${snapshots}/{id}/restore`. */
        snapshots?: string;
        /** GET the map templates. */
        map_templates?: string;
        /** POST a new map ({name, template?, brief?}). */
        create_map?: string;
    };
    /** Foliage types scattered on the first load of a template map (null: every type). */
    initial_foliage?: number[] | null;
};

/** Mirrors App\Support\SettingField::toArray() (World tab environment form). */
export type SettingFieldDef = {
    key: string;
    label: string;
    type: 'number' | 'boolean' | 'select' | 'color' | 'text';
    default: unknown;
    min?: number;
    max?: number;
    step?: number;
    options?: Record<string, string>;
    description?: string;
    unit?: string;
};

export type SettingGroupDef = {
    key: string;
    title: string;
    description: string;
    fields: SettingFieldDef[];
};

/** A library material for the World tab's material picker (Material::toGameArray + category). */
export type MaterialSummary = TerrainMaterialRef & { category: string | null };

/** App\Mcp\MapSnapshots::summary(). */
export type SnapshotSummary = {
    id: number;
    label: string;
    auto: boolean;
    /** Taken automatically while the user edited. */
    editing: boolean;
    created_at: string;
};

/** App\Support\MapTemplates::describe(). */
export type MapTemplateSummary = {
    key: string;
    name: string;
    summary: string;
    terrain: Record<string, unknown>;
    environment: Record<string, unknown>;
    biomes: Record<string, string>;
    foliage_kinds: string[];
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

/** A point of a spline's course (world metres). */
export type SplinePoint = { x: number; z: number };

/**
 * What a spline did to the terrain, so it can be edited or removed later: the grid samples it touched
 * (base64 Uint32 indices), the height it added there (base64 Float32, subtracted again on re-carve so
 * later sculpting survives) and the paint / water it replaced (base64 bytes / Float32).
 */
export type SplineFootprint = {
    cells: string;
    heights: string;
    splat?: string;
    water?: string;
};

/** Road surface profile: footpath, paved road with shoulders and banking, or rutted dirt track. */
export type RoadProfile = 'path' | 'road' | 'track';

/** An editable road / path (maps/{id}/splines.json). */
export type RoadSpline = {
    id: string;
    name: string;
    /** Control points; the course is a smooth curve through them. */
    points: SplinePoint[];
    /** Width of the road bed (m). */
    width: number;
    profile: RoadProfile;
    /** Terrain layer slot painted along it (null: no paint). */
    layer: number | null;
    /** Width of the soft banks on each side that blend into the terrain (m). */
    shoulder: number;
    /** 0-1: how much the bed leans into curves (superelevation). */
    bank: number;
    /** Length (m) over which the grade is evened out. */
    smoothing: number;
    /** Remove placed foliage along it. */
    clear_foliage: boolean;
    footprint?: SplineFootprint | null;
};

/** An editable river (maps/{id}/splines.json): carved downhill from its first point. */
export type RiverSpline = {
    id: string;
    name: string;
    points: SplinePoint[];
    /** Water width (m). */
    width: number;
    /** Channel depth below the surface (m). */
    depth: number;
    /** Width of the banks sloping into the channel (m). */
    bank: number;
    footprint?: SplineFootprint | null;
};

export type SplinesFile = {
    version: 1;
    roads: RoadSpline[];
    rivers: RiverSpline[];
};
