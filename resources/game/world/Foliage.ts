import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FOLIAGE_STRIDE } from '../shared/types';
import type { FoliageFile, FoliageType } from '../shared/types';
import { mulberry32, SimplexNoise } from '../util/noise';
import { createFoliageGeometry } from './FoliageGeometry';
import type { Heightfield } from './Heightfield';

const CELL_SIZE = 128;

type Cell = {
    key: string;
    cx: number;
    cz: number;
    data: number[];
    mesh: THREE.InstancedMesh | null;
    dirty: boolean;
    lod: number;
    box: THREE.Box3;
};

type TypeRenderer = {
    type: FoliageType;
    lods: THREE.BufferGeometry[];
    lodDistances: number[];
    /** Material(s) per LOD — procedural LODs share one material, baked models have one set per LOD. */
    lodMaterials: (THREE.Material | THREE.Material[])[];
    /**
     * Wind-aware depth material for procedural meshes. null for models: three then builds a depth
     * variant per material that honours map + alphaTest, so leaf cards cast leaf-shaped shadows.
     */
    depthMaterial: THREE.MeshDepthMaterial | null;
    /** true once a GLB model replaced the procedural geometry. */
    model: boolean;
    disposed: boolean;
    cells: Map<string, Cell>;
};

export type FoliagePlacementContext = {
    heights: Heightfield;
    waterLevelAt: (x: number, z: number) => number | null;
    /** ESA WorldCover class at a world position (0 = unknown), for real-world maps. */
    landCoverAt?: (x: number, z: number) => number;
};

/**
 * How likely each foliage kind grows on each ESA WorldCover class (10 trees, 20 shrubland,
 * 30 grassland, 40 cropland, 50 built-up, 60 bare, 70 snow, 80 water, 90 wetland, 95 mangroves,
 * 100 moss & lichen). Unknown classes fall back to the procedural masks.
 */
const LAND_COVER_AFFINITY: Record<string, Record<number, number>> = {
    tree: {
        10: 1,
        95: 0.9,
        20: 0.18,
        30: 0.04,
        40: 0.01,
        60: 0.03,
        90: 0.08,
        100: 0.04,
        50: 0.01,
        70: 0,
        80: 0,
    },
    bush: {
        20: 1,
        10: 0.5,
        30: 0.25,
        40: 0.05,
        60: 0.15,
        90: 0.4,
        95: 0.6,
        100: 0.3,
        50: 0.02,
        70: 0,
        80: 0,
    },
    grass: {
        30: 1,
        100: 0.9,
        20: 0.7,
        40: 0.5,
        10: 0.3,
        90: 0.8,
        95: 0.2,
        60: 0.12,
        50: 0.05,
        70: 0,
        80: 0,
    },
    flower: {
        30: 1,
        100: 0.6,
        20: 0.4,
        40: 0.15,
        10: 0.1,
        90: 0.3,
        60: 0.05,
        50: 0.02,
        70: 0,
        80: 0,
    },
    reed: {
        90: 1,
        95: 0.6,
        80: 1,
        30: 0.4,
        20: 0.4,
        40: 0.2,
        10: 0.2,
        60: 0.1,
        50: 0,
        70: 0,
        100: 0.3,
    },
    rock: {
        60: 1.6,
        70: 0.4,
        100: 0.9,
        20: 0.8,
        30: 0.6,
        10: 0.7,
        40: 0.2,
        50: 0.1,
        90: 0.2,
        80: 0.5,
        95: 0.1,
    },
};

function affinityGroup(kind: string): keyof typeof LAND_COVER_AFFINITY {
    return kind === 'conifer' || kind === 'broadleaf' || kind === 'palm'
        ? 'tree'
        : (kind as keyof typeof LAND_COVER_AFFINITY);
}

/**
 * Instanced foliage split into spatial cells per foliage type, so painting only rebuilds nearby
 * batches and distant cells can be culled or drawn with a cheaper LOD.
 */
export class Foliage {
    readonly group = new THREE.Group();
    densityScale = 1;
    distanceScale = 1;
    /** Called before a cell's instance list changes (used for undo snapshots). */
    onBeforeModify: ((typeId: number, cellKey: string) => void) | null = null;
    private renderers = new Map<number, TypeRenderer>();
    private orphaned = new Map<number, Map<string, number[]>>();
    private uniforms = {
        uTime: { value: 0 },
        uWind: { value: 0.4 },
        uCamPos: { value: new THREE.Vector3() },
    };
    private gltf = new GLTFLoader();
    private random = mulberry32(Date.now() & 0xffff);

    constructor() {
        this.group.name = 'Foliage';
    }

    setTypes(types: FoliageType[]): void {
        const keep = new Set(types.map((t) => t.id));

        for (const [id, renderer] of this.renderers) {
            if (!keep.has(id)) {
                // Keep the data so re-adding the type (or saving) doesn't lose placements.
                const cells = new Map<string, number[]>();

                for (const cell of renderer.cells.values()) {
                    cells.set(cell.key, cell.data);
                }

                this.orphaned.set(id, cells);
                this.disposeRenderer(renderer);
                this.renderers.delete(id);
            }
        }

        for (const type of types) {
            const existing = this.renderers.get(type.id);

            if (existing && sameVisuals(existing.type, type)) {
                existing.type = type;
                continue;
            }

            const cells = new Map<string, Cell>();

            if (existing) {
                for (const cell of existing.cells.values()) {
                    cells.set(cell.key, { ...cell, mesh: null, dirty: true });
                }

                this.disposeRenderer(existing);
            } else {
                const orphan = this.orphaned.get(type.id);

                if (orphan) {
                    for (const [key, data] of orphan) {
                        cells.set(key, this.makeCell(key, data));
                    }

                    this.orphaned.delete(type.id);
                }
            }

            this.renderers.set(type.id, this.createRenderer(type, cells));
        }
    }

