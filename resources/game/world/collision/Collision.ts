import * as THREE from 'three/webgpu';
import { raycastShape, sphereContacts, supportHeight } from './shapes';
import type { Shape } from './shapes';

export type ColliderSource = 'foliage' | 'ground_cover' | 'prop';

/** What a collider belongs to (sample_collision, the debug view). */
export type ColliderInfo = {
    source: ColliderSource;
    /** Unique per collider (the same object in consecutive queries has the same key). */
    key: string;
    name: string;
    /** trunk / bounds (foliage), box / auto / mesh (props). */
    mode: string;
    foliageTypeId?: number;
    propModelId?: number;
    propId?: string;
};

/** A shape placed in the world: local shape → yaw about +Y, uniform scale, translation. */
export type Collider = {
    info: ColliderInfo;
    x: number;
    y: number;
    z: number;
    cos: number;
    sin: number;
    scale: number;
    /** Horizontal bounding radius around (x, z), world metres. */
    radius: number;
    /** World height range. */
    bottom: number;
    top: number;
    shape: Shape;
};

/** Anything that owns colliders: fills `out` with those touching a world rect (O(nearby)). */
export interface CollisionProvider {
    collidersIn(
        minX: number,
        minZ: number,
        maxX: number,
        maxZ: number,
        out: Collider[],
    ): void;
}

/** A capsule standing on its feet: vertical, radius, total height. */
export type Capsule = { radius: number; height: number; step: number };

/** Obstacles lower than this (m) are stepped onto rather than blocking. */
export const STEP_HEIGHT = 0.4;

export type CollisionHit = { t: number; collider: Collider };

/**
 * Collision queries over every provider (placed foliage, ground cover, props). The providers keep
 * their own spatial grids and update them incrementally on edits; queries only look at nearby
 * colliders, so thousands of trees cost nothing until the player walks among them.
 */
export class CollisionWorld {
    enabled = true;
    private readonly scratch: Collider[] = [];

    constructor(private readonly providers: CollisionProvider[]) {}

    /** Colliders touching a world rect. */
    gather(
        minX: number,
        minZ: number,
        maxX: number,
        maxZ: number,
        out: Collider[] = [],
    ): Collider[] {
        out.length = 0;

        if (!this.enabled) {
            return out;
        }

        for (const p of this.providers) {
            p.collidersIn(minX, minZ, maxX, maxZ, out);
        }

        return out;
    }

    /**
     * Pushes a capsule (feet at `feet`) out of every collider it overlaps, horizontally: walls, trunks
     * and rocks slide the player instead of stopping it. Obstacles below `step` above the feet are left
     * to supportHeight (stepping up). Returns the horizontal contact normals (x, z pairs) for sliding
     * the velocity, and whether the head hit something above.
     */
    resolveCapsule(
        feet: THREE.Vector3,
        capsule: Capsule,
        normals: number[] = [],
    ): { normals: number[]; ceiling: boolean } {
        normals.length = 0;
        const r = capsule.radius;
        const list = this.gather(
            feet.x - r - 0.1,
            feet.z - r - 0.1,
            feet.x + r + 0.1,
            feet.z + r + 0.1,
            this.scratch,
        );
        let ceiling = false;

        if (!list.length) {
            return { normals, ceiling };
        }

        const spheres = sphereHeights(capsule);

        for (let iter = 0; iter < 4; iter++) {
            let moved = false;

            for (const h of spheres) {
                const cy = feet.y + h;

                for (const c of list) {
                    if (cy + r < c.bottom || cy - r > c.top) {
                        continue;
                    }

                    const dx = feet.x - c.x;
                    const dz = feet.z - c.z;

                    if (dx * dx + dz * dz > (c.radius + r) ** 2) {
                        continue;
                    }

                    const inv = 1 / c.scale;
                    const lx = (dx * c.cos - dz * c.sin) * inv;
                    const lz = (dx * c.sin + dz * c.cos) * inv;
                    const ly = (cy - c.y) * inv;
                    sphereContacts(
                        c.shape,
                        lx,
                        ly,
                        lz,
                        r * inv,
                        (nx, ny, nz, depth) => {
                            const wx = nx * c.cos + nz * c.sin;
                            const wz = -nx * c.sin + nz * c.cos;
                            const h2 = Math.hypot(wx, wz);

                            if (h2 < 0.3) {
                                // Floor or ceiling: floors are handled by supportHeight.
                                if (ny < -0.5) {
                                    ceiling = true;
                                }

                                return;
                            }

                            const push =
                                Math.min(depth * c.scale, r * 2) + 1e-3;
                            feet.x += (wx / h2) * push;
                            feet.z += (wz / h2) * push;
                            normals.push(wx / h2, wz / h2);
                            moved = true;
                        },
                    );
                }
            }

            if (!moved) {
                break;
            }
        }

        return { normals, ceiling };
    }

