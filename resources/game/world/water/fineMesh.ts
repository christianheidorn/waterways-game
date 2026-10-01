import * as THREE from 'three/webgpu';

/** Spacing (m) of the innermost ring of the fine water mesh (before the camera-height scale). */
export const FINE_BASE_SPACING = 0.25;
/** Quads per side of each level (power of two). */
const QUADS = 64;

export type FineMeshLayout = {
    /** Half size of the whole mesh (m, before scaling). */
    half: number;
    /** Spacing of the coarsest level (m): the mesh moves in steps of twice this. */
    coarsest: number;
};

/**
 * Camera-centred fine water mesh: a 64×64 grid of 0.25 m quads around the camera surrounded by rings of
 * doubling spacing (`levels` in all), like a geometry clipmap. The mesh only moves in steps of twice the
 * coarsest spacing, so every vertex keeps its parity; vertices in the outer band of each level are morphed
 * (CDLOD) onto the even grid of the next level, so ring borders meet the coarser ring's vertices exactly
 * and the displaced surface has no cracks. Vertex heights come from the water level texture in the shader;
 * where there is no water the fragments are discarded.
 */
export function createFineMeshGeometry(levels = 4): {
    geometry: THREE.BufferGeometry;
    layout: FineMeshLayout;
} {
    const positions: number[] = [];
    const index: number[] = [];
    const half = QUADS / 2;

    for (let level = 0; level < levels; level++) {
        const s = FINE_BASE_SPACING * 2 ** level;
        const start = positions.length / 3;
        const last = level === levels - 1;

        for (let j = -half; j <= half; j++) {
            for (let i = -half; i <= half; i++) {
                // Morph band: the outer 6 quads ramp onto the even grid of the next (coarser) level.
                const d = Math.max(Math.abs(i), Math.abs(j));
                const m = last ? 0 : Math.min(1, Math.max(0, (d - 26) / 5));
                const oi = ((i % 2) + 2) % 2;
                const oj = ((j % 2) + 2) % 2;
                positions.push((i - oi * m) * s, 0, (j - oj * m) * s);
            }
        }

        const row = QUADS + 1;

        for (let j = 0; j < QUADS; j++) {
            for (let i = 0; i < QUADS; i++) {
                const ci = i - half + 0.5;
                const cj = j - half + 0.5;

                // Rings leave out the area the finer level covers.
                if (
                    level > 0 &&
                    Math.abs(ci) < half / 2 &&
                    Math.abs(cj) < half / 2
                ) {
                    continue;
                }

                const a = start + j * row + i;
                const b = a + row;
                index.push(a, b, a + 1, a + 1, b, b + 1);
            }
        }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(positions, 3),
    );
    geometry.setAttribute(
        'normal',
        new THREE.Float32BufferAttribute(
            Array.from({ length: positions.length }, (_, i) =>
                i % 3 === 1 ? 1 : 0,
            ),
            3,
        ),
    );
    geometry.setAttribute(
        'waterFine',
        new THREE.Float32BufferAttribute(
            new Float32Array(positions.length / 3).fill(1),
            1,
        ),
    );
    geometry.setIndex(index);
    const coarsest = FINE_BASE_SPACING * 2 ** (levels - 1);
    const extent = half * coarsest;
    geometry.boundingSphere = new THREE.Sphere(
        new THREE.Vector3(),
        extent * 1.5,
    );

    return { geometry, layout: { half: extent, coarsest } };
}
