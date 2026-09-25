import * as THREE from 'three';
import {
    mergeGeometries,
    mergeVertices,
} from 'three/addons/utils/BufferGeometryUtils.js';
import type { FoliageKind } from '../shared/types';
import { SimplexNoise, mulberry32 } from '../util/noise';

/**
 * Procedural placeholder foliage meshes.
 *
 * Every geometry carries `position`, `normal`, `color` (linear RGB) and `wind`
 * (0 at the rooted base → 1 at tips) attributes and is indexed.
 */

export type FoliageMeshSet = {
    /** One or more LOD geometries (LOD0 detailed, LOD1 cheaper), in metres, origin at the base, +Y up. */
    lods: THREE.BufferGeometry[];
    /** Suggested LOD switch distances as a fraction of the cull distance, same length as lods. */
    lodDistances: number[];
    /** true for grass/flowers/reeds: render double-sided, no shadow casting recommended. */
    doubleSided: boolean;
};

type Rng = () => number;
type Noise3 = (x: number, y: number, z: number) => number;
/** Fills `out` with the vertex colour and returns the wind weight. */
type Shader = (
    p: THREE.Vector3,
    n: THREE.Vector3,
    aux: number,
    out: THREE.Color,
) => number;

type Palette = {
    primary: THREE.Color;
    secondary: THREE.Color;
    /** Sun-bleached highlight used on tips and upward faces. */
    tip: THREE.Color;
    /** Shadowed interior colour. */
    deep: THREE.Color;
};

const UP = new THREE.Vector3(0, 1, 0);
const TAU = Math.PI * 2;
const tmpP = new THREE.Vector3();
const tmpN = new THREE.Vector3();
const tmpC = new THREE.Color();

function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

function smoothstep(e0: number, e1: number, x: number): number {
    const t = clamp01((x - e0) / (e1 - e0));

    return t * t * (3 - 2 * t);
}

/** Cheap pseudo-3D noise in roughly [-1, 1] built from three 2D simplex slices. */
function makeNoise3(seed: number): Noise3 {
    const s = new SimplexNoise(seed);

    return (x, y, z) =>
        (s.noise2D(x + 31.7, y - 12.3) +
            s.noise2D(y + 5.1, z + 47.9) +
            s.noise2D(z - 23.3, x + 8.6)) *
        0.6;
}

/** Brightness and warm/cool hue variation driven by v in [-1, 1]. */
function vary(c: THREE.Color, v: number, amount: number): THREE.Color {
    const k = 1 + v * amount;
    c.r *= k * (1 + v * 0.06);
    c.g *= k;
    c.b *= k * (1 - v * 0.08);

    return c;
}

function makePalette(primary: THREE.Color, secondary: THREE.Color): Palette {
    const tip = primary.clone().multiplyScalar(1.35);
    tip.r += 0.03;
    tip.g += 0.025;
    const deep = primary.clone().lerp(secondary, 0.35).multiplyScalar(0.55);

    return {
        primary: primary.clone(),
        secondary: secondary.clone(),
        tip,
        deep,
    };
}

/** Accumulates an indexed triangle mesh with one free-form scalar (`aux`) per vertex. */
class PartBuilder {
    private readonly pos: number[] = [];
    private readonly aux: number[] = [];
    private readonly idx: number[] = [];

    get vertexCount(): number {
        return this.aux.length;
    }

    vertex(x: number, y: number, z: number, aux = 0): number {
        this.pos.push(x, y, z);
        this.aux.push(aux);

        return this.aux.length - 1;
    }

    vertexV(v: THREE.Vector3, aux = 0): number {
        return this.vertex(v.x, v.y, v.z, aux);
    }

    tri(a: number, b: number, c: number): void {
        this.idx.push(a, b, c);
    }

    quad(a: number, b: number, c: number, d: number): void {
        this.idx.push(a, b, c, a, c, d);
    }

    indices(base: number, list: ArrayLike<number>): void {
        for (let i = 0; i < list.length; i++) {
            this.idx.push(base + list[i]);
        }
    }

    /** Duplicates all triangles with reversed winding on separate vertices (thin double-sided sheets). */
    addBackfaces(): void {
        const n = this.vertexCount;
        const triCount = this.idx.length;

        for (let i = 0; i < n; i++) {
            this.vertex(
                this.pos[i * 3],
                this.pos[i * 3 + 1],
                this.pos[i * 3 + 2],
                this.aux[i],
            );
        }

        for (let i = 0; i < triCount; i += 3) {
            this.idx.push(
                this.idx[i] + n,
                this.idx[i + 2] + n,
                this.idx[i + 1] + n,
            );
        }
    }

    /** Shifts every vertex vertically so the lowest one sits at `y`. */
    groundTo(y: number): void {
        let min = Infinity;

        for (let i = 1; i < this.pos.length; i += 3) {
            min = Math.min(min, this.pos[i]);
        }

        for (let i = 1; i < this.pos.length; i += 3) {
            this.pos[i] += y - min;
        }
    }

