import type {
    EnvironmentSettings,
    MaterialMapName,
    TerrainLayer,
    TerrainMaterialRef,
} from '@game/shared/types';

export type MaterialSource = 'upload' | 'polyhaven' | 'ambientcg' | 'ai';
export type MaterialStatus = 'ready' | 'processing' | 'failed';
export type BrowseSource = 'polyhaven' | 'ambientcg';
export type AiImageResolution = '1K' | '2K';

/** Mirrors App\Models\Material::toStudioArray(). */
export type MaterialStudio = TerrainMaterialRef & {
    slug: string;
    category: string;
    source: MaterialSource;
    source_ref: string | null;
    source_url: string | null;
    author: string | null;
    license: string | null;
    tags: string[];
    resolution: number | null;
    thumbnail_url: string | null;
    status: MaterialStatus;
    status_message: string | null;
    ai_prompt: string | null;
    ai_model: string | null;
    parent_id: number | null;
    layers_count: number | null;
    created_at: string | null;
};

export type { MaterialMapName };

export type CategoryOption = { value: string; label: string };

/** AI configuration shared with the material library page. */
export type AiConfig = {
    configured: boolean;
    image_model: string;
    text_model: string;
    image_resolution: AiImageResolution;
};

/** settings/ai page props. */
export type AiSettings = AiConfig & {
    key_hint: string | null;
    key_source: 'studio' | 'env' | null;
};

/** GET /api/materials/browse/{source}. */
export type BrowseItem = {
    ref: string;
    name: string;
    thumbnail_url: string | null;
    categories: string[];
    tags: string[];
    author: string | null;
    license: string | null;
    source_url: string | null;
    max_resolution: string | number | null;
};

export type BrowseResponse = {
    items: BrowseItem[];
    page: number;
    has_more: boolean;
};

export type AiImageModel = {
    id: string;
    name: string;
    resolutions?: string[];
    supports_references?: boolean;
    pricing?: Record<string, string | number> | string | null;
};

export type AiTextModel = { id: string; name: string; vision: boolean };

/** GET /api/ai/models. */
export type AiModels = {
    configured: boolean;
    image: AiImageModel[];
    text: AiTextModel[];
};

export type PlanAction = 'keep' | 'change' | 'remove' | 'add';

export type PlanLibraryMaterial = {
    type: 'library';
    material_id: number;
    name: string;
    category: string;
    source: MaterialSource;
    status: MaterialStatus;
    tile_size: number;
    thumbnail_url: string | null;
};

export type PlanImportMaterial = {
    type: 'import';
    source: BrowseSource;
    ref: string;
    resolution: '1k' | '2k';
    name: string;
    category: string;
    thumbnail_url: string | null;
    /** Measured scan width in metres (null = unknown). */
    tile_size: number | null;
    /** Aerial / very large scan: the plan picks a ground-level tile size. */
    aerial: boolean;
    license: string;
    source_url: string;
};

export type PlanGenerateMaterial = {
    type: 'generate';
    prompt: string;
    category: string;
};

export type PlanMaterial =
    | PlanLibraryMaterial
    | PlanImportMaterial
    | PlanGenerateMaterial
    | { type: 'procedural' };

export type PlanSettings = {
    /** Metres per texture repeat. */
    texture_scale: number;
    tint: string;
    roughness_scale: number;
    normal_strength: number;
    auto_min_height: number | null;
    auto_max_height: number | null;
    auto_min_slope: number | null;
    auto_max_slope: number | null;
    auto_priority: number;
};

export type PlanCurrent = {
    name: string;
    color: string;
    color_secondary: string;
    material: PlanMaterial;
    settings: PlanSettings;
    /** Share of the painted terrain in percent (null without a splat map). */
    coverage: number | null;
};

/** One slot of the AI layer plan. */
export type PlanLayer = {
    slot: number;
    action: PlanAction;
    name: string;
    reason: string;
    /** null for removals. */
    material: PlanMaterial | null;
    settings: PlanSettings | null;
    /** null for layers added to a free slot. */
    current: PlanCurrent | null;
};

/** POST /api/maps/{map}/ai/suggest-materials. */
export type LayerPlan = {
    summary: string;
    notes: string[];
    layers: PlanLayer[];
    /** WorldCover class → slot, real-world maps with land cover only. */
    landcover_mapping: Record<string, number> | null;
    current_landcover_mapping: Record<string, number> | null;
    estimate: { imports: number; generations: number; generation_note: string };
    /** Removing a slot painted above this percentage is unticked by default. */
    painted_threshold: number;
    unavailable_sources: string[];
};

export type RepaintMode = 'none' | 'auto_rules' | 'landcover';

export type AiLayerChange = {
    slot: number;
    tint?: string;
    roughness_scale?: number;
    normal_strength?: number;
    texture_scale?: number;
    material_id?: number | null;
};

export type AiChanges = {
    environment?: Partial<EnvironmentSettings>;
    layers?: AiLayerChange[];
};

export type AiReviewSuggestion = {
    title: string;
    detail: string;
    changes: AiChanges;
};

/** POST /api/maps/{map}/ai/review. */
export type AiReview = {
    summary: string;
    score: number;
    suggestions: AiReviewSuggestion[];
};

/** POST /api/maps/{map}/ai/apply-changes. */
export type AiAppliedChanges = {
    environment: EnvironmentSettings;
    layers: TerrainLayer[];
};
