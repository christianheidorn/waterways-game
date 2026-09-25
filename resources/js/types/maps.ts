import type { MapInfo } from '@game/shared/types';

export type SettingFieldType =
    | 'number'
    | 'boolean'
    | 'select'
    | 'color'
    | 'text';

export type SettingValue = number | boolean | string | null;

/** Mirrors App\Support\SettingField::toArray(). */
export type SettingField = {
    key: string;
    label: string;
    type: SettingFieldType;
    default: SettingValue;
    min?: number;
    max?: number;
    step?: number;
    options?: Record<string, string>;
    description?: string;
    unit?: string;
};

/** Mirrors App\Support\SettingGroup::toArray(). */
export type SettingGroup = {
    key: string;
    title: string;
    description: string;
    fields: SettingField[];
};

export type SettingValues = Record<string, SettingValue>;

/** Mirrors MapController::summary(). */
export type MapSummary = MapInfo & {
    description: string | null;
    is_default: boolean;
    terrain_progress: number;
    terrain_message: string | null;
    thumbnail_url: string | null;
    updated_at: string | null;
};

export type MapBounds = {
    south: number;
    west: number;
    north: number;
    east: number;
};

/** Mirrors MapController::detail(). */
export type MapDetail = MapSummary & {
    height_scale: number;
    import_water: boolean;
    lake_depth: number;
    river_depth: number;
    shore_angle: number;
    bank_angle: number;
    smoothing: number;
    seed: number;
    bounds: MapBounds | null;
    terrain_generated_at: string | null;
};