    /**
     * Builds the final geometry: normals (smooth, or faceted when `flat`), optional blend of
     * normals toward +Y, then colour and wind from the shader.
     */
    finish(shade: Shader, flat = false, upBlend = 0): THREE.BufferGeometry {
        let pos = this.pos;
        let aux = this.aux;
        let idx = this.idx;

        if (flat) {
            pos = [];
            aux = [];
            idx = [];

            for (let i = 0; i < this.idx.length; i++) {
                const v = this.idx[i];
                pos.push(
                    this.pos[v * 3],
                    this.pos[v * 3 + 1],
                    this.pos[v * 3 + 2],
                );
                aux.push(this.aux[v]);
                idx.push(i);
            }
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setIndex(idx);
        geo.computeVertexNormals();

        const normals = geo.getAttribute('normal') as THREE.BufferAttribute;
        const count = aux.length;
        const colors = new Float32Array(count * 3);
        const wind = new Float32Array(count);

        for (let i = 0; i < count; i++) {
            tmpP.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
            tmpN.fromBufferAttribute(normals, i);

            if (upBlend > 0) {
                tmpN.multiplyScalar(1 - upBlend)
                    .addScaledVector(UP, upBlend)
                    .normalize();
                normals.setXYZ(i, tmpN.x, tmpN.y, tmpN.z);
            }

            wind[i] = clamp01(shade(tmpP, tmpN, aux[i], tmpC));
            colors[i * 3] = Math.max(0, tmpC.r);
            colors[i * 3 + 1] = Math.max(0, tmpC.g);
            colors[i * 3 + 2] = Math.max(0, tmpC.b);
        }

        geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        geo.setAttribute('wind', new THREE.BufferAttribute(wind, 1));

        return geo;
    }
}

/** Tube along a polyline using parallel-transport frames; aux = auxBase + t (0..1 along the path). */
function addTube(
    b: PartBuilder,
    path: THREE.Vector3[],
    radii: number[],
    radial: number,
    cap: boolean,
    auxBase = 0,
): void {
    const n = path.length;
    const T = new THREE.Vector3();
    const N = new THREE.Vector3();
    const B = new THREE.Vector3();
    const p = new THREE.Vector3();
    const rings: number[][] = [];

    const tangent = (i: number): void => {
        const a = path[Math.max(0, i - 1)];
        const c = path[Math.min(n - 1, i + 1)];
        T.subVectors(c, a).normalize();
    };

    tangent(0);
    N.set(Math.abs(T.x) < 0.9 ? 1 : 0, 0, Math.abs(T.x) < 0.9 ? 0 : 1);

    for (let i = 0; i < n; i++) {
        tangent(i);
        N.addScaledVector(T, -N.dot(T)).normalize();
        B.crossVectors(T, N);
        const t = i / (n - 1);
        const ring: number[] = [];

        for (let j = 0; j < radial; j++) {
            const a = (j / radial) * TAU;
            p.copy(path[i])
                .addScaledVector(N, Math.cos(a) * radii[i])
                .addScaledVector(B, Math.sin(a) * radii[i]);
            ring.push(b.vertexV(p, auxBase + t));
        }

        rings.push(ring);
    }

    for (let i = 0; i < n - 1; i++) {
        for (let j = 0; j < radial; j++) {
            const jn = (j + 1) % radial;
            const a0 = rings[i][j];
            const a1 = rings[i][jn];
            const b0 = rings[i + 1][j];
            const b1 = rings[i + 1][jn];
            b.tri(a0, a1, b0);
            b.tri(a1, b1, b0);
        }
    }

    if (cap) {
        const top = rings[n - 1];
        p.copy(path[n - 1]).addScaledVector(T, radii[n - 1] * 0.6);
        const c = b.vertexV(p, auxBase + 1);

        for (let j = 0; j < radial; j++) {
            b.tri(top[j], top[(j + 1) % radial], c);
        }
    }
}

/** Noise-displaced sphere blob (icosphere, or dodecahedron for low LODs). */
function addBlob(
    b: PartBuilder,
    center: THREE.Vector3,
    radius: number,
    detail: number,
    n3: Noise3,
    amp: number,
    squash: number,
    aux: number,
): void {
    const src =
        detail < 0
            ? new THREE.DodecahedronGeometry(1, 0)
            : new THREE.IcosahedronGeometry(1, detail);
    src.deleteAttribute('normal');
    src.deleteAttribute('uv');
    const geo = mergeVertices(src);
    const pos = geo.getAttribute('position');
    const index = geo.getIndex();
    const v = new THREE.Vector3();
    const base = b.vertexCount;
    const o = center.x * 0.37 + center.z * 0.53 + center.y * 0.21;

    for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).normalize();
        const d =
            1 +
            amp * n3(v.x * 1.4 + o, v.y * 1.4, v.z * 1.4 - o) +
            amp * 0.4 * n3(v.x * 3.3, v.y * 3.3 + o, v.z * 3.3);
        let y = v.y * d * squash;

        if (y < -0.35) {
            y = -0.35 + (y + 0.35) * 0.55;
        }

        b.vertex(
            center.x + v.x * radius * d,
            center.y + y * radius,
            center.z + v.z * radius * d,
            aux,
        );
    }

    if (index) {
        b.indices(base, index.array);
    }

    src.dispose();
    geo.dispose();
}

