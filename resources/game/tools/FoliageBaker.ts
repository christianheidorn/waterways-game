/**
 * In-browser foliage asset baker.
 *
 * Turns an imported model (Poly Haven glTF, Quaternius / Kenney GLB, …) or a single AI-generated plant
 * image into a game-ready GLB with levels of detail:
 *
 *   scene
 *   ├── LOD0   (Group of meshes, one per material — full detail within a per-kind triangle budget)
 *   ├── LOD1   (≈ 20 % of LOD0, or 2 crossed cards for image assets)
 *   └── LOD2   (crossed-card impostor rendered from the model; a ≈ 4 % mesh for rocks)
 *
 * Units are metres, the pivot sits at the base (min Y = 0) and bake metadata lives in the scene extras
 * (`scene.userData.waterways`). See resources/game/world/Foliage.ts for the runtime side.
 */
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptSimplifier } from 'meshoptimizer';
import type { FoliageKind } from '../shared/types';
import { LOD_BUDGETS, lodIndexOf } from '../world/FoliageLod';

export type BakeSource =
    /** .gltf (external .bin / textures resolved relative to url) or .glb */
    | { type: 'model'; url: string }
    /** PNG/JPG image of ONE plant standing on the bottom edge, ideally with a transparent background. */
    | {
          type: 'card';
          url: string;
          /** Remove a flat background colour (forced on for images without meaningful alpha). */
          keyBackground?: boolean;
          /** Hex colour of the flat background ('#ff00ff', '#00ffff', …); detected from the border when omitted. */
          keyColor?: string;
      };

export type BakeInput = {
    kind: FoliageKind;
    source: BakeSource;
    /** Final height in metres; null keeps the model's native size (cards fall back to a per-kind default). */
    targetHeight: number | null;
    /** Largest texture side in the output (default 1024). */
    maxTextureSize?: number;
};

export type BakeMeta = {
    height: number;
    width: number;
    triangles: number[];
    source_triangles: number;
    texture_size: number;
    lod_distances: number[];
};

export type BakeResult = {
    glb: Blob;
    /** 256×256 PNG with a transparent background. */
    thumbnail: Blob;
    meta: BakeMeta;
};

export type BakeProgress = (stage: string, fraction: number) => void;

// ------------------------------------------------------------------ tuning

/**
 * LOD0 triangle budget per kind — shared with the runtime (world/FoliageLod.ts), which fills in a
 * mid / far LOD for models that exceed these budgets. Every further mesh LOD gets 20 % of the one
 * before it.
 */
const LOD0_BUDGET: Record<FoliageKind, number> = {
    conifer: LOD_BUDGETS.conifer.lod0,
    broadleaf: LOD_BUDGETS.broadleaf.lod0,
    palm: LOD_BUDGETS.palm.lod0,
    bush: LOD_BUDGETS.bush.lod0,
    rock: LOD_BUDGETS.rock.lod0,
    grass: LOD_BUDGETS.grass.lod0,
    flower: LOD_BUDGETS.flower.lod0,
    reed: LOD_BUDGETS.reed.lod0,
};
const LOD_REDUCTION = 0.2;

/** Fraction of the cull distance where each LOD starts (last entry = impostor, except rocks). */
const MODEL_LOD_DISTANCES: Record<FoliageKind, number[]> = {
    conifer: [0, 0.18, 0.45],
    broadleaf: [0, 0.18, 0.45],
    palm: [0, 0.18, 0.45],
    bush: [0, 0.25, 0.55],
    grass: [0, 0.2, 0.4],
    flower: [0, 0.2, 0.4],
    reed: [0, 0.2, 0.4],
    rock: [0, 0.3, 0.6],
};

const CARD_LOD_DISTANCES = [0, 0.4];

const CARD_DEFAULT_HEIGHT: Record<FoliageKind, number> = {
    grass: 0.6,
    flower: 0.5,
    reed: 1.6,
    bush: 1.5,
    broadleaf: 10,
    conifer: 14,
    palm: 9,
    rock: 1,
};

/** Components up to this many triangles (and small relative to the model) count as leaves / cards. */
const DETAIL_MAX_TRIS = 64;
const DETAIL_MAX_EXTENT = 0.25;
/** Upper bound for scaling up surviving leaf cards (keeps a heavily thinned canopy from turning into blobs). */
const MAX_CARD_SCALE = 3.5;

const THUMB_SIZE = 256;

// ------------------------------------------------------------------ entry point

export async function bakeFoliageAsset(
    input: BakeInput,
    onProgress?: BakeProgress,
): Promise<BakeResult> {
    const report: BakeProgress = (stage, fraction) =>
        onProgress?.(stage, Math.min(1, Math.max(0, fraction)));
    const maxTextureSize = Math.max(
        16,
        Math.floor(input.maxTextureSize ?? 1024),
    );

    if (input.source.type === 'card') {
        if (input.kind === 'rock') {
            throw new Error('Rocks cannot be generated as cards');
        }

        return bakeCard(input, input.source, maxTextureSize, report);
    }

    return bakeModel(input, input.source.url, maxTextureSize, report);
}

// ------------------------------------------------------------------ shared helpers

type RawImage = { data: Uint8ClampedArray; width: number; height: number };

/** Bake-wide resources, disposed together at the end. */
class BakeContext {
    readonly geometries = new Set<THREE.BufferGeometry>();
    readonly materials = new Set<THREE.Material>();
    readonly textures = new Set<THREE.Texture>();
    /** Textures exported through our own PNG encoder (keeps colour under transparent pixels). */
    readonly rawTextures = new Map<THREE.Texture, RawImage>();
    private renderer: THREE.WebGLRenderer | null = null;

    constructor(readonly maxTextureSize: number) {}

    getRenderer(): THREE.WebGLRenderer {
        if (!this.renderer) {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = THUMB_SIZE * 2;
            this.renderer = new THREE.WebGLRenderer({
                canvas,
                antialias: true,
                alpha: true,
                preserveDrawingBuffer: true,
                powerPreference: 'high-performance',
            });
            this.renderer.setPixelRatio(1);
            this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        }

        return this.renderer;
    }

    rawTexture(image: RawImage, name: string): THREE.DataTexture {
        const texture = new THREE.DataTexture(
            image.data,
            image.width,
            image.height,
            THREE.RGBAFormat,
        );
        texture.name = name;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.flipY = false;
        texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.magFilter = THREE.LinearFilter;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.generateMipmaps = true;
        texture.anisotropy = 4;
        texture.userData.mimeType = 'image/png';
        texture.needsUpdate = true;
        this.textures.add(texture);
        this.rawTextures.set(texture, image);

        return texture;
    }

    dispose(): void {
        for (const g of this.geometries) {
            g.dispose();
        }

        for (const m of this.materials) {
            m.dispose();
        }

        for (const t of this.textures) {
            t.dispose();
            const image: unknown = t.image;

            if (
                typeof ImageBitmap !== 'undefined' &&
                image instanceof ImageBitmap
            ) {
                image.close();
            }
        }

        this.geometries.clear();
        this.materials.clear();
        this.textures.clear();
        this.rawTextures.clear();

        if (this.renderer) {
            this.renderer.dispose();
            this.renderer.forceContextLoss();
            this.renderer = null;
        }
    }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function hash01(a: number, b: number): number {
    let h =
        Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^
        Math.imul(b + 0x632be5ab, 0xc2b2ae35);
    h ^= h >>> 16;
    h = Math.imul(h, 0x7feb352d);
    h ^= h >>> 15;
    h = Math.imul(h, 0x846ca68b);
    h ^= h >>> 16;

    return (h >>> 0) / 4294967296;
}

function triangleCount(geometry: THREE.BufferGeometry): number {
    const index = geometry.getIndex();

    return Math.round(
        (index ? index.count : geometry.getAttribute('position').count) / 3,
    );
}

function objectTriangles(root: THREE.Object3D): number {
    let total = 0;
    root.traverse((obj) => {
        const mesh = obj as THREE.Mesh;

        if (mesh.isMesh) {
            total += triangleCount(mesh.geometry);
        }
    });

    return total;
}

// ------------------------------------------------------------------ model path

type SourceMaterial = {
    key: string;
    material: THREE.MeshStandardMaterial;
    vertexColors: boolean;
};

/** All triangles of one material in world space (metres, after pivot/scale). */
type Part = {
    material: THREE.MeshStandardMaterial;
    pos: Float32Array;
    nrm: Float32Array;
    uv: Float32Array;
    col: Float32Array | null;
    index: Uint32Array;
    vertexCount: number;
};

type PartAnalysis = {
    compOfVertex: Int32Array;
    compCount: number;
    compTris: Uint32Array;
    compCenter: Float32Array;
    detail: Uint8Array;
    detailIndex: Uint32Array;
    solidIndex: Uint32Array;
    /** Interleaved normal + uv for attribute-aware simplification. */
    attributes: Float32Array;
    /** Median extent of the detail components (metres). */
    detailSize: number;
    meshScale: number;
};

type LodResult = { index: Uint32Array; scale: Float32Array | null };

async function bakeModel(
    input: BakeInput,
    url: string,
    maxTextureSize: number,
    report: BakeProgress,
): Promise<BakeResult> {
    const ctx = new BakeContext(maxTextureSize);
    let gltf: GLTF | null = null;

    try {
        report('Loading model', 0);
        await MeshoptSimplifier.ready;
        const loader = new GLTFLoader();
        gltf = await loader.loadAsync(url, (event) => {
            if (event.total) {
                report('Loading model', (event.loaded / event.total) * 0.9);
            }
        });
        report('Loading model', 1);
        await tick();

        // Materials → MeshStandardMaterial, fix up alpha, cap texture sizes.
        report('Preparing materials', 0);
        const materials = await convertMaterials(gltf, url, input.kind, ctx);
        await tick();

        report('Flattening meshes', 0);
        const parts = flattenScene(gltf, materials);

        // Source data is no longer needed; free the loader's copies early (big models).
        disposeGltf(gltf);
        gltf = null;

        if (!parts.length) {
            throw new Error('The model contains no triangles');
        }

        const sourceTriangles = parts.reduce(
            (sum, p) => sum + p.index.length / 3,
            0,
        );
        const bounds = normalizeParts(parts, input.targetHeight);
        report('Flattening meshes', 1);
        await tick();

        // Connected components per material.
        const analyses: PartAnalysis[] = [];

        for (let i = 0; i < parts.length; i++) {
            report('Analysing geometry', i / parts.length);
            analyses.push(analysePart(parts[i], bounds.maxDim));
            await tick();
        }

        const kind = input.kind;
        const budget0 = LOD0_BUDGET[kind];
        const impostor = kind !== 'rock';
        const lodDistances = MODEL_LOD_DISTANCES[kind];
        const meshLodCount = impostor
            ? lodDistances.length - 1
            : lodDistances.length;
        const lodGroups: THREE.Group[] = [];
        let previousTris = Infinity;

        for (let level = 0; level < meshLodCount; level++) {
            const stage = `Simplifying LOD${level}`;
            report(stage, 0);
            const budget =
                level === 0
                    ? budget0
                    : Math.max(
                          64,
                          Math.round(
                              Math.min(previousTris, budget0) *
                                  LOD_REDUCTION ** level,
                          ),
                      );
            const results = await buildMeshLod(
                parts,
                analyses,
                budget,
                level,
                (f) => report(stage, f),
            );
            const group = new THREE.Group();
            group.name = `LOD${level}`;

            for (let i = 0; i < parts.length; i++) {
                const result = results[i];

                if (result.index.length === 0) {
                    continue;
                }

                const geometry = makeGeometry(parts[i], analyses[i], result);
                ctx.geometries.add(geometry);
                const mesh = new THREE.Mesh(geometry, parts[i].material);
                mesh.name = `${group.name}_${parts[i].material.name || i}`;
                group.add(mesh);
            }

            if (level === 0) {
                previousTris = objectTriangles(group);
            }

            lodGroups.push(group);
            report(stage, 1);
            await tick();
        }

        const lod0 = lodGroups[0];

        // Enlarged leaf cards can poke out above the crown: keep an explicit target height exact.
        if (input.targetHeight && input.targetHeight > 0) {
            const lodBox = new THREE.Box3().setFromObject(lod0);
            const actual = lodBox.max.y - lodBox.min.y;

            if (
                actual > 0 &&
                Math.abs(actual / input.targetHeight - 1) > 0.005
            ) {
                const f = input.targetHeight / actual;

                for (const geometry of ctx.geometries) {
                    geometry.scale(f, f, f);
                }
            }
        }

        if (impostor) {
            report('Rendering impostor', 0);
            lodGroups.push(renderImpostor(lod0, ctx, `LOD${lodGroups.length}`));
            report('Rendering impostor', 1);
            await tick();
        }

        report('Rendering thumbnail', 0);
        const thumbnail = await renderThumbnail(lod0, ctx);
        await tick();

        const box = new THREE.Box3().setFromObject(lod0);
        const meta: BakeMeta = {
            height: round3(box.max.y - box.min.y),
            width: round3(
                Math.max(box.max.x - box.min.x, box.max.z - box.min.z),
            ),
            triangles: lodGroups.map(objectTriangles),
            source_triangles: sourceTriangles,
            texture_size: 0,
            lod_distances: lodDistances.slice(0, lodGroups.length),
        };

        report('Exporting GLB', 0);
        const glb = await exportGlb(lodGroups, meta, ctx);
        report('Exporting GLB', 1);

        return { glb, thumbnail, meta };
    } finally {
        if (gltf) {
            disposeGltf(gltf);
        }

        ctx.dispose();
    }
}

function round3(v: number): number {
    return Math.round(v * 1000) / 1000;
}

/** Frees the loader's geometry (materials and textures are tracked by the bake context). */
function disposeGltf(gltf: GLTF): void {
    gltf.scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;

        if (mesh.isMesh) {
            mesh.geometry.dispose();
        }
    });
}

