/** Largest box count before the voxel grid is coarsened. */
const MAX_BOXES = 160;

/**
 * A small set of boxes approximating a model (local space), for props with `auto` collision: the
 * surface is voxelised on a coarse grid (about 32 voxels along the longest side, at least 12 cm) and
 * the solid voxels are merged greedily into boxes. Only the surface is filled, so rooms, doorways and
 * arches stay open (walls grow by less than a voxel, and every box is shrunk back by a fifth of one).
 *
 * @param triangles 9 floats per triangle
 * @returns boxes as [minX, minY, minZ, maxX, maxY, maxZ] per box
 */
export function voxelBoxes(triangles: Float32Array): Float32Array {
    const bounds = [
        Infinity,
        Infinity,
        Infinity,
        -Infinity,
        -Infinity,
        -Infinity,
    ];

    for (let i = 0; i < triangles.length; i += 3) {
        for (let k = 0; k < 3; k++) {
            bounds[k] = Math.min(bounds[k], triangles[i + k]);
            bounds[k + 3] = Math.max(bounds[k + 3], triangles[i + k]);
        }
    }

    if (!triangles.length) {
        return new Float32Array(0);
    }

    const span = Math.max(
        bounds[3] - bounds[0],
        bounds[4] - bounds[1],
        bounds[5] - bounds[2],
    );
    let voxel = Math.max(0.12, span / 32);

    for (let attempt = 0; attempt < 4; attempt++) {
        const boxes = voxelise(triangles, bounds, voxel);

        if (boxes.length / 6 <= MAX_BOXES || attempt === 3) {
            return boxes;
        }

        voxel *= 1.6;
    }

    return new Float32Array(0);
}

function voxelise(
    tri: Float32Array,
    bounds: number[],
    voxel: number,
): Float32Array {
    const nx = Math.max(1, Math.ceil((bounds[3] - bounds[0]) / voxel));
    const ny = Math.max(1, Math.ceil((bounds[4] - bounds[1]) / voxel));
    const nz = Math.max(1, Math.ceil((bounds[5] - bounds[2]) / voxel));
    const solid = new Uint8Array(nx * ny * nz);
    /** Highest sample in each voxel: box tops sit on the real surface, not the voxel's top. */
    const top = new Float32Array(nx * ny * nz).fill(-Infinity);
    const index = (x: number, y: number, z: number) => (y * nz + z) * nx + x;
    const mark = (px: number, py: number, pz: number) => {
        const x = Math.min(
            nx - 1,
            Math.max(0, Math.floor((px - bounds[0]) / voxel)),
        );
        const y = Math.min(
            ny - 1,
            Math.max(0, Math.floor((py - bounds[1]) / voxel)),
        );
        const z = Math.min(
            nz - 1,
            Math.max(0, Math.floor((pz - bounds[2]) / voxel)),
        );
        const i = index(x, y, z);
        solid[i] = 1;
        top[i] = Math.max(top[i], py);
    };

    // Sample every triangle densely enough that no voxel it passes through is skipped.
    for (let o = 0; o + 8 < tri.length; o += 9) {
        const edge = Math.max(
            Math.hypot(
                tri[o + 3] - tri[o],
                tri[o + 4] - tri[o + 1],
                tri[o + 5] - tri[o + 2],
            ),
            Math.hypot(
                tri[o + 6] - tri[o],
                tri[o + 7] - tri[o + 1],
                tri[o + 8] - tri[o + 2],
            ),
            Math.hypot(
                tri[o + 6] - tri[o + 3],
                tri[o + 7] - tri[o + 4],
                tri[o + 8] - tri[o + 5],
            ),
        );
        const n = Math.min(200, Math.max(1, Math.ceil(edge / (voxel * 0.5))));

        for (let i = 0; i <= n; i++) {
            for (let j = 0; j <= n - i; j++) {
                const u = i / n;
                const v = j / n;
                const w = 1 - u - v;
                mark(
                    tri[o] * w + tri[o + 3] * u + tri[o + 6] * v,
                    tri[o + 1] * w + tri[o + 4] * u + tri[o + 7] * v,
                    tri[o + 2] * w + tri[o + 5] * u + tri[o + 8] * v,
                );
            }
        }
    }

    // Greedy merge: runs along x, grown along z, then along y.
    const used = new Uint8Array(solid.length);
    const free = (x: number, y: number, z: number) =>
        solid[index(x, y, z)] === 1 && used[index(x, y, z)] === 0;
    const out: number[] = [];
    const shrink = voxel * 0.2;

    for (let y = 0; y < ny; y++) {
        for (let z = 0; z < nz; z++) {
            for (let x = 0; x < nx; x++) {
                if (!free(x, y, z)) {
                    continue;
                }

                let x1 = x;

                while (x1 + 1 < nx && free(x1 + 1, y, z)) {
                    x1++;
                }

                let z1 = z;

                grow: while (z1 + 1 < nz) {
                    for (let i = x; i <= x1; i++) {
                        if (!free(i, y, z1 + 1)) {
                            break grow;
                        }
                    }

                    z1++;
                }

                let y1 = y;

                rise: while (y1 + 1 < ny) {
                    for (let k = z; k <= z1; k++) {
                        for (let i = x; i <= x1; i++) {
                            if (!free(i, y1 + 1, k)) {
                                break rise;
                            }
                        }
                    }

                    y1++;
                }

                let surface = -Infinity;

                for (let j = y; j <= y1; j++) {
                    for (let k = z; k <= z1; k++) {
                        for (let i = x; i <= x1; i++) {
                            used[index(i, j, k)] = 1;

                            if (j === y1) {
                                surface = Math.max(
                                    surface,
                                    top[index(i, j, k)],
                                );
                            }
                        }
                    }
                }

                const minX = bounds[0] + x * voxel;
                const minZ = bounds[2] + z * voxel;
                const maxX = Math.min(bounds[3], bounds[0] + (x1 + 1) * voxel);
                const maxZ = Math.min(bounds[5], bounds[2] + (z1 + 1) * voxel);
                const minY = bounds[1] + y * voxel;
                const maxY = Math.max(minY + 0.02, surface);
                // Shrink the sides (not below a sliver), keep floors and tops where they are.
                const sx = Math.min(shrink, (maxX - minX) * 0.3);
                const sz = Math.min(shrink, (maxZ - minZ) * 0.3);
                out.push(
                    minX + sx,
                    minY,
                    minZ + sz,
                    maxX - sx,
                    maxY,
                    maxZ - sz,
                );
            }
        }
    }

    return new Float32Array(out);
}