    load(file: FoliageFile | null): void {
        for (const renderer of this.renderers.values()) {
            for (const cell of renderer.cells.values()) {
                this.removeCellMesh(cell);
            }

            renderer.cells.clear();
        }

        this.orphaned.clear();

        if (!file) {
            return;
        }

        for (const [id, flat] of Object.entries(file.instances)) {
            const typeId = Number(id);
            const renderer = this.renderers.get(typeId);
            const target = renderer ? null : new Map<string, number[]>();

            for (
                let i = 0;
                i + FOLIAGE_STRIDE <= flat.length;
                i += FOLIAGE_STRIDE
            ) {
                const key = cellKey(flat[i], flat[i + 2]);

                if (renderer) {
                    this.cellFor(renderer, key).data.push(
                        ...flat.slice(i, i + FOLIAGE_STRIDE),
                    );
                } else {
                    const list = target!.get(key) ?? [];
                    list.push(...flat.slice(i, i + FOLIAGE_STRIDE));
                    target!.set(key, list);
                }
            }

            if (target) {
                this.orphaned.set(typeId, target);
            }
        }
    }

    serialize(): FoliageFile {
        const instances: Record<string, number[]> = {};
        const round = (v: number) => Math.round(v * 1000) / 1000;

        const add = (id: number, data: number[]) => {
            const list = (instances[id] ??= []);

            for (const v of data) {
                list.push(round(v));
            }
        };

        for (const [id, renderer] of this.renderers) {
            for (const cell of renderer.cells.values()) {
                add(id, cell.data);
            }
        }

        for (const [id, cells] of this.orphaned) {
            for (const data of cells.values()) {
                add(id, data);
            }
        }

        return { version: 1, instances };
    }

    get instanceCount(): number {
        let count = 0;

        for (const renderer of this.renderers.values()) {
            for (const cell of renderer.cells.values()) {
                count += cell.data.length / FOLIAGE_STRIDE;
            }
        }

        return count;
    }

    setWind(strength: number): void {
        this.uniforms.uWind.value = strength;
    }

    /** Paint instances of the given types into a circle, respecting each type's rules and density. */
    paint(
        ctx: FoliagePlacementContext,
        typeIds: number[],
        x: number,
        z: number,
        radius: number,
        strength: number,
        dt: number,
        weightAt: (d: number) => number,
    ): void {
        const area = Math.PI * radius * radius;

        for (const id of typeIds) {
            const renderer = this.renderers.get(id);

            if (!renderer) {
                continue;
            }

            const type = renderer.type;
            const target = (type.density / 100) * area * strength;
            const existing = this.countInCircle(renderer, x, z, radius);
            const budget = Math.min(
                Math.ceil((target - existing) * Math.min(1, dt * 6)),
                400,
            );

            if (budget <= 0) {
                continue;
            }

            const spacing =
                Math.sqrt(100 / Math.max(0.01, type.density)) * 0.45;
            let placed = 0;

            for (
                let attempt = 0;
                attempt < budget * 4 && placed < budget;
                attempt++
            ) {
                const a = this.random() * Math.PI * 2;
                const d = Math.sqrt(this.random()) * radius;

                if (this.random() > weightAt(d)) {
                    continue;
                }

                const px = x + Math.cos(a) * d;
                const pz = z + Math.sin(a) * d;

                if (this.tryPlace(ctx, renderer, px, pz, spacing)) {
                    placed++;
                }
            }
        }
    }