// ---------------------------------------------------------- materials

type GltfParserLike = {
    json: {
        textures?: { source?: number }[];
        images?: { uri?: string; name?: string }[];
    };
    associations: Map<
        object,
        { textures?: number; materials?: number } | undefined
    >;
};

function textureUri(
    parser: GltfParserLike,
    texture: THREE.Texture | null,
): string | null {
    if (!texture) {
        return null;
    }

    const assoc = parser.associations.get(texture);

    if (assoc?.textures === undefined) {
        return null;
    }

    const source = parser.json.textures?.[assoc.textures]?.source;
    const uri =
        source !== undefined ? parser.json.images?.[source]?.uri : undefined;

    return uri && !uri.startsWith('data:') ? uri : null;
}

async function convertMaterials(
    gltf: GLTF,
    url: string,
    kind: FoliageKind,
    ctx: BakeContext,
): Promise<Map<THREE.Material, SourceMaterial>> {
    const parser = gltf.parser as unknown as GltfParserLike;
    const result = new Map<THREE.Material, SourceMaterial>();
    const byKey = new Map<string, SourceMaterial>();
    const sources = new Set<THREE.Material>();
    const base = new URL(url, location.href);
    const alphaCache = new Map<string, Promise<RawImage | null>>();

    gltf.scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;

        if (mesh.isMesh) {
            for (const m of Array.isArray(mesh.material)
                ? mesh.material
                : [mesh.material]) {
                sources.add(m);
            }
        }
    });

    for (const src of sources) {
        const assoc = parser.associations.get(src);
        const s = src as THREE.MeshStandardMaterial & {
            map?: THREE.Texture | null;
            vertexColors?: boolean;
        };
        const hasMap = !!s.map;
        const vertexColors = !!s.vertexColors && !hasMap;
        const key = `${assoc?.materials ?? src.uuid}:${vertexColors ? 'vc' : ''}`;
        const existing = byKey.get(key);

        if (existing) {
            result.set(src, existing);
            continue;
        }

        const m = new THREE.MeshStandardMaterial({
            name: src.name || `material_${byKey.size}`,
        });
        m.color.copy(s.color ?? new THREE.Color(0xffffff));
        m.map = s.map ?? null;
        m.vertexColors = vertexColors;

        if ((src as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
            m.normalMap = s.normalMap ?? null;
            m.normalScale.copy(s.normalScale);
            m.roughness = s.roughness;
            m.metalness = s.metalness;
            m.roughnessMap = s.roughnessMap ?? null;
            m.metalnessMap = s.metalnessMap ?? null;
            m.aoMap = s.aoMap ?? null;
            m.aoMapIntensity = s.aoMapIntensity;
            m.emissive.copy(s.emissive);
            m.emissiveMap = s.emissiveMap ?? null;
            m.emissiveIntensity = s.emissiveIntensity;
        } else {
            const phong = src as THREE.MeshPhongMaterial;
            m.normalMap = phong.normalMap ?? null;
            m.roughness = 0.85;
            m.metalness = 0;

            if (phong.emissive) {
                m.emissive.copy(phong.emissive);
                m.emissiveMap = phong.emissiveMap ?? null;
            }
        }

        // Packed occlusion/roughness/metalness (Poly Haven "arm") → also use it as the AO map.
        const armUri = textureUri(parser, m.roughnessMap);

        if (
            !m.aoMap &&
            m.roughnessMap &&
            armUri &&
            /[_-](arm|orm)[_.-]/i.test(armUri)
        ) {
            m.aoMap = m.roughnessMap;
        }

        const alpha = src.transparent || src.alphaTest > 0 || src.alphaHash;
        const leafName =
            /leaf|leaves|needle|foliage|grass|fern|frond|petal|flower|twig/i.test(
                src.name,
            );

        if (alpha) {
            m.alphaTest = src.alphaTest > 0 ? src.alphaTest : 0.5;
            m.transparent = false;
            m.depthWrite = true;
        }

        // Rocks are closed scans: no need to pay for back faces (Poly Haven marks everything double-sided).
        m.side =
            alpha ||
            leafName ||
            (src.side === THREE.DoubleSide && kind !== 'rock')
                ? THREE.DoubleSide
                : THREE.FrontSide;

        // Clones of one packed texture (KHR_texture_transform) → one texture, so the exporter
        // writes a single metallicRoughness / occlusion image instead of merging copies.
        if (m.roughnessMap) {
            const same = (t: THREE.Texture | null) =>
                !!t &&
                t !== m.roughnessMap &&
                t.source === m.roughnessMap!.source;

            if (same(m.metalnessMap)) {
                m.metalnessMap = m.roughnessMap;
            }

            if (same(m.aoMap)) {
                m.aoMap = m.roughnessMap;
            }
        }

        // Base colour without an alpha channel (Poly Haven ships leaf alpha as a separate map).
        if (alpha && m.map && !textureHasAlpha(m.map)) {
            const uri = textureUri(parser, m.map);
            const raw = uri
                ? await findAlphaMap(base, uri, m.map, ctx, alphaCache)
                : null;

            if (raw) {
                m.map = cloneAsRaw(m.map, raw, ctx);
            }
        } else if (alpha && m.map && m.map.userData.mimeType === 'image/png') {
            // Re-encode with dilated colour so mip-mapped edges don't pick up black fringes.
            const raw = imageToRaw(
                m.map.image as CanvasImageSource & {
                    width: number;
                    height: number;
                },
                ctx.maxTextureSize,
            );

            if (raw) {
                dilateColor(raw);
                m.map = cloneAsRaw(m.map, raw, ctx);
            }
        }

        for (const t of materialTextures(m)) {
            ctx.textures.add(t);
            capTextureSize(t, ctx.maxTextureSize);
        }

        ctx.materials.add(m);
        const entry = { key, material: m, vertexColors };
        byKey.set(key, entry);
        result.set(src, entry);
    }

    for (const src of sources) {
        // Loader textures not carried over still need freeing.
        for (const t of materialTextures(src as THREE.MeshStandardMaterial)) {
            ctx.textures.add(t);
        }

        src.dispose();
    }

    return result;
}

function materialTextures(m: THREE.MeshStandardMaterial): THREE.Texture[] {
    const list = [
        m.map,
        m.normalMap,
        m.roughnessMap,
        m.metalnessMap,
        m.aoMap,
        m.emissiveMap,
        m.alphaMap,
    ];

    return [
        ...new Set(
            list.filter(
                (t): t is THREE.Texture =>
                    !!t && (t as THREE.Texture).isTexture,
            ),
        ),
    ];
}

function textureHasAlpha(texture: THREE.Texture): boolean {
    const mime = texture.userData.mimeType as string | undefined;

    if (mime === 'image/jpeg') {
        return false;
    }

    // PNG/WebP/unknown: sample the image.
    const image = texture.image as
        | (CanvasImageSource & { width: number; height: number })
        | null;

    if (!image || !image.width) {
        return true;
    }

    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const c2d = canvas.getContext('2d', { willReadFrequently: true })!;
    c2d.drawImage(image, 0, 0, size, size);
    const data = c2d.getImageData(0, 0, size, size).data;

    for (let i = 3; i < data.length; i += 4) {
        if (data[i] < 250) {
            return true;
        }
    }

    return false;
}

function alphaCandidates(uri: string): string[] {
    const out: string[] = [];
    const push = (u: string) => {
        if (u !== uri && !out.includes(u)) {
            out.push(u);
        }
    };
    const re =
        /([_-])(diff(?:use)?|basecolou?r|base_colou?r|albedo|col(?:ou?r)?)(?=[_.-])/i;

    if (re.test(uri)) {
        const replaced = uri.replace(re, '$1alpha');
        push(replaced);
        push(replaced.replace(/\.(jpe?g)$/i, '.png'));
        push(replaced.replace(/\.png$/i, '.jpg'));
    }

    return out;
}

async function findAlphaMap(
    base: URL,
    uri: string,
    map: THREE.Texture,
    ctx: BakeContext,
    cache: Map<string, Promise<RawImage | null>>,
): Promise<RawImage | null> {
    const cached = cache.get(uri);

    if (cached) {
        return cached;
    }

    const job = (async () => {
        for (const candidate of alphaCandidates(uri)) {
            try {
                const response = await fetch(new URL(candidate, base).href);

                if (!response.ok) {
                    continue;
                }

                const bitmap = await createImageBitmap(await response.blob());
                const image = map.image as CanvasImageSource & {
                    width: number;
                    height: number;
                };
                const scale = Math.min(
                    1,
                    ctx.maxTextureSize / Math.max(image.width, image.height),
                );
                const w = Math.max(1, Math.round(image.width * scale));
                const h = Math.max(1, Math.round(image.height * scale));
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const c2d = canvas.getContext('2d', {
                    willReadFrequently: true,
                })!;
                c2d.drawImage(bitmap, 0, 0, w, h);
                const alpha = c2d.getImageData(0, 0, w, h).data;
                c2d.clearRect(0, 0, w, h);
                c2d.drawImage(image, 0, 0, w, h);
                const rgb = c2d.getImageData(0, 0, w, h).data;
                bitmap.close();

                for (let i = 0; i < rgb.length; i += 4) {
                    rgb[i + 3] = alpha[i];
                }

                return { data: rgb, width: w, height: h };
            } catch {
                // try next candidate
            }
        }

        return null;
    })();
    cache.set(uri, job);

    return job;
}