/** Curved tapered blade (grass, reeds, leaves). Front face is the upper (concave) side. */
function addBlade(
    b: PartBuilder,
    base: THREE.Vector3,
    dir: THREE.Vector3,
    height: number,
    halfWidth: number,
    lean: number,
    segs: number,
    auxOffset: number,
): void {
    const side = new THREE.Vector3().crossVectors(UP, dir).normalize();
    const p = new THREE.Vector3();
    const ratio = lean / height;
    let prevL = -1;
    let prevR = -1;

    const point = (t: number): THREE.Vector3 =>
        p
            .copy(base)
            .addScaledVector(dir, lean * t * t)
            .setY(base.y + height * t * (1 - 0.3 * ratio * t));

    for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        point(t);

        if (i === segs) {
            const tip = b.vertexV(p, auxOffset + t);
            b.tri(prevR, prevL, tip);
            break;
        }

        const w = halfWidth * (1 - 0.8 * Math.pow(t, 1.3));
        const l = b.vertex(
            p.x - side.x * w,
            p.y,
            p.z - side.z * w,
            auxOffset + t,
        );
        const r = b.vertex(
            p.x + side.x * w,
            p.y,
            p.z + side.z * w,
            auxOffset + t,
        );

        if (i > 0) {
            b.quad(prevR, prevL, l, r);
        }

        prevL = l;
        prevR = r;
    }
}

function barkColor(
    out: THREE.Color,
    pal: Palette,
    v: number,
    heightT: number,
): void {
    out.copy(pal.secondary);
    vary(out, v, 0.2);
    out.multiplyScalar(0.5 + 0.5 * smoothstep(0, 0.35, heightT));
}

function randomHorizontal(rng: Rng, out = new THREE.Vector3()): THREE.Vector3 {
    const a = rng() * TAU;

    return out.set(Math.cos(a), 0, Math.sin(a));
}

// ---------------------------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------------------------

function buildConifer(
    pal: Palette,
    seed: number,
    lod: number,
): THREE.BufferGeometry[] {
    const rng = mulberry32(seed);
    const n3 = makeNoise3(seed);
    const hi = lod === 0;
    const H = 10.5 + rng() * 5;
    const trunkTop = H * 0.9;
    const leanX = (rng() - 0.5) * 0.5;
    const leanZ = (rng() - 0.5) * 0.5;
    const baseR = 0.26 + rng() * 0.08;
    const axisAt = (y: number): [number, number] => {
        const t = clamp01(y / trunkTop);

        return [leanX * t * t, leanZ * t * t];
    };

    const trunk = new PartBuilder();
    const segs = hi ? 4 : 1;
    const path: THREE.Vector3[] = [];
    const radii: number[] = [];

    for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const [x, z] = axisAt(trunkTop * t);
        path.push(new THREE.Vector3(x, trunkTop * t, z));
        radii.push(lerp(baseR, 0.04, t) * (i === 0 && hi ? 1.3 : 1));
    }

    addTube(trunk, path, radii, hi ? 7 : 5, false);

    const crown = new PartBuilder();
    const tiers = hi ? 8 : 5;
    const M = hi ? 16 : 9;
    const rings = hi ? 3 : 1;
    const bottom = H * (0.14 + rng() * 0.06);
    const span = H - bottom;
    const maxR = H * (0.2 + rng() * 0.05);

    for (let k = 0; k < tiers; k++) {
        const f = k / (tiers - 1);
        const rimY = bottom + span * (k / tiers) * 0.88;
        const apexY =
            k === tiers - 1 ? H : Math.min(H, rimY + span * (0.36 - 0.14 * f));
        const R = maxR * (1 - 0.78 * f) * (0.9 + rng() * 0.2);
        const [cx, cz] = axisAt(apexY);
        const rot = rng() * TAU;
        const apex = crown.vertex(cx, apexY, cz, 0);
        const spoke: number[] = [];
        const droop: number[] = [];

        for (let j = 0; j < M; j++) {
            spoke.push(
                1 +
                    (hi ? (j % 2 === 0 ? 0.12 : -0.08) : 0) +
                    (rng() - 0.5) * 0.16,
            );
            droop.push((0.12 + rng() * 0.14) * R);
        }

        let inner: number[] = [];

        for (let l = 1; l <= rings; l++) {
            const u = l / rings;
            const row: number[] = [];

            for (let j = 0; j < M; j++) {
                const a = rot + (j / M) * TAU + (hi ? (rng() - 0.5) * 0.12 : 0);
                const r = R * u * lerp(1, spoke[j], u);
                const y =
                    apexY -
                    (apexY - rimY) * (0.7 * u + 0.3 * u * u) -
                    droop[j] * u * u * u;
                row.push(
                    crown.vertex(
                        cx + Math.cos(a) * r,
                        y,
                        cz + Math.sin(a) * r,
                        u,
                    ),
                );
            }

            for (let j = 0; j < M; j++) {
                const jn = (j + 1) % M;

                if (l === 1) {
                    crown.tri(apex, row[jn], row[j]);
                } else {
                    crown.tri(inner[j], row[jn], row[j]);
                    crown.tri(inner[j], inner[jn], row[jn]);
                }
            }

            inner = row;
        }

        const under = crown.vertex(cx, rimY + (apexY - rimY) * 0.25, cz, -1);

        for (let j = 0; j < M; j++) {
            crown.tri(under, inner[j], inner[(j + 1) % M]);
        }
    }

    return [
        trunk.finish((p, _n, t, out) => {
            barkColor(out, pal, n3(p.x * 4, p.y * 0.7, p.z * 4), t);

            return 0.25 * t * t;
        }),
        crown.finish((p, n, u, out) => {
            const hN = clamp01(p.y / H);
            out.copy(pal.primary);
            vary(out, n3(p.x * 0.5, p.y * 0.5, p.z * 0.5), 0.22);

            if (u >= 0.99) {
                out.lerp(pal.tip, 0.3);
            }

            let ao = u < 0 ? 0.3 : lerp(0.45, 1.0, u);
            ao *= lerp(0.7, 1.05, hN) * (0.72 + 0.28 * (n.y * 0.5 + 0.5));
            out.multiplyScalar(ao);

            return u < 0 ? 0.3 * hN : 0.25 * hN + 0.75 * u * lerp(0.7, 1, hN);
        }),
    ];
}