    /**
     * Procedurally scatter foliage over the whole map using each type's rules plus natural masks:
     * trees cluster into forests, bushes favour forest edges, reeds hug shorelines, rocks prefer slopes.
     * Existing instances of the given types are replaced.
     */
    populate(
        ctx: FoliagePlacementContext,
        typeIds: number[],
        seed = 1,
    ): number {
        const hf = ctx.heights;
        const noise = new SimplexNoise(seed * 31 + 7);
        const rand = mulberry32(seed * 977 + 13);
        const size = hf.size;
        const half = hf.half;
        const forest = (x: number, z: number) =>
            noise.fbm(x / 420, z / 420, 4) * 0.8 +
            noise.noise2D(x / 90 + 50, z / 90) * 0.2;
        const meadow = (x: number, z: number) =>
            noise.fbm(x / 160 + 100, z / 160 - 40, 3);
        const nearWater = (x: number, z: number) => {
            for (const [dx, dz] of [
                [0, 0],
                [7, 0],
                [-7, 0],
                [0, 7],
                [0, -7],
            ]) {
                if (ctx.waterLevelAt(x + dx, z + dz) !== null) {
                    return true;
                }
            }

            return false;
        };
        let total = 0;

        for (const id of typeIds) {
            const renderer = this.renderers.get(id);

            if (!renderer) {
                continue;
            }

            const type = renderer.type;
            const kindFactor: Record<string, number> = {
                conifer: 1,
                broadleaf: 1,
                palm: 0.6,
                bush: 0.35,
                grass: 0.12,
                flower: 0.12,
                reed: 0.5,
                rock: 0.6,
            };
            const cap: Record<string, number> = {
                conifer: 30000,
                broadleaf: 25000,
                palm: 8000,
                bush: 25000,
                grass: 140000,
                flower: 25000,
                reed: 20000,
                rock: 8000,
            };
            const density = Math.max(
                0.001,
                type.density * (kindFactor[type.kind] ?? 0.5),
            );
            const spacing = Math.max(0.6, Math.sqrt(100 / density));
            const steps = Math.floor(size / spacing);
            const maxCount = cap[type.kind] ?? 20000;
            const typeSeed = id * 0.37;

            for (const cell of renderer.cells.values()) {
                this.onBeforeModify?.(id, cell.key);
                cell.data = [];
                cell.dirty = true;
            }

            let count = 0;

            for (let j = 0; j < steps && count < maxCount; j++) {
                for (let i = 0; i < steps && count < maxCount; i++) {
                    const x = -half + (i + rand()) * spacing;
                    const z = -half + (j + rand()) * spacing;
                    const f = forest(x + typeSeed * 1000, z);
                    let p = 1;

                    switch (type.kind) {
                        case 'conifer':
                        case 'broadleaf':
                        case 'palm':
                            p = smooth01(
                                0.05,
                                0.35,
                                f +
                                    (type.kind === 'broadleaf'
                                        ? noise.noise2D(x / 300, z / 300 + 9) *
                                          0.25
                                        : 0),
                            );
                            break;
                        case 'bush':
                            p =
                                0.15 +
                                smooth01(-0.1, 0.15, f) *
                                    (1 - smooth01(0.3, 0.5, f)) *
                                    0.85;
                            break;
                        case 'grass':
                            p =
                                smooth01(-0.45, 0.1, meadow(x, z)) *
                                (1 - smooth01(0.25, 0.5, f) * 0.7);
                            break;
                        case 'flower':
                            p =
                                smooth01(0.2, 0.55, meadow(x + 300, z)) *
                                (1 - smooth01(0.1, 0.3, f));
                            break;
                        case 'reed':
                            p = nearWater(x, z) ? 0.9 : 0;
                            break;
                        case 'rock':
                            p = 0.25 + smooth01(15, 40, hf.slope(x, z)) * 0.75;
                            break;
                    }

                    // Real-world maps: follow the actual land cover (forests, meadows, wetlands…).
                    const lc = ctx.landCoverAt?.(x, z) ?? 0;

                    if (lc !== 0) {
                        const group = affinityGroup(type.kind);
                        const affinity =
                            LAND_COVER_AFFINITY[group]?.[lc] ?? 0.5;

                        if (group === 'tree' && lc === 10) {
                            // Inside mapped forest: dense, with small natural clearings.
                            p = 0.55 + p * 0.45;
                        }

                        p *= affinity;
                    }

                    if (rand() > p) {
                        continue;
                    }

                    if (this.tryPlace(ctx, renderer, x, z, 0, false, true)) {
                        count++;
                    }
                }
            }

            for (const cell of renderer.cells.values()) {
                shuffleInstances(cell.data, rand);
            }

            total += count;
        }

        return total;
    }

    /**
     * Fill a circle as if painted at full strength until saturated (used by the foliage preview).
     * Every candidate spot is subject to the type's rules and spacing, so forbidden ground stays
     * empty and allowed ground ends up at the configured density. Deterministic for a given seed.
     * Returns the number of instances placed.
     */
    fill(
        ctx: FoliagePlacementContext,
        typeId: number,
        x: number,
        z: number,
        radius: number,
        seed = 1,
        maxInstances = 60000,
    ): number {
        const renderer = this.renderers.get(typeId);

        if (!renderer) {
            return 0;
        }

        const type = renderer.type;
        const target = Math.min(
            maxInstances,
            Math.round((type.density / 100) * Math.PI * radius * radius),
        );
        const spacing = Math.sqrt(100 / Math.max(0.01, type.density)) * 0.45;
        const checkSpacing = spacing > 0.3;
        const s2 = spacing * spacing;
        // Local spatial hash so the neighbour test stays O(1) even for dense grass.
        const grid = new Map<number, number[]>();
        const gridKey = (gx: number, gz: number) =>
            (gx + 32768) * 65536 + (gz + 32768);
        const crowded = (px: number, pz: number) => {
            const gx = Math.floor(px / spacing);
            const gz = Math.floor(pz / spacing);

            for (let dz = -1; dz <= 1; dz++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const list = grid.get(gridKey(gx + dx, gz + dz));

                    if (!list) {
                        continue;
                    }

                    for (let i = 0; i < list.length; i += 2) {
                        const ex = list[i] - px;
                        const ez = list[i + 1] - pz;

                        if (ex * ex + ez * ez < s2) {
                            return true;
                        }
                    }
                }
            }

            return false;
        };
        const previousRandom = this.random;
        const rand = mulberry32(seed * 7919 + 17);
        this.random = mulberry32(seed * 104729 + 3);
        let placed = 0;

        try {
            for (let i = 0; i < target; i++) {
                const a = rand() * Math.PI * 2;
                const d = Math.sqrt(rand()) * radius;
                let px = x + Math.cos(a) * d;
                let pz = z + Math.sin(a) * d;

                // Like a brush dab, a spot taken by a neighbour is retried nearby a few times.
                for (let attempt = 0; attempt < 4; attempt++) {
                    if (!placementAllowed(ctx, type, px, pz)) {
                        break;
                    }

                    if (!checkSpacing || !crowded(px, pz)) {
                        if (
                            this.tryPlace(ctx, renderer, px, pz, 0, true, true)
                        ) {
                            placed++;

                            if (checkSpacing) {
                                const k = gridKey(
                                    Math.floor(px / spacing),
                                    Math.floor(pz / spacing),
                                );
                                const list = grid.get(k) ?? [];
                                list.push(px, pz);
                                grid.set(k, list);
                            }
                        }

                        break;
                    }

                    px += (rand() - 0.5) * spacing * 3;
                    pz += (rand() - 0.5) * spacing * 3;

                    if ((px - x) ** 2 + (pz - z) ** 2 > radius * radius) {
                        break;
                    }
                }
            }

            for (const cell of renderer.cells.values()) {
                shuffleInstances(cell.data, rand);
            }
        } finally {
            this.random = previousRandom;
        }

