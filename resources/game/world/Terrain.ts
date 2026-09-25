import * as THREE from 'three';
import type { GridRect, Heightfield } from './Heightfield';
import type { TerrainMaterial } from './TerrainMaterial';

const CHUNK_CELLS = 64;
const MAX_LOD = 5;

type Chunk = {
    mesh: THREE.Mesh;
    geometry: THREE.BufferGeometry;
    col0: number;
    row0: number;
    center: THREE.Vector3;
    box: THREE.Box3;
    lod: number;
};

/**
 * Chunked terrain with geomipmapping LOD. Every chunk has (CHUNK_CELLS+1)² vertices plus skirt
 * vertices along its four edges that hide cracks between chunks of different LODs. Index buffers
 * for each LOD are shared between all chunks.
 */
export class Terrain {
    readonly group = new THREE.Group();
    readonly chunks: Chunk[] = [];
    readonly chunksPerSide: number;
    lodBias = 1;
    private lodIndices: THREE.BufferAttribute[] = [];
    private skirtDepth: number;

    constructor(
        readonly heights: Heightfield,
        readonly material: TerrainMaterial,
    ) {
        if ((heights.resolution - 1) % CHUNK_CELLS !== 0) {
            throw new Error(
                `Heightmap resolution must be 64·n + 1, got ${heights.resolution}.`,
            );
        }

        this.group.name = 'Terrain';
        this.chunksPerSide = (heights.resolution - 1) / CHUNK_CELLS;
        this.skirtDepth = Math.max(4, heights.cell * 6);
        this.buildIndices();

        for (let cz = 0; cz < this.chunksPerSide; cz++) {
            for (let cx = 0; cx < this.chunksPerSide; cx++) {
                this.chunks.push(
                    this.createChunk(cx * CHUNK_CELLS, cz * CHUNK_CELLS),
                );
            }
        }
    }

    /** Picks an LOD per chunk based on camera distance. */
    updateLod(camera: THREE.Camera): void {
        const chunkSize = CHUNK_CELLS * this.heights.cell;
        const camPos = camera.position;

        for (const chunk of this.chunks) {
            const d = chunk.box.distanceToPoint(camPos);
            const t = d / (chunkSize * 1.2 * this.lodBias);
            const lod = Math.min(
                MAX_LOD,
                Math.max(
                    0,
                    Math.floor(Math.log2(Math.max(1, t)) + (t > 1 ? 1 : 0)),
                ),
            );

            if (lod !== chunk.lod) {
                chunk.lod = lod;
                chunk.geometry.setIndex(this.lodIndices[lod]);
            }
        }
    }

    /** Rewrites vertex heights and normals inside the given grid rectangle. */
    updateRect(rect: GridRect): void {
        const r = {
            x0: Math.max(0, rect.x0 - 1),
            z0: Math.max(0, rect.z0 - 1),
            x1: Math.min(this.heights.resolution - 1, rect.x1 + 1),
            z1: Math.min(this.heights.resolution - 1, rect.z1 + 1),
        };

        for (const chunk of this.chunks) {
            const cx1 = chunk.col0 + CHUNK_CELLS;
            const cz1 = chunk.row0 + CHUNK_CELLS;

            if (
                r.x1 < chunk.col0 ||
                r.x0 > cx1 ||
                r.z1 < chunk.row0 ||
                r.z0 > cz1
            ) {
                continue;
            }

            this.writeChunk(chunk, {
                x0: Math.max(r.x0, chunk.col0) - chunk.col0,
                z0: Math.max(r.z0, chunk.row0) - chunk.row0,
                x1: Math.min(r.x1, cx1) - chunk.col0,
                z1: Math.min(r.z1, cz1) - chunk.row0,
            });
        }
    }

    updateAll(): void {
        this.updateRect({
            x0: 0,
            z0: 0,
            x1: this.heights.resolution - 1,
            z1: this.heights.resolution - 1,
        });
    }

    setShadows(cast: boolean): void {
        for (const chunk of this.chunks) {
            chunk.mesh.castShadow = cast;
        }
    }

    dispose(): void {
        for (const chunk of this.chunks) {
            chunk.geometry.dispose();
        }

        this.group.clear();
    }

    private createChunk(col0: number, row0: number): Chunk {
        const n = CHUNK_CELLS + 1;
        const vertexCount = n * n + 4 * n;
        const geometry = new THREE.BufferGeometry();
        const positions = new Float32Array(vertexCount * 3);
        const normals = new Float32Array(vertexCount * 3);
        geometry.setAttribute(
            'position',
            new THREE.BufferAttribute(positions, 3),
        );
        geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
        geometry.setIndex(this.lodIndices[0]);

        const mesh = new THREE.Mesh(geometry, this.material);
        mesh.receiveShadow = true;
        mesh.castShadow = true;
        mesh.matrixAutoUpdate = false;
        mesh.name = `TerrainChunk_${col0}_${row0}`;
        this.group.add(mesh);

        const chunk: Chunk = {
            mesh,
            geometry,
            col0,
            row0,
            center: new THREE.Vector3(),
            box: new THREE.Box3(),
            lod: 0,
        };

        // Static X/Z for main grid and skirts.
        for (let r = 0; r < n; r++) {
            for (let c = 0; c < n; c++) {
                const i = (r * n + c) * 3;
                positions[i] = this.heights.colToX(col0 + c);
                positions[i + 2] = this.heights.rowToZ(row0 + r);
            }
        }

        for (let e = 0; e < 4; e++) {
            for (let k = 0; k < n; k++) {
                const [c, r] = edgeCoord(e, k, CHUNK_CELLS);
                const i = (n * n + e * n + k) * 3;
                positions[i] = this.heights.colToX(col0 + c);
                positions[i + 2] = this.heights.rowToZ(row0 + r);
            }
        }

        this.writeChunk(chunk, {
            x0: 0,
            z0: 0,
            x1: CHUNK_CELLS,
            z1: CHUNK_CELLS,
        });

        return chunk;
    }

