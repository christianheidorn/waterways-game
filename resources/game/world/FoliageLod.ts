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
 * - a crossed-card impostor rendered from the model (vegetation) or a very coarse mesh (rocks) as the
 *   far LOD,
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

// ------------------------------------------------------------------ impostor

const IMPOSTOR_ANGLES = [0, 60, 120];
/** Height (or width, for wide models) of one impostor view in texels. */
const IMPOSTOR_CELL = 256;
const IMPOSTOR_MAX_WIDTH = 1024;
const IMPOSTOR_SUPERSAMPLE = 2;

/**
 * Renders a model from 3 horizontal directions into a small atlas and builds 3 crossed quads (6
 * triangles) textured with it — the same impostor layout the baker writes. Uses the given renderer
 * (e.g. the game's) and restores its render target / clear state; call outside a render pass.
 * Materials are cloned for the capture, so patched (wind / fade) materials are fine to pass.
 */
export function renderImpostor(
    renderer: THREE.WebGLRenderer,
    geometry: THREE.BufferGeometry,
    material: THREE.Material | THREE.Material[],
): {
    geometry: THREE.BufferGeometry;
    material: THREE.MeshStandardMaterial;
} | null {
    const position = geometry.getAttribute('position');

    if (!position?.count) {
        return null;
    }

    let radius = 0;
    let bottom = Infinity;
    let top = -Infinity;

    for (let i = 0; i < position.count; i++) {
        radius = Math.max(
            radius,
            Math.hypot(position.getX(i), position.getZ(i)),
        );
        bottom = Math.min(bottom, position.getY(i));
        top = Math.max(top, position.getY(i));
    }

    bottom = Math.min(0, bottom);
    radius = Math.max(radius, 0.01) * 1.03;
    const height = Math.max(top - bottom, 0.01) * 1.02;
    top = bottom + height;

    // Views side by side; the texel size follows the model's aspect.
    const aspect = (2 * radius) / height;
    let ch = aspect <= 1 ? IMPOSTOR_CELL : Math.round(IMPOSTOR_CELL / aspect);
    let cw = aspect <= 1 ? Math.round(IMPOSTOR_CELL * aspect) : IMPOSTOR_CELL;

    if (cw * IMPOSTOR_ANGLES.length > IMPOSTOR_MAX_WIDTH) {
        const f = IMPOSTOR_MAX_WIDTH / (cw * IMPOSTOR_ANGLES.length);
        cw = Math.floor(cw * f);
        ch = Math.floor(ch * f);
    }

    cw = Math.max(8, cw);
    ch = Math.max(8, ch);
    const atlasW = cw * IMPOSTOR_ANGLES.length;
    const atlasH = ch;
    const ss = IMPOSTOR_SUPERSAMPLE;
    const target = new THREE.WebGLRenderTarget(atlasW * ss, atlasH * ss, {
        colorSpace: THREE.SRGBColorSpace,
    });
    const clones = (Array.isArray(material) ? material : [material]).map(
        captureMaterial,
    );
    const scene = new THREE.Scene();
    // Soft, near-albedo lighting: the game lights the impostor cards again.
    const ambient = new THREE.AmbientLight(0xffffff, Math.PI * 0.35);
    const key = new THREE.DirectionalLight(0xffffff, Math.PI * 0.35);
    scene.add(ambient, key, key.target);
    scene.add(
        new THREE.Mesh(geometry, Array.isArray(material) ? clones : clones[0]),
    );
    const camera = new THREE.OrthographicCamera(
        -radius,
        radius,
        top,
        bottom,
        0.01,
        radius * 4 + 2,
    );

    const previousTarget = renderer.getRenderTarget();
    const previousAutoClear = renderer.autoClear;
    const previousClear = renderer.getClearColor(new THREE.Color());
    const previousAlpha = renderer.getClearAlpha();
    const pixels = new Uint8Array(atlasW * ss * atlasH * ss * 4);

    try {
        renderer.autoClear = false;
        renderer.setClearColor(0x000000, 0);
        target.scissorTest = true;
        target.viewport.set(0, 0, atlasW * ss, atlasH * ss);
        target.scissor.set(0, 0, atlasW * ss, atlasH * ss);
        renderer.setRenderTarget(target);
        renderer.clear(true, true, true);

        IMPOSTOR_ANGLES.forEach((deg, i) => {
            const a = THREE.MathUtils.degToRad(deg);
            const dir = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
            camera.position
                .copy(dir)
                .multiplyScalar(radius * 2 + 1)
                .setY((top + bottom) / 2);
            camera.up.set(0, 1, 0);
            camera.lookAt(0, (top + bottom) / 2, 0);
            camera.top = height / 2;
            camera.bottom = -height / 2;
            camera.updateProjectionMatrix();
            camera.updateMatrixWorld();
            key.position.copy(dir).multiplyScalar(10).setY(7);
            target.viewport.set(i * cw * ss, 0, cw * ss, ch * ss);
            target.scissor.set(i * cw * ss, 0, cw * ss, ch * ss);
            renderer.setRenderTarget(target);
            renderer.render(scene, camera);
        });

        renderer.readRenderTargetPixels(
            target,
            0,
            0,
            atlasW * ss,
            atlasH * ss,
            pixels,
        );
    } finally {
        renderer.setRenderTarget(previousTarget);
        renderer.autoClear = previousAutoClear;
        renderer.setClearColor(previousClear, previousAlpha);
        target.dispose();

        for (const m of clones) {
            m.dispose();
        }
    }

    const image = downsample(pixels, atlasW, atlasH, ss);

    if (!dilate(image, atlasW, atlasH)) {
        return null;
    }

    // Rows stay bottom-up (as read back), so v = 0 is the bottom of every view.
    const texture = new THREE.DataTexture(
        image,
        atlasW,
        atlasH,
        THREE.RGBAFormat,
    );
    texture.name = 'foliage-impostor';
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.flipY = false;
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 4;
    texture.needsUpdate = true;
    const impostorMaterial = new THREE.MeshStandardMaterial({
        name: 'impostor',
        map: texture,
        alphaTest: 0.5,
        side: THREE.DoubleSide,
        roughness: 0.9,
        metalness: 0,
    });

    return {
        geometry: buildImpostorQuads(
            radius,
            bottom,
            top,
            IMPOSTOR_ANGLES.length,
        ),
        material: impostorMaterial,
    };
}