        return placed;
    }

    /** Current render geometry of a type (procedural LODs, or the loaded GLB model's LODs). */
    geometryOf(typeId: number): {
        lods: THREE.BufferGeometry[];
        lodDistances: number[];
        /** true once a GLB model has replaced the procedural mesh. */
        model: boolean;
    } | null {
        const renderer = this.renderers.get(typeId);

        return renderer
            ? {
                  lods: renderer.lods,
                  lodDistances: renderer.lodDistances,
                  model: renderer.model,
              }
            : null;
    }

    /** Place one instance exactly (single-click placement). */
    placeSingle(
        ctx: FoliagePlacementContext,
        typeId: number,
        x: number,
        z: number,
    ): boolean {
        const renderer = this.renderers.get(typeId);

        return renderer ? this.tryPlace(ctx, renderer, x, z, 0, true) : false;
    }

    erase(
        typeIds: number[] | null,
        x: number,
        z: number,
        radius: number,
        strength: number,
        weightAt: (d: number) => number,
    ): void {
        const r2 = radius * radius;

        for (const [id, renderer] of this.renderers) {
            if (typeIds && !typeIds.includes(id)) {
                continue;
            }

            for (const cell of this.cellsInCircle(renderer, x, z, radius)) {
                const data = cell.data;
                let changed = false;
                const next: number[] = [];

                for (let i = 0; i < data.length; i += FOLIAGE_STRIDE) {
                    const dx = data[i] - x;
                    const dz = data[i + 2] - z;
                    const dd = dx * dx + dz * dz;

                    if (
                        dd <= r2 &&
                        this.random() <
                            weightAt(Math.sqrt(dd)) * Math.max(0.05, strength)
                    ) {
                        if (!changed) {
                            this.onBeforeModify?.(id, cell.key);
                            changed = true;
                        }

                        continue;
                    }

                    for (let k = 0; k < FOLIAGE_STRIDE; k++) {
                        next.push(data[i + k]);
                    }
                }

                if (changed) {
                    cell.data = next;
                    cell.dirty = true;
                }
            }
        }
    }

    /** Re-seat instances on the terrain after sculpting (world-space rect). */
    snapToTerrain(
        heights: Heightfield,
        minX: number,
        minZ: number,
        maxX: number,
        maxZ: number,
    ): void {
        const normal = new THREE.Vector3();

        for (const renderer of this.renderers.values()) {
            for (const cell of renderer.cells.values()) {
                if (
                    cell.box.max.x < minX ||
                    cell.box.min.x > maxX ||
                    cell.box.max.z < minZ ||
                    cell.box.min.z > maxZ
                ) {
                    continue;
                }

                const d = cell.data;

                for (let i = 0; i < d.length; i += FOLIAGE_STRIDE) {
                    if (
                        d[i] < minX ||
                        d[i] > maxX ||
                        d[i + 2] < minZ ||
                        d[i + 2] > maxZ
                    ) {
                        continue;
                    }

                    d[i + 1] = heights.sample(d[i], d[i + 2]);

                    if (renderer.type.align_to_normal) {
                        heights.normal(d[i], d[i + 2], normal);
                        d[i + 5] = Math.atan2(normal.z, normal.y);
                        d[i + 6] = -Math.atan2(normal.x, normal.y);
                    }

                    cell.dirty = true;
                }
            }
        }
    }

    /** Snapshot / restore support for undo (per type + cell). */
    captureCell(typeId: number, key: string): number[] {
        return [...(this.renderers.get(typeId)?.cells.get(key)?.data ?? [])];
    }

    restoreCell(typeId: number, key: string, data: number[]): void {
        const renderer = this.renderers.get(typeId);

        if (!renderer) {
            return;
        }

        const cell = this.cellFor(renderer, key);
        cell.data = [...data];
        cell.dirty = true;
    }

    update(dt: number, camera: THREE.Camera): void {
        this.uniforms.uTime.value += dt;
        this.uniforms.uCamPos.value.copy(camera.position);
        const cam = camera.position;

        for (const renderer of this.renderers.values()) {
            const cull = renderer.type.cull_distance * this.distanceScale;

            for (const cell of renderer.cells.values()) {
                const dist = cell.box.distanceToPoint(cam);
                const visible = dist < cull && cell.data.length > 0;

                if (!visible) {
                    if (cell.mesh) {
                        cell.mesh.visible = false;
                    }

                    continue;
                }

                let lod = 0;

                for (let l = renderer.lodDistances.length - 1; l > 0; l--) {
                    if (dist > renderer.lodDistances[l] * cull) {
                        lod = l;
                        break;
                    }
                }

                if (cell.dirty || !cell.mesh) {
                    this.buildCellMesh(renderer, cell, lod);
                } else if (lod !== cell.lod) {
                    cell.mesh.geometry = renderer.lods[lod];
                    cell.mesh.material = lodMaterial(renderer, lod);
                    cell.lod = lod;
                }

                if (cell.mesh) {
                    cell.mesh.visible = true;
                    const total = cell.data.length / FOLIAGE_STRIDE;
                    cell.mesh.count = Math.max(
                        0,
                        Math.floor(total * this.densityScale),
                    );
                }
            }
        }
    }

    dispose(): void {
        for (const renderer of this.renderers.values()) {
            this.disposeRenderer(renderer);
        }

        this.renderers.clear();
    }

    private tryPlace(
        ctx: FoliagePlacementContext,
        renderer: TypeRenderer,
        x: number,
        z: number,
        spacing: number,
        force = false,
        append = false,
    ): boolean {
        const type = renderer.type;
        const hf = ctx.heights;

        if (!hf.contains(x, z)) {
            return false;
        }

        const y = hf.sample(x, z);

        if (!force) {
            if (!placementAllowed(ctx, type, x, z)) {
                return false;
            }

            if (spacing > 0.3 && this.hasNeighbour(renderer, x, z, spacing)) {
                return false;
            }
        }

        const normal = hf.normal(x, z, _normal);
        const scale =
            type.min_scale + this.random() * (type.max_scale - type.min_scale);
        const yaw = type.random_yaw ? this.random() * Math.PI * 2 : 0;
        const tiltX = type.align_to_normal ? Math.atan2(normal.z, normal.y) : 0;
        const tiltZ = type.align_to_normal
            ? -Math.atan2(normal.x, normal.y)
            : 0;
        const key = cellKey(x, z);
        this.onBeforeModify?.(type.id, key);
        const cell = this.cellFor(renderer, key);

        if (append) {
            cell.data.push(x, y - 0.05 * scale, z, yaw, scale, tiltX, tiltZ);
        } else {
            // Insert at a random position so any prefix (density scaling) is spatially uniform.
            const count = cell.data.length / FOLIAGE_STRIDE;
            const slot = Math.floor(this.random() * (count + 1));
            cell.data.splice(
                slot * FOLIAGE_STRIDE,
                0,
                x,
                y - 0.05 * scale,
                z,
                yaw,
                scale,
                tiltX,
                tiltZ,
            );
        }

        cell.dirty = true;

        return true;
    }

    private hasNeighbour(
        renderer: TypeRenderer,
        x: number,
        z: number,
        spacing: number,
    ): boolean {
        const s2 = spacing * spacing;

        for (const cell of this.cellsInCircle(renderer, x, z, spacing)) {
            const d = cell.data;

            for (let i = 0; i < d.length; i += FOLIAGE_STRIDE) {
                const dx = d[i] - x;
                const dz = d[i + 2] - z;

                if (dx * dx + dz * dz < s2) {
                    return true;
                }
            }
        }

        return false;
    }

    private countInCircle(
        renderer: TypeRenderer,
        x: number,
        z: number,
        radius: number,
    ): number {
        const r2 = radius * radius;
        let count = 0;

        for (const cell of this.cellsInCircle(renderer, x, z, radius)) {
            const d = cell.data;

            for (let i = 0; i < d.length; i += FOLIAGE_STRIDE) {
                const dx = d[i] - x;
                const dz = d[i + 2] - z;

                if (dx * dx + dz * dz <= r2) {
                    count++;
                }
            }
        }

        return count;
    }

    private *cellsInCircle(
        renderer: TypeRenderer,
        x: number,
        z: number,
        radius: number,
    ): Generator<Cell> {
        const c0 = Math.floor((x - radius) / CELL_SIZE);
        const c1 = Math.floor((x + radius) / CELL_SIZE);
        const r0 = Math.floor((z - radius) / CELL_SIZE);
        const r1 = Math.floor((z + radius) / CELL_SIZE);

        for (let cz = r0; cz <= r1; cz++) {
            for (let cx = c0; cx <= c1; cx++) {
                const cell = renderer.cells.get(`${cx},${cz}`);

                if (cell) {
                    yield cell;
                }
            }
        }
    }

    private cellFor(renderer: TypeRenderer, key: string): Cell {
        let cell = renderer.cells.get(key);

        if (!cell) {
            cell = this.makeCell(key, []);
            renderer.cells.set(key, cell);
        }

        return cell;
    }

    private makeCell(key: string, data: number[]): Cell {
        const [cx, cz] = key.split(',').map(Number);

        return {
            key,
            cx,
            cz,
            data,
            mesh: null,
            dirty: true,
            lod: 0,
            box: new THREE.Box3(
                new THREE.Vector3(cx * CELL_SIZE, -1e4, cz * CELL_SIZE),
                new THREE.Vector3(
                    (cx + 1) * CELL_SIZE,
                    1e4,
                    (cz + 1) * CELL_SIZE,
                ),
            ),
        };
    }

    private buildCellMesh(
        renderer: TypeRenderer,
        cell: Cell,
        lod: number,
    ): void {
        const count = cell.data.length / FOLIAGE_STRIDE;
        this.removeCellMesh(cell);
        cell.dirty = false;
        cell.lod = lod;

        if (count === 0) {
            return;
        }

        const mesh = new THREE.InstancedMesh(
            renderer.lods[lod],
            lodMaterial(renderer, lod),
            count,
        );
        mesh.castShadow = renderer.type.cast_shadows;
        mesh.receiveShadow = true;

        if (renderer.depthMaterial) {
            mesh.customDepthMaterial = renderer.depthMaterial;
        }

        mesh.name = `Foliage_${renderer.type.name}_${cell.key}`;
        const m = new THREE.Matrix4();
        const q = new THREE.Quaternion();
        const e = new THREE.Euler();
        const p = new THREE.Vector3();
        const s = new THREE.Vector3();
        let minY = Infinity;
        let maxY = -Infinity;
        const d = cell.data;

        for (let i = 0; i < count; i++) {
            const o = i * FOLIAGE_STRIDE;
            p.set(d[o], d[o + 1], d[o + 2]);
            // Yaw first (Y), then tilt to the terrain normal (Z, X).
            e.set(d[o + 5], d[o + 3], d[o + 6], 'XZY');
            q.setFromEuler(e);
            s.setScalar(d[o + 4]);
            m.compose(p, q, s);
            mesh.setMatrixAt(i, m);
            minY = Math.min(minY, p.y);
            maxY = Math.max(maxY, p.y);
        }

        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
        mesh.frustumCulled = true;
        cell.box.min.y = minY - 2;
        cell.box.max.y = maxY + 30;
        cell.mesh = mesh;
        this.group.add(mesh);
    }

    private removeCellMesh(cell: Cell): void {
        if (cell.mesh) {
            this.group.remove(cell.mesh);
            cell.mesh.dispose();
            cell.mesh = null;
        }
    }

    private createRenderer(
        type: FoliageType,
        cells: Map<string, Cell>,
    ): TypeRenderer {
        const set = createFoliageGeometry(
            type.kind,
            new THREE.Color(type.color),
            new THREE.Color(type.color_secondary),
            type.id * 7919,
        );
        const material = new THREE.MeshStandardMaterial({
            vertexColors: true,
            roughness: type.kind === 'rock' ? 0.85 : 0.75,
            metalness: 0,
            side: set.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
        });
        const fade =
            type.kind === 'grass' ||
            type.kind === 'flower' ||
            type.kind === 'reed';
        this.patchMaterial(material, type, fade);
        const depthMaterial = new THREE.MeshDepthMaterial({
            depthPacking: THREE.RGBADepthPacking,
        });
        this.patchMaterial(depthMaterial, type, fade);

        const renderer: TypeRenderer = {
            type,
            lods: set.lods,
            lodDistances: set.lodDistances,
            lodMaterials: set.lods.map(() => material),
            depthMaterial,
            model: false,
            disposed: false,
            cells,
        };

        if (type.model_url) {
            void this.loadModel(renderer, type.model_url);
        }

        return renderer;
    }

    /** Wind sway + distance fade injected into the standard material. */
    private patchMaterial(
        material: THREE.Material,
        type: FoliageType,
        fade: boolean,
    ): void {
        const stiffness =
            type.kind === 'rock'
                ? 0
                : type.kind === 'conifer' ||
                    type.kind === 'broadleaf' ||
                    type.kind === 'palm'
                  ? 0.35
                  : 1;

        material.onBeforeCompile = (shader) => {
            shader.uniforms.uTime = this.uniforms.uTime;
            shader.uniforms.uWind = this.uniforms.uWind;
            shader.uniforms.uCamPos = this.uniforms.uCamPos;
            shader.uniforms.uFadeEnd = { value: type.cull_distance };
            shader.uniforms.uFadeScale = { value: this.distanceScale };
            shader.vertexShader = shader.vertexShader
                .replace(
                    '#include <common>',
                    `#include <common>
attribute float wind;
uniform float uTime;
uniform float uWind;
uniform vec3 uCamPos;
uniform float uFadeEnd;
uniform float uFadeScale;`,
                )
                .replace(
                    '#include <begin_vertex>',
                    `#include <begin_vertex>
#ifdef USE_INSTANCING
vec3 instPos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
#else
vec3 instPos = vec3(0.0);
#endif
float phase = dot(instPos.xz, vec2(0.071, 0.113));
float gust = sin(uTime * 0.7 + instPos.x * 0.01) * 0.5 + 0.5;
float sway = (sin(uTime * 1.9 + phase) * 0.6 + sin(uTime * 3.7 + phase * 1.7) * 0.25) * (0.4 + gust * 0.6);
float bend = wind * wind * uWind * ${stiffness.toFixed(2)};
transformed.x += sway * bend * 0.35;
transformed.z += sway * bend * 0.22;
${
    fade
        ? `float camDist = distance(instPos.xz, uCamPos.xz);
float fadeK = 1.0 - smoothstep(uFadeEnd * uFadeScale * 0.7, uFadeEnd * uFadeScale, camDist);
transformed *= fadeK;`
        : ''
}`,
                );

            // Blade normals are bent upwards; flipping them on back faces would render grass dark.
            if (material.side === THREE.DoubleSide) {
                shader.fragmentShader = shader.fragmentShader.replace(
                    '#include <normal_fragment_begin>',
                    THREE.ShaderChunk.normal_fragment_begin.replace(
                        'normal *= faceDirection;',
                        '',
                    ),
                );
            }
        };
        material.customProgramCacheKey = () =>
            `foliage-${stiffness}-${fade}-${material.side}`;
    }

    /**
     * Loads a GLB model. Baked assets (resources/game/tools/FoliageBaker.ts) contain top-level
     * nodes "LOD0".."LODn" which become the type's LODs; any other GLB is a single LOD.
     */
    private async loadModel(
        renderer: TypeRenderer,
        url: string,
    ): Promise<void> {
        try {
            const gltf = await this.gltf.loadAsync(url);

            if (renderer.disposed) {
                disposeObject(gltf.scene);

                return;
            }

            gltf.scene.updateMatrixWorld(true);
            const lodNodes = gltf.scene.children
                .filter((child) => /^LOD\d+$/.test(child.name))
                .sort(
                    (a, b) => Number(a.name.slice(3)) - Number(b.name.slice(3)),
                );
            const roots = lodNodes.length ? lodNodes : [gltf.scene];
            const lods: THREE.BufferGeometry[] = [];
            const lodMaterials: (THREE.Material | THREE.Material[])[] = [];

            for (const root of roots) {
                const built = buildModelLod(root);

                if (built) {
                    lods.push(built.geometry);
                    lodMaterials.push(
                        built.materials.length === 1
                            ? built.materials[0]
                            : built.materials,
                    );
                }
            }

            // The loader's per-node geometry was copied into the merged LODs.
            gltf.scene.traverse((obj) => {
                const mesh = obj as THREE.Mesh;

                if (mesh.isMesh) {
                    mesh.geometry.dispose();
                }
            });

            if (!lods.length) {
                return;
            }

            // Wind weight: 0 at the base → 1 at the top of LOD0, shared by all LODs so they sway alike.
            lods[0].computeBoundingBox();
            const box = lods[0].boundingBox!;
            const height = Math.max(0.001, box.max.y - box.min.y);

            for (const geometry of lods) {
                const pos = geometry.getAttribute('position');
                const windAttr = new Float32Array(pos.count);

                for (let i = 0; i < pos.count; i++) {
                    windAttr[i] = Math.min(
                        1.2,
                        Math.max(0, (pos.getY(i) - box.min.y) / height),
                    );
                }

                geometry.setAttribute(
                    'wind',
                    new THREE.BufferAttribute(windAttr, 1),
                );
            }

            const type = renderer.type;
            const fade =
                type.kind === 'grass' ||
                type.kind === 'flower' ||
                type.kind === 'reed';
            const tint = new THREE.Color(type.tint || '#ffffff');
            const unique = new Set(lodMaterials.flat());

            for (const mat of unique) {
                const colored = mat as THREE.MeshStandardMaterial;

                if (colored.color?.isColor) {
                    colored.color.multiply(tint);
                }

                this.patchMaterial(mat, type, fade);
            }

            const previous = {
                lods: renderer.lods,
                materials: renderer.lodMaterials,
                depth: renderer.depthMaterial,
            };
            renderer.lods = lods;
            renderer.lodMaterials = lodMaterials;
            renderer.lodDistances = pickLodDistances(
                type,
                gltf.scene.userData,
                lods.length,
            );
            renderer.depthMaterial = null;
            renderer.model = true;

            for (const cell of renderer.cells.values()) {
                cell.dirty = true;
            }

            // Procedural stand-ins are no longer referenced once dirty cells rebuild.
            for (const g of previous.lods) {
                g.dispose();
            }

            for (const m of new Set(previous.materials.flat())) {
                m.dispose();
            }

            previous.depth?.dispose();
        } catch (error) {
            console.warn(`Failed to load foliage model ${url}`, error);
        }
    }

    private disposeRenderer(renderer: TypeRenderer): void {
        renderer.disposed = true;

        for (const cell of renderer.cells.values()) {
            this.removeCellMesh(cell);
        }

        for (const g of renderer.lods) {
            g.dispose();
        }

        for (const m of new Set(renderer.lodMaterials.flat())) {
            if (renderer.model) {
                disposeMaterialTextures(m);
            }

            m.dispose();
        }

        renderer.depthMaterial?.dispose();
    }
}

