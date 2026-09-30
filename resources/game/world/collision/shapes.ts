import * as THREE from 'three/webgpu';

/**
 * Collision shapes in a collider's local space (base at y = 0, +Y up, before the instance's yaw,
 * uniform scale and position). All queries run in local space; CollisionWorld converts.
 */
export type Shape =
    /** Vertical cylinder around (cx, cz) (tree trunks, rocks with a radius override). */
    | {
          kind: 'cylinder';
          radius: number;
          height: number;
          cx: number;
          cz: number;
      }
    /** Axis-aligned boxes in local space: [minX, minY, minZ, maxX, maxY, maxZ] per box. */
    | { kind: 'boxes'; boxes: Float32Array }
    /** Exact triangles (walk-in buildings). */
    | { kind: 'mesh'; mesh: MeshShape };

/** Receives a contact: the direction pushing the query out (local, unit) and the penetration depth. */
export type ContactFn = (
    nx: number,
    ny: number,
    nz: number,
    depth: number,
) => void;

/** Local-space bounds of a shape: [minX, minY, minZ, maxX, maxY, maxZ]. */
export function shapeBounds(shape: Shape): number[] {
    switch (shape.kind) {
        case 'cylinder':
            return [
                shape.cx - shape.radius,
                0,
                shape.cz - shape.radius,
                shape.cx + shape.radius,
                shape.height,
                shape.cz + shape.radius,
            ];
        case 'boxes': {
            const b = shape.boxes;
            const out = [
                Infinity,
                Infinity,
                Infinity,
                -Infinity,
                -Infinity,
                -Infinity,
            ];

            for (let i = 0; i < b.length; i += 6) {
                for (let k = 0; k < 3; k++) {
                    out[k] = Math.min(out[k], b[i + k]);
                    out[k + 3] = Math.max(out[k + 3], b[i + 3 + k]);
                }
            }

            return out;
        }
        case 'mesh':
            return [...shape.mesh.bounds];
    }
}

/** Sphere (local centre, radius) against a shape: calls `contact` for each overlap. */
export function sphereContacts(
    shape: Shape,
    px: number,
    py: number,
    pz: number,
    r: number,
    contact: ContactFn,
): void {
    switch (shape.kind) {
        case 'cylinder':
            cylinderContact(
                shape.radius,
                shape.height,
                px - shape.cx,
                py,
                pz - shape.cz,
                r,
                contact,
            );
            break;
        case 'boxes': {
            const b = shape.boxes;

            for (let i = 0; i < b.length; i += 6) {
                boxContact(b, i, px, py, pz, r, contact);
            }

            break;
        }
        case 'mesh':
            shape.mesh.sphereContacts(px, py, pz, r, contact);
            break;
    }
}

/**
 * Highest walkable surface of a shape under a disc (local centre x, z and radius) that is not above
 * `maxY`, or -Infinity.
 */
export function supportHeight(
    shape: Shape,
    x: number,
    z: number,
    r: number,
    maxY: number,
): number {
    let best = -Infinity;

    switch (shape.kind) {
        case 'cylinder':
            if (
                shape.height <= maxY &&
                Math.hypot(x - shape.cx, z - shape.cz) <= shape.radius + r * 0.5
            ) {
                best = shape.height;
            }

            break;
        case 'boxes': {
            const b = shape.boxes;
            const reach = r * 0.5;

            for (let i = 0; i < b.length; i += 6) {
                const top = b[i + 4];

                if (top > maxY || top <= best) {
                    continue;
                }

                const dx = Math.max(b[i] - x, 0, x - b[i + 3]);
                const dz = Math.max(b[i + 2] - z, 0, z - b[i + 5]);

                if (dx * dx + dz * dz <= reach * reach) {
                    best = top;
                }
            }

            break;
        }
        case 'mesh': {
            const o = r * 0.5;
            best = Math.max(
                shape.mesh.surfaceBelow(x, z, maxY),
                shape.mesh.surfaceBelow(x + o, z, maxY),
                shape.mesh.surfaceBelow(x - o, z, maxY),
                shape.mesh.surfaceBelow(x, z + o, maxY),
                shape.mesh.surfaceBelow(x, z - o, maxY),
            );
            break;
        }
    }

    return best;
}