function buildBroadleaf(
    pal: Palette,
    seed: number,
    lod: number,
): THREE.BufferGeometry[] {
    const rng = mulberry32(seed);
    const n3 = makeNoise3(seed);
    const hi = lod === 0;
    const H = 9.5 + rng() * 4;
    const trunkH = H * 0.55;
    const Rc = H * (0.3 + rng() * 0.05);

    const wood = new PartBuilder();
    const path: THREE.Vector3[] = [];
    const radii: number[] = [];
    const segs = hi ? 5 : 2;
    const bendX = (rng() - 0.5) * 0.8;
    const bendZ = (rng() - 0.5) * 0.8;

    for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const y = trunkH * 1.1 * t;
        const wob = hi ? n3(t * 2.5, 3.1, 0.7) * 0.18 : 0;
        path.push(
            new THREE.Vector3(
                bendX * Math.sin(t * 2.2) + wob,
                y,
                bendZ * Math.sin(t * 2.2) - wob,
            ),
        );
        radii.push(lerp(0.34, 0.13, t) * (i === 0 && hi ? 1.4 : 1));
    }

    addTube(wood, path, radii, hi ? 8 : 5, true);
    const top = path[segs];
    const canopyC = new THREE.Vector3(top.x, H - Rc * 0.95, top.z);

    type Blob = { c: THREE.Vector3; r: number };
    const blobs: Blob[] = [
        { c: new THREE.Vector3(top.x, H - Rc * 0.62, top.z), r: Rc * 0.62 },
    ];
    const branches = 4 + Math.floor(rng() * 2);
    const yaw0 = rng() * TAU;

    for (let k = 0; k < branches; k++) {
        const yaw = yaw0 + (k / branches) * TAU + (rng() - 0.5) * 0.6;
        const dir = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
        const t0 = 0.72 + rng() * 0.25;
        const start = path[Math.min(segs, Math.round(t0 * segs))].clone();
        const len = Rc * (0.75 + rng() * 0.3);
        const rise = 0.55 + rng() * 0.35;
        const mid = start
            .clone()
            .addScaledVector(dir, len * 0.5)
            .setY(start.y + len * rise * 0.55);
        const end = start
            .clone()
            .addScaledVector(dir, len)
            .setY(start.y + len * rise);

        if (hi) {
            addTube(wood, [start, mid, end], [0.11, 0.07, 0.035], 5, false, 2);
        }

        blobs.push({
            c: end.clone().setY(end.y + Rc * 0.1),
            r: Rc * (0.42 + rng() * 0.14),
        });
    }

    if (hi) {
        for (let k = 0; k < 2; k++) {
            const d = randomHorizontal(rng);
            blobs.push({
                c: canopyC
                    .clone()
                    .addScaledVector(d, Rc * 0.45)
                    .setY(canopyC.y - Rc * 0.1 + rng() * Rc * 0.4),
                r: Rc * (0.38 + rng() * 0.1),
            });
        }
    }

    const leaves = new PartBuilder();

    for (const bl of blobs) {
        addBlob(leaves, bl.c, bl.r, hi ? 1 : -1, n3, 0.2, 0.82, 0);
    }

    const canopyBottom = canopyC.y - Rc * 0.9;
    const dirTmp = new THREE.Vector3();

    return [
        wood.finish((p, _n, aux, out) => {
            const isBranch = aux >= 2;
            const t = isBranch ? aux - 2 : aux;
            barkColor(
                out,
                pal,
                n3(p.x * 4, p.y * 0.8, p.z * 4),
                isBranch ? 1 : t,
            );

            return isBranch ? 0.25 + 0.35 * t : 0.2 * t * t;
        }),
        leaves.finish((p, n, _aux, out) => {
            const yN = clamp01((p.y - canopyBottom) / (H - canopyBottom));
            out.copy(pal.primary);
            vary(out, n3(p.x * 0.45, p.y * 0.45, p.z * 0.45), 0.25);
            out.lerp(pal.tip, smoothstep(0.55, 1, n.y) * 0.3 * yN);
            dirTmp.subVectors(p, canopyC).normalize();
            const outward = clamp01(n.dot(dirTmp) * 0.5 + 0.5);
            out.lerp(pal.deep, (1 - outward) * 0.55);
            out.multiplyScalar(lerp(0.5, 1.05, yN) * (0.75 + 0.25 * outward));
            const horiz = Math.hypot(p.x - canopyC.x, p.z - canopyC.z) / Rc;

            return 0.25 + 0.4 * yN + 0.4 * horiz;
        }),
    ];
}