/** Whether a type's slope / height / underwater rules allow an instance at world X/Z. */
export function placementAllowed(
    ctx: FoliagePlacementContext,
    type: FoliageType,
    x: number,
    z: number,
): boolean {
    const hf = ctx.heights;

    if (!hf.contains(x, z)) {
        return false;
    }

    const y = hf.sample(x, z);
    const slope = hf.slope(x, z);

    if (slope < type.min_slope || slope > type.max_slope) {
        return false;
    }

    if (
        (type.min_height !== null && y < type.min_height) ||
        (type.max_height !== null && y > type.max_height)
    ) {
        return false;
    }

    const water = ctx.waterLevelAt(x, z);

    return type.allow_underwater || water === null || water <= y - 0.05;
}

function smooth01(a: number, b: number, v: number): number {
    const t = Math.min(1, Math.max(0, (v - a) / (b - a)));

    return t * t * (3 - 2 * t);
}

/** Fisher–Yates shuffle of whole instances so density scaling (prefix rendering) stays uniform. */
function shuffleInstances(data: number[], rand: () => number): void {
    const n = data.length / FOLIAGE_STRIDE;

    for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));

        for (let k = 0; k < FOLIAGE_STRIDE; k++) {
            const a = i * FOLIAGE_STRIDE + k;
            const b = j * FOLIAGE_STRIDE + k;
            const t = data[a];
            data[a] = data[b];
            data[b] = t;
        }
    }
}

