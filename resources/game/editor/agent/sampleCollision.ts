import * as THREE from 'three/webgpu';
import type { Heightfield } from '../../world/Heightfield';
import { describeCollider, STEP_HEIGHT } from '../../world/collision/Collision';
import type {
    Capsule,
    Collider,
    CollisionWorld,
} from '../../world/collision/Collision';

type Vec = { x: number; z: number };

/** Most points / path samples one call checks. */
const MAX_SAMPLES = 4000;

/**
 * sample_collision: what blocks a capsule (the player's, or a given radius / height) standing at
 * points, or walking straight from A to B. Along a path the capsule is moved in steps of half its
 * radius, stepping up onto low rocks and props as the player does; every collider it runs into is
 * reported once, with where along the path it was first hit.
 */
export function sampleCollision(
    world: CollisionWorld,
    heights: Heightfield,
    defaults: Capsule,
    payload: Record<string, unknown>,
): Record<string, unknown> {
    const capsule: Capsule = {
        radius: clampNumber(payload.radius, 0.05, 5, defaults.radius),
        height: clampNumber(payload.height, 0.2, 20, defaults.height),
        step: clampNumber(payload.step, 0, 2, defaults.step ?? STEP_HEIGHT),
    };
    const ground = (x: number, z: number) =>
        heights.contains(x, z) ? heights.sample(x, z) : 0;
    const round = (v: number) => Math.round(v * 100) / 100;

    if (Array.isArray(payload.points)) {
        const points = (payload.points as Vec[]).slice(0, MAX_SAMPLES);

        return {
            capsule,
            points: points.map((p) => {
                const terrain = ground(p.x, p.z);
                const top = world.supportHeight(
                    p.x,
                    p.z,
                    capsule.radius,
                    terrain + capsule.step,
                );
                const y = Math.max(terrain, top);
                const blockers = world.overlaps(
                    new THREE.Vector3(p.x, y, p.z),
                    capsule,
                );

                return {
                    x: p.x,
                    z: p.z,
                    ground: round(y),
                    standing_on: top > terrain ? 'collider' : 'terrain',
                    blocked: blockers.length > 0,
                    blockers: blockers.map(describeCollider),
                };
            }),
        };
    }

    const from = payload.from as Vec | undefined;
    const to = payload.to as Vec | undefined;

    if (!from || !to) {
        throw new Error('Give `points`, or `from` and `to`.');
    }

    const length = Math.hypot(to.x - from.x, to.z - from.z);
    const step = Math.max(capsule.radius * 0.5, length / MAX_SAMPLES);
    const n = Math.max(1, Math.ceil(length / step));
    const feet = new THREE.Vector3(from.x, ground(from.x, from.z), from.z);
    const hits = new Map<
        string,
        { collider: Collider; distance: number; at: THREE.Vector3 }
    >();
    let firstBlock: { distance: number; x: number; z: number } | null = null;
    let highest = -Infinity;

    for (let i = 0; i <= n; i++) {
        const t = i / n;
        const x = from.x + (to.x - from.x) * t;
        const z = from.z + (to.z - from.z) * t;
        const terrain = ground(x, z);
        const top = world.supportHeight(
            x,
            z,
            capsule.radius,
            feet.y + capsule.step,
        );
        feet.set(x, Math.max(terrain, top), z);
        highest = Math.max(highest, top);

        for (const c of world.overlaps(feet, capsule)) {
            if (!hits.has(c.info.key)) {
                hits.set(c.info.key, {
                    collider: c,
                    distance: length * t,
                    at: feet.clone(),
                });
            }

            firstBlock ??= { distance: length * t, x, z };
        }
    }

    return {
        capsule,
        length: round(length),
        clear: hits.size === 0,
        first_blocked: firstBlock
            ? {
                  distance: round(firstBlock.distance),
                  x: round(firstBlock.x),
                  z: round(firstBlock.z),
              }
            : null,
        steps_onto_colliders: highest > -Infinity,
        blockers: [...hits.values()]
            .sort((a, b) => a.distance - b.distance)
            .slice(0, 100)
            .map((h) => ({
                ...describeCollider(h.collider),
                distance: round(h.distance),
                at: { x: round(h.at.x), y: round(h.at.y), z: round(h.at.z) },
            })),
    };
}

function clampNumber(
    value: unknown,
    min: number,
    max: number,
    fallback: number,
): number {
    const n = Number(value);

    return value === undefined || value === null || !Number.isFinite(n)
        ? fallback
        : Math.min(max, Math.max(min, n));
}