function imageToRaw(
    image: (CanvasImageSource & { width: number; height: number }) | null,
    maxSize: number,
): RawImage | null {
    if (!image || !image.width) {
        return null;
    }

    const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
    const w = Math.max(1, Math.round(image.width * scale));
    const h = Math.max(1, Math.round(image.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const c2d = canvas.getContext('2d', { willReadFrequently: true })!;
    c2d.drawImage(image, 0, 0, w, h);

    return { data: c2d.getImageData(0, 0, w, h).data, width: w, height: h };
}

function cloneAsRaw(
    source: THREE.Texture,
    raw: RawImage,
    ctx: BakeContext,
): THREE.DataTexture {
    const texture = ctx.rawTexture(raw, source.name);
    texture.wrapS = source.wrapS;
    texture.wrapT = source.wrapT;
    texture.offset.copy(source.offset);
    texture.repeat.copy(source.repeat);
    texture.rotation = source.rotation;
    texture.center.copy(source.center);
    texture.channel = source.channel;

    return texture;
}

function capTextureSize(texture: THREE.Texture, maxSize: number): void {
    const image = texture.image as
        | (CanvasImageSource & { width: number; height: number })
        | null;

    if (
        !image ||
        !image.width ||
        (texture as THREE.DataTexture).isDataTexture
    ) {
        return;
    }

    if (Math.max(image.width, image.height) <= maxSize) {
        return;
    }

    const scale = maxSize / Math.max(image.width, image.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const c2d = canvas.getContext('2d')!;
    c2d.imageSmoothingQuality = 'high';
    c2d.drawImage(image, 0, 0, canvas.width, canvas.height);

    if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) {
        image.close();
    }

    texture.image = canvas;
    texture.needsUpdate = true;
}

// ---------------------------------------------------------- geometry

class FloatBuilder {
    data: Float32Array;
    length = 0;

    constructor(capacity: number) {
        this.data = new Float32Array(Math.max(16, capacity));
    }

    reserve(extra: number): void {
        if (this.length + extra > this.data.length) {
            const next = new Float32Array(
                Math.max(this.data.length * 2, this.length + extra),
            );
            next.set(this.data.subarray(0, this.length));
            this.data = next;
        }
    }

    result(): Float32Array {
        return this.data.slice(0, this.length);
    }
}

class IndexBuilder {
    data: Uint32Array;
    length = 0;

    constructor(capacity: number) {
        this.data = new Uint32Array(Math.max(16, capacity));
    }

    push(v: number): void {
        if (this.length === this.data.length) {
            const next = new Uint32Array(this.data.length * 2);
            next.set(this.data);
            this.data = next;
        }

        this.data[this.length++] = v;
    }

    result(): Uint32Array {
        return this.data.slice(0, this.length);
    }
}

type PartBuilder = {
    entry: SourceMaterial;
    pos: FloatBuilder;
    nrm: FloatBuilder;
    uv: FloatBuilder;
    col: FloatBuilder | null;
    index: IndexBuilder;
    vertexCount: number;
};

function flattenScene(
    gltf: GLTF,
    materials: Map<THREE.Material, SourceMaterial>,
): Part[] {
    const builders = new Map<string, PartBuilder>();
    const normalMatrix = new THREE.Matrix3();
    const world = new THREE.Matrix4();
    const instance = new THREE.Matrix4();
    const v = new THREE.Vector3();
    gltf.scene.updateMatrixWorld(true);

    // Sources that already carry LODs ("LOD0".."LODn", "Tree_LOD1", …): bake only the most
    // detailed one (the lowest index present).
    let minLod = Infinity;
    gltf.scene.traverse((obj) => {
        const lod = lodIndexOf(obj.name);

        if (lod !== null) {
            minLod = Math.min(minLod, lod);
        }
    });

    const visible = (obj: THREE.Object3D): boolean => {
        for (let o: THREE.Object3D | null = obj; o; o = o.parent) {
            const lod = lodIndexOf(o.name);

            if (!o.visible || (lod !== null && lod > minLod)) {
                return false;
            }
        }

        return true;
    };

    gltf.scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;

        if (!mesh.isMesh || !visible(mesh)) {
            return;
        }

        const geometry = mesh.geometry;
        const position = geometry.getAttribute('position');

        if (!position || position.itemSize < 3) {
            return;
        }

        if (!geometry.getAttribute('normal')) {
            geometry.computeVertexNormals();
        }

        const normal = geometry.getAttribute('normal');
        const uv = geometry.getAttribute('uv');
        const color = geometry.getAttribute('color');
        const index = geometry.getIndex();
        const vertexCount = position.count;
        const materialList = Array.isArray(mesh.material)
            ? mesh.material
            : [mesh.material];
        const groups = geometry.groups.length
            ? geometry.groups
            : [
                  {
                      start: 0,
                      count: index ? index.count : vertexCount,
                      materialIndex: 0,
                  },
              ];
        const instanced = (mesh as THREE.InstancedMesh).isInstancedMesh
            ? (mesh as THREE.InstancedMesh)
            : null;
        const instances = instanced ? instanced.count : 1;

        for (let inst = 0; inst < instances; inst++) {
            world.copy(mesh.matrixWorld);

            if (instanced) {
                instanced.getMatrixAt(inst, instance);
                world.multiply(instance);
            }

            normalMatrix.getNormalMatrix(world);
            const flip = world.determinant() < 0;

            for (const group of groups) {
                const srcMaterial =
                    materialList[group.materialIndex ?? 0] ?? materialList[0];
                const entry = srcMaterial
                    ? materials.get(srcMaterial)
                    : undefined;

                if (!entry) {
                    continue;
                }

                let builder = builders.get(entry.key);

                if (!builder) {
                    builder = {
                        entry,
                        pos: new FloatBuilder(vertexCount * 3),
                        nrm: new FloatBuilder(vertexCount * 3),
                        uv: new FloatBuilder(vertexCount * 2),
                        col: entry.vertexColors
                            ? new FloatBuilder(vertexCount * 4)
                            : null,
                        index: new IndexBuilder(group.count),
                        vertexCount: 0,
                    };
                    builders.set(entry.key, builder);
                }

                const b = builder;
                const start = Math.max(0, group.start);
                const end = Math.min(
                    index ? index.count : vertexCount,
                    group.start + group.count,
                );
                const remap = new Int32Array(vertexCount).fill(-1);
                const add = (src: number): number => {
                    let dst = remap[src];

                    if (dst >= 0) {
                        return dst;
                    }

                    dst = b.vertexCount++;
                    remap[src] = dst;
                    b.pos.reserve(3);
                    b.nrm.reserve(3);
                    b.uv.reserve(2);
                    v.fromBufferAttribute(position, src).applyMatrix4(world);
                    b.pos.data[b.pos.length++] = v.x;
                    b.pos.data[b.pos.length++] = v.y;
                    b.pos.data[b.pos.length++] = v.z;
                    v.fromBufferAttribute(normal, src).applyMatrix3(
                        normalMatrix,
                    );

                    if (v.lengthSq() > 0) {
                        v.normalize();
                    } else {
                        v.set(0, 1, 0);
                    }

                    b.nrm.data[b.nrm.length++] = v.x;
                    b.nrm.data[b.nrm.length++] = v.y;
                    b.nrm.data[b.nrm.length++] = v.z;
                    b.uv.data[b.uv.length++] = uv ? uv.getX(src) : 0;
                    b.uv.data[b.uv.length++] = uv ? uv.getY(src) : 0;

                    if (b.col) {
                        b.col.reserve(4);
                        b.col.data[b.col.length++] = color
                            ? color.getX(src)
                            : 1;
                        b.col.data[b.col.length++] = color
                            ? color.getY(src)
                            : 1;
                        b.col.data[b.col.length++] = color
                            ? color.getZ(src)
                            : 1;
                        b.col.data[b.col.length++] =
                            color && color.itemSize > 3 ? color.getW(src) : 1;
                    }

                    return dst;
                };

                for (let i = start; i + 2 < end; i += 3) {
                    const a = index ? index.getX(i) : i;
                    const c1 = index ? index.getX(i + 1) : i + 1;
                    const c2 = index ? index.getX(i + 2) : i + 2;

                    if (a === c1 || c1 === c2 || a === c2) {
                        continue;
                    }

                    const ia = add(a);
                    const ib = add(flip ? c2 : c1);
                    const ic = add(flip ? c1 : c2);
                    b.index.push(ia);
                    b.index.push(ib);
                    b.index.push(ic);
                }
            }
        }
    });

    const parts: Part[] = [];

    for (const b of builders.values()) {
        if (b.index.length === 0) {
            continue;
        }

        parts.push({
            material: b.entry.material,
            pos: b.pos.result(),
            nrm: b.nrm.result(),
            uv: b.uv.result(),
            col: b.col ? b.col.result() : null,
            index: b.index.result(),
            vertexCount: b.vertexCount,
        });
    }

    return parts;
}

/** Pivot at the base (min Y = 0), metres, optional target height. Returns the final bounds. */
function normalizeParts(
    parts: Part[],
    targetHeight: number | null,
): { height: number; maxDim: number } {
    const box = new THREE.Box3();

    for (const p of parts) {
        for (let i = 0; i < p.pos.length; i += 3) {
            box.expandByPoint(
                new THREE.Vector3(p.pos[i], p.pos[i + 1], p.pos[i + 2]),
            );
        }
    }

    const height = Math.max(1e-6, box.max.y - box.min.y);
    let scale = 1;

    if (targetHeight && targetHeight > 0) {
        scale = targetHeight / height;
    } else if (height > 150) {
        scale = 0.01; // centimetres
    } else if (height < 0.02) {
        scale = 100;
    }

    // Keep the authored X/Z origin unless it lies outside the model's footprint (packs often
    // place several models side by side) — then centre on the footprint.
    const cx = box.min.x > 0 || box.max.x < 0 ? (box.min.x + box.max.x) / 2 : 0;
    const cz = box.min.z > 0 || box.max.z < 0 ? (box.min.z + box.max.z) / 2 : 0;
    const minY = box.min.y;

    for (const p of parts) {
        const pos = p.pos;

        for (let i = 0; i < pos.length; i += 3) {
            pos[i] = (pos[i] - cx) * scale;
            pos[i + 1] = (pos[i + 1] - minY) * scale;
            pos[i + 2] = (pos[i + 2] - cz) * scale;
        }
    }

    const size = box.getSize(new THREE.Vector3()).multiplyScalar(scale);

    return { height: height * scale, maxDim: Math.max(size.x, size.y, size.z) };
}

