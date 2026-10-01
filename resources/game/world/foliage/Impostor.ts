import * as THREE from 'three/webgpu';
import { isWebGpu } from '../../core/renderer';
import type { GameRenderer } from '../../core/renderer';
import { describeCoverage, measureCoverage } from '../../util/alphaCoverage';
import { keepBackFaceNormals, toNodeMaterial } from './FoliageMaterial';

const IMPOSTOR_ANGLES = [0, 60, 120];
/** Height (or width, for wide models) of one impostor view in texels. */
const IMPOSTOR_CELL = 256;
const IMPOSTOR_MAX_WIDTH = 1024;
const IMPOSTOR_SUPERSAMPLE = 2;

/**
 * Renders a model from 3 horizontal directions into a small atlas and builds 3 crossed quads (6
 * triangles) textured with it — the same impostor layout the baker writes. Uses the game renderer
 * (WebGPU or WebGL 2; each view goes to an 8-bit sRGB target and is read back asynchronously) and
 * restores its render target / clear state right after each draw (frames rendered while a read-back is
 * pending keep their own); call outside a render pass.
 *
 * 8-bit RGBA rather than half floats: reading RGBA16F back is implementation-defined in WebGL 2
 * (RGBA / HALF_FLOAT is only guaranteed when the driver reports it; ANGLE on Metal may not), while
 * RGBA / UNSIGNED_BYTE always works and the sRGB target stores what the atlas needs anyway. The source materials are
 * copied for the capture, so their foliage node versions never see the capture.
 */
export async function renderImpostor(
    renderer: GameRenderer,
    geometry: THREE.BufferGeometry,
    material: THREE.Material | THREE.Material[],
): Promise<{
    geometry: THREE.BufferGeometry;
    material: THREE.MeshStandardNodeMaterial;
} | null> {
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
    const target = new THREE.RenderTarget(cw * ss, ch * ss, {
        type: THREE.UnsignedByteType,
        colorSpace: THREE.SRGBColorSpace,
        generateMipmaps: false,
    });
    const clones = (Array.isArray(material) ? material : [material]).map(
        captureMaterial,
    );
    // A private copy: the game's LOD geometry may carry indirect draw arguments (GPU culling).
    const captured = geometry.clone();
    captured.setIndirect(null);
    const scene = new THREE.Scene();
    // Soft, near-albedo lighting: the game lights the impostor cards again.
    const ambient = new THREE.AmbientLight(0xffffff, Math.PI * 0.35);
    const key = new THREE.DirectionalLight(0xffffff, Math.PI * 0.35);
    scene.add(ambient, key, key.target);
    scene.add(
        new THREE.Mesh(captured, Array.isArray(material) ? clones : clones[0]),
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
    const previousClear = renderer.getClearColor(new THREE.Color());
    const previousAlpha = renderer.getClearAlpha();
    // Bottom-up rows (v = 0 at the bottom of every view), sRGB colour, linear alpha.
    const pixels = new Uint8Array(atlasW * ss * atlasH * ss * 4);
    const w = cw * ss;
    const h = ch * ss;
    // WebGPU reads textures top row first; the WebGL backend bottom row first.
    const topDown = isWebGpu(renderer);

    try {
        for (const [i, deg] of IMPOSTOR_ANGLES.entries()) {
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
            renderer.setClearColor(0x000000, 0);
            renderer.setRenderTarget(target);
            renderer.render(scene, camera);
            renderer.setRenderTarget(previousTarget);
            renderer.setClearColor(previousClear, previousAlpha);
            const data = (await renderer.readRenderTargetPixelsAsync(
                target,
                0,
                0,
                w,
                h,
            )) as Uint8Array;
            // Rows may be padded (WebGPU copies align rows to 256 bytes).
            const stride = h > 1 ? (data.length - w * 4) / (h - 1) : w * 4;

            for (let y = 0; y < h; y++) {
                const row = (topDown ? h - 1 - y : y) * stride;

                for (let x = 0; x < w; x++) {
                    const o = (y * atlasW * ss + i * w + x) * 4;

                    for (let c = 0; c < 4; c++) {
                        pixels[o + c] = data[row + x * 4 + c];
                    }
                }
            }
        }
    } finally {
        renderer.setRenderTarget(previousTarget);
        renderer.setClearColor(previousClear, previousAlpha);
        target.dispose();
        captured.dispose();

        for (const m of clones) {
            m.dispose();
        }
    }

    const image = downsample(pixels, atlasW, atlasH, ss);

    if (!dilate(image, atlasW, atlasH)) {
        return null;
    }

    // Never a box: every view must be a cut-out (an opaque background means the capture lost alpha).
    const coverage = measureCoverage(
        image,
        atlasW,
        atlasH,
        'views',
        IMPOSTOR_ANGLES.length,
    );

    if (!coverage.ok) {
        throw new Error(`captured views are ${describeCoverage(coverage)}`);
    }

    // Rows are bottom-up, so v = 0 is the bottom of every view.
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
    const impostorMaterial = new THREE.MeshStandardNodeMaterial({
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

/** Node copy for the capture; double-sided leaves skip the back-face normal flip (as in game). */
function captureMaterial(material: THREE.Material): THREE.Material {
    const clone = toNodeMaterial(
        material,
        new THREE.MeshStandardNodeMaterial(),
    );
    keepBackFaceNormals(clone);

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
