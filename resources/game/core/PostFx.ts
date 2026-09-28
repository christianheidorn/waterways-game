import * as THREE from 'three/webgpu';
import { pass } from 'three/tsl';
import type { EnvironmentSettings, GraphicsSettings } from '../shared/types';
import type { GpuProfiler } from './GpuProfiler';
import type { LightSource, Look } from './look';
import { DEFAULT_LOOK, lookFromEnvironment } from './look';
import type { GameRenderer } from './renderer';

/**
 * Post-processing on three.js' node-based RenderPipeline (WebGPU / WebGL 2).
 *
 * Phase 1 of the WebGPU port: HDR scene pass + tone mapping / sRGB output. The effect chain (TAA / TAAU,
 * GTAO, SSR, light shafts, DoF, motion blur, eye adaptation, bloom, grading …) is rebuilt in TSL on top.
 */
export class PostFx {
    readonly renderSize = new THREE.Vector2(1, 1);
    private readonly pipeline: THREE.RenderPipeline;
    private readonly scenePass: ReturnType<typeof pass>;
    private graphics: GraphicsSettings | null = null;
    private look: Look = { ...DEFAULT_LOOK };
    private light: LightSource | null = null;

    constructor(
        private readonly renderer: GameRenderer,
        private readonly scene: THREE.Scene,
        private readonly camera: THREE.Camera,
    ) {
        this.scenePass = pass(scene, camera);
        this.pipeline = new THREE.RenderPipeline(renderer, this.scenePass);
    }

    /** Human readable list of the active passes (F10 menu / stats). */
    get passNames(): string[] {
        return ['Scene', 'Output'];
    }

    configure(g: GraphicsSettings): void {
        this.graphics = g;
    }

    /** Per-map artistic look (EnvironmentSettings "Camera & look"); missing fields fall back to defaults. */
    setLook(env: Partial<EnvironmentSettings>): void {
        this.look = lookFromEnvironment(env);
    }

    setLightSource(light: LightSource): void {
        this.light = light;
    }

    /** Terrain material uniforms (wetness inputs) for screen-space reflections. */
    setTerrainSurface(_surface: unknown): void {}

    /** Objects that move on their own (the player): motion vectors for TAA and motion blur. */
    setDynamicObjects(_objects: THREE.Object3D[]): void {}

    focusAtScreen(_ndcX: number, _ndcY: number): void {}

    clearFocusPoint(): void {}

    readFocusDistance(): Promise<number | null> {
        return Promise.resolve(null);
    }

    resetHistory(): void {}

    /** Scene resolution: `pixelRatio` × CSS size; the pipeline output fills the canvas. */
    setSize(width: number, height: number, pixelRatio: number): void {
        const w = Math.max(1, Math.floor(width * pixelRatio));
        const h = Math.max(1, Math.floor(height * pixelRatio));
        this.renderSize.set(w, h);
        const canvasRatio = this.renderer.getPixelRatio();
        this.scenePass.setResolutionScale(
            Math.min(1, pixelRatio / Math.max(1e-3, canvasRatio)),
        );
    }

    render(_dt: number, profiler?: GpuProfiler | null): void {
        profiler?.mark('Scene + post');
        this.pipeline.render();
    }

    dispose(): void {
        this.pipeline.dispose();
    }
}