function buildPalm(
    pal: Palette,
    seed: number,
    lod: number,
): THREE.BufferGeometry[] {
    const rng = mulberry32(seed);
    const n3 = makeNoise3(seed);
    const hi = lod === 0;
    const H = 7.5 + rng() * 3;
    const leanDir = randomHorizontal(rng);
    const lean = 0.8 + rng() * 1.2;
    const segs = hi ? 12 : 5;

    const trunk = new PartBuilder();
    const path: THREE.Vector3[] = [];
    const radii: number[] = [];

    for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        path.push(
            new THREE.Vector3(
                leanDir.x * lean * t * t,
                H * t,
                leanDir.z * lean * t * t,
            ),
        );
        const flare = 1 + 0.35 * Math.pow(1 - t, 6);
        radii.push(
            lerp(0.26, 0.16, t) * flare * (hi && i % 2 === 1 ? 1.07 : 1),
        );
    }

    addTube(trunk, path, radii, hi ? 8 : 5, true);
    const crown = path[segs];

    const fronds = new PartBuilder();
    const count = hi ? 9 : 6;
    const S = hi ? 10 : 4;
    const yaw0 = rng() * TAU;
    const pt = new THREE.Vector3();
    const side = new THREE.Vector3();

    for (let k = 0; k < count; k++) {
        const yaw = yaw0 + (k / count) * TAU + (rng() - 0.5) * 0.4;
        const dir = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
        side.crossVectors(UP, dir).normalize();
        const L = 3.2 + rng() * 1.1;
        const e0 = 0.45 + rng() * 0.6;
        const droop = 1.5 + rng() * 0.7;
        const maxW = 0.5 + rng() * 0.2;
        pt.copy(crown);
        let prev: number[] = [];

        for (let i = 0; i <= S; i++) {
            const u = i / S;

            if (i > 0) {
                const th = e0 - droop * (u - 0.5 / S);
                pt.addScaledVector(dir, Math.cos(th) * (L / S)).setY(
                    pt.y + Math.sin(th) * (L / S),
                );
            }

            let w = maxW * Math.sin(Math.PI * Math.pow(u, 0.7)) + 0.03;

            if (hi && i % 2 === 1) {
                w *= 0.72;
            }

            const drop = w * 0.35;
            const l = fronds.vertex(
                pt.x - side.x * w,
                pt.y - drop,
                pt.z - side.z * w,
                u,
            );
            const s = fronds.vertex(pt.x, pt.y, pt.z, 2 + u);
            const r = fronds.vertex(
                pt.x + side.x * w,
                pt.y - drop,
                pt.z + side.z * w,
                u,
            );

            if (i > 0) {
                fronds.quad(prev[0], prev[1], s, l);
                fronds.quad(prev[1], prev[2], r, s);
            }

            prev = [l, s, r];
        }
    }

    fronds.addBackfaces();

    const nuts = new PartBuilder();

    if (hi) {
        const n = 3 + Math.floor(rng() * 2);

        for (let k = 0; k < n; k++) {
            const d = randomHorizontal(rng);
            const c = crown
                .clone()
                .addScaledVector(d, 0.2)
                .setY(crown.y - 0.18 - rng() * 0.1);
            addBlob(nuts, c, 0.12, -1, n3, 0.05, 1, 0);
        }
    }

    const parts = [
        trunk.finish((p, _n, t, out) => {
            barkColor(out, pal, n3(p.x * 5, p.y * 1.5, p.z * 5), t);
            out.multiplyScalar(0.85 + 0.2 * Math.cos(t * segs * Math.PI));

            return 0.5 * t * t;
        }),
        fronds.finish((p, n, aux, out) => {
            const spine = aux >= 2;
            const u = spine ? aux - 2 : aux;
            out.copy(pal.primary);
            vary(out, n3(p.x * 0.8, p.y * 0.8, p.z * 0.8), 0.2);

            if (spine) {
                out.lerp(pal.tip, 0.35);
            }

            out.lerp(pal.tip, smoothstep(0.7, 1, u) * 0.25);
            out.multiplyScalar(
                lerp(0.55, 1.0, smoothstep(0, 0.5, u)) * (n.y < 0 ? 0.72 : 1),
            );

            return 0.35 + 0.65 * u;
        }),
    ];

    if (hi) {
        parts.push(
            nuts.finish((p, _n, _a, out) => {
                out.copy(pal.secondary)
                    .lerp(pal.primary, 0.3)
                    .multiplyScalar(0.7);
                vary(out, n3(p.x * 9, p.y * 9, p.z * 9), 0.2);

                return 0.35;
            }),
        );
    }

    return parts;
}