/** Unpatched clone for the capture; double-sided leaves skip the back-face normal flip (as in game). */
function captureMaterial(material: THREE.Material): THREE.Material {
    const clone = material.clone();

    if (clone.side === THREE.DoubleSide) {
        clone.onBeforeCompile = (shader) => {
            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <normal_fragment_begin>',
                THREE.ShaderChunk.normal_fragment_begin.replace(
                    'normal *= faceDirection;',
                    '',
                ),
            );
        };
        clone.customProgramCacheKey = () => 'foliage-impostor-no-face-flip';
    }

    return clone;
}

/** Alpha-weighted box filter; blended (premultiplied-looking) edges are un-premultiplied. */
function downsample(
    pixels: Uint8Array,
    w: number,
    h: number,
    ss: number,
): Uint8ClampedArray<ArrayBuffer> {
    const out = new Uint8ClampedArray(w * h * 4);
    const srcW = w * ss;

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let r = 0;
            let g = 0;
            let b = 0;
            let al = 0;

            for (let sy = 0; sy < ss; sy++) {
                for (let sx = 0; sx < ss; sx++) {
                    const o = ((y * ss + sy) * srcW + x * ss + sx) * 4;
                    const a = pixels[o + 3];
                    // Normal blending leaves rgb × alpha against the transparent clear colour.
                    const k = a > 0 && a < 255 ? 255 / a : 1;
                    r += pixels[o] * k * a;
                    g += pixels[o + 1] * k * a;
                    b += pixels[o + 2] * k * a;
                    al += a;
                }
            }

            const o = (y * w + x) * 4;

            if (al > 0) {
                out[o] = r / al;
                out[o + 1] = g / al;
                out[o + 2] = b / al;
            }

            out[o + 3] = al / (ss * ss);
        }
    }

    return out;
}

/**
 * Bleeds opaque colours into transparent texels so mip levels don't fade to black at the
 * silhouette. Returns false when the image is empty (nothing was rendered).
 */
function dilate(data: Uint8ClampedArray, w: number, h: number): boolean {
    const n = w * h;
    let known = new Uint8Array(n);
    let sum = [0, 0, 0];
    let count = 0;

    for (let i = 0; i < n; i++) {
        if (data[i * 4 + 3] >= 64) {
            known[i] = 1;
            sum = [
                sum[0] + data[i * 4],
                sum[1] + data[i * 4 + 1],
                sum[2] + data[i * 4 + 2],
            ];
            count++;
        }
    }

    if (!count) {
        return false;
    }

    for (let pass = 0; pass < 8; pass++) {
        const next = known.slice();
        let grew = false;

        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const i = y * w + x;

                if (known[i]) {
                    continue;
                }

                let r = 0;
                let g = 0;
                let b = 0;
                let k = 0;

                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const nx = x + dx;
                        const ny = y + dy;

                        if (nx < 0 || ny < 0 || nx >= w || ny >= h) {
                            continue;
                        }

                        const j = ny * w + nx;

                        if (known[j]) {
                            r += data[j * 4];
                            g += data[j * 4 + 1];
                            b += data[j * 4 + 2];
                            k++;
                        }
                    }
                }

                if (k) {
                    data[i * 4] = r / k;
                    data[i * 4 + 1] = g / k;
                    data[i * 4 + 2] = b / k;
                    next[i] = 1;
                    grew = true;
                }
            }
        }

        known = next;

        if (!grew) {
            break;
        }
    }

    // Everything further away gets the average colour.
    for (let i = 0; i < n; i++) {
        if (!known[i]) {
            data[i * 4] = sum[0] / count;
            data[i * 4 + 1] = sum[1] / count;
            data[i * 4 + 2] = sum[2] / count;
        }
    }

    return true;
}

/** Crossed vertical quads around the Y axis, one atlas column each (normals tilted up, like the baker). */
function buildImpostorQuads(
    radius: number,
    bottom: number,
    top: number,
    views: number,
): THREE.BufferGeometry {
    const pos: number[] = [];
    const nrm: number[] = [];
    const uv: number[] = [];
    const index: number[] = [];
    const n = new THREE.Vector3();

    for (let i = 0; i < views; i++) {
        const a = THREE.MathUtils.degToRad(IMPOSTOR_ANGLES[i]);
        const right = new THREE.Vector3(Math.cos(a), 0, -Math.sin(a));
        const u0 = i / views;
        const u1 = (i + 1) / views;
        const base = pos.length / 3;
        const corners: [number, number, number, number][] = [
            // side offset, y, u, v
            [-radius, bottom, u0, 0],
            [radius, bottom, u1, 0],
            [radius, top, u1, 1],
            [-radius, top, u0, 1],
        ];

        for (const [s, y, cu, cv] of corners) {
            pos.push(right.x * s, y, right.z * s);
            n.copy(right)
                .multiplyScalar(s < 0 ? -0.45 : 0.45)
                .add(new THREE.Vector3(0, y > bottom ? 1 : 0.75, 0))
                .normalize();
            nrm.push(n.x, n.y, n.z);
            uv.push(cu, cv);
        }

        index.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geometry.setIndex(index);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    return geometry;
}