/**
 * First hit of the segment origin + t · dir (t in 0…1, local space) with a shape: the t, or Infinity.
 */
export function raycastShape(
    shape: Shape,
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
): number {
    switch (shape.kind) {
        case 'cylinder':
            return rayCylinder(
                shape.radius,
                shape.height,
                ox - shape.cx,
                oy,
                oz - shape.cz,
                dx,
                dy,
                dz,
            );
        case 'boxes': {
            const b = shape.boxes;
            let best = Infinity;

            for (let i = 0; i < b.length; i += 6) {
                best = Math.min(best, rayBox(b, i, ox, oy, oz, dx, dy, dz));
            }

            return best;
        }
        case 'mesh':
            return shape.mesh.raycast(ox, oy, oz, dx, dy, dz);
    }
}

function cylinderContact(
    radius: number,
    height: number,
    px: number,
    py: number,
    pz: number,
    r: number,
    contact: ContactFn,
): void {
    if (py < -r || py > height + r) {
        return;
    }

    const d = Math.hypot(px, pz);

    if (d > radius + r) {
        return;
    }

    const inside = py >= 0 && py <= height;

    if (inside) {
        // Beside (or inside) the wall: push out radially.
        if (d < 1e-6) {
            contact(1, 0, 0, radius + r);
        } else {
            contact(px / d, 0, pz / d, radius + r - d);
        }

        return;
    }

    // Above or below the caps.
    const s = d > radius ? radius / d : 1;
    const qx = px * s;
    const qz = pz * s;
    const qy = py < 0 ? 0 : height;
    const vx = px - qx;
    const vy = py - qy;
    const vz = pz - qz;
    const dist = Math.hypot(vx, vy, vz);

    if (dist < r && dist > 1e-9) {
        contact(vx / dist, vy / dist, vz / dist, r - dist);
    }
}

function boxContact(
    b: Float32Array,
    i: number,
    px: number,
    py: number,
    pz: number,
    r: number,
    contact: ContactFn,
): void {
    const qx = Math.min(Math.max(px, b[i]), b[i + 3]);
    const qy = Math.min(Math.max(py, b[i + 1]), b[i + 4]);
    const qz = Math.min(Math.max(pz, b[i + 2]), b[i + 5]);
    const vx = px - qx;
    const vy = py - qy;
    const vz = pz - qz;
    const d2 = vx * vx + vy * vy + vz * vz;

    if (d2 > r * r) {
        return;
    }

    if (d2 > 1e-12) {
        const d = Math.sqrt(d2);
        contact(vx / d, vy / d, vz / d, r - d);

        return;
    }

    // Centre inside: out through the nearest face (sides preferred over top / bottom).
    const faces = [
        [px - b[i], -1, 0, 0],
        [b[i + 3] - px, 1, 0, 0],
        [pz - b[i + 2], 0, 0, -1],
        [b[i + 5] - pz, 0, 0, 1],
        [(py - b[i + 1]) * 1.5, 0, -1, 0],
        [(b[i + 4] - py) * 1.5, 0, 1, 0],
    ];
    let best = faces[0];

    for (const f of faces) {
        if (f[0] < best[0]) {
            best = f;
        }
    }

    const depth = best[1] !== 0 || best[3] !== 0 ? best[0] : best[0] / 1.5;
    contact(best[1], best[2], best[3], depth + r);
}