function buildBush(
    pal: Palette,
    seed: number,
    lod: number,
): THREE.BufferGeometry[] {
    const rng = mulberry32(seed);
    const n3 = makeNoise3(seed);
    const hi = lod === 0;
    const Hb = 1.45 + rng() * 0.5;
    const b = new PartBuilder();
    const center = new THREE.Vector3(0, Hb * 0.4, 0);

    addBlob(
        b,
        new THREE.Vector3(0, Hb * 0.55, 0),
        Hb * 0.45,
        hi ? 1 : -1,
        n3,
        0.22,
        0.9,
        0,
    );
    const n = hi ? 5 : 2;
    const yaw0 = rng() * TAU;

    for (let k = 0; k < n; k++) {
        const yaw = yaw0 + (k / n) * TAU + (rng() - 0.5) * 0.7;
        const d = Hb * (0.3 + rng() * 0.12);
        const c = new THREE.Vector3(
            Math.cos(yaw) * d,
            Hb * (0.28 + rng() * 0.2),
            Math.sin(yaw) * d,
        );
        addBlob(
            b,
            c,
            Hb * (0.28 + rng() * 0.1),
            hi ? 1 : -1,
            n3,
            0.25,
            0.85,
            0,
        );
    }

    b.groundTo(-0.06);
    const dirTmp = new THREE.Vector3();

    return [
        b.finish((p, nrm, _a, out) => {
            const yN = clamp01(p.y / Hb);
            out.copy(pal.primary);
            vary(out, n3(p.x * 1.6, p.y * 1.6, p.z * 1.6), 0.25);
            out.lerp(pal.tip, smoothstep(0.5, 1, nrm.y) * 0.3 * yN);
            dirTmp.subVectors(p, center).normalize();
            const outward = clamp01(nrm.dot(dirTmp) * 0.5 + 0.5);
            out.lerp(pal.deep, (1 - outward) * 0.5 + (1 - yN) * 0.3);
            out.multiplyScalar(lerp(0.45, 1.05, smoothstep(0, 0.8, yN)));
            const horiz = Math.hypot(p.x, p.z) / Hb;

            return 0.1 + 0.6 * yN + 0.4 * horiz;
        }),
    ];
}

/** Grass-like blade clump shading: aux = bladeIndex * 2 + t. */
function bladeShader(pal: Palette, n3: Noise3, stemTint: number): Shader {
    const stem = pal.secondary.clone().lerp(pal.primary, 0.4);

    return (p, _n, aux, out) => {
        const blade = Math.floor(aux / 2);
        const t = aux - blade * 2;
        const h = Math.sin(blade * 12.9898 + 4.1) * 43758.5453;
        const hv = (h - Math.floor(h)) * 2 - 1;
        out.copy(pal.primary);
        vary(out, hv * 0.8 + n3(p.x * 3, p.y, p.z * 3) * 0.3, 0.2);
        out.lerp(stem, (1 - smoothstep(0, 0.45, t)) * stemTint);
        out.lerp(
            pal.tip,
            smoothstep(0.6, 1, t) * (0.25 + 0.2 * Math.max(0, hv)),
        );
        out.multiplyScalar(0.45 + 0.6 * Math.pow(t, 0.6));

        return Math.pow(t, 1.5);
    };
}

function buildGrass(
    pal: Palette,
    seed: number,
    lod: number,
): THREE.BufferGeometry[] {
    const rng = mulberry32(seed);
    const n3 = makeNoise3(seed);
    const hi = lod === 0;
    const count = hi ? 14 : 6;
    const segs = hi ? 4 : 2;
    const b = new PartBuilder();

    for (let k = 0; k < count; k++) {
        const a = rng() * TAU;
        const r = 0.11 * Math.sqrt(rng());
        const base = new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
        const dir = new THREE.Vector3(
            Math.cos(a + (rng() - 0.5) * 1.6),
            0,
            Math.sin(a + (rng() - 0.5) * 1.6),
        );
        const h = 0.35 + rng() * 0.32;
        addBlade(
            b,
            base,
            dir,
            h,
            0.018 + rng() * 0.014,
            h * (0.2 + rng() * 0.5),
            segs,
            k * 2,
        );
    }

    return [b.finish(bladeShader(pal, n3, 0.6), false, 0.65)];
}

function buildReed(
    pal: Palette,
    seed: number,
    lod: number,
): THREE.BufferGeometry[] {
    const rng = mulberry32(seed);
    const n3 = makeNoise3(seed);
    const hi = lod === 0;
    const blades = new PartBuilder();
    const stems = new PartBuilder();
    const heads = new PartBuilder();
    const bladeCount = hi ? 9 : 4;

    for (let k = 0; k < bladeCount; k++) {
        const a = rng() * TAU;
        const r = 0.12 * Math.sqrt(rng());
        const base = new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
        const dir = new THREE.Vector3(
            Math.cos(a + (rng() - 0.5)),
            0,
            Math.sin(a + (rng() - 0.5)),
        );
        const h = 1.1 + rng() * 0.7;
        addBlade(
            blades,
            base,
            dir,
            h,
            0.014 + rng() * 0.008,
            h * (0.08 + rng() * 0.25),
            hi ? 4 : 2,
            k * 2,
        );
    }

    const stemCount = hi ? 2 + Math.floor(rng() * 2) : 1;
    let maxStem = 0;

    for (let k = 0; k < stemCount; k++) {
        const a = rng() * TAU;
        const r = 0.08 * Math.sqrt(rng());
        const h = 1.5 + rng() * 0.45;
        maxStem = Math.max(maxStem, h);
        const lean = randomHorizontal(rng).multiplyScalar(0.06 + rng() * 0.12);
        const at = (t: number): THREE.Vector3 =>
            new THREE.Vector3(
                Math.cos(a) * r + lean.x * t * t,
                h * t,
                Math.sin(a) * r + lean.z * t * t,
            );
        const stemPath = [at(0), at(0.45), at(0.8), at(1)];
        addTube(
            stems,
            stemPath,
            [0.009, 0.007, 0.005, 0.002],
            hi ? 4 : 3,
            false,
        );
        const h0 = 0.8 - (hi ? 0.02 : 0);
        const headPath = hi
            ? [
                  at(h0),
                  at(h0 + 0.012),
                  at(h0 + 0.06),
                  at(h0 + 0.12),
                  at(h0 + 0.135),
              ]
            : [at(h0), at(h0 + 0.135)];
        const headRadii = hi
            ? [0.008, 0.024, 0.027, 0.023, 0.008]
            : [0.024, 0.022];
        addTube(heads, headPath, headRadii, hi ? 6 : 4, hi);
    }

    const cattail = new THREE.Color(0.16, 0.075, 0.03);
    const parts = [blades.finish(bladeShader(pal, n3, 0.5), false, 0.55)];

    parts.push(
        stems.finish(
            (p, _n, t, out) => {
                out.copy(pal.secondary).lerp(pal.primary, 0.3);
                vary(out, n3(p.x * 5, p.y * 2, p.z * 5), 0.15);
                out.multiplyScalar(0.5 + 0.55 * t);

                return Math.pow(clamp01(p.y / maxStem), 1.5);
            },
            false,
            0.2,
        ),
    );
    parts.push(
        heads.finish((p, n, _t, out) => {
            out.copy(cattail).lerp(pal.secondary, 0.15);
            vary(out, n3(p.x * 40, p.y * 40, p.z * 40), 0.25);
            out.multiplyScalar(0.8 + 0.25 * n.y);

            return Math.pow(clamp01(p.y / maxStem), 1.5);
        }),
    );

    return parts;
}