function analysePart(part: Part, modelSize: number): PartAnalysis {
    const vc = part.vertexCount;
    const index = part.index;
    const triCount = index.length / 3;
    const remap = MeshoptSimplifier.generatePositionRemap(part.pos, 3);
    const parent = new Int32Array(vc);

    for (let i = 0; i < vc; i++) {
        parent[i] = i;
    }

    const find = (x: number): number => {
        while (parent[x] !== x) {
            parent[x] = parent[parent[x]];
            x = parent[x];
        }

        return x;
    };

    for (let t = 0; t < index.length; t += 3) {
        const a = find(remap[index[t]]);
        const b = find(remap[index[t + 1]]);
        const c = find(remap[index[t + 2]]);

        if (b !== a) {
            parent[b] = a;
        }

        if (c !== a && c !== b) {
            parent[c] = a;
        }
    }

    const compOfRoot = new Int32Array(vc).fill(-1);
    const compOfVertex = new Int32Array(vc);
    let compCount = 0;

    for (let i = 0; i < vc; i++) {
        const r = find(remap[i]);

        if (compOfRoot[r] < 0) {
            compOfRoot[r] = compCount++;
        }

        compOfVertex[i] = compOfRoot[r];
    }

    const compTris = new Uint32Array(compCount);
    const bounds = new Float32Array(compCount * 6);

    for (let c = 0; c < compCount; c++) {
        bounds[c * 6] = bounds[c * 6 + 1] = bounds[c * 6 + 2] = Infinity;
        bounds[c * 6 + 3] = bounds[c * 6 + 4] = bounds[c * 6 + 5] = -Infinity;
    }

    for (let t = 0; t < index.length; t += 3) {
        compTris[compOfVertex[index[t]]]++;
    }

    const pos = part.pos;

    for (let i = 0; i < vc; i++) {
        const o = compOfVertex[i] * 6;

        for (let k = 0; k < 3; k++) {
            const value = pos[i * 3 + k];

            if (value < bounds[o + k]) {
                bounds[o + k] = value;
            }

            if (value > bounds[o + 3 + k]) {
                bounds[o + 3 + k] = value;
            }
        }
    }

    const detail = new Uint8Array(compCount);
    const compCenter = new Float32Array(compCount * 3);
    const detailSizes: number[] = [];

    for (let c = 0; c < compCount; c++) {
        const o = c * 6;
        const dx = bounds[o + 3] - bounds[o];
        const dy = bounds[o + 4] - bounds[o + 1];
        const dz = bounds[o + 5] - bounds[o + 2];
        const diag = Math.sqrt(dx * dx + dy * dy + dz * dz);
        compCenter[c * 3] = (bounds[o] + bounds[o + 3]) / 2;
        compCenter[c * 3 + 1] = (bounds[o + 1] + bounds[o + 4]) / 2;
        compCenter[c * 3 + 2] = (bounds[o + 2] + bounds[o + 5]) / 2;

        if (
            compTris[c] <= DETAIL_MAX_TRIS &&
            diag <= modelSize * DETAIL_MAX_EXTENT
        ) {
            detail[c] = 1;

            if (detailSizes.length < 20000) {
                detailSizes.push(diag);
            }
        }
    }

    detailSizes.sort((a, b) => a - b);
    const detailBuilder = new IndexBuilder(16);
    const solidBuilder = new IndexBuilder(16);

    for (let t = 0; t < triCount; t++) {
        const target = detail[compOfVertex[index[t * 3]]]
            ? detailBuilder
            : solidBuilder;
        target.push(index[t * 3]);
        target.push(index[t * 3 + 1]);
        target.push(index[t * 3 + 2]);
    }

    const attributes = new Float32Array(vc * 5);

    for (let i = 0; i < vc; i++) {
        attributes[i * 5] = part.nrm[i * 3];
        attributes[i * 5 + 1] = part.nrm[i * 3 + 1];
        attributes[i * 5 + 2] = part.nrm[i * 3 + 2];
        attributes[i * 5 + 3] = part.uv[i * 2];
        attributes[i * 5 + 4] = part.uv[i * 2 + 1];
    }

    return {
        compOfVertex,
        compCount,
        compTris,
        compCenter,
        detail,
        detailIndex: detailBuilder.result(),
        solidIndex: solidBuilder.result(),
        attributes,
        detailSize: detailSizes.length
            ? detailSizes[detailSizes.length >> 1]
            : 0,
        meshScale: MeshoptSimplifier.getScale(part.pos, 3) || 1,
    };
}

const ATTRIBUTE_WEIGHTS = [0.4, 0.4, 0.4, 1, 1];

function simplifyIndices(
    part: Part,
    analysis: PartAnalysis,
    indices: Uint32Array,
    targetTris: number,
    relativeError: number,
): Uint32Array {
    const target = Math.max(3, Math.floor(targetTris) * 3);

    if (indices.length <= target) {
        return indices;
    }

    let [result] = MeshoptSimplifier.simplifyWithAttributes(
        indices,
        part.pos,
        3,
        analysis.attributes,
        5,
        ATTRIBUTE_WEIGHTS,
        null,
        target,
        relativeError,
    );

    if (result.length > target * 1.25) {
        // Topology-limited (open borders, UV seams): relax seam/border handling.
        [result] = MeshoptSimplifier.simplifyWithAttributes(
            result,
            part.pos,
            3,
            analysis.attributes,
            5,
            ATTRIBUTE_WEIGHTS,
            null,
            target,
            relativeError,
            ['Permissive'],
        );
    }

    if (result.length > target * 1.25) {
        // Still too many (lots of tiny parts): cluster-based fallback.
        [result] = MeshoptSimplifier.simplifySloppy(
            result,
            part.pos,
            3,
            null,
            target,
            1,
        );
    }

    return result;
}

/**
 * Builds one mesh LOD within a triangle budget. Leaf-like components ("detail") are first
 * collapsed individually (bent/subdivided cards → ~2 triangles), then thinned out by dropping
 * whole components and scaling the survivors up (area preserving). Trunks, branches and rocks
 * ("solid") are edge-collapse simplified.
 */
async function buildMeshLod(
    parts: Part[],
    analyses: PartAnalysis[],
    budget: number,
    level: number,
    progress: (f: number) => void,
): Promise<LodResult[]> {
    let solidTris = 0;
    let detailTris = 0;

    for (const a of analyses) {
        solidTris += a.solidIndex.length / 3;
        detailTris += a.detailIndex.length / 3;
    }

    if (solidTris + detailTris <= budget) {
        return parts.map((p) => ({ index: p.index, scale: null }));
    }

    // Stage A: collapse each leaf card as far as its shape allows.
    const detail: Uint32Array[] = [];
    let detailAfter = 0;

    for (let i = 0; i < parts.length; i++) {
        const a = analyses[i];
        let idx = a.detailIndex;

        if (idx.length) {
            const error =
                (a.detailSize * (level === 0 ? 0.3 : 0.6)) / a.meshScale ||
                0.01;
            let detailComps = 0;

            for (let c = 0; c < a.compCount; c++) {
                detailComps += a.detail[c];
            }

            idx = simplifyIndices(parts[i], a, idx, detailComps * 2, error);
        }

        detail.push(idx);
        detailAfter += idx.length / 3;
        progress((0.4 * (i + 1)) / parts.length);
        await tick();
    }

    let solidBudget = solidTris;
    let detailBudget = detailAfter;

    if (solidTris + detailAfter > budget) {
        solidBudget = Math.min(
            solidTris,
            Math.max(budget * 0.3, budget - detailAfter),
        );
        detailBudget = budget - solidBudget;

        if (detailBudget > detailAfter) {
            detailBudget = detailAfter;
            solidBudget = budget - detailAfter;
        }
    }

    const keep = detailAfter > 0 ? Math.min(1, detailBudget / detailAfter) : 1;

    // Details: deterministic per-component keep decision (LOD1 keeps a subset of LOD0).
    const kept: Uint32Array[] = [];
    let sourceArea = 0;
    let keptArea = 0;

    for (let i = 0; i < parts.length; i++) {
        const a = analyses[i];
        let det = detail[i];

        if (keep < 1 && det.length) {
            const out = new IndexBuilder(
                Math.ceil(det.length * keep * 1.2) + 16,
            );
            const keepComp = new Uint8Array(a.compCount);

            for (let c = 0; c < a.compCount; c++) {
                keepComp[c] = hash01(i + 1, c) < keep ? 1 : 0;
            }

            for (let t = 0; t < det.length; t += 3) {
                if (keepComp[a.compOfVertex[det[t]]]) {
                    out.push(det[t]);
                    out.push(det[t + 1]);
                    out.push(det[t + 2]);
                }
            }

            det = out.result();
        }

        sourceArea += triangleArea(parts[i].pos, a.detailIndex);
        keptArea += triangleArea(parts[i].pos, det);
        kept.push(det);
    }

    // Scale survivors so the total leaf area matches the source (compensates both the dropped
    // cards and outlines eroded by the per-card collapse).
    const cardScale =
        keptArea > 0 && sourceArea > keptArea * 1.02
            ? Math.min(MAX_CARD_SCALE, Math.sqrt(sourceArea / keptArea))
            : 1;
    const results: LodResult[] = [];

    for (let i = 0; i < parts.length; i++) {
        const a = analyses[i];
        const part = parts[i];
        // Solids: share of the solid budget proportional to their source size.
        let solid = a.solidIndex;

        if (solid.length && solidBudget < solidTris) {
            const target = Math.max(
                4,
                (solidBudget * (solid.length / 3)) / solidTris,
            );
            solid = simplifyIndices(
                part,
                a,
                solid,
                target,
                level === 0 ? 0.25 : 0.5,
            );
        }

        const det = kept[i];
        let scale: Float32Array | null = null;

        if (cardScale !== 1 && det.length) {
            scale = new Float32Array(a.compCount).fill(1);

            for (let c = 0; c < a.compCount; c++) {
                if (a.detail[c]) {
                    scale[c] = cardScale;
                }
            }
        }

        const index = new Uint32Array(solid.length + det.length);
        index.set(solid, 0);
        index.set(det, solid.length);
        results.push({ index, scale });
        progress(0.4 + (0.6 * (i + 1)) / parts.length);
        await tick();
    }

    return results;
}

function triangleArea(pos: Float32Array, index: Uint32Array): number {
    let area = 0;

    for (let t = 0; t < index.length; t += 3) {
        const a = index[t] * 3;
        const b = index[t + 1] * 3;
        const c = index[t + 2] * 3;
        const ux = pos[b] - pos[a];
        const uy = pos[b + 1] - pos[a + 1];
        const uz = pos[b + 2] - pos[a + 2];
        const vx = pos[c] - pos[a];
        const vy = pos[c + 1] - pos[a + 1];
        const vz = pos[c + 2] - pos[a + 2];
        const cx = uy * vz - uz * vy;
        const cy = uz * vx - ux * vz;
        const cz = ux * vy - uy * vx;
        area += Math.sqrt(cx * cx + cy * cy + cz * cz) * 0.5;
    }

    return area;
}

function makeGeometry(
    part: Part,
    analysis: PartAnalysis,
    lod: LodResult,
): THREE.BufferGeometry {
    const source = lod.index;
    const map = new Int32Array(part.vertexCount).fill(-1);
    let count = 0;

    for (let i = 0; i < source.length; i++) {
        if (map[source[i]] < 0) {
            map[source[i]] = count++;
        }
    }

    const pos = new Float32Array(count * 3);
    const nrm = new Float32Array(count * 3);
    const uv = new Float32Array(count * 2);
    const col = part.col ? new Float32Array(count * 4) : null;
    const center = analysis.compCenter;

    for (let v = 0; v < part.vertexCount; v++) {
        const d = map[v];

        if (d < 0) {
            continue;
        }

        const comp = analysis.compOfVertex[v];
        const s = lod.scale ? lod.scale[comp] : 1;

        for (let k = 0; k < 3; k++) {
            const p = part.pos[v * 3 + k];
            pos[d * 3 + k] =
                s === 1
                    ? p
                    : center[comp * 3 + k] + (p - center[comp * 3 + k]) * s;
            nrm[d * 3 + k] = part.nrm[v * 3 + k];
        }

        uv[d * 2] = part.uv[v * 2];
        uv[d * 2 + 1] = part.uv[v * 2 + 1];

        if (col && part.col) {
            for (let k = 0; k < 4; k++) {
                col[d * 4 + k] = part.col[v * 4 + k];
            }
        }
    }

    const IndexArray = count > 65535 ? Uint32Array : Uint16Array;
    const index = new IndexArray(source.length);

    for (let i = 0; i < source.length; i++) {
        index[i] = map[source[i]];
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));

    if (col) {
        geometry.setAttribute('color', new THREE.BufferAttribute(col, 4));
    }

    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    return geometry;
}

// ---------------------------------------------------------- impostor