function rayCylinder(
    radius: number,
    height: number,
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
): number {
    if (ox * ox + oz * oz <= radius * radius && oy >= 0 && oy <= height) {
        return 0;
    }

    let best = Infinity;
    const a = dx * dx + dz * dz;

    if (a > 1e-12) {
        const b = 2 * (ox * dx + oz * dz);
        const c = ox * ox + oz * oz - radius * radius;
        const disc = b * b - 4 * a * c;

        if (disc >= 0) {
            const t = (-b - Math.sqrt(disc)) / (2 * a);
            const y = oy + dy * t;

            if (t >= 0 && t <= 1 && y >= 0 && y <= height) {
                best = t;
            }
        }
    }

    if (Math.abs(dy) > 1e-12) {
        for (const capY of [0, height]) {
            const t = (capY - oy) / dy;

            if (t >= 0 && t <= 1 && t < best) {
                const x = ox + dx * t;
                const z = oz + dz * t;

                if (x * x + z * z <= radius * radius) {
                    best = t;
                }
            }
        }
    }

    return best;
}

function rayBox(
    b: ArrayLike<number>,
    i: number,
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
): number {
    let t0 = 0;
    let t1 = 1;
    const o = [ox, oy, oz];
    const d = [dx, dy, dz];

    for (let k = 0; k < 3; k++) {
        const min = b[i + k];
        const max = b[i + 3 + k];

        if (Math.abs(d[k]) < 1e-12) {
            if (o[k] < min || o[k] > max) {
                return Infinity;
            }

            continue;
        }

        let a = (min - o[k]) / d[k];
        let c = (max - o[k]) / d[k];

        if (a > c) {
            [a, c] = [c, a];
        }

        t0 = Math.max(t0, a);
        t1 = Math.min(t1, c);

        if (t0 > t1) {
            return Infinity;
        }
    }

    return t0;
}

/** Scratch for closestOnTriangle. */
const _q = [0, 0, 0];

/**
 * Triangles of a model in local space with a column grid over x / z (each column lists the triangles
 * whose footprint touches it), for exact sphere, ground and ray queries.
 */
export class MeshShape {
    readonly bounds: number[];
    readonly triangles: number;
    private readonly cell: number;
    private readonly nx: number;
    private readonly nz: number;
    private readonly starts: Uint32Array;
    private readonly items: Uint32Array;
    private readonly normals: Float32Array;
    private readonly marks: Uint32Array;
    private stamp = 0;
    private edgeCache: Float32Array | null = null;