function buildFlower(
    pal: Palette,
    seed: number,
    lod: number,
): THREE.BufferGeometry[] {
    const rng = mulberry32(seed);
    const n3 = makeNoise3(seed);
    const hi = lod === 0;
    const countRoll = rng();
    const count = hi ? 1 + Math.floor(countRoll * 3) : 1;
    const green = new PartBuilder();
    const bloom = new PartBuilder();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const v = new THREE.Vector3();
    let maxH = 0.3;

    for (let k = 0; k < count; k++) {
        const a = rng() * TAU;
        const r = k === 0 ? 0 : 0.05 + rng() * 0.05;
        const h = 0.28 + rng() * 0.17;
        maxH = Math.max(maxH, h);
        const bend = randomHorizontal(rng).multiplyScalar(0.03 + rng() * 0.05);
        const bx = Math.cos(a) * r;
        const bz = Math.sin(a) * r;
        const at = (t: number): THREE.Vector3 =>
            new THREE.Vector3(bx + bend.x * t * t, h * t, bz + bend.z * t * t);
        addTube(
            green,
            hi ? [at(0), at(0.4), at(0.75), at(1)] : [at(0), at(1)],
            hi ? [0.006, 0.005, 0.004, 0.0035] : [0.006, 0.004],
            3,
            false,
        );

        if (hi) {
            for (let l = 0; l < 2; l++) {
                const dir = randomHorizontal(rng);
                addBlade(
                    green,
                    at(0.02),
                    dir,
                    h * (0.3 + rng() * 0.2),
                    0.012,
                    h * 0.15,
                    2,
                    2,
                );
            }
        }

        // Head: petals in a local disc tilted toward the bend direction.
        const top = at(1);
        e.set(bend.z * 5, rng() * TAU, -bend.x * 5);
        q.setFromEuler(e);
        const petals = hi ? 5 + Math.floor(rng() * 3) : 5;
        const pl = 0.035 + rng() * 0.02;
        const pw = pl * (hi ? 0.42 : 0.5);
        const local = (x: number, y: number, z: number): THREE.Vector3 =>
            v.set(x, y, z).applyQuaternion(q).add(top);

        for (let i = 0; i < petals; i++) {
            const ang = (i / petals) * TAU;
            const c = Math.cos(ang);
            const s = Math.sin(ang);
            const pt = (rad: number, lat: number, y: number): THREE.Vector3 =>
                local(c * rad - s * lat, y, s * rad + c * lat);
            const b0 = bloom.vertexV(pt(0.006, 0, 0.002), 4);
            const ml = bloom.vertexV(pt(pl * 0.55, -pw, pl * 0.12), 4.6);
            const mr = bloom.vertexV(pt(pl * 0.55, pw, pl * 0.12), 4.6);
            const tp = bloom.vertexV(pt(pl, 0, pl * 0.3), 5);
            bloom.tri(b0, mr, tp);
            bloom.tri(b0, tp, ml);
        }

        const hub = bloom.vertexV(local(0, 0.012, 0), 7);
        const hubRing: number[] = [];

        for (let i = 0; i < 6; i++) {
            const ang = (i / 6) * TAU;
            hubRing.push(
                bloom.vertexV(
                    local(Math.cos(ang) * 0.011, 0.004, Math.sin(ang) * 0.011),
                    6,
                ),
            );
        }

        for (let i = 0; i < 6; i++) {
            bloom.tri(hub, hubRing[(i + 1) % 6], hubRing[i]);
        }
    }

    const centre = new THREE.Color(0.55, 0.3, 0.02);

    return [
        green.finish(
            (p, _n, aux, out) => {
                const leaf = aux >= 2;
                const t = leaf ? aux - 2 : aux;
                out.copy(pal.secondary);
                vary(out, n3(p.x * 20, p.y * 5, p.z * 20), 0.15);
                out.multiplyScalar(leaf ? 0.55 + 0.45 * t : 0.5 + 0.55 * t);

                return leaf ? 0.4 * t : Math.pow(clamp01(p.y / maxH), 1.3);
            },
            false,
            0.3,
        ),
        bloom.finish(
            (p, _n, aux, out) => {
                if (aux >= 6) {
                    out.copy(centre)
                        .lerp(pal.primary, 0.15)
                        .multiplyScalar(aux >= 7 ? 1 : 0.7);
                } else {
                    const t = aux - 4;
                    out.copy(pal.primary);
                    vary(out, n3(p.x * 30, p.y * 30, p.z * 30), 0.15);
                    out.multiplyScalar(0.7 + 0.4 * t);
                }

                return 0.85 + 0.15 * clamp01(p.y / maxH);
            },
            false,
            0.3,
        ),
    ];
}