const IMPOSTOR_ANGLES = [0, 60, 120];

/** Renders the model from 3 horizontal directions into an atlas and builds 3 crossed quads. */
function renderImpostor(
    model: THREE.Object3D,
    ctx: BakeContext,
    name: string,
): THREE.Group {
    let radius = 0;
    let height = 0;
    model.traverse((obj) => {
        const mesh = obj as THREE.Mesh;

        if (!mesh.isMesh) {
            return;
        }

        const pos = mesh.geometry.getAttribute('position');

        for (let i = 0; i < pos.count; i++) {
            radius = Math.max(radius, Math.hypot(pos.getX(i), pos.getZ(i)));
            height = Math.max(height, pos.getY(i));
        }
    });
    radius = Math.max(radius, 0.01) * 1.03;
    height = Math.max(height, 0.01) * 1.02;

    // Cell layout: tall models side by side, wide ones stacked.
    const aspect = (2 * radius) / height;
    let cw: number;
    let ch: number;

    if (aspect <= 1) {
        ch = Math.min(512, ctx.maxTextureSize);
        cw = Math.max(16, Math.round(ch * aspect));

        if (cw * 3 > ctx.maxTextureSize) {
            const f = ctx.maxTextureSize / (cw * 3);
            cw = Math.floor(cw * f);
            ch = Math.floor(ch * f);
        }
    } else {
        cw = Math.min(512, ctx.maxTextureSize);
        ch = Math.max(16, Math.round(cw / aspect));

        if (ch * 3 > ctx.maxTextureSize) {
            const f = ctx.maxTextureSize / (ch * 3);
            cw = Math.floor(cw * f);
            ch = Math.floor(ch * f);
        }
    }

    const horizontal = aspect <= 1;
    const atlasW = horizontal ? cw * 3 : cw;
    const atlasH = horizontal ? ch : ch * 3;
    const ss = 2;
    const renderer = ctx.getRenderer();
    const target = new THREE.WebGLRenderTarget(atlasW * ss, atlasH * ss, {
        samples: 4,
        colorSpace: THREE.SRGBColorSpace,
    });
    const scene = new THREE.Scene();
    // Soft, near-albedo lighting: the game lights the impostor cards again.
    const ambient = new THREE.AmbientLight(0xffffff, Math.PI * 0.35);
    const key = new THREE.DirectionalLight(0xffffff, Math.PI * 0.35);
    scene.add(ambient, key, key.target);
    const holder = new THREE.Group();
    holder.add(...gameShadedClones(model, ctx));
    scene.add(holder);
    const camera = new THREE.OrthographicCamera(
        -radius,
        radius,
        height,
        0,
        0.01,
        radius * 4 + 2,
    );
    const previousAutoClear = renderer.autoClear;
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
        camera.position.copy(dir).multiplyScalar(radius * 2 + 1);
        camera.up.set(0, 1, 0);
        camera.lookAt(0, 0, 0);
        camera.updateMatrixWorld();
        key.position
            .copy(dir)
            .multiplyScalar(10)
            .add(new THREE.Vector3(0, 7, 0));
        // Cells are stored top-down in the image; GL render targets are bottom-up.
        const x = horizontal ? i * cw : 0;
        const yTop = horizontal ? 0 : i * ch;
        const glY = atlasH - yTop - ch;
        target.viewport.set(x * ss, glY * ss, cw * ss, ch * ss);
        target.scissor.set(x * ss, glY * ss, cw * ss, ch * ss);
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
    });

    const pixels = new Uint8Array(atlasW * ss * atlasH * ss * 4);
    renderer.readRenderTargetPixels(
        target,
        0,
        0,
        atlasW * ss,
        atlasH * ss,
        pixels,
    );
    renderer.setRenderTarget(null);
    renderer.autoClear = previousAutoClear;
    target.dispose();

    // Downsample (alpha-weighted box filter) and flip to top-down rows.
    const out = new Uint8ClampedArray(atlasW * atlasH * 4);
    const srcW = atlasW * ss;

    for (let y = 0; y < atlasH; y++) {
        for (let x = 0; x < atlasW; x++) {
            let r = 0;
            let g = 0;
            let b = 0;
            let al = 0;

            for (let sy = 0; sy < ss; sy++) {
                for (let sx = 0; sx < ss; sx++) {
                    const glRow = (atlasH - 1 - y) * ss + (ss - 1 - sy);
                    const o = (glRow * srcW + x * ss + sx) * 4;
                    const w = pixels[o + 3];
                    r += pixels[o] * w;
                    g += pixels[o + 1] * w;
                    b += pixels[o + 2] * w;
                    al += w;
                }
            }

            const o = (y * atlasW + x) * 4;

            if (al > 0) {
                out[o] = r / al;
                out[o + 1] = g / al;
                out[o + 2] = b / al;
            }

            out[o + 3] = al / (ss * ss);
        }
    }

    const raw: RawImage = { data: out, width: atlasW, height: atlasH };
    dilateColor(raw);
    const texture = ctx.rawTexture(raw, 'impostor');
    const material = new THREE.MeshStandardMaterial({
        name: 'impostor',
        map: texture,
        alphaTest: 0.5,
        side: THREE.DoubleSide,
        roughness: 0.9,
        metalness: 0,
    });
    ctx.materials.add(material);

    const quads: Quad[] = IMPOSTOR_ANGLES.map((deg, i) => {
        const u0 = horizontal ? (i * cw) / atlasW : 0;
        const u1 = horizontal ? ((i + 1) * cw) / atlasW : 1;
        const v0 = horizontal ? 0 : (i * ch) / atlasH;
        const v1 = horizontal ? 1 : ((i + 1) * ch) / atlasH;

        return {
            angle: deg,
            left: -radius,
            right: radius,
            height,
            lean: 0,
            uv: [u0, v0, u1, v1],
        };
    });
    const geometry = buildQuads(quads);
    ctx.geometries.add(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `${name}_impostor`;
    const group = new THREE.Group();
    group.name = name;
    group.add(mesh);

    return group;
}

type Quad = {
    /** Degrees; 0 = quad faces +Z. */
    angle: number;
    left: number;
    right: number;
    height: number;
    /** Tilt of the top edge along the quad normal, radians. */
    lean: number;
    /** u0, v0 (top), u1, v1 (bottom) — glTF convention (v = 0 at the top of the image). */
    uv: [number, number, number, number];
};

/** Vertical quads with softly up-tilted, outward-rounded normals (double-sided alpha-tested cards). */
function buildQuads(quads: Quad[]): THREE.BufferGeometry {
    const pos: number[] = [];
    const nrm: number[] = [];
    const uv: number[] = [];
    const index: number[] = [];
    const n = new THREE.Vector3();

    for (const q of quads) {
        const a = THREE.MathUtils.degToRad(q.angle);
        const right = new THREE.Vector3(Math.cos(a), 0, -Math.sin(a));
        const facing = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
        const leanOffset = facing
            .clone()
            .multiplyScalar(Math.tan(q.lean) * q.height);
        const base = pos.length / 3;
        const [u0, v0, u1, v1] = q.uv;
        const corners: [number, number, number, number][] = [
            // side offset, y, u, v
            [q.left, 0, u0, v1],
            [q.right, 0, u1, v1],
            [q.right, q.height, u1, v0],
            [q.left, q.height, u0, v0],
        ];

        for (const [s, y, cu, cv] of corners) {
            const top = y > 0;
            pos.push(
                right.x * s + (top ? leanOffset.x : 0),
                y,
                right.z * s + (top ? leanOffset.z : 0),
            );
            const side = s < 0 ? -1 : 1;
            n.copy(right)
                .multiplyScalar(side * 0.45)
                .add(new THREE.Vector3(0, top ? 1 : 0.75, 0))
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

/**
 * Mesh clones whose double-sided materials skip three's back-face normal flip — the same
 * shading the game's foliage material patch uses — so captures match the in-game look.
 */
function gameShadedClones(
    model: THREE.Object3D,
    ctx: BakeContext,
): THREE.Mesh[] {
    const patched = new Map<THREE.Material, THREE.Material>();
    const patch = (material: THREE.Material): THREE.Material => {
        if (material.side !== THREE.DoubleSide) {
            return material;
        }

        let m = patched.get(material);

        if (!m) {
            m = material.clone();
            m.onBeforeCompile = (shader) => {
                shader.fragmentShader = shader.fragmentShader.replace(
                    '#include <normal_fragment_begin>',
                    THREE.ShaderChunk.normal_fragment_begin.replace(
                        'normal *= faceDirection;',
                        '',
                    ),
                );
            };
            m.customProgramCacheKey = () => 'baker-no-face-flip';
            ctx.materials.add(m);
            patched.set(material, m);
        }

        return m;
    };
    const meshes: THREE.Mesh[] = [];
    model.traverse((obj) => {
        const mesh = obj as THREE.Mesh;

        if (mesh.isMesh) {
            const clone = mesh.clone();
            clone.material = Array.isArray(mesh.material)
                ? mesh.material.map(patch)
                : patch(mesh.material);
            mesh.updateWorldMatrix(true, false);
            clone.matrixAutoUpdate = false;
            clone.matrix.copy(mesh.matrixWorld);
            meshes.push(clone);
        }
    });

    return meshes;
}

// ---------------------------------------------------------- thumbnail

async function renderThumbnail(
    model: THREE.Object3D,
    ctx: BakeContext,
): Promise<Blob> {
    const renderer = ctx.getRenderer();
    const size = THUMB_SIZE * 2;
    renderer.setSize(size, size, false);
    renderer.setRenderTarget(null);
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;

    const scene = new THREE.Scene();
    const holder = new THREE.Group();
    holder.add(...gameShadedClones(model, ctx));
    scene.add(holder);
    scene.add(new THREE.HemisphereLight(0xdcebff, 0x6b5a45, Math.PI * 0.45));
    scene.add(new THREE.AmbientLight(0xffffff, Math.PI * 0.15));
    const sun = new THREE.DirectionalLight(0xfff1dc, Math.PI * 0.95);
    sun.position.set(2, 3, 2.4);
    scene.add(sun);

    const box = new THREE.Box3().setFromObject(holder);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 1000);
    const dir = new THREE.Vector3(0.75, 0.42, 1).normalize();
    const dist =
        (sphere.radius / Math.sin(THREE.MathUtils.degToRad(15))) * 1.02;
    camera.position.copy(sphere.center).addScaledVector(dir, dist);
    camera.near = Math.max(0.001, dist - sphere.radius * 2);
    camera.far = dist + sphere.radius * 2;
    camera.lookAt(sphere.center);
    camera.updateProjectionMatrix();
    renderer.clear();
    renderer.render(scene, camera);

    const out = document.createElement('canvas');
    out.width = out.height = THUMB_SIZE;
    const c2d = out.getContext('2d')!;
    c2d.imageSmoothingQuality = 'high';
    c2d.drawImage(renderer.domElement, 0, 0, THUMB_SIZE, THUMB_SIZE);
    renderer.toneMapping = THREE.NoToneMapping;

    return new Promise<Blob>((resolve, reject) =>
        out.toBlob(
            (b) =>
                b ? resolve(b) : reject(new Error('Thumbnail encoding failed')),
            'image/png',
        ),
    );
}

// ---------------------------------------------------------- export

type WriterLike = {
    json: { images?: { mimeType: string; bufferView?: number }[] };
    processBufferViewImage(blob: Blob): Promise<number>;
};

async function exportGlb(
    lods: THREE.Group[],
    meta: BakeMeta,
    ctx: BakeContext,
): Promise<Blob> {
    const scene = new THREE.Scene();
    scene.name = 'Foliage';

    for (const lod of lods) {
        scene.add(lod);
    }

    // Texture size actually written (after caps).
    let textureSize = 0;
    const seen = new Set<THREE.Texture>();
    scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;

        if (!mesh.isMesh) {
            return;
        }

        for (const t of materialTextures(
            mesh.material as THREE.MeshStandardMaterial,
        )) {
            if (seen.has(t)) {
                continue;
            }

            seen.add(t);
            const image = t.image as { width?: number; height?: number } | null;
            const side = Math.max(image?.width ?? 0, image?.height ?? 0);
            textureSize = Math.max(
                textureSize,
                Math.min(side, ctx.maxTextureSize),
            );
        }
    });
    meta.texture_size = textureSize;
    scene.userData = { waterways: { version: 1, ...meta } };

    // Raw textures go through our own PNG encoder; the exporter only sees a 1×1 placeholder.
    const placeholder = (): HTMLCanvasElement => {
        const c = document.createElement('canvas');
        c.width = c.height = 1;

        return c;
    };

    for (const texture of ctx.rawTextures.keys()) {
        if (seen.has(texture)) {
            texture.image = placeholder();
        }
    }

    const exporter = new GLTFExporter();
    exporter.register((writer) => {
        const w = writer as unknown as WriterLike;

        return {
            writeTexture: async (
                map: THREE.Texture,
                textureDef: { [key: string]: unknown },
            ) => {
                const raw = ctx.rawTextures.get(map);

                if (!raw) {
                    return;
                }

                const blob = await encodePng(raw);
                const images = (w.json.images ??= []);
                const imageDef: { mimeType: string; bufferView?: number } = {
                    mimeType: 'image/png',
                };
                const index = images.push(imageDef) - 1;
                imageDef.bufferView = await w.processBufferViewImage(blob);
                textureDef.source = index;
            },
        };
    });
    const result = await exporter.parseAsync(scene, {
        binary: true,
        maxTextureSize: ctx.maxTextureSize,
        onlyVisible: false,
    });

    return new Blob([result as ArrayBuffer], { type: 'model/gltf-binary' });
}

