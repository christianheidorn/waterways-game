import type { FoliageKind } from '../../shared/types';
import { mulberry32, SimplexNoise } from '../../util/noise';

/**
 * Candidates of the procedural foliage scatter (Foliage.populate): a jittered grid per type with the
 * probability from the forest / meadow noise fields. Pure (no world state), so it runs the same on the
 * main thread and in the editor worker (editor/workers/editorWorker.ts, used on the WebGL fallback).
 * The world-dependent parts (water for reeds, slope for rocks, land cover, the type's rules and
 * spacing) stay with populate().
 */

export type ScatterType = { id: number; kind: FoliageKind; density: number };

const KIND_FACTOR: Record<string, number> = {
    conifer: 1,
    broadleaf: 1,
    palm: 0.6,
    bush: 0.35,
    grass: 0.12,
    flower: 0.12,
    reed: 0.5,
    rock: 0.6,
};

/** Most instances one scatter places per type. */
export const SCATTER_CAP: Record<string, number> = {
    conifer: 30000,
    broadleaf: 25000,
    palm: 8000,
    bush: 25000,
    grass: 140000,
    flower: 25000,
    reed: 20000,
    rock: 8000,
};

/** Floats per candidate: x, z, noise probability (-1: decided by the world), acceptance draw. */
export const CANDIDATE_STRIDE = 4;

function smooth01(a: number, b: number, v: number): number {
    const t = Math.min(1, Math.max(0, (v - a) / (b - a)));

    return t * t * (3 - 2 * t);
}

export function isTreeKind(kind: string): boolean {
    return kind === 'conifer' || kind === 'broadleaf' || kind === 'palm';
}

/**
 * Candidates of one type on a `size` m map, ordered row by row. Only candidates that can still be
 * accepted are returned: the draw must be below the noise probability (for trees on mapped land
 * cover below the forest boost, 0.55 + 0.45 p, which is the most land cover can raise it to).
 */
export function scatterCandidates(
    size: number,
    seed: number,
    type: ScatterType,
    landCover: boolean,
): Float32Array {
    const noise = new SimplexNoise(seed * 31 + 7);
    const rand = mulberry32(seed * 977 + 13 + type.id * 7919);
    const half = size / 2;
    const density = Math.max(
        0.001,
        type.density * (KIND_FACTOR[type.kind] ?? 0.5),
    );
    const spacing = Math.max(0.6, Math.sqrt(100 / density));
    const steps = Math.floor(size / spacing);
    const typeSeed = type.id * 0.37;
    const kind = type.kind;
    const forest = (x: number, z: number) =>
        noise.fbm(x / 420, z / 420, 4) * 0.8 +
        noise.noise2D(x / 90 + 50, z / 90) * 0.2;
    const meadow = (x: number, z: number) =>
        noise.fbm(x / 160 + 100, z / 160 - 40, 3);
    const out: number[] = [];
    // Plenty for the placements a type is capped at (spacing and rules reject some).
    const limit = (SCATTER_CAP[kind] ?? 20000) * 3;

    for (let j = 0; j < steps; j++) {
        for (let i = 0; i < steps; i++) {
            const x = -half + (i + rand()) * spacing;
            const z = -half + (j + rand()) * spacing;
            const r = rand();
            let p = -1;

            if (kind !== 'reed' && kind !== 'rock') {
                const f = forest(x + typeSeed * 1000, z);

                switch (kind) {
                    case 'conifer':
                    case 'broadleaf':
                    case 'palm':
                        p = smooth01(
                            0.05,
                            0.35,
                            f +
                                (kind === 'broadleaf'
                                    ? noise.noise2D(x / 300, z / 300 + 9) * 0.25
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
                    default:
                        p = 1;
                }

                const bound =
                    landCover && isTreeKind(kind) ? 0.55 + p * 0.45 : p;

                if (r > bound) {
                    continue;
                }
            } else if (kind === 'reed' && r > 0.9) {
                continue;
            }

            out.push(x, z, p, r);

            if (out.length >= limit * CANDIDATE_STRIDE) {
                return Float32Array.from(out);
            }
        }
    }

    return Float32Array.from(out);
}
