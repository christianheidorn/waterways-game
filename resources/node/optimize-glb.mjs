#!/usr/bin/env node
/**
 * Compresses a GLB for the game (run by `php artisan assets:optimize`, see App\Support\AssetOptimizer):
 *
 * - meshes: EXT_meshopt_compression (meshoptimizer), lossless: attributes stay float, only the
 *   buffers are encoded (vertex / index codecs after reordering for locality);
 * - textures: KTX2 / Basis Universal (KHR_texture_basisu) with mipmaps: normal maps as UASTC (RDO +
 *   Zstandard), everything else as ETC1S (colour in sRGB). On the GPU they stay compressed (BC / ETC /
 *   ASTC after transcoding): about a quarter of the memory of RGBA8, or less.
 *
 * Usage: node optimize-glb.mjs <in.glb> <out.glb> [--no-textures] [--no-meshes]
 * The last line of output is `@@RESULT {json}`: ok, bytes before / after, textures (converted), texture
 * bytes before / after in the file and estimated GPU memory before / after.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { NodeIO } from '@gltf-transform/core';
import {
    ALL_EXTENSIONS,
    EXTMeshoptCompression,
} from '@gltf-transform/extensions';
import { dedup, prune, reorder } from '@gltf-transform/functions';
import jpeg from 'jpeg-js';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { PNG } from 'pngjs';

// The Basis encoder logs every slice: keep stdout for the result.
const log = console.log;
console.log = () => undefined;
const { ktx2 } = await import('ktx2-encoder/gltf-transform');

const [input, output, ...flags] = process.argv.slice(2);

if (!input || !output) {
    console.error(
        'usage: optimize-glb.mjs <in.glb> <out.glb> [--no-textures] [--no-meshes]',
    );
    process.exit(2);
}

/** PNG / JPEG bytes → RGBA for the Basis encoder. */
async function decodeImage(buffer) {
    const bytes = Buffer.from(buffer);

    if (bytes[0] === 0x89 && bytes[1] === 0x50) {
        // Some exporters leave bytes after IEND, which the strict reader rejects.
        const end = bytes.indexOf('IEND');
        const png = PNG.sync.read(end > 0 ? bytes.subarray(0, end + 8) : bytes);

        return {
            width: png.width,
            height: png.height,
            data: new Uint8Array(png.data),
        };
    }

    const img = jpeg.decode(bytes, {
        useTArray: true,
        formatAsRGBA: true,
        maxMemoryUsageInMB: 1024,
    });

    return { width: img.width, height: img.height, data: img.data };
}

async function main() {
    await MeshoptEncoder.ready;
    await MeshoptDecoder.ready;
    const io = new NodeIO()
        .registerExtensions(ALL_EXTENSIONS)
        .registerDependencies({
            'meshopt.decoder': MeshoptDecoder,
            'meshopt.encoder': MeshoptEncoder,
        });
    const source = await readFile(input);
    const document = await io.readBinary(new Uint8Array(source));
    const textures = document.getRoot().listTextures();
    const before = new Map(
        textures.map((t) => [t, t.getImage()?.byteLength ?? 0]),
    );
    // GPU memory of the originals: RGBA8 with mipmaps (4 bytes per texel × 4/3).
    const texels = new Map(
        textures.map((t) => {
            const size = t.getSize();

            return [t, size ? size[0] * size[1] : 0];
        }),
    );
    const withTextures = !flags.includes('--no-textures');
    const withMeshes = !flags.includes('--no-meshes');

    await document.transform(dedup(), prune());

    if (withTextures) {
        const decoder = { imageDecoder: decodeImage, generateMipmap: true };
        await document.transform(
            // Normal maps: UASTC (ETC1S blocks band normals), rate-distortion optimised so that
            // Zstandard shrinks it, linear.
            ktx2({
                ...decoder,
                slots: /normalTexture/,
                isUASTC: true,
                isNormalMap: true,
                enableRDO: true,
                rdoQualityLevel: 1.5,
                isPerceptual: false,
                isSetKTX2SRGBTransferFunc: false,
                needSupercompression: true,
            }),
            // Colour: ETC1S (smallest), sRGB.
            ktx2({
                ...decoder,
                slots: /baseColorTexture|emissiveTexture|diffuseTexture/,
                isUASTC: false,
                qualityLevel: 192,
                compressionLevel: 2,
                isPerceptual: true,
                isSetKTX2SRGBTransferFunc: true,
            }),
            // Everything else is data (roughness / metalness / occlusion): ETC1S, linear.
            ktx2({
                ...decoder,
                isUASTC: false,
                qualityLevel: 192,
                compressionLevel: 2,
                isPerceptual: false,
                isSetKTX2SRGBTransferFunc: false,
            }),
        );
    }

    if (withMeshes) {
        await document.transform(reorder({ encoder: MeshoptEncoder }));
        document
            .createExtension(EXTMeshoptCompression)
            .setRequired(true)
            .setEncoderOptions({
                method: EXTMeshoptCompression.EncoderMethod.QUANTIZE,
            });
    }

    const out = await io.writeBinary(document);
    await writeFile(output, out);
    const converted = textures.filter((t) => t.getMimeType() === 'image/ktx2');
    const sum = (list, size) => list.reduce((n, t) => n + size(t), 0);
    const gpu = (t) =>
        Math.round(
            (texels.get(t) ?? 0) *
                (t.getMimeType() === 'image/ktx2' ? 1 : 4) *
                (4 / 3),
        );

    log(
        '@@RESULT ' +
            JSON.stringify({
                ok: true,
                bytes_before: source.byteLength,
                bytes_after: out.byteLength,
                textures: textures.length,
                textures_converted: converted.length,
                texture_bytes_before: sum(textures, (t) => before.get(t) ?? 0),
                texture_bytes_after: sum(
                    textures,
                    (t) => t.getImage()?.byteLength ?? 0,
                ),
                texture_memory_before: sum(textures, (t) =>
                    Math.round((texels.get(t) ?? 0) * 4 * (4 / 3)),
                ),
                texture_memory_after: sum(textures, gpu),
                meshopt: withMeshes,
            }),
    );
}

main().catch((error) => {
    log(
        '@@RESULT ' +
            JSON.stringify({
                ok: false,
                error: String(error?.message ?? error),
            }),
    );
    process.exit(1);
});