// ---------------------------------------------------------- PNG + pixels

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array, crc = 0xffffffff): number {
    if (!crcTable) {
        crcTable = new Uint32Array(256);

        for (let n = 0; n < 256; n++) {
            let c = n;

            for (let k = 0; k < 8; k++) {
                c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            }

            crcTable[n] = c >>> 0;
        }
    }

    for (let i = 0; i < bytes.length; i++) {
        crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }

    return crc;
}

/** Straight (non-premultiplied) RGBA PNG, so colour under transparent pixels survives. */
async function encodePng(image: RawImage): Promise<Blob> {
    const { width, height, data } = image;
    const stride = width * 4;
    const filtered = new Uint8Array((stride + 1) * height);

    const candidate = new Uint8Array(stride);

    // Per row, pick the filter with the smallest sum of absolute residuals (libpng heuristic).
    for (let y = 0; y < height; y++) {
        const row = y * (stride + 1);
        const cur = y * stride;
        const prev = (y - 1) * stride;
        let best = Infinity;

        for (let filter = 0; filter < 5; filter++) {
            let cost = 0;

            for (let i = 0; i < stride; i++) {
                const x = data[cur + i];
                const a = i >= 4 ? data[cur + i - 4] : 0;
                const b = y > 0 ? data[prev + i] : 0;
                const c = y > 0 && i >= 4 ? data[prev + i - 4] : 0;
                let predictor = 0;

                if (filter === 1) {
                    predictor = a;
                } else if (filter === 2) {
                    predictor = b;
                } else if (filter === 3) {
                    predictor = (a + b) >> 1;
                } else if (filter === 4) {
                    const p = a + b - c;
                    const pa = Math.abs(p - a);
                    const pb = Math.abs(p - b);
                    const pc = Math.abs(p - c);
                    predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
                }

                const residual = (x - predictor) & 0xff;
                candidate[i] = residual;
                cost += residual < 128 ? residual : 256 - residual;
            }

            if (cost < best) {
                best = cost;
                filtered[row] = filter;
                filtered.set(candidate, row + 1);
            }
        }
    }

    const stream = new Blob([filtered])
        .stream()
        .pipeThrough(new CompressionStream('deflate'));
    const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
    const chunk = (type: string, payload: Uint8Array): Uint8Array => {
        const out = new Uint8Array(payload.length + 12);
        const view = new DataView(out.buffer);
        view.setUint32(0, payload.length);

        for (let i = 0; i < 4; i++) {
            out[4 + i] = type.charCodeAt(i);
        }

        out.set(payload, 8);
        view.setUint32(
            8 + payload.length,
            (crc32(out.subarray(4, 8 + payload.length)) ^ 0xffffffff) >>> 0,
        );

        return out;
    };
    const ihdr = new Uint8Array(13);
    const hv = new DataView(ihdr.buffer);
    hv.setUint32(0, width);
    hv.setUint32(4, height);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // RGBA
    const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

    return new Blob(
        [
            signature,
            chunk('IHDR', ihdr),
            chunk('IDAT', compressed),
            chunk('IEND', new Uint8Array(0)),
        ].map((part) => part.slice().buffer as ArrayBuffer),
        { type: 'image/png' },
    );
}

/**
 * Fills the colour of (nearly) transparent pixels from their opaque neighbours, layer by layer,
 * so bilinear filtering and mip-maps don't bleed black into alpha-tested edges.
 */
function dilateColor(image: RawImage, threshold = 64): void {
    const { width: w, height: h, data } = image;
    const n = w * h;
    const known = new Uint8Array(n);
    let layer: number[] = [];
    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;

    for (let i = 0; i < n; i++) {
        if (data[i * 4 + 3] >= threshold) {
            known[i] = 1;
            r += data[i * 4];
            g += data[i * 4 + 1];
            b += data[i * 4 + 2];
            count++;
        }
    }

    if (count === 0) {
        return;
    }

    const queued = new Uint8Array(n);
    const enqueueNeighbours = (i: number, into: number[]) => {
        const x = i % w;
        const y = (i / w) | 0;

        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const nx = x + dx;
                const ny = y + dy;

                if (nx < 0 || ny < 0 || nx >= w || ny >= h) {
                    continue;
                }

                const j = ny * w + nx;

                if (!known[j] && !queued[j]) {
                    queued[j] = 1;
                    into.push(j);
                }
            }
        }
    };

    for (let i = 0; i < n; i++) {
        if (known[i]) {
            const x = i % w;
            const y = (i / w) | 0;

            // Only border pixels of the known region seed the first layer.
            if (
                (x > 0 && !known[i - 1]) ||
                (x < w - 1 && !known[i + 1]) ||
                (y > 0 && !known[i - w]) ||
                (y < h - 1 && !known[i + w])
            ) {
                enqueueNeighbours(i, layer);
            }
        }
    }

    for (let pass = 0; layer.length && pass < 4096; pass++) {
        const fill = new Uint8ClampedArray(layer.length * 3);

        for (let k = 0; k < layer.length; k++) {
            const i = layer[k];
            const x = i % w;
            const y = (i / w) | 0;
            let sr = 0;
            let sg = 0;
            let sb = 0;
            let c = 0;

            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = x + dx;
                    const ny = y + dy;

                    if (nx < 0 || ny < 0 || nx >= w || ny >= h) {
                        continue;
                    }

                    const j = ny * w + nx;

                    if (known[j]) {
                        sr += data[j * 4];
                        sg += data[j * 4 + 1];
                        sb += data[j * 4 + 2];
                        c++;
                    }
                }
            }

            fill[k * 3] = c ? sr / c : r / count;
            fill[k * 3 + 1] = c ? sg / c : g / count;
            fill[k * 3 + 2] = c ? sb / c : b / count;
        }

        const next: number[] = [];

        for (let k = 0; k < layer.length; k++) {
            const i = layer[k];
            data[i * 4] = fill[k * 3];
            data[i * 4 + 1] = fill[k * 3 + 1];
            data[i * 4 + 2] = fill[k * 3 + 2];
            known[i] = 1;
        }

        for (const i of layer) {
            enqueueNeighbours(i, next);
        }

        layer = next;
    }
}

/** Area-average resample (alpha-weighted colour); only used for downscaling. */
function resampleRaw(src: RawImage, dw: number, dh: number): RawImage {
    const { width: sw, height: sh, data } = src;
    const out = new Uint8ClampedArray(dw * dh * 4);
    const fx = sw / dw;
    const fy = sh / dh;

    for (let y = 0; y < dh; y++) {
        const y0 = Math.floor(y * fy);
        const y1 = Math.max(y0 + 1, Math.min(sh, Math.floor((y + 1) * fy)));

        for (let x = 0; x < dw; x++) {
            const x0 = Math.floor(x * fx);
            const x1 = Math.max(x0 + 1, Math.min(sw, Math.floor((x + 1) * fx)));
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            let n = 0;

            for (let sy = y0; sy < y1; sy++) {
                for (let sx = x0; sx < x1; sx++) {
                    const o = (sy * sw + sx) * 4;
                    const w = data[o + 3];
                    r += data[o] * w;
                    g += data[o + 1] * w;
                    b += data[o + 2] * w;
                    a += w;
                    n++;
                }
            }

            const o = (y * dw + x) * 4;

            if (a > 0) {
                out[o] = r / a;
                out[o + 1] = g / a;
                out[o + 2] = b / a;
            }

            out[o + 3] = a / n;
        }
    }

    return { data: out, width: dw, height: dh };
}

// ------------------------------------------------------------------ card path

