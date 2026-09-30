import type * as THREE from 'three/webgpu';
import { FOLIAGE_STRIDE } from '../../shared/types';
import type {
    FoliageCollision,
    FoliageKind,
    FoliageType,
} from '../../shared/types';
import type { Foliage, FoliageCollisionCell } from '../Foliage';
import type { Collider, CollisionProvider } from './Collision';
import { trianglesOf } from './shapes';
import type { Shape } from './shapes';

/** Bucket size (m) of the per-cell collision index. */
const BUCKET = 8;

const TREES: ReadonlySet<FoliageKind> = new Set([
    'conifer',
    'broadleaf',
    'palm',
]);

/**
 * The collision a foliage type really uses: `auto` is a trunk for trees, the footprint for rocks and
 * nothing for bushes, grass, flowers and reeds (walked through).
 */
export function foliageCollisionMode(
    type: Pick<FoliageType, 'kind' | 'collision'>,
): Exclude<FoliageCollision, 'auto'> {
    const mode = type.collision ?? 'auto';

    if (mode !== 'auto') {
        return mode;
    }

    return TREES.has(type.kind)
        ? 'trunk'
        : type.kind === 'rock'
          ? 'bounds'
          : 'none';
}

/** Collision measurements of a foliage model at scale 1. */
type Profile = {
    height: number;
    /** Trunk ring near the ground: centre (it may stand off the pivot) and radius. */
    trunk: { cx: number; cz: number; r: number };
    /** Footprint box (slightly inset) [minX, minY, minZ, maxX, maxY, maxZ]. */
    box: Float32Array;
};

const profiles = new WeakMap<THREE.BufferGeometry, Profile>();

/**
 * Measures a foliage model: its height, its footprint and the radius of its trunk (a low percentile of
 * the distances of vertices from the axis between 3 % and 10 % of the height: trunk vertices are the
 * innermost ones there, branches and leaves lie further out).
 */
export function foliageProfile(geometry: THREE.BufferGeometry): Profile {
    let profile = profiles.get(geometry);

    if (profile) {
        return profile;
    }

    const pos = geometry.getAttribute('position');
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;

    for (let i = 0; i < (pos?.count ?? 0); i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const z = pos.getZ(i);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        minZ = Math.min(minZ, z);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        maxZ = Math.max(maxZ, z);
    }

    if (!pos?.count) {
        minX = minY = minZ = -0.5;
        maxX = maxY = maxZ = 0.5;
    }

    const height = Math.max(0.05, maxY);
    const footprint = Math.min(maxX - minX, maxZ - minZ) / 2;
    // Cross-sections of the triangles at knee and hip height (above a root flare): the trunk is the
    // innermost ring of crossing points; branches and leaves cross further out.
    const triangles = trianglesOf([geometry]);
    const rings = [Math.min(0.6, height * 0.06), Math.min(1.2, height * 0.12)]
        .map((y) => trunkSection(triangles, y))
        .filter((r) => r !== null);
    const ring = rings.length
        ? rings.reduce((a, b) => (b.r < a.r ? b : a))
        : { cx: 0, cz: 0, r: footprint * 0.15 };
    const trunk = {
        cx: ring.cx,
        cz: ring.cz,
        r: Math.min(
            Math.max(ring.r, 0.04),
            height * 0.08,
            Math.max(0.04, footprint),
        ),
    };
    const insetX = (maxX - minX) * 0.08;
    const insetZ = (maxZ - minZ) * 0.08;
    profile = {
        height,
        trunk,
        box: new Float32Array([
            minX + insetX,
            Math.min(0, minY),
            minZ + insetZ,
            maxX - insetX,
            maxY,
            maxZ - insetZ,
        ]),
    };
    profiles.set(geometry, profile);

    return profile;
}

/**
 * The trunk ring where a horizontal plane at `y` cuts the triangles, or null when nothing crosses it.
 * Crossing points near the innermost one belong to the trunk (branches and leaves cross further out);
 * the trunk may stand off the pivot (bent trunks), so the ring's own centre is used.
 */
