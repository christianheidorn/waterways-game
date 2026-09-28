import * as THREE from 'three';
import type { FoliageKind } from '../shared/types';

/**
 * Runtime LOD completion for foliage models.
 *
 * Baked assets (resources/game/tools/FoliageBaker.ts) normally carry LOD0 / LOD1 / impostor, but older
 * bakes, rocks, uploaded GLBs (`model_url`) and third-party models may have a single, heavy LOD. The
 * helpers here fill the gaps when a model is loaded so no foliage draws full detail at distance:
 *
 * - a simplified mid LOD (meshoptimizer, loaded on demand) when the cheapest mesh LOD is over budget,
 * - a crossed-card impostor rendered from the model (vegetation; see foliage/Impostor.ts) or a very
 *   coarse mesh (rocks) as the far LOD,
 * - LOD0 itself is simplified only when it is far beyond any sensible budget (raw, unbaked sources).
 */

export type LodBudget = {
    /** Sensible LOD0 triangle budget (per instance). LOD0 is only reduced beyond 3× this. */
    lod0: number;
    /** Mid LOD budget: the cheapest mesh LOD before the far LOD should not exceed ~1.5× this. */
    mid: number;
    /** A last LOD at or below this many triangles counts as the far LOD (impostor / coarse mesh). */
    far: number;
    /** Far LOD is a rendered impostor (vegetation) rather than a coarse mesh (rocks). */
    impostor: boolean;
    /** Default LOD switch distances (fraction of the cull distance) for a mid and the far LOD. */
    midAt: number;
    farAt: number;
};

export const LOD_BUDGETS: Record<FoliageKind, LodBudget> = {
    conifer: {
        lod0: 10000,
        mid: 2000,
        far: 64,
        impostor: true,
        midAt: 0.15,
        farAt: 0.4,
    },
    broadleaf: {
        lod0: 10000,
        mid: 2000,
        far: 64,
        impostor: true,
        midAt: 0.15,
        farAt: 0.4,
    },
    palm: {
        lod0: 10000,
        mid: 2000,
        far: 64,
        impostor: true,
        midAt: 0.16,
        farAt: 0.42,
    },
    bush: {
        lod0: 4000,
        mid: 800,
        far: 32,
        impostor: true,
        midAt: 0.25,
        farAt: 0.55,
    },
    rock: {
        lod0: 3000,
        mid: 400,
        far: 128,
        impostor: false,
        midAt: 0.3,
        farAt: 0.6,
    },
    grass: {
        lod0: 600,
        mid: 120,
        far: 24,
        impostor: true,
        midAt: 0.15,
        farAt: 0.4,
    },
    flower: {
        lod0: 800,
        mid: 150,
        far: 24,
        impostor: true,
        midAt: 0.2,
        farAt: 0.4,
    },
    reed: {
        lod0: 800,
        mid: 150,
        far: 48,
        impostor: true,
        midAt: 0.2,
        farAt: 0.4,
    },
};

/** Triangles a geometry draws per instance (index / draw range aware). */
export function triangleCount(geometry: THREE.BufferGeometry): number {
    const total = geometry.index
        ? geometry.index.count
        : (geometry.getAttribute('position')?.count ?? 0);
    const start = Math.max(0, geometry.drawRange.start);
    const end = Math.min(total, start + geometry.drawRange.count);

    return Math.max(0, Math.floor((end - start) / 3));
}

/** LOD level encoded in a node name ("LOD1", "Tree_LOD2", "leaves.lod0", …), or null. */
export function lodIndexOf(name: string): number | null {
    const match =
        /(?:^|[_\-\s.])lod[_\-\s]?(\d+)$/i.exec(name) ??
        /^lod(\d+)$/i.exec(name);

    return match ? Number(match[1]) : null;
}

/**
 * LOD roots of a loaded model: every outermost node whose name carries a LOD level, grouped by
 * level (ascending). Empty when the model has no LOD naming (it is then a single LOD).
 */
export function findLodRoots(scene: THREE.Object3D): THREE.Object3D[][] {
    const levels = new Map<number, THREE.Object3D[]>();
    const visit = (obj: THREE.Object3D) => {
        const lod = obj === scene ? null : lodIndexOf(obj.name);

        if (lod !== null) {
            const list = levels.get(lod) ?? [];
            list.push(obj);
            levels.set(lod, list);

            // The outermost LOD-named node owns everything below it.
            return;
        }

        for (const child of obj.children) {
            visit(child);
        }
    };
    visit(scene);

    return [...levels.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, roots]) => roots);
}

type Simplifier =
    (typeof import('meshoptimizer/simplifier'))['MeshoptSimplifier'];

let simplifierPromise: Promise<Simplifier | null> | null = null;

/** meshoptimizer's simplifier (WASM), loaded once on first use; null when unavailable. */
function loadSimplifier(): Promise<Simplifier | null> {
    simplifierPromise ??= import('meshoptimizer/simplifier')
        .then(async ({ MeshoptSimplifier }) => {
            if (!MeshoptSimplifier.supported) {
                return null;
            }

            await MeshoptSimplifier.ready;

            return MeshoptSimplifier;
        })
        .catch((error: unknown) => {
            console.warn('Foliage LOD simplifier unavailable', error);

            return null;
        });

    return simplifierPromise;
}

