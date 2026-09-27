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

/** One row of POST /api/maps/{map}/ai/suggest-materials. */
export type SuggestedLayer = {
    slot: number;
    name: string;
    material_id: number | null;
    generate_prompt: string | null;
    category: string;
    tint: string;
    auto_min_height: number | null;
    auto_max_height: number | null;
    auto_min_slope: number | null;
    auto_max_slope: number | null;
    auto_priority: number;
    reason: string;
};

export type MaterialSuggestion = {
    summary: string;
    layers: SuggestedLayer[];
};

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