    /** Writes heights + normals for a rect in chunk-local vertex coordinates. */
    private writeChunk(chunk: Chunk, rect: GridRect): void {
        const n = CHUNK_CELLS + 1;
        const hf = this.heights;
        const pos = chunk.geometry.getAttribute(
            'position',
        ) as THREE.BufferAttribute;
        const nor = chunk.geometry.getAttribute(
            'normal',
        ) as THREE.BufferAttribute;
        const p = pos.array as Float32Array;
        const nr = nor.array as Float32Array;

        for (let r = rect.z0; r <= rect.z1; r++) {
            for (let c = rect.x0; c <= rect.x1; c++) {
                const gc = chunk.col0 + c;
                const gr = chunk.row0 + r;
                const i = r * n + c;
                p[i * 3 + 1] = hf.data[gr * hf.resolution + gc];
                hf.normalAtSample(gc, gr, nr, i * 3);
            }
        }

        // Skirts mirror their edge vertex, pushed down.
        for (let e = 0; e < 4; e++) {
            for (let k = 0; k < n; k++) {
                const [c, r] = edgeCoord(e, k, CHUNK_CELLS);

                if (c < rect.x0 || c > rect.x1 || r < rect.z0 || r > rect.z1) {
                    continue;
                }

                const src = r * n + c;
                const dst = n * n + e * n + k;
                p[dst * 3 + 1] = p[src * 3 + 1] - this.skirtDepth;
                nr[dst * 3] = nr[src * 3];
                nr[dst * 3 + 1] = nr[src * 3 + 1];
                nr[dst * 3 + 2] = nr[src * 3 + 2];
            }
        }

        pos.needsUpdate = true;
        nor.needsUpdate = true;

        // Bounds from the main grid only (skirts are hidden below).
        let minY = Infinity;
        let maxY = -Infinity;

        for (let i = 0; i < n * n; i++) {
            const y = p[i * 3 + 1];
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
        }

        chunk.box.set(
            new THREE.Vector3(
                hf.colToX(chunk.col0),
                minY - this.skirtDepth,
                hf.rowToZ(chunk.row0),
            ),
            new THREE.Vector3(
                hf.colToX(chunk.col0 + CHUNK_CELLS),
                maxY,
                hf.rowToZ(chunk.row0 + CHUNK_CELLS),
            ),
        );
        chunk.box.getCenter(chunk.center);
        chunk.geometry.boundingBox = chunk.box.clone();
        chunk.geometry.boundingSphere = chunk.box.getBoundingSphere(
            new THREE.Sphere(),
        );
    }

    private buildIndices(): void {
        const n = CHUNK_CELLS + 1;

        for (let lod = 0; lod <= MAX_LOD; lod++) {
            const s = 1 << lod;
            const idx: number[] = [];
            const v = (c: number, r: number) => r * n + c;
            const skirt = (e: number, k: number) => n * n + e * n + k;

            for (let r = 0; r < CHUNK_CELLS; r += s) {
                for (let c = 0; c < CHUNK_CELLS; c += s) {
                    const a = v(c, r);
                    const b = v(c, r + s);
                    const cc = v(c + s, r);
                    const d = v(c + s, r + s);

                    // Alternate the diagonal for a more even triangulation.
                    if ((c / s + r / s) % 2 === 0) {
                        idx.push(a, b, cc, cc, b, d);
                    } else {
                        idx.push(a, b, d, a, d, cc);
                    }
                }
            }

            for (let k = 0; k < CHUNK_CELLS; k += s) {
                // North edge (row 0), outward -Z.
                idx.push(
                    v(k, 0),
                    v(k + s, 0),
                    skirt(0, k),
                    v(k + s, 0),
                    skirt(0, k + s),
                    skirt(0, k),
                );
                // South edge (row N), outward +Z.
                idx.push(
                    v(k, CHUNK_CELLS),
                    skirt(1, k),
                    v(k + s, CHUNK_CELLS),
                    v(k + s, CHUNK_CELLS),
                    skirt(1, k),
                    skirt(1, k + s),
                );
                // West edge (col 0), outward -X.
                idx.push(
                    v(0, k),
                    skirt(2, k),
                    v(0, k + s),
                    v(0, k + s),
                    skirt(2, k),
                    skirt(2, k + s),
                );
                // East edge (col N), outward +X.
                idx.push(
                    v(CHUNK_CELLS, k),
                    v(CHUNK_CELLS, k + s),
                    skirt(3, k),
                    v(CHUNK_CELLS, k + s),
                    skirt(3, k + s),
                    skirt(3, k),
                );
            }

            this.lodIndices.push(
                new THREE.BufferAttribute(new Uint16Array(idx), 1),
            );
        }
    }
}

/** Chunk-local (col, row) of the k-th vertex along edge e: 0 north, 1 south, 2 west, 3 east. */
function edgeCoord(e: number, k: number, max: number): [number, number] {
    switch (e) {
        case 0:
            return [k, 0];
        case 1:
            return [k, max];
        case 2:
            return [0, k];
        default:
            return [max, k];
    }
}
