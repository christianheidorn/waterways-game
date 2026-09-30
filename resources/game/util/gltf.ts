import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { GameRenderer } from '../core/renderer';

/**
 * glTF loading for library models (foliage, props). Compressed copies made by `waterways:optimize-assets`
 * (`optimized_url`: EXT_meshopt_compression meshes, KHR_texture_basisu KTX2 textures) are decoded with
 * meshoptimizer's decoder and three's KTX2 loader (Basis transcoder in public/basis/, transcoded to
 * the GPU's BC / ETC / ASTC formats). Anything that fails to load that way falls back to the
 * original GLB.
 */
let ktx2: KTX2Loader | null = null;

/** Enables KTX2 textures once the renderer knows its compressed formats (after init). */
export function configureCompressedTextures(renderer: GameRenderer): void {
    if (!ktx2) {
        ktx2 = new KTX2Loader().setTranscoderPath('/basis/');
    }

    ktx2.detectSupport(renderer);
}

/** A glTF loader with the meshopt decoder and (once configured) KTX2 textures. */
export function createGltfLoader(): GLTFLoader {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);

    if (ktx2) {
        loader.setKTX2Loader(ktx2);
    }

    return loader;
}

/** Loads the first of `urls` that loads (e.g. the compressed copy, then the original). */
export async function loadGltfFirst(
    loader: GLTFLoader,
    urls: (string | null | undefined)[],
): Promise<GLTF> {
    const list = urls.filter((url): url is string => !!url);
    let error: unknown = new Error('No model URL');

    for (const url of list) {
        if (ktx2) {
            // Loaders made before the renderer was ready get KTX2 support late.
            loader.setKTX2Loader(ktx2);
        }

        try {
            return await loader.loadAsync(url);
        } catch (e) {
            error = e;

            if (url !== list[list.length - 1]) {
                console.warn(
                    `Compressed model ${url} failed; using the original`,
                    e,
                );
            }
        }
    }

    throw error;
}
