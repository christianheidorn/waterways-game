import type {
    FoliageAssetRef,
    FoliageAssetStyle,
    FoliageKind,
} from '@game/shared/types';

export type FoliageAssetSource = 'polyhaven' | 'upload' | 'ai';
export type FoliageAssetStatus =
    | 'queued'
    | 'processing'
    | 'awaiting_bake'
    | 'ready'
    | 'failed';

/** Mirrors App\Models\FoliageAsset::toStudioArray(). */
export type FoliageAssetStudio = FoliageAssetRef & {
    kind: FoliageKind;
    source: FoliageAssetSource;
    source_ref: string | null;
    source_url: string | null;
    author: string | null;
    license: string | null;
    tags: string[];
    source_type: 'model' | 'card';
    source_file_url: string | null;
    bake_options: { key_background?: boolean };
    target_height: number | null;
    meta: {
        height?: number;
        width?: number;
        triangles?: number[];
        source_triangles?: number;
        source_polycount?: number;
        texture_size?: number;
        lod_distances?: number[];
        model_bytes?: number;
    };
    status: FoliageAssetStatus;
    status_message: string | null;
    ai_prompt: string | null;
    ai_model: string | null;
    types_count: number | null;
    created_at: string | null;
    updated_at: string | null;
};

export type { FoliageAssetStyle };

/** One Poly Haven model (App\Services\Foliage\PolyHavenModels::summary). */
export type FoliageBrowseItem = {
    ref: string;
    name: string;
    thumbnail_url: string;
    categories: string[];
    tags: string[];
    author: string;
    license: string;
    source_url: string;
    polycount: number;
    too_heavy: boolean;
    kind: FoliageKind;
    imported_asset_id: number | null;
};

export type FoliageBrowseResponse = {
    items: FoliageBrowseItem[];
    page: number;
    has_more: boolean;
    total: number;
};

export type FoliageMapOption = {
    id: number;
    name: string;
    source: string;
    real_world: boolean;
};

// ---- AI foliage plan (App\Services\Ai\FoliagePlanner) ----

export type FoliagePlanAction = 'keep' | 'change' | 'remove' | 'add';

export type FoliagePlanAsset =
    | { type: 'current' }
    | {
          type: 'library';
          asset_id: number;
          name: string;
          style: FoliageAssetStyle;
          source: FoliageAssetSource;
          status: FoliageAssetStatus;
          thumbnail_url: string | null;
          height: number | null;
      }
    | {
          type: 'import';
          source: 'polyhaven';
          ref: string;
          name: string;
          thumbnail_url: string | null;
          polycount: number | null;
          source_url: string;
      }
    | { type: 'generate'; prompt: string }
    | { type: 'procedural' }
    | { type: 'upload' };

export type FoliagePlanSettings = {
    size_min_m: number;
    size_max_m: number;
    density: number;
    min_slope: number;
    max_slope: number;
    min_height: number | null;
    max_height: number | null;
    cull_distance: number;
    color: string;
    color_secondary: string;
    tint: string;
    align_to_normal: boolean;
    random_yaw: boolean;
    cast_shadows: boolean;
    allow_underwater: boolean;
};

export type FoliagePlanRow = {
    action: FoliagePlanAction;
    type_id: number | null;
    name: string;
    kind: FoliageKind;
    reason: string;
    asset: FoliagePlanAsset | null;
    settings: FoliagePlanSettings | null;
    current: {
        name: string;
        kind: FoliageKind;
        asset: FoliagePlanAsset;
        settings: FoliagePlanSettings;
    } | null;
    usage: { maps: number; instances: number } | null;
};

export type FoliagePlan = {
    summary: string;
    notes: string[];
    types: FoliagePlanRow[];
    estimate: {
        imports: number;
        generations: number;
        generation_note: string;
    };
    brief: {
        region: string | null;
        style: number;
        map_id: number | null;
        map_name: string | null;
    };
    unavailable_sources: string[];
};