/**
 * Simplified copy of an indexed (or non-indexed) geometry with about `targetTris` triangles, keeping
 * its material groups. Tries an attribute-preserving simplification first, then a position-welded
 * one (UV seams no longer block collapses), then meshoptimizer's sloppy clustering (many small,
 * disconnected parts such as leaf cards). Returns null when it cannot reduce the mesh meaningfully.
 */
export async function simplifyGeometry(
    geometry: THREE.BufferGeometry,
    targetTris: number,
): Promise<THREE.BufferGeometry | null> {
    const source = triangleCount(geometry);

    if (source <= targetTris) {
        return null;
    }

    const S = await loadSimplifier();
    const position = geometry.getAttribute('position');

    if (!S || !position || position.itemSize !== 3) {
        return null;
    }

    const positions = floatArrayOf(position);
    const vertexCount = position.count;
    const index = geometry.index
        ? Uint32Array.from({ length: geometry.index.count }, (_, i) =>
              geometry.index!.getX(i),
          )
        : Uint32Array.from({ length: vertexCount }, (_, i) => i);
    const remap = S.generatePositionRemap(positions, 3);
    const groups = geometry.groups.length
        ? geometry.groups
        : [{ start: 0, count: index.length, materialIndex: 0 }];
    const out: number[] = [];
    const outGroups: { start: number; count: number; materialIndex: number }[] =
        [];

    for (const group of groups) {
        const start = Math.max(0, group.start);
        const end = Math.min(index.length, start + group.count);
        const count = end - start - ((end - start) % 3);

        if (count <= 0) {
            continue;
        }

        const sub = index.slice(start, start + count);
        // Groups share the budget in proportion to their size (tiny groups may vanish).
        const target = Math.max(
            0,
            Math.round((targetTris * count) / index.length) * 3,
        );
        let result: Uint32Array = sub;

        if (target >= 3) {
            // No pruning here: in an unwelded mesh every triangle is its own component.
            [result] = S.simplify(sub, positions, 3, target, 0.05);

            if (result.length > target * 1.25) {
                const welded = result.map((v) => remap[v]);
                const [pruned] = S.simplify(
                    welded,
                    positions,
                    3,
                    target,
                    0.05,
                    ['Prune'],
                );
                // Pruning may drop far more than asked (many tiny parts): keep the welded input then.
                result =
                    pruned.length >= Math.min(target, welded.length) * 0.25
                        ? pruned
                        : welded;
            }

            if (result.length > target * 1.25) {
                const [sloppy] = S.simplifySloppy(
                    result,
                    positions,
                    3,
                    null,
                    target,
                    1,
                );

                if (sloppy.length) {
                    result = sloppy;
                }
            }
        } else {
            result = new Uint32Array(0);
        }

        if (!result.length) {
            continue;
        }

        outGroups.push({
            start: out.length,
            count: result.length,
            materialIndex: group.materialIndex ?? 0,
        });

        for (const v of result) {
            out.push(v);
        }
    }

    if (!out.length || out.length / 3 > source * 0.9) {
        return null;
    }

    return compactGeometry(geometry, out, outGroups);
}

/** New geometry holding only the vertices `index` references (attributes copied as float). */
function compactGeometry(
    source: THREE.BufferGeometry,
    index: number[],
    groups: { start: number; count: number; materialIndex: number }[],
): THREE.BufferGeometry {
    const map = new Map<number, number>();
    const order: number[] = [];
    const next = new Uint32Array(index.length);

    for (let i = 0; i < index.length; i++) {
        let v = map.get(index[i]);

        if (v === undefined) {
            v = order.length;
            map.set(index[i], v);
            order.push(index[i]);
        }

        next[i] = v;
    }

    const geometry = new THREE.BufferGeometry();

    for (const [name, attr] of Object.entries(source.attributes)) {
        const size = attr.itemSize;
        const array = new Float32Array(order.length * size);

        for (let i = 0; i < order.length; i++) {
            for (let k = 0; k < size; k++) {
                array[i * size + k] = attr.getComponent(order[i], k);
            }
        }

        geometry.setAttribute(name, new THREE.BufferAttribute(array, size));
    }

    geometry.setIndex(new THREE.BufferAttribute(next, 1));

    for (const group of groups) {
        geometry.addGroup(group.start, group.count, group.materialIndex);
    }

    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    return geometry;
}

function floatArrayOf(
    attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
): Float32Array {
    if (
        !(attr as THREE.InterleavedBufferAttribute)
            .isInterleavedBufferAttribute &&
        attr.array instanceof Float32Array &&
        !attr.normalized &&
        attr.array.length === attr.count * attr.itemSize
    ) {
        return attr.array;
    }

    const out = new Float32Array(attr.count * attr.itemSize);

    for (let i = 0; i < attr.count; i++) {
        for (let k = 0; k < attr.itemSize; k++) {
            out[i * attr.itemSize + k] = attr.getComponent(i, k);
        }
    }

    return out;
}