    /** @param positions 9 floats per triangle */
    constructor(private readonly positions: Float32Array) {
        const count = positions.length / 9;
        this.triangles = count;
        const bounds = [
            Infinity,
            Infinity,
            Infinity,
            -Infinity,
            -Infinity,
            -Infinity,
        ];

        for (let i = 0; i < positions.length; i += 3) {
            for (let k = 0; k < 3; k++) {
                bounds[k] = Math.min(bounds[k], positions[i + k]);
                bounds[k + 3] = Math.max(bounds[k + 3], positions[i + k]);
            }
        }

        if (!count) {
            bounds.fill(0);
        }

        this.bounds = bounds;
        const span = Math.max(bounds[3] - bounds[0], bounds[5] - bounds[2]);
        this.cell = Math.max(0.5, span / 32);
        this.nx = Math.max(1, Math.ceil((bounds[3] - bounds[0]) / this.cell));
        this.nz = Math.max(1, Math.ceil((bounds[5] - bounds[2]) / this.cell));
        this.normals = new Float32Array(count * 3);
        this.marks = new Uint32Array(count);

        const counts = new Uint32Array(this.nx * this.nz + 1);
        const ranges = new Int32Array(count * 4);

        for (let t = 0; t < count; t++) {
            const o = t * 9;
            const ax = positions[o];
            const ay = positions[o + 1];
            const az = positions[o + 2];
            const e1x = positions[o + 3] - ax;
            const e1y = positions[o + 4] - ay;
            const e1z = positions[o + 5] - az;
            const e2x = positions[o + 6] - ax;
            const e2y = positions[o + 7] - ay;
            const e2z = positions[o + 8] - az;
            const nx = e1y * e2z - e1z * e2y;
            const ny = e1z * e2x - e1x * e2z;
            const nz = e1x * e2y - e1y * e2x;
            const len = Math.hypot(nx, ny, nz) || 1;
            this.normals[t * 3] = nx / len;
            this.normals[t * 3 + 1] = ny / len;
            this.normals[t * 3 + 2] = nz / len;
            const minX = Math.min(ax, positions[o + 3], positions[o + 6]);
            const maxX = Math.max(ax, positions[o + 3], positions[o + 6]);
            const minZ = Math.min(az, positions[o + 5], positions[o + 8]);
            const maxZ = Math.max(az, positions[o + 5], positions[o + 8]);
            const c0 = this.col(minX);
            const c1 = this.col(maxX);
            const r0 = this.row(minZ);
            const r1 = this.row(maxZ);
            ranges.set([c0, c1, r0, r1], t * 4);

            for (let r = r0; r <= r1; r++) {
                for (let c = c0; c <= c1; c++) {
                    counts[r * this.nx + c + 1]++;
                }
            }
        }

        for (let i = 1; i < counts.length; i++) {
            counts[i] += counts[i - 1];
        }

        this.starts = counts.slice();
        const fill = counts.slice();
        this.items = new Uint32Array(counts[counts.length - 1]);

        for (let t = 0; t < count; t++) {
            const [c0, c1, r0, r1] = ranges.subarray(t * 4, t * 4 + 4);

            for (let r = r0; r <= r1; r++) {
                for (let c = c0; c <= c1; c++) {
                    this.items[fill[r * this.nx + c]++] = t;
                }
            }
        }
    }

    /** Flattens (indexed or not) geometries into a mesh shape. */
    static fromGeometries(geometries: THREE.BufferGeometry[]): MeshShape {
        return new MeshShape(trianglesOf(geometries));
    }

    sphereContacts(
        px: number,
        py: number,
        pz: number,
        r: number,
        contact: ContactFn,
    ): void {
        const b = this.bounds;

        if (
            px + r < b[0] ||
            px - r > b[3] ||
            py + r < b[1] ||
            py - r > b[4] ||
            pz + r < b[2] ||
            pz - r > b[5]
        ) {
            return;
        }

        const p = this.positions;
        this.visit(px - r, pz - r, px + r, pz + r, (t) => {
            closestOnTriangle(px, py, pz, p, t * 9, _q);
            const vx = px - _q[0];
            const vy = py - _q[1];
            const vz = pz - _q[2];
            const d2 = vx * vx + vy * vy + vz * vz;

            if (d2 >= r * r) {
                return;
            }

            const d = Math.sqrt(d2);

            if (d > 1e-6) {
                contact(vx / d, vy / d, vz / d, r - d);
            } else {
                const n = this.normals;
                contact(n[t * 3], n[t * 3 + 1], n[t * 3 + 2], r);
            }
        });
    }

    /** Highest upward-facing surface at (x, z) not above maxY, or -Infinity. */
    surfaceBelow(x: number, z: number, maxY: number): number {
        const b = this.bounds;

        if (x < b[0] || x > b[3] || z < b[2] || z > b[5] || maxY < b[1]) {
            return -Infinity;
        }

        let best = -Infinity;
        const p = this.positions;
        const n = this.normals;
        this.visit(x, z, x, z, (t) => {
            if (Math.abs(n[t * 3 + 1]) < 0.35) {
                return;
            }

            const y = heightOnTriangle(p, t * 9, x, z);

            if (y !== null && y <= maxY + 1e-4 && y > best) {
                best = y;
            }
        });

        return best;
    }

