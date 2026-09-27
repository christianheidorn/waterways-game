import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { FoliageType } from '../shared/types';
import { createFoliageGeometry } from '../world/FoliageGeometry';

/** Output size in CSS px is ~80; render at 2× for sharp tiles on high-DPI screens. */
const SIZE = 160;
/** Dispose the offscreen renderer after this long without work (frees the WebGL context). */
const IDLE_DISPOSE_MS = 15000;

type Entry = { url: string | null; failed: boolean };

/**
 * Small rendered previews of foliage types for the editor panel: the type's procedural LOD0 (the
 * same geometry, colours and seed the world renders) or, for types with a model but no baked
 * thumbnail, the model's LOD0 — lit from a 3/4 angle on a transparent background.
 *
 * All thumbnails share one tiny offscreen WebGL renderer (created on demand, released when idle)
 * so the game's renderer and frame are never touched. Renders are queued, one per frame;
 * `onChange` fires whenever a thumbnail becomes ready.
 */
export class FoliageThumbnails {
    onChange: (() => void) | null = null;
    /** Increments whenever a thumbnail finishes; part of the panel's re-render key. */
    version = 0;

    private readonly entries = new Map<string, Entry>();
    private readonly queue: { key: string; type: FoliageType }[] = [];
    private renderer: THREE.WebGLRenderer | null = null;
    private working = false;
    private idleTimer: number | null = null;
    private disposed = false;

    /** Data URL of the type's rendered thumbnail, or null while it's queued / rendering. */
    get(type: FoliageType): string | null {
        const key = thumbnailKey(type);
        const entry = this.entries.get(key);

        if (entry) {
            return entry.url;
        }

        this.entries.set(key, { url: null, failed: false });
        this.queue.push({ key, type });
        this.pump();

        return null;
    }

    dispose(): void {
        this.disposed = true;
        this.queue.length = 0;
        this.releaseRenderer();
    }

    private pump(): void {
        if (this.working || this.disposed) {
            return;
        }

        const job = this.queue.shift();

        if (!job) {
            this.scheduleRelease();

            return;
        }

        this.working = true;
        this.cancelRelease();
        // One render per frame keeps the editor responsive while a long list fills in.
        requestAnimationFrame(() => {
            void this.render(job.type)
                .then((url) => {
                    this.entries.set(job.key, { url, failed: false });
                })
                .catch(() => {
                    this.entries.set(job.key, { url: null, failed: true });
                })
                .finally(() => {
                    this.working = false;

                    if (this.disposed) {
                        return;
                    }

                    this.version++;
                    this.onChange?.();
                    this.pump();
                });
        });
    }

    private async render(type: FoliageType): Promise<string> {
        const root = new THREE.Group();
        const disposables: { dispose(): void }[] = [];
        let rendered = false;

        if (type.model_url) {
            try {
                const gltf = await new GLTFLoader().loadAsync(type.model_url);
                const lod0 =
                    gltf.scene.getObjectByName('LOD0') ??
                    gltf.scene.children.find((c) =>
                        c.name.startsWith('LOD0'),
                    ) ??
                    gltf.scene;
                const tint = new THREE.Color(type.tint || '#ffffff');
                lod0.traverse((obj) => {
                    const mesh = obj as THREE.Mesh;

                    if (!mesh.isMesh) {
                        return;
                    }

                    disposables.push(mesh.geometry);
                    const materials = Array.isArray(mesh.material)
                        ? mesh.material
                        : [mesh.material];

                    for (const m of materials) {
                        const standard = m as THREE.MeshStandardMaterial;
                        standard.color?.multiply(tint);
                        disposables.push(m);

                        for (const value of Object.values(m)) {
                            if ((value as THREE.Texture)?.isTexture) {
                                disposables.push(value as THREE.Texture);
                            }
                        }
                    }
                });
                lod0.removeFromParent();
                root.add(lod0);
                rendered = true;
            } catch {
                // Fall back to the procedural mesh below.
            }
        }

        if (!rendered) {
            const set = createFoliageGeometry(
                type.kind,
                new THREE.Color(type.color),
                new THREE.Color(type.color_secondary),
                type.id * 7919,
            );
            const material = new THREE.MeshStandardMaterial({
                vertexColors: true,
                roughness: type.kind === 'rock' ? 0.85 : 0.75,
                metalness: 0,
                side: set.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
            });

            // Same as the world material: blade normals point up, don't flip them on back faces.
            if (set.doubleSided) {
                material.onBeforeCompile = (shader) => {
                    shader.fragmentShader = shader.fragmentShader.replace(
                        '#include <normal_fragment_begin>',
                        THREE.ShaderChunk.normal_fragment_begin.replace(
                            'normal *= faceDirection;',
                            '',
                        ),
                    );
                };
                material.customProgramCacheKey = () => 'thumb-no-face-flip';
            }

            root.add(new THREE.Mesh(set.lods[0], material));
            disposables.push(material, ...set.lods);
        }

        try {
            return this.draw(root);
        } finally {
            for (const d of disposables) {
                d.dispose();
            }
        }
    }

    private draw(root: THREE.Object3D): string {
        const renderer = this.getRenderer();
        const scene = new THREE.Scene();
        scene.add(root);
        scene.add(new THREE.HemisphereLight(0xdcebff, 0x6b5a45, Math.PI * 0.5));
        scene.add(new THREE.AmbientLight(0xffffff, Math.PI * 0.12));
        const sun = new THREE.DirectionalLight(0xfff1dc, Math.PI * 1.05);
        sun.position.set(2, 3, 2.4);
        scene.add(sun);

        const box = new THREE.Box3().setFromObject(root);

        if (box.isEmpty()) {
            throw new Error('Empty foliage mesh');
        }

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

        return renderer.domElement.toDataURL('image/png');
    }

    private getRenderer(): THREE.WebGLRenderer {
        if (!this.renderer) {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = SIZE;
            this.renderer = new THREE.WebGLRenderer({
                canvas,
                antialias: true,
                alpha: true,
                preserveDrawingBuffer: true,
                powerPreference: 'low-power',
            });
            this.renderer.setPixelRatio(1);
            this.renderer.setSize(SIZE, SIZE, false);
            this.renderer.setClearColor(0x000000, 0);
            this.renderer.outputColorSpace = THREE.SRGBColorSpace;
            this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
            this.renderer.toneMappingExposure = 1;
        }

        return this.renderer;
    }

    private scheduleRelease(): void {
        if (this.renderer && this.idleTimer === null) {
            this.idleTimer = window.setTimeout(() => {
                this.idleTimer = null;
                this.releaseRenderer();
            }, IDLE_DISPOSE_MS);
        }
    }

    private cancelRelease(): void {
        if (this.idleTimer !== null) {
            window.clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
    }

    private releaseRenderer(): void {
        this.cancelRelease();

        if (this.renderer) {
            this.renderer.dispose();
            this.renderer.forceContextLoss();
            this.renderer = null;
        }
    }
}

/** Everything the rendered image depends on. */
function thumbnailKey(type: FoliageType): string {
    return [
        type.id,
        type.kind,
        type.color,
        type.color_secondary,
        type.tint ?? '',
        type.model_url ?? '',
    ].join('|');
}