    /**
     * Highest collider surface under a disc (the capsule's footprint) that is at most `maxY`: the top of
     * a rock, crate or floor the player can stand on. -Infinity when there is none.
     */
    supportHeight(x: number, z: number, radius: number, maxY: number): number {
        const list = this.gather(
            x - radius,
            z - radius,
            x + radius,
            z + radius,
            this.scratch,
        );
        let best = -Infinity;

        for (const c of list) {
            if (c.bottom > maxY || c.top <= best) {
                continue;
            }

            const dx = x - c.x;
            const dz = z - c.z;

            if (dx * dx + dz * dz > (c.radius + radius) ** 2) {
                continue;
            }

            const inv = 1 / c.scale;
            const h = supportHeight(
                c.shape,
                (dx * c.cos - dz * c.sin) * inv,
                (dx * c.sin + dz * c.cos) * inv,
                radius * inv,
                (maxY - c.y) * inv,
            );

            if (h > -Infinity) {
                best = Math.max(best, c.y + h * c.scale);
            }
        }

        return best;
    }

    /** First collider hit by the segment from → to (t in 0…1), or null. */
    raycast(from: THREE.Vector3, to: THREE.Vector3): CollisionHit | null {
        const list = this.gather(
            Math.min(from.x, to.x),
            Math.min(from.z, to.z),
            Math.max(from.x, to.x),
            Math.max(from.z, to.z),
            this.scratch,
        );
        let best: CollisionHit | null = null;
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const dz = to.z - from.z;

        for (const c of list) {
            if (
                Math.max(from.y, to.y) < c.bottom ||
                Math.min(from.y, to.y) > c.top
            ) {
                continue;
            }

            const inv = 1 / c.scale;
            const ox = from.x - c.x;
            const oz = from.z - c.z;
            const t = raycastShape(
                c.shape,
                (ox * c.cos - oz * c.sin) * inv,
                (from.y - c.y) * inv,
                (ox * c.sin + oz * c.cos) * inv,
                (dx * c.cos - dz * c.sin) * inv,
                dy * inv,
                (dx * c.sin + dz * c.cos) * inv,
            );

            if (t <= 1 && (!best || t < best.t)) {
                best = { t, collider: c };
            }
        }

        return best;
    }

    /** Colliders a capsule standing at `feet` overlaps above its step height (what blocks it there). */
    overlaps(feet: THREE.Vector3, capsule: Capsule): Collider[] {
        const r = capsule.radius;
        const list = this.gather(
            feet.x - r - 0.1,
            feet.z - r - 0.1,
            feet.x + r + 0.1,
            feet.z + r + 0.1,
        );
        const hits: Collider[] = [];

        for (const c of list) {
            const dx = feet.x - c.x;
            const dz = feet.z - c.z;

            if (dx * dx + dz * dz > (c.radius + r) ** 2) {
                continue;
            }

            const inv = 1 / c.scale;
            const lx = (dx * c.cos - dz * c.sin) * inv;
            const lz = (dx * c.sin + dz * c.cos) * inv;
            let hit = false;

            for (const h of sphereHeights(capsule)) {
                const cy = feet.y + h;

                if (hit || cy + r < c.bottom || cy - r > c.top) {
                    continue;
                }

                sphereContacts(
                    c.shape,
                    lx,
                    (cy - c.y) * inv,
                    lz,
                    r * inv,
                    (_x, ny, _z, depth) => {
                        if (depth > 0.01 * inv && Math.abs(ny) < 0.95) {
                            hit = true;
                        }
                    },
                );
            }

            if (hit) {
                hits.push(c);
            }
        }

        return hits;
    }
}

/** Heights (above the feet) of the spheres making up a capsule's blocking part. */
export function sphereHeights(capsule: Capsule): number[] {
    const r = capsule.radius;
    const low = capsule.step + r;
    const high = Math.max(low, capsule.height - r);
    const n = Math.max(1, Math.ceil((high - low) / r) + 1);
    const out: number[] = [];

    for (let i = 0; i < n; i++) {
        out.push(n === 1 ? low : low + ((high - low) * i) / (n - 1));
    }

    return out;
}

/** Collider info as the MCP tools report it. */
export function describeCollider(c: Collider): Record<string, unknown> {
    const i = c.info;
    const round = (v: number) => Math.round(v * 100) / 100;

    return {
        source: i.source,
        name: i.name,
        collision: i.mode,
        ...(i.foliageTypeId !== undefined
            ? { foliage_type_id: i.foliageTypeId }
            : {}),
        ...(i.propModelId !== undefined
            ? { prop_model_id: i.propModelId }
            : {}),
        ...(i.propId !== undefined ? { prop_id: i.propId } : {}),
        position: { x: round(c.x), y: round(c.y), z: round(c.z) },
        radius: round(c.radius),
        top: round(c.top),
    };
}