function cellKey(x: number, z: number): string {
    return `${Math.floor(x / CELL_SIZE)},${Math.floor(z / CELL_SIZE)}`;
}

function sameVisuals(a: FoliageType, b: FoliageType): boolean {
    return (
        a.kind === b.kind &&
        a.color === b.color &&
        a.color_secondary === b.color_secondary &&
        a.model_url === b.model_url &&
        (a.tint || '#ffffff').toLowerCase() ===
            (b.tint || '#ffffff').toLowerCase() &&
        (a.asset?.id ?? null) === (b.asset?.id ?? null) &&
        (a.asset?.lod_distances ?? []).join() ===
            (b.asset?.lod_distances ?? []).join() &&
        a.cull_distance === b.cull_distance &&
        a.cast_shadows === b.cast_shadows
    );
}

function lodMaterial(
    renderer: TypeRenderer,
    lod: number,
): THREE.Material | THREE.Material[] {
    return (
        renderer.lodMaterials[lod] ??
        renderer.lodMaterials[renderer.lodMaterials.length - 1]
    );
}

/**
 * Merges every mesh under a LOD node into one indexed geometry (one group per material) with
 * float position / normal / uv (+ colour when a material uses vertex colours).
 */
function buildModelLod(root: THREE.Object3D): {
    geometry: THREE.BufferGeometry;
    materials: THREE.Material[];
} | null {
    const pieces: {
        geometry: THREE.BufferGeometry;
        material: THREE.Material;
    }[] = [];
    root.updateWorldMatrix(true, true);

    root.traverse((obj) => {
        const mesh = obj as THREE.Mesh;

        if (!mesh.isMesh || !mesh.geometry.getAttribute('position')) {
            return;
        }

        const source = mesh.geometry;
        const materials = Array.isArray(mesh.material)
            ? mesh.material
            : [mesh.material];
        const groups =
            Array.isArray(mesh.material) && source.groups.length
                ? source.groups
                : [
                      {
                          start: 0,
                          count: Infinity,
                          materialIndex: 0,
                      },
                  ];

        for (const group of groups) {
            const material = materials[group.materialIndex ?? 0];

            if (!material) {
                continue;
            }

            const g = new THREE.BufferGeometry();

            for (const name of ['position', 'normal', 'uv', 'color']) {
                const attr = source.getAttribute(name);

                if (attr) {
                    g.setAttribute(
                        name,
                        toFloatAttribute(
                            attr,
                            name === 'color' ? 3 : attr.itemSize,
                        ),
                    );
                }
            }

            const count = source.index
                ? source.index.count
                : source.getAttribute('position').count;
            const start = Math.max(0, group.start);
            const end = Math.min(count, group.start + group.count);
            const index: number[] = [];

            for (let i = start; i < end; i++) {
                index.push(source.index ? source.index.getX(i) : i);
            }

            g.setIndex(index);
            g.applyMatrix4(mesh.matrixWorld);

            if (!g.getAttribute('normal')) {
                g.computeVertexNormals();
            }

            if (!g.getAttribute('uv')) {
                g.setAttribute(
                    'uv',
                    new THREE.BufferAttribute(
                        new Float32Array(g.getAttribute('position').count * 2),
                        2,
                    ),
                );
            }

            pieces.push({ geometry: g, material });
        }
    });

    if (!pieces.length) {
        return null;
    }

    const withColor = pieces.some(
        (p) => (p.material as THREE.MeshStandardMaterial).vertexColors,
    );

    for (const { geometry } of pieces) {
        if (!withColor) {
            geometry.deleteAttribute('color');
        } else if (!geometry.getAttribute('color')) {
            const white = new Float32Array(
                geometry.getAttribute('position').count * 3,
            ).fill(1);
            geometry.setAttribute('color', new THREE.BufferAttribute(white, 3));
        }
    }

    // Consecutive pieces sharing a material become one draw group.
    const materials: THREE.Material[] = [];
    const ordered = [...pieces].sort(
        (a, b) =>
            firstIndexOf(pieces, a.material) - firstIndexOf(pieces, b.material),
    );

    for (const piece of ordered) {
        if (!materials.includes(piece.material)) {
            materials.push(piece.material);
        }
    }

    const merged = mergeGeometries(
        ordered.map((p) => p.geometry),
        true,
    );

    for (const piece of pieces) {
        piece.geometry.dispose();
    }

    if (!merged) {
        return null;
    }

    // mergeGeometries makes one group per input; remap them to material slots and coalesce.
    const groups = merged.groups.map((group, i) => ({
        start: group.start,
        count: group.count,
        materialIndex: materials.indexOf(ordered[i].material),
    }));
    merged.clearGroups();

    for (const group of groups) {
        const last = merged.groups[merged.groups.length - 1];

        if (
            last &&
            last.materialIndex === group.materialIndex &&
            last.start + last.count === group.start
        ) {
            last.count += group.count;
        } else {
            merged.addGroup(group.start, group.count, group.materialIndex);
        }
    }

    merged.computeBoundingBox();
    merged.computeBoundingSphere();

    return { geometry: merged, materials };
}