async function bakeCard(
    input: BakeInput,
    source: { url: string; keyBackground?: boolean; keyColor?: string },
    maxTextureSize: number,
    report: BakeProgress,
): Promise<BakeResult> {
    const ctx = new BakeContext(maxTextureSize);

    try {
        report('Loading image', 0);
        const response = await fetch(source.url);

        if (!response.ok) {
            throw new Error(`Could not load image (${response.status})`);
        }

        const bitmap = await createImageBitmap(await response.blob());
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const c2d = canvas.getContext('2d', { willReadFrequently: true })!;
        c2d.drawImage(bitmap, 0, 0);
        bitmap.close();
        let image: RawImage = {
            data: c2d.getImageData(0, 0, canvas.width, canvas.height).data,
            width: canvas.width,
            height: canvas.height,
        };
        report('Loading image', 1);
        await tick();

        report('Removing background', 0);

        const keyed = !!source.keyBackground || !hasMeaningfulAlpha(image);

        if (keyed) {
            keyBackground(image, parseHexColor(source.keyColor));
        }

        await tick();
        // Cut the rim off the matte so no background-tinted halo survives (thin blades are kept).
        chokeMatte(image, keyed);
        const trimmed = trimToAlpha(image);

        if (!trimmed) {
            throw new Error('The image is empty after removing the background');
        }

        image = trimmed;
        const pivotU = basePivot(image);
        const scale = Math.min(
            1,
            maxTextureSize / Math.max(image.width, image.height),
        );

        if (scale < 1) {
            image = resampleRaw(
                image,
                Math.max(1, Math.round(image.width * scale)),
                Math.max(1, Math.round(image.height * scale)),
            );
        }

        // Edge pixels take the colour of the solid plant next to them (also pads transparent texels).
        bleedEdgeColor(image);
        report('Removing background', 1);
        await tick();

        report('Building cards', 0);
        const kind = input.kind;
        const height =
            input.targetHeight && input.targetHeight > 0
                ? input.targetHeight
                : CARD_DEFAULT_HEIGHT[kind];
        const width = (image.width / image.height) * height;
        const left = -pivotU * width;
        const right = (1 - pivotU) * width;
        const texture = ctx.rawTexture(image, 'card');
        const material = new THREE.MeshStandardMaterial({
            name: 'card',
            map: texture,
            alphaTest: 0.5,
            side: THREE.DoubleSide,
            roughness: 0.8,
            metalness: 0,
        });
        ctx.materials.add(material);
        const full: [number, number, number, number] = [0, 0, 1, 1];
        const quad = (angle: number, lean = 0, h = height): Quad => ({
            angle,
            left: (left * h) / height,
            right: (right * h) / height,
            height: h,
            lean,
            uv: full,
        });
        let lod0Quads: Quad[];
        const small = kind === 'grass' || kind === 'flower' || kind === 'reed';
        const lean = THREE.MathUtils.degToRad(7);

        if (small) {
            lod0Quads = [quad(0, lean), quad(60, -lean), quad(120, lean)];
        } else if (kind === 'bush') {
            lod0Quads = [
                quad(0),
                quad(60),
                quad(120),
                quad(45, 0, height * 0.85),
            ];
        } else {
            lod0Quads = [quad(0), quad(60), quad(120)];
        }

        const lod1Quads = [
            quad(0, small ? lean * 0.5 : 0),
            quad(90, small ? -lean * 0.5 : 0),
        ];
        const lods = [lod0Quads, lod1Quads].map((quads, level) => {
            const geometry = buildQuads(quads);
            ctx.geometries.add(geometry);
            const mesh = new THREE.Mesh(geometry, material);
            mesh.name = `LOD${level}_card`;
            const group = new THREE.Group();
            group.name = `LOD${level}`;
            group.add(mesh);

            return group;
        });
        report('Building cards', 1);

        report('Rendering thumbnail', 0);
        const thumbnail = await renderThumbnail(lods[0], ctx);
        await tick();

        const meta: BakeMeta = {
            height: round3(height),
            width: round3(width),
            triangles: lods.map(objectTriangles),
            source_triangles: objectTriangles(lods[0]),
            texture_size: 0,
            lod_distances: CARD_LOD_DISTANCES.slice(),
        };

        report('Exporting GLB', 0);
        const glb = await exportGlb(lods, meta, ctx);
        report('Exporting GLB', 1);

        return { glb, thumbnail, meta };
    } finally {
        ctx.dispose();
    }
}

function hasMeaningfulAlpha(image: RawImage): boolean {
    const { width: w, height: h, data } = image;
    let transparent = 0;
    let border = 0;

    for (let x = 0; x < w; x++) {
        for (const y of [0, h - 1]) {
            border++;

            if (data[(y * w + x) * 4 + 3] < 128) {
                transparent++;
            }
        }
    }

    for (let y = 0; y < h; y++) {
        for (const x of [0, w - 1]) {
            border++;

            if (data[(y * w + x) * 4 + 3] < 128) {
                transparent++;
            }
        }
    }

    return transparent / border > 0.5;
}

function parseHexColor(
    hex: string | undefined,
): [number, number, number] | null {
    const m = hex?.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);

    if (!m) {
        return null;
    }

    const v =
        m[1].length === 3
            ? m[1]
                  .split('')
                  .map((c) => c + c)
                  .join('')
            : m[1];

    return [
        parseInt(v.slice(0, 2), 16),
        parseInt(v.slice(2, 4), 16),
        parseInt(v.slice(4, 6), 16),
    ];
}

function smooth01(e0: number, e1: number, x: number): number {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));

    return t * t * (3 - 2 * t);
}

/**
 * Breadth-first colour propagation: every pixel reached from the `known` set (in `mask`, when
 * given) takes the average `rgb` of its already-known 8-neighbours, layer by layer.
 * Returns the layer each pixel was reached in (0 = known, -1 = not reached).
 */
function propagateColor(
    w: number,
    h: number,
    rgb: Float32Array,
    known: Uint8Array,
    maxLayers: number,
    mask?: Uint8Array,
): Int32Array {
    const n = w * h;
    const layerOf = new Int32Array(n).fill(-1);
    let layer: number[] = [];
    const visit = (i: number, into: number[]) => {
        const x = i % w;
        const y = (i / w) | 0;

        for (let dy = -1; dy <= 1; dy++) {
            const ny = y + dy;

            if (ny < 0 || ny >= h) {
                continue;
            }

            for (let dx = -1; dx <= 1; dx++) {
                const nx = x + dx;

                if (nx < 0 || nx >= w) {
                    continue;
                }

                const j = ny * w + nx;

                if (layerOf[j] === -1 && (!mask || mask[j])) {
                    layerOf[j] = -2;
                    into.push(j);
                }
            }
        }
    };

    for (let i = 0; i < n; i++) {
        if (known[i]) {
            layerOf[i] = 0;
        }
    }

    for (let i = 0; i < n; i++) {
        if (known[i]) {
            visit(i, layer);
        }
    }

    for (let pass = 1; layer.length && pass <= maxLayers; pass++) {
        const fill = new Float32Array(layer.length * 3);

        for (let k = 0; k < layer.length; k++) {
            const i = layer[k];
            const x = i % w;
            const y = (i / w) | 0;
            let r = 0;
            let g = 0;
            let b = 0;
            let c = 0;

            for (let dy = -1; dy <= 1; dy++) {
                const ny = y + dy;

                if (ny < 0 || ny >= h) {
                    continue;
                }

                for (let dx = -1; dx <= 1; dx++) {
                    const nx = x + dx;
                    const j = ny * w + nx;

                    if (nx >= 0 && nx < w && layerOf[j] >= 0) {
                        r += rgb[j * 3];
                        g += rgb[j * 3 + 1];
                        b += rgb[j * 3 + 2];
                        c++;
                    }
                }
            }

            fill[k * 3] = r / c;
            fill[k * 3 + 1] = g / c;
            fill[k * 3 + 2] = b / c;
        }

        for (let k = 0; k < layer.length; k++) {
            const i = layer[k];
            rgb[i * 3] = fill[k * 3];
            rgb[i * 3 + 1] = fill[k * 3 + 1];
            rgb[i * 3 + 2] = fill[k * 3 + 2];
            layerOf[i] = pass;
        }

        const next: number[] = [];

        for (const i of layer) {
            visit(i, next);
        }

        layer = next;
    }

    for (const i of layer) {
        layerOf[i] = -1;
    }

    return layerOf;
}

/**
 * Removes a flat background colour (magenta, cyan, white, …) — `key` when given, else sampled
 * from the image border. Background-like regions connected to the border — or large enclosed
 * ones (gaps between branches) — become transparent. In a band along the cut-out edge, alpha is
 * re-estimated by un-mixing each pixel between the key and the nearby solid plant colour, the
 * foreground colour is recovered (F = (C − (1 − a)·B) / a) and remaining key spill is removed.
 */
