import type { MaterialMapName } from '@game/shared/types';
import type { CategoryOption, MaterialSource } from '@/types';

export const MATERIAL_SOURCE_LABELS: Record<MaterialSource, string> = {
    upload: 'Upload',
    polyhaven: 'Poly Haven',
    ambientcg: 'ambientCG',
    ai: 'AI',
};

export const MATERIAL_MAPS: { key: MaterialMapName; label: string }[] = [
    { key: 'albedo', label: 'Albedo' },
    { key: 'normal', label: 'Normal' },
    { key: 'roughness', label: 'Roughness' },
    { key: 'ao', label: 'AO' },
    { key: 'height', label: 'Height' },
];

/** Mirrors App\Models\Material::CATEGORIES (fallback when a page does not pass them). */
export const DEFAULT_CATEGORIES: CategoryOption[] = [
    { value: 'grass', label: 'Grass' },
    { value: 'forest', label: 'Forest floor' },
    { value: 'soil', label: 'Soil & dirt' },
    { value: 'rock', label: 'Rock & cliff' },
    { value: 'gravel', label: 'Gravel & pebbles' },
    { value: 'sand', label: 'Sand' },
    { value: 'mud', label: 'Mud' },
    { value: 'snow', label: 'Snow & ice' },
    { value: 'field', label: 'Fields & crops' },
    { value: 'urban', label: 'Paved & urban' },
    { value: 'other', label: 'Other' },
];

export function categoryLabel(
    categories: CategoryOption[],
    value: string,
): string {
    return categories.find((c) => c.value === value)?.label ?? value;
}

/** Map types detected from file names; `packed` = ARM/ORM (AO, roughness, metal in RGB). */
export type DetectedMap = MaterialMapName | 'packed' | null;

/**
 * Same file-name heuristics as the backend upload importer:
 * albedo/basecolor/diffuse/diff/color/col, normal/nor/nrm (+dx), rough, ao/occlusion,
 * height/disp/displacement/bump, arm/orm.
 */
export function detectMapType(fileName: string): {
    map: DetectedMap;
    directX: boolean;
} {
    const base = fileName.replace(/\.[a-z0-9]+$/i, '');
    const tokens = base
        .replace(/([a-z])([A-Z])/g, '$1_$2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
    const has = (test: (t: string) => boolean) => tokens.some(test);
    const directX = has((t) => t === 'dx' || t.endsWith('dx'));

    if (has((t) => t === 'arm' || t === 'orm')) {
        return { map: 'packed', directX };
    }

    if (has((t) => t.startsWith('normal') || t === 'nor' || t === 'nrm')) {
        return { map: 'normal', directX };
    }

    if (has((t) => t.startsWith('rough'))) {
        return { map: 'roughness', directX };
    }

    if (has((t) => t === 'ao' || t.includes('occlusion'))) {
        return { map: 'ao', directX };
    }

    if (
        has(
            (t) =>
                t === 'height' ||
                t.startsWith('disp') ||
                t === 'displacement' ||
                t === 'bump',
        )
    ) {
        return { map: 'height', directX };
    }

    if (
        has(
            (t) =>
                t === 'albedo' ||
                t === 'basecolor' ||
                t === 'diffuse' ||
                t === 'diff' ||
                t === 'color' ||
                t === 'colour' ||
                t === 'col',
        )
    ) {
        return { map: 'albedo', directX };
    }

    return { map: null, directX };
}

export const DETECTED_LABELS: Record<Exclude<DetectedMap, null>, string> = {
    albedo: 'Albedo',
    normal: 'Normal',
    roughness: 'Roughness',
    ao: 'Ambient occlusion',
    height: 'Height',
    packed: 'Packed ARM/ORM',
};

/** ESA WorldCover 2021 classes with their official colours. */
export const LANDCOVER_CLASSES: {
    code: string;
    label: string;
    color: string;
}[] = [
    { code: '10', label: 'Tree cover', color: '#006400' },
    { code: '20', label: 'Shrubland', color: '#ffbb22' },
    { code: '30', label: 'Grassland', color: '#ffff4c' },
    { code: '40', label: 'Cropland', color: '#f096ff' },
    { code: '50', label: 'Built-up', color: '#fa0000' },
    { code: '60', label: 'Bare / sparse vegetation', color: '#b4b4b4' },
    { code: '70', label: 'Snow and ice', color: '#f0f0f0' },
    { code: '80', label: 'Permanent water', color: '#0064c8' },
    { code: '90', label: 'Herbaceous wetland', color: '#0096a0' },
    { code: '95', label: 'Mangroves', color: '#00cf75' },
    { code: '100', label: 'Moss and lichen', color: '#fae6a0' },
];

/** JSON endpoints (stateless `api` routes). */
export const materialApi = {
    browse: (source: string) => `/api/materials/browse/${source}`,
    show: (id: number) => `/api/materials/${id}`,
    models: () => '/api/ai/models',
    enhancePrompt: () => '/api/ai/enhance-prompt',
    suggestMaterials: (map: string) => `/api/maps/${map}/ai/suggest-materials`,
    review: (map: string) => `/api/maps/${map}/ai/review`,
    applyChanges: (map: string) => `/api/maps/${map}/ai/apply-changes`,
};