function firstIndexOf(
    pieces: { material: THREE.Material }[],
    material: THREE.Material,
): number {
    return pieces.findIndex((p) => p.material === material);
}

/** Plain, non-normalized Float32 copy of any (interleaved / quantized) attribute. */
function toFloatAttribute(
    attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
    itemSize: number,
): THREE.BufferAttribute {
    const out = new Float32Array(attr.count * itemSize);

    for (let i = 0; i < attr.count; i++) {
        for (let k = 0; k < itemSize; k++) {
            out[i * itemSize + k] =
                k < attr.itemSize ? attr.getComponent(i, k) : 1;
        }
    }

    return new THREE.BufferAttribute(out, itemSize);
}

function pickLodDistances(
    type: FoliageType,
    userData: Record<string, unknown>,
    count: number,
): number[] {
    const valid = (d: unknown): d is number[] =>
        Array.isArray(d) &&
        d.length === count &&
        d.every((v) => typeof v === 'number' && Number.isFinite(v));
    const fromAsset = type.asset?.lod_distances;

    if (valid(fromAsset)) {
        return [0, ...fromAsset.slice(1)];
    }

    const extras = (
        userData?.waterways as { lod_distances?: unknown } | undefined
    )?.lod_distances;

    if (valid(extras)) {
        return [0, ...extras.slice(1)];
    }

    if (count === 1) {
        return [0];
    }

    if (count === 2) {
        return [0, 0.35];
    }

    return Array.from({ length: count }, (_, i) =>
        i === 0 ? 0 : 0.5 * (i / (count - 1)) ** 1.3,
    );
}

function disposeMaterialTextures(material: THREE.Material): void {
    for (const value of Object.values(material)) {
        if ((value as THREE.Texture | null)?.isTexture) {
            (value as THREE.Texture).dispose();
        }
    }
}

function disposeObject(root: THREE.Object3D): void {
    root.traverse((obj) => {
        const mesh = obj as THREE.Mesh;

        if (!mesh.isMesh) {
            return;
        }

        mesh.geometry.dispose();

        for (const m of Array.isArray(mesh.material)
            ? mesh.material
            : [mesh.material]) {
            disposeMaterialTextures(m);
            m.dispose();
        }
    });
}

const _normal = new THREE.Vector3();