    raycast(
        ox: number,
        oy: number,
        oz: number,
        dx: number,
        dy: number,
        dz: number,
    ): number {
        const p = this.positions;
        let best = Infinity;
        this.visit(
            Math.min(ox, ox + dx),
            Math.min(oz, oz + dz),
            Math.max(ox, ox + dx),
            Math.max(oz, oz + dz),
            (t) => {
                const hit = rayTriangle(p, t * 9, ox, oy, oz, dx, dy, dz);

                if (hit < best) {
                    best = hit;
                }
            },
        );

        return best;
    }

    /** Line segments of every triangle edge (debug view), in local space. */
    edges(): Float32Array {
        if (this.edgeCache) {
            return this.edgeCache;
        }

        const p = this.positions;
        const out = new Float32Array(this.triangles * 18);

        for (let t = 0; t < this.triangles; t++) {
            const o = t * 9;
            const w = t * 18;

            for (let e = 0; e < 3; e++) {
                const a = o + e * 3;
                const b = o + ((e + 1) % 3) * 3;
                out.set(
                    [p[a], p[a + 1], p[a + 2], p[b], p[b + 1], p[b + 2]],
                    w + e * 6,
                );
            }
        }

        this.edgeCache = out;

        return out;
    }

    /** Each triangle touching the x / z rect, once. */
    private visit(
        minX: number,
        minZ: number,
        maxX: number,
        maxZ: number,
        fn: (t: number) => void,
    ): void {
        const b = this.bounds;

        if (maxX < b[0] || minX > b[3] || maxZ < b[2] || minZ > b[5]) {
            return;
        }

        this.stamp = (this.stamp + 1) >>> 0;

        if (this.stamp === 0) {
            this.marks.fill(0);
            this.stamp = 1;
        }

        const c0 = this.col(minX);
        const c1 = this.col(maxX);
        const r0 = this.row(minZ);
        const r1 = this.row(maxZ);

        for (let r = r0; r <= r1; r++) {
            for (let c = c0; c <= c1; c++) {
                const cell = r * this.nx + c;

                for (
                    let i = this.starts[cell];
                    i < this.starts[cell + 1];
                    i++
                ) {
                    const t = this.items[i];

                    if (this.marks[t] !== this.stamp) {
                        this.marks[t] = this.stamp;
                        fn(t);
                    }
                }
            }
        }
    }

    private col(x: number): number {
        return Math.min(
            this.nx - 1,
            Math.max(0, Math.floor((x - this.bounds[0]) / this.cell)),
        );
    }

    private row(z: number): number {
        return Math.min(
            this.nz - 1,
            Math.max(0, Math.floor((z - this.bounds[2]) / this.cell)),
        );
    }
}

/** Closest point on triangle p[o…o+9] to (px, py, pz) (Ericson, Real-Time Collision Detection). */
function closestOnTriangle(
    px: number,
    py: number,
    pz: number,
    p: Float32Array,
    o: number,
    out: number[],
): void {
    const ax = p[o];
    const ay = p[o + 1];
    const az = p[o + 2];
    const bx = p[o + 3];
    const by = p[o + 4];
    const bz = p[o + 5];
    const cx = p[o + 6];
    const cy = p[o + 7];
    const cz = p[o + 8];
    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const acx = cx - ax;
    const acy = cy - ay;
    const acz = cz - az;
    const apx = px - ax;
    const apy = py - ay;
    const apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz;
    const d2 = acx * apx + acy * apy + acz * apz;
    const set = (x: number, y: number, z: number) => {
        out[0] = x;
        out[1] = y;
        out[2] = z;
    };

    if (d1 <= 0 && d2 <= 0) {
        return set(ax, ay, az);
    }

    const bpx = px - bx;
    const bpy = py - by;
    const bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;

    if (d3 >= 0 && d4 <= d3) {
        return set(bx, by, bz);
    }

    const vc = d1 * d4 - d3 * d2;

    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);

        return set(ax + abx * v, ay + aby * v, az + abz * v);
    }

    const cpx = px - cx;
    const cpy = py - cy;
    const cpz = pz - cz;
    const d5 = abx * cpx + aby * cpy + abz * cpz;
    const d6 = acx * cpx + acy * cpy + acz * cpz;

    if (d6 >= 0 && d5 <= d6) {
        return set(cx, cy, cz);
    }

    const vb = d5 * d2 - d1 * d6;

    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        const w = d2 / (d2 - d6);

        return set(ax + acx * w, ay + acy * w, az + acz * w);
    }

    const va = d3 * d6 - d5 * d4;

    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
        const w = (d4 - d3) / (d4 - d3 + (d5 - d6));

        return set(bx + (cx - bx) * w, by + (cy - by) * w, bz + (cz - bz) * w);
    }

    const denom = 1 / (va + vb + vc);
    const v = vb * denom;
    const w = vc * denom;
    set(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}