function trunkSection(
    t: Float32Array,
    y: number,
): { cx: number; cz: number; r: number } | null {
    const pts: number[] = [];

    for (let o = 0; o + 8 < t.length; o += 9) {
        for (let e = 0; e < 3; e++) {
            const a = o + e * 3;
            const b = o + ((e + 1) % 3) * 3;
            const ya = t[a + 1];
            const yb = t[b + 1];

            if ((ya - y) * (yb - y) < 0) {
                const f = (y - ya) / (yb - ya);
                pts.push(
                    t[a] + (t[b] - t[a]) * f,
                    t[a + 2] + (t[b + 2] - t[a + 2]) * f,
                );
            }
        }
    }

    if (!pts.length) {
        return null;
    }

    let inner = Infinity;

    for (let i = 0; i < pts.length; i += 2) {
        inner = Math.min(inner, Math.hypot(pts[i], pts[i + 1]));
    }

    // The ring around the pivot: points within reach of the innermost crossing, twice (the second
    // pass around the first pass's centre).
    let cx = 0;
    let cz = 0;
    let r = 0;
    let reach = inner + 0.8;

    for (let pass = 0; pass < 2; pass++) {
        let sx = 0;
        let sz = 0;
        let n = 0;

        for (let i = 0; i < pts.length; i += 2) {
            if (Math.hypot(pts[i] - cx, pts[i + 1] - cz) <= reach) {
                sx += pts[i];
                sz += pts[i + 1];
                n++;
            }
        }

        if (!n) {
            return null;
        }

        const nx = sx / n;
        const nz = sz / n;
        const d: number[] = [];

        for (let i = 0; i < pts.length; i += 2) {
            if (Math.hypot(pts[i] - cx, pts[i + 1] - cz) <= reach) {
                d.push(Math.hypot(pts[i] - nx, pts[i + 1] - nz));
            }
        }

        cx = nx;
        cz = nz;
        d.sort((a, b) => a - b);
        r = d[Math.floor(d.length / 2)];
        reach = r * 1.6 + 0.02;
    }

    return { cx, cz, r: r * 1.05 };
}

/** The local shape of a foliage type's collider at scale 1. */
function shapeFor(type: FoliageType, profile: Profile): Shape | null {
    const mode = foliageCollisionMode(type);
    const radius = type.collision_radius ?? null;

    if (mode === 'trunk') {
        return {
            kind: 'cylinder',
            radius: radius ?? profile.trunk.r,
            height: profile.height,
            cx: profile.trunk.cx,
            cz: profile.trunk.cz,
        };
    }

    if (mode === 'bounds') {
        return radius
            ? {
                  kind: 'cylinder',
                  radius,
                  height: profile.height,
                  cx: (profile.box[0] + profile.box[3]) / 2,
                  cz: (profile.box[2] + profile.box[5]) / 2,
              }
            : { kind: 'boxes', boxes: profile.box };
    }

    return null;
}

type CellIndex = {
    version: number;
    buckets: Map<number, number[]>;
};

/**
 * Foliage colliders (placed foliage and ground cover). The foliage keeps instances in cells of
 * 32–128 m; each cell gets a finer bucket index (8 m) the first time collision looks at it, rebuilt
 * when its data changes (brush, scatter, undo), so queries only touch the instances nearby.
 */
export class FoliageColliders implements CollisionProvider {
    private readonly indexes = new WeakMap<FoliageCollisionCell, CellIndex>();
    private readonly shapes = new Map<
        number,
        {
            type: FoliageType;
            geometry: THREE.BufferGeometry;
            shape: Shape | null;
            profile: Profile;
        }
    >();

    constructor(private readonly foliage: Foliage) {}