function buildRock(
    pal: Palette,
    seed: number,
    lod: number,
): THREE.BufferGeometry[] {
    const rng = mulberry32(seed);
    const n3 = makeNoise3(seed);
    const sx = 0.75 * (0.85 + rng() * 0.35);
    const sz = 0.75 * (0.8 + rng() * 0.3);
    const sy = 0.75 * (0.5 + rng() * 0.25);
    const cuts: { n: THREE.Vector3; d: number }[] = [];

    for (let k = 0; k < 4; k++) {
        const n = new THREE.Vector3(
            rng() - 0.5,
            rng() * 0.8 - 0.1,
            rng() - 0.5,
        ).normalize();
        cuts.push({ n, d: 0.72 + rng() * 0.18 });
    }

    const src = new THREE.IcosahedronGeometry(1, lod === 0 ? 3 : 1);
    src.deleteAttribute('normal');
    src.deleteAttribute('uv');
    const geo = mergeVertices(src);
    const pos = geo.getAttribute('position');
    const b = new PartBuilder();
    const v = new THREE.Vector3();
    const pts: THREE.Vector3[] = [];
    let minY = Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).normalize();
        v.multiplyScalar(
            1 +
                0.22 * n3(v.x * 1.3, v.y * 1.3, v.z * 1.3) +
                0.07 * n3(v.x * 3.7, v.y * 3.7, v.z * 3.7),
        );

        for (const c of cuts) {
            const over = v.dot(c.n) - c.d;

            if (over > 0) {
                v.addScaledVector(c.n, -over * 0.85);
            }
        }

        const p = new THREE.Vector3(v.x * sx, v.y * sy, v.z * sz);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
        pts.push(p);
    }

    const lift = -minY - (maxY - minY) * 0.2;

    for (const p of pts) {
        b.vertex(p.x, p.y + lift, p.z);
    }

    const index = geo.getIndex();

    if (index) {
        b.indices(0, index.array);
    }

    src.dispose();
    geo.dispose();
    const top = maxY + lift;

    return [
        b.finish((p, n, _a, out) => {
            const hN = clamp01(p.y / top);
            out.copy(pal.primary);
            vary(
                out,
                n3(p.x * 2.5, p.y * 2.5, p.z * 2.5) * 0.7 +
                    0.3 * Math.sin(p.y * 22 + n3(p.x, 0, p.z) * 3),
                0.2,
            );
            const moss =
                smoothstep(0.35, 0.85, n.y) *
                smoothstep(-0.2, 0.4, n3(p.x * 1.8 + 5, p.y * 1.8, p.z * 1.8));
            out.lerp(pal.secondary, moss * 0.85);
            out.multiplyScalar(lerp(0.5, 1.05, smoothstep(0, 0.7, hN)));

            return 0;
        }, true),
    ];
}

const BUILDERS: Record<
    FoliageKind,
    (pal: Palette, seed: number, lod: number) => THREE.BufferGeometry[]
> = {
    conifer: buildConifer,
    broadleaf: buildBroadleaf,
    palm: buildPalm,
    bush: buildBush,
    grass: buildGrass,
    flower: buildFlower,
    reed: buildReed,
    rock: buildRock,
};

const LOD_DISTANCES: Record<FoliageKind, number[]> = {
    conifer: [0, 0.3],
    broadleaf: [0, 0.3],
    palm: [0, 0.3],
    bush: [0, 0.35],
    grass: [0, 0.45],
    flower: [0, 0.4],
    reed: [0, 0.4],
    rock: [0, 0.35],
};

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
    const merged =
        parts.length === 1 ? parts[0] : mergeGeometries(parts, false);

    if (!merged) {
        throw new Error('FoliageGeometry: failed to merge parts');
    }

    if (merged !== parts[0]) {
        for (const p of parts) {
            p.dispose();
        }
    }

    merged.computeBoundingBox();
    merged.computeBoundingSphere();

    return merged;
}

/**
 * Builds deterministic procedural geometry for a foliage kind.
 * `primary` is the leaf/petal/rock colour, `secondary` the trunk/stem/moss colour (linear RGB).
 */
export function createFoliageGeometry(
    kind: FoliageKind,
    primary: THREE.Color,
    secondary: THREE.Color,
    seed = 1,
): FoliageMeshSet {
    const pal = makePalette(primary, secondary);
    const build = BUILDERS[kind] ?? buildBush;
    const lodDistances = LOD_DISTANCES[kind] ?? [0, 0.35];

    return {
        lods: lodDistances.map((_d, lod) => merge(build(pal, seed, lod))),
        lodDistances: lodDistances.slice(),
        doubleSided: kind === 'grass' || kind === 'flower' || kind === 'reed',
    };
}