/** Height of the triangle's plane at (x, z) if (x, z) lies inside its footprint. */
function heightOnTriangle(
    p: Float32Array,
    o: number,
    x: number,
    z: number,
): number | null {
    const ax = p[o];
    const az = p[o + 2];
    const v0x = p[o + 3] - ax;
    const v0z = p[o + 5] - az;
    const v1x = p[o + 6] - ax;
    const v1z = p[o + 8] - az;
    const det = v0x * v1z - v1x * v0z;

    if (Math.abs(det) < 1e-12) {
        return null;
    }

    const wx = x - ax;
    const wz = z - az;
    const u = (wx * v1z - v1x * wz) / det;
    const v = (v0x * wz - wx * v0z) / det;

    if (u < -1e-6 || v < -1e-6 || u + v > 1 + 1e-6) {
        return null;
    }

    return p[o + 1] + u * (p[o + 4] - p[o + 1]) + v * (p[o + 7] - p[o + 1]);
}

/** Segment (t in 0…1) against a triangle, both sides (Möller–Trumbore); Infinity if missed. */
function rayTriangle(
    p: Float32Array,
    o: number,
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
): number {
    const e1x = p[o + 3] - p[o];
    const e1y = p[o + 4] - p[o + 1];
    const e1z = p[o + 5] - p[o + 2];
    const e2x = p[o + 6] - p[o];
    const e2y = p[o + 7] - p[o + 1];
    const e2z = p[o + 8] - p[o + 2];
    const hx = dy * e2z - dz * e2y;
    const hy = dz * e2x - dx * e2z;
    const hz = dx * e2y - dy * e2x;
    const a = e1x * hx + e1y * hy + e1z * hz;

    if (Math.abs(a) < 1e-12) {
        return Infinity;
    }

    const f = 1 / a;
    const sx = ox - p[o];
    const sy = oy - p[o + 1];
    const sz = oz - p[o + 2];
    const u = f * (sx * hx + sy * hy + sz * hz);

    if (u < 0 || u > 1) {
        return Infinity;
    }

    const qx = sy * e1z - sz * e1y;
    const qy = sz * e1x - sx * e1z;
    const qz = sx * e1y - sy * e1x;
    const v = f * (dx * qx + dy * qy + dz * qz);

    if (v < 0 || u + v > 1) {
        return Infinity;
    }

    const t = f * (e2x * qx + e2y * qy + e2z * qz);

    return t >= 0 && t <= 1 ? t : Infinity;
}

/**
 * Local-space triangles of geometries as a flat list (9 floats per triangle), for voxelising.
 */
export function trianglesOf(geometries: THREE.BufferGeometry[]): Float32Array {
    const out: number[] = [];

    for (const g of geometries) {
        const pos = g.getAttribute('position');

        if (!pos) {
            continue;
        }

        const index = g.getIndex();
        const n = index ? index.count : pos.count;

        for (let i = 0; i + 2 < n; i += 3) {
            for (let k = 0; k < 3; k++) {
                const v = index ? index.getX(i + k) : i + k;
                out.push(pos.getX(v), pos.getY(v), pos.getZ(v));
            }
        }
    }

    return new Float32Array(out);
}