function keyBackground(
    image: RawImage,
    key: [number, number, number] | null,
): void {
    const { width: w, height: h, data } = image;
    const n = w * h;
    const rs: number[] = [];
    const gs: number[] = [];
    const bs: number[] = [];
    const sample = (x: number, y: number) => {
        const o = (y * w + x) * 4;

        if (data[o + 3] >= 128) {
            rs.push(data[o]);
            gs.push(data[o + 1]);
            bs.push(data[o + 2]);
        }
    };
    const ring = Math.max(1, Math.round(Math.min(w, h) * 0.01));

    for (let k = 0; k < ring; k++) {
        for (let x = 0; x < w; x++) {
            sample(x, k);
            sample(x, h - 1 - k);
        }

        for (let y = 0; y < h; y++) {
            sample(k, y);
            sample(w - 1 - k, y);
        }
    }

    if (!rs.length) {
        return;
    }

    const median = (list: number[]) => {
        const sorted = list.slice().sort((a, b) => a - b);

        return sorted[sorted.length >> 1];
    };
    const detected = [median(rs), median(gs), median(bs)];
    const far = (c: number[]) =>
        Math.hypot(c[0] - detected[0], c[1] - detected[1], c[2] - detected[2]);
    // Trust the requested key unless the image plainly came back with another background.
    const bg = key && far(key) < 90 ? key : detected;
    // Noise of the border (JPEG artefacts, gradients) widens the tolerance.
    let variance = 0;
    let samples = 0;

    for (let i = 0; i < rs.length; i++) {
        const d2 =
            (rs[i] - bg[0]) ** 2 + (gs[i] - bg[1]) ** 2 + (bs[i] - bg[2]) ** 2;

        // Plant pixels touching the border are not background noise.
        if (d2 < 90 * 90) {
            variance += d2;
            samples++;
        }
    }

    const noise = samples ? Math.sqrt(variance / samples) : 0;
    const tolerance = Math.min(70, Math.max(26, noise * 2.5));
    const feather = 42;
    const dist = new Float32Array(n);

    for (let i = 0; i < n; i++) {
        const o = i * 4;
        dist[i] = Math.sqrt(
            (data[o] - bg[0]) ** 2 +
                (data[o + 1] - bg[1]) ** 2 +
                (data[o + 2] - bg[2]) ** 2,
        );
    }

    // Connected regions of background-like pixels.
    const limit = tolerance + feather;
    const region = new Int32Array(n).fill(-1);
    const keyRegion: boolean[] = [];
    const lum = (r: number, g: number, b: number) =>
        0.2126 * r + 0.7152 * g + 0.0722 * b;
    const magentaKey = bg[0] > 150 && bg[2] > 150 && bg[1] < 110;
    const cyanKey = bg[1] > 150 && bg[2] > 150 && bg[0] < 110;
    const whiteKey =
        lum(bg[0], bg[1], bg[2]) > 190 &&
        Math.max(...bg) - Math.min(...bg) < 40;
    // Saturated keys (magenta, cyan) don't occur in plants: every enclosed pocket of key colour
    // (gaps between leaflets) is background. Otherwise only large pockets or near-exact key
    // colour are, so white blossoms on a white background survive.
    const saturatedKey = magentaKey || cyanKey;
    const minArea = Math.max(48, n * 0.0008);
    const stack: number[] = [];

    for (let start = 0; start < n; start++) {
        if (
            region[start] >= 0 ||
            dist[start] >= limit ||
            data[start * 4 + 3] < 8
        ) {
            continue;
        }

        const id = keyRegion.length;
        let area = 0;
        let touchesBorder = false;
        let core = 0;
        region[start] = id;
        stack.push(start);

        while (stack.length) {
            const i = stack.pop()!;
            area++;
            core += dist[i] < tolerance ? 1 : 0;
            const x = i % w;
            const y = (i / w) | 0;

            if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
                touchesBorder = true;
            }

            const neighbours = [
                x > 0 ? i - 1 : -1,
                x < w - 1 ? i + 1 : -1,
                y > 0 ? i - w : -1,
                y < h - 1 ? i + w : -1,
            ];

            for (const j of neighbours) {
                if (
                    j >= 0 &&
                    region[j] < 0 &&
                    dist[j] < limit &&
                    data[j * 4 + 3] >= 8
                ) {
                    region[j] = id;
                    stack.push(j);
                }
            }
        }

        keyRegion.push(
            touchesBorder ||
                area >= minArea ||
                saturatedKey ||
                core >= area * 0.3,
        );
    }

    const isKey = new Uint8Array(n);

    for (let i = 0; i < n; i++) {
        const id = region[i];
        isKey[i] = id >= 0 && keyRegion[id] ? 1 : 0;
    }

    // Edge band: everything within `radius` px of a keyed pixel; beyond it the plant is "solid".
    const radius = Math.max(3, Math.round(Math.max(w, h) / 400));
    const band = new Uint8Array(n);
    const solid = new Uint8Array(n);
    {
        const reach = new Int32Array(n).fill(-1);
        let front: number[] = [];

        for (let i = 0; i < n; i++) {
            if (isKey[i]) {
                reach[i] = 0;
                front.push(i);
            }
        }

        for (let step = 1; step <= radius && front.length; step++) {
            const next: number[] = [];

            for (const i of front) {
                const x = i % w;
                const y = (i / w) | 0;

                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const nx = x + dx;
                        const ny = y + dy;
                        const j = ny * w + nx;

                        if (
                            nx >= 0 &&
                            ny >= 0 &&
                            nx < w &&
                            ny < h &&
                            reach[j] < 0
                        ) {
                            reach[j] = step;
                            next.push(j);
                        }
                    }
                }
            }

            front = next;
        }

        for (let i = 0; i < n; i++) {
            band[i] = reach[i] >= 0 ? 1 : 0;

            if (data[i * 4 + 3] < 128) {
                continue;
            }

            if (reach[i] < 0) {
                solid[i] = 1;
                continue;
            }

            // Inside the band (thin fronds are all band): a pixel not touching the background
            // that is the most plant-like of its neighbourhood counts as pure plant colour.
            if (isKey[i] || dist[i] < limit) {
                continue;
            }

            const x = i % w;
            const y = (i / w) | 0;
            let pure = true;

            for (let dy = -1; dy <= 1 && pure; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = x + dx;
                    const ny = y + dy;

                    if (nx < 0 || ny < 0 || nx >= w || ny >= h) {
                        continue;
                    }

                    const j = ny * w + nx;

                    if (isKey[j] || dist[i] < dist[j] * 0.85) {
                        pure = false;
                        break;
                    }
                }
            }

            solid[i] = pure ? 1 : 0;
        }
    }

    // Local plant colour for every band pixel, grown in from the solid interior.
    const local = new Float32Array(n * 3);

    for (let i = 0; i < n; i++) {
        local[i * 3] = data[i * 4];
        local[i * 3 + 1] = data[i * 4 + 1];
        local[i * 3 + 2] = data[i * 4 + 2];
    }

    const localLayer = propagateColor(w, h, local, solid, radius * 4 + 4, band);
    for (let i = 0; i < n; i++) {
        if (!band[i]) {
            continue;
        }

        const o = i * 4;

        if (isKey[i] && dist[i] < tolerance) {
            data[o + 3] = 0;
            continue;
        }

        const cr = data[o];
        const cg = data[o + 1];
        const cb = data[o + 2];
        // Distance-based fallback (plant colour close to the key, or no solid plant nearby).
        let alpha = isKey[i]
            ? smooth01(tolerance, tolerance + feather, dist[i])
            : 1;
        let fr = localLayer[i] >= 0 ? local[i * 3] : cr;
        let fg = localLayer[i] >= 0 ? local[i * 3 + 1] : cg;
        let fb = localLayer[i] >= 0 ? local[i * 3 + 2] : cb;
        const vr = fr - bg[0];
        const vg = fg - bg[1];
        const vb = fb - bg[2];
        const len2 = vr * vr + vg * vg + vb * vb;

        if (localLayer[i] >= 0 && len2 > 60 * 60) {
            // Project the pixel onto the key → plant line; colour off that line is real detail
            // (a highlight, a blossom), not a mix with the background.
            const pr = cr - bg[0];
            const pg = cg - bg[1];
            const pb = cb - bg[2];
            const t = Math.min(
                1,
                Math.max(0, (pr * vr + pg * vg + pb * vb) / len2),
            );
            const off = Math.hypot(pr - t * vr, pg - t * vg, pb - t * vb);
            alpha = t + (1 - t) * smooth01(24, 70, off);
        }

        if (alpha <= 0.03) {
            data[o + 3] = 0;
            continue;
        }

        // Decontaminate: recover the foreground colour from the mix with the key.
        const a = Math.max(alpha, 0.08);
        fr = Math.min(255, Math.max(0, (cr - (1 - a) * bg[0]) / a));
        fg = Math.min(255, Math.max(0, (cg - (1 - a) * bg[1]) / a));
        fb = Math.min(255, Math.max(0, (cb - (1 - a) * bg[2]) / a));

        // Despill whatever key tint is left.
        if (magentaKey) {
            const spill = Math.min(fr, fb) - fg;

            if (spill > 0) {
                fr -= spill;
                fb -= spill;
            }
        } else if (cyanKey) {
            const spill = Math.min(fg, fb) - fr;

            if (spill > 0) {
                fg -= spill;
                fb -= spill;
            }
        } else if (whiteKey && localLayer[i] >= 0) {
            // Brightness lift: an edge pixel shouldn't be lighter than the plant next to it.
            const cap =
                lum(local[i * 3], local[i * 3 + 1], local[i * 3 + 2]) * 1.12 +
                6;
            const l = lum(fr, fg, fb);

            if (l > cap) {
                const k = cap / l;
                fr *= k;
                fg *= k;
                fb *= k;
            }
        }

        data[o] = fr;
        data[o + 1] = fg;
        data[o + 2] = fb;
        data[o + 3] = Math.min(data[o + 3], Math.round(alpha * 255));
    }

    // Keyed pixels outside the band (can only be deep background) are fully transparent.
    for (let i = 0; i < n; i++) {
        if (isKey[i] && !band[i]) {
            data[i * 4 + 3] = 0;
        }
    }
}

/**
 * Matte choke: erodes the rim of the alpha matte by ~1 px (scaled with the image) where the
 * plant is thick enough, then tightens the soft edge, so no background-tinted halo survives.
 * Features up to ~4 px across (thin fronds, grass blades) are not eroded, only tightened.
 * Without `erodeOpaque`, fully opaque rim pixels are kept (images that came with real alpha).
 */
function chokeMatte(image: RawImage, erodeOpaque: boolean): void {
    const { width: w, height: h, data } = image;
    const n = w * h;
    const r = Math.max(1, Math.round(Math.max(w, h) / 1024));
    const cap = r + 3;
    // Chebyshev distance (in px) to the nearest background pixel, capped.
    const d = new Uint8Array(n).fill(cap);
    let front: number[] = [];

    for (let i = 0; i < n; i++) {
        if (data[i * 4 + 3] < 20) {
            d[i] = 0;
            front.push(i);
        }
    }

    for (let step = 1; step < cap && front.length; step++) {
        const next: number[] = [];

        for (const i of front) {
            const x = i % w;
            const y = (i / w) | 0;

            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = x + dx;
                    const ny = y + dy;
                    const j = ny * w + nx;

                    if (nx >= 0 && ny >= 0 && nx < w && ny < h && d[j] > step) {
                        d[j] = step;
                        next.push(j);
                    }
                }
            }
        }

        front = next;
    }

    const out = new Uint8ClampedArray(n);
    const win = r + 1;

    for (let i = 0; i < n; i++) {
        let a = data[i * 4 + 3] / 255;
        out[i] = data[i * 4 + 3];

        if (d[i] === 0 || d[i] > r + 1) {
            continue;
        }

        if (d[i] <= r && (erodeOpaque || a < 0.98)) {
            // Thickness: deepest pixel within reach. Thin features stay whole.
            const x = i % w;
            const y = (i / w) | 0;
            let depth = 0;

            for (let dy = -win; dy <= win; dy++) {
                const ny = y + dy;

                if (ny < 0 || ny >= h) {
                    continue;
                }

                for (let dx = -win; dx <= win; dx++) {
                    const nx = x + dx;

                    if (nx >= 0 && nx < w) {
                        depth = Math.max(depth, d[ny * w + nx]);
                    }
                }
            }

            if (depth >= r + 2) {
                a *= d[i] / (r + 1);
            }
        }

        if (a < 1) {
            a = smooth01(0.15, 0.85, a);
        }

        out[i] = Math.round(a * 255);
    }

    for (let i = 0; i < n; i++) {
        data[i * 4 + 3] = out[i];
    }
}

/**
 * Edge colour bleed: every pixel below ~95 % alpha takes the average colour of the solidly
 * opaque plant pixels a few px away, so light (or key-tinted) edge colour can't show through
 * bilinear filtering and mip-maps. Visible pixels further from any solid pixel (thin blades)
 * keep their own colour; fully transparent texels are then padded from everything visible.
 */
function bleedEdgeColor(image: RawImage, reach = 3): void {
    const { width: w, height: h, data } = image;
    const n = w * h;
    let maxAlpha = 0;

    for (let i = 0; i < n; i++) {
        maxAlpha = Math.max(maxAlpha, data[i * 4 + 3]);
    }

    if (maxAlpha === 0) {
        return;
    }

    const solidAlpha = Math.min(242, maxAlpha * 0.95);
    const rgb = new Float32Array(n * 3);
    const known = new Uint8Array(n);

    for (let i = 0; i < n; i++) {
        rgb[i * 3] = data[i * 4];
        rgb[i * 3 + 1] = data[i * 4 + 1];
        rgb[i * 3 + 2] = data[i * 4 + 2];
        known[i] = data[i * 4 + 3] >= solidAlpha ? 1 : 0;
    }

    // 1. Near solid pixels: replace edge colour by the solid neighbourhood's.
    const first = propagateColor(w, h, rgb, known, reach);

    // 2. Everything else: pad from all pixels that now have a trusted colour.
    for (let i = 0; i < n; i++) {
        if (first[i] >= 0) {
            known[i] = 1;
        } else if (data[i * 4 + 3] >= 128) {
            known[i] = 1;
            rgb[i * 3] = data[i * 4];
            rgb[i * 3 + 1] = data[i * 4 + 1];
            rgb[i * 3 + 2] = data[i * 4 + 2];
        } else {
            known[i] = 0;
        }
    }

    propagateColor(w, h, rgb, known, 1 << 16);

    for (let i = 0; i < n; i++) {
        if (data[i * 4 + 3] < solidAlpha) {
            data[i * 4] = rgb[i * 3];
            data[i * 4 + 1] = rgb[i * 3 + 1];
            data[i * 4 + 2] = rgb[i * 3 + 2];
        }
    }
}

function trimToAlpha(image: RawImage): RawImage | null {
    const { width: w, height: h, data } = image;
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (data[(y * w + x) * 4 + 3] > 24) {
                x0 = Math.min(x0, x);
                x1 = Math.max(x1, x);
                y0 = Math.min(y0, y);
                y1 = Math.max(y1, y);
            }
        }
    }

    if (x1 < 0) {
        return null;
    }

    // One pixel of padding so edge filtering doesn't clamp into the plant.
    x0 = Math.max(0, x0 - 1);
    y0 = Math.max(0, y0 - 1);
    x1 = Math.min(w - 1, x1 + 1);
    y1 = Math.min(h - 1, y1 + 1);
    const tw = x1 - x0 + 1;
    const th = y1 - y0 + 1;
    const out = new Uint8ClampedArray(tw * th * 4);

    for (let y = 0; y < th; y++) {
        out.set(
            data.subarray(
                ((y + y0) * w + x0) * 4,
                ((y + y0) * w + x0 + tw) * 4,
            ),
            y * tw * 4,
        );
    }

    return { data: out, width: tw, height: th };
}

/** Horizontal position (0..1) of the plant's base: opaque-pixel centroid of the bottom rows. */
function basePivot(image: RawImage): number {
    const { width: w, height: h, data } = image;
    const rows = Math.max(2, Math.round(h * 0.04));
    let sum = 0;
    let count = 0;

    for (let y = h - 1; y >= 0 && y >= h - rows * 4; y--) {
        for (let x = 0; x < w; x++) {
            if (data[(y * w + x) * 4 + 3] > 128) {
                sum += x;
                count++;
            }
        }

        if (count > 0 && y <= h - rows) {
            break;
        }
    }

    return count ? (sum / count + 0.5) / w : 0.5;
}