    collidersIn(
        minX: number,
        minZ: number,
        maxX: number,
        maxZ: number,
        out: Collider[],
    ): void {
        this.foliage.collisionCells(
            minX,
            minZ,
            maxX,
            maxZ,
            (type) => foliageCollisionMode(type) !== 'none',
            (type, geometry, cover, cell) => {
                const entry = this.shapeOf(type, geometry, cover);

                if (!entry.shape) {
                    return;
                }

                const shape = entry.shape;
                const reach = localReach(shape) * type.max_scale;
                const index = this.indexOf(cell);
                const data = cell.data;
                const b0 = Math.floor((minX - reach) / BUCKET);
                const b1 = Math.floor((maxX + reach) / BUCKET);
                const r0 = Math.floor((minZ - reach) / BUCKET);
                const r1 = Math.floor((maxZ + reach) / BUCKET);
                const mode = foliageCollisionMode(type);

                for (let bz = r0; bz <= r1; bz++) {
                    for (let bx = b0; bx <= b1; bx++) {
                        const list = index.buckets.get(bucketKey(bx, bz));

                        if (!list) {
                            continue;
                        }

                        for (const o of list) {
                            const x = data[o];
                            const z = data[o + 2];
                            const scale = data[o + 4];
                            const r = localReach(shape) * scale;

                            if (
                                x + r < minX ||
                                x - r > maxX ||
                                z + r < minZ ||
                                z - r > maxZ
                            ) {
                                continue;
                            }

                            const y = data[o + 1];
                            const yaw = data[o + 3];
                            out.push({
                                info: {
                                    source: cover ? 'ground_cover' : 'foliage',
                                    key: `${cover ? 'c' : 'f'}${type.id}:${cell.key}:${o / FOLIAGE_STRIDE}`,
                                    name: type.name,
                                    mode,
                                    foliageTypeId: type.id,
                                },
                                x,
                                y,
                                z,
                                cos: Math.cos(yaw),
                                sin: Math.sin(yaw),
                                scale,
                                radius: r,
                                bottom: y + localBottom(shape) * scale,
                                top: y + localTop(shape) * scale,
                                shape,
                            });
                        }
                    }
                }
            },
        );
    }

    private shapeOf(
        type: FoliageType,
        geometry: THREE.BufferGeometry,
        cover: boolean,
    ) {
        const key = cover ? -type.id : type.id;
        let entry = this.shapes.get(key);

        if (!entry || entry.type !== type || entry.geometry !== geometry) {
            const profile = foliageProfile(geometry);
            entry = { type, geometry, profile, shape: shapeFor(type, profile) };
            this.shapes.set(key, entry);
        }

        return entry;
    }

    private indexOf(cell: FoliageCollisionCell): CellIndex {
        let index = this.indexes.get(cell);

        if (index && index.version === cell.version) {
            return index;
        }

        const buckets = new Map<number, number[]>();
        const data = cell.data;

        for (
            let o = 0;
            o + FOLIAGE_STRIDE <= data.length;
            o += FOLIAGE_STRIDE
        ) {
            const key = bucketKey(
                Math.floor(data[o] / BUCKET),
                Math.floor(data[o + 2] / BUCKET),
            );
            const list = buckets.get(key);

            if (list) {
                list.push(o);
            } else {
                buckets.set(key, [o]);
            }
        }

        index = { version: cell.version, buckets };
        this.indexes.set(cell, index);

        return index;
    }
}

function bucketKey(bx: number, bz: number): number {
    return (bx + 32768) * 65536 + (bz + 32768);
}

/** Horizontal reach of a local shape from its origin. */
function localReach(shape: Shape): number {
    if (shape.kind === 'cylinder') {
        return Math.hypot(shape.cx, shape.cz) + shape.radius;
    }

    if (shape.kind === 'boxes') {
        const b = shape.boxes;

        return Math.hypot(
            Math.max(Math.abs(b[0]), Math.abs(b[3])),
            Math.max(Math.abs(b[2]), Math.abs(b[5])),
        );
    }

    const m = shape.mesh.bounds;

    return Math.hypot(
        Math.max(Math.abs(m[0]), Math.abs(m[3])),
        Math.max(Math.abs(m[2]), Math.abs(m[5])),
    );
}

function localTop(shape: Shape): number {
    return shape.kind === 'cylinder'
        ? shape.height
        : shape.kind === 'boxes'
          ? shape.boxes[4]
          : shape.mesh.bounds[4];
}

function localBottom(shape: Shape): number {
    return shape.kind === 'cylinder'
        ? 0
        : shape.kind === 'boxes'
          ? shape.boxes[1]
          : shape.mesh.bounds[1];
}
