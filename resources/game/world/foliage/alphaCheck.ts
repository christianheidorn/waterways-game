import * as THREE from 'three/webgpu';
import { float, step, texture, uv, vec4 } from 'three/tsl';
import type { GameRenderer } from '../../core/renderer';
import { measureCoverage } from '../../util/alphaCoverage';
import type { CoverageLayout, CoverageReport } from '../../util/alphaCoverage';

/** Texels per cell of the coverage read-back (the whole texture: at most 256 × 256). */
const CELL_TEXELS = 32;
const MAX_SIDE = 256;

/**
 * Alpha coverage of a cut-out texture as this GPU samples it: the texture is drawn once into a small
 * target with `alpha ≥ 0.5` written to the colour channels and read back. Going through the GPU
 * covers every source (PNG ImageBitmaps, KTX2 transcoded to BC / ETC2 / ASTC, data textures) and
 * catches platform-specific alpha loss (a transcode target without alpha, a premultiplied upload)
 * that a check of the file would miss; the colour channels survive read-backs that drop alpha.
 * Call outside a render pass. Returns null when the read-back fails.
 */
export async function measureTextureCoverage(
    renderer: GameRenderer,
    map: THREE.Texture,
    layout: CoverageLayout,
    cols = 1,
    rows = 1,
): Promise<CoverageReport | null> {
    const width = Math.min(MAX_SIDE, cols * CELL_TEXELS);
    const height = Math.min(MAX_SIDE, rows * CELL_TEXELS);
    const target = new THREE.RenderTarget(width, height, {
        depthBuffer: false,
        generateMipmaps: false,
    });
    const material = new THREE.MeshBasicNodeMaterial();
    // Base level only (no derivative-picked mip), thresholded like the alpha test.
    const a = step(float(0.5), texture(map, uv()).level(float(0)).a);
    material.colorNode = vec4(a, a, a, 1);
    material.toneMapped = false;
    const quad = new THREE.QuadMesh(material);
    const state = THREE.RendererUtils.resetRendererState(renderer, {} as never);

    try {
        try {
            renderer.setRenderTarget(target);
            quad.render(renderer);
        } finally {
            THREE.RendererUtils.restoreRendererState(renderer, state);
        }

        const data = (await renderer.readRenderTargetPixelsAsync(
            target,
            0,
            0,
            width,
            height,
        )) as Uint8Array;
        // Rows may be padded (WebGPU copies align rows to 256 bytes).
        const stride =
            height > 1 ? (data.length - width * 4) / (height - 1) : width * 4;
        const red = new Uint8Array(width * height);

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                red[y * width + x] = data[y * stride + x * 4];
            }
        }

        return measureCoverage(red, width, height, layout, cols, rows, 1, 0);
    } catch (error) {
        console.warn('Foliage texture coverage check failed', error);

        return null;
    } finally {
        target.dispose();
        material.dispose();
    }
}
