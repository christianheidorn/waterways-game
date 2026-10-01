import * as THREE from 'three/webgpu';
import {
    unpackRGBToNormal,
    packNormalToRGB,
    Fn,
    metalness,
    mix,
    mrt,
    normalView,
    output,
    pass,
    roughness,
    rtt,
    sample,
    uniform,
    vec3,
    vec4,
    velocity,
} from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import type GTAONode from 'three/addons/tsl/display/GTAONode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import type BloomNode from 'three/addons/tsl/display/BloomNode.js';
import { denoise } from 'three/addons/tsl/display/DenoiseNode.js';
import { fsr1 } from 'three/addons/tsl/display/FSR1Node.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import type SSRNode from 'three/addons/tsl/display/SSRNode.js';
import { taau } from 'three/addons/tsl/display/TAAUNode.js';
import { antiAliasingMode } from '../shared/graphicsPresets';
import type { EnvironmentSettings, GraphicsSettings } from '../shared/types';
import type { GpuProfiler } from './GpuProfiler';
import type { LightSource, Look } from './look';
import { DEFAULT_LOOK, lookFromEnvironment } from './look';
import { AutoExposure } from './postfx/AutoExposure';
import { colorGradeLut, whiteBalanceGains } from './postfx/ColorLut';
import type {
    FloatNode,
    TextureNode,
    Vec3Node,
    Vec4Node,
} from './postfx/common';
import { FrameContext, luma, solidTexture } from './postfx/common';
import { Composite } from './postfx/Composite';
import { ContactShadows } from './postfx/ContactShadows';
import { DepthOfField } from './postfx/DepthOfField';
import { GodRays } from './postfx/GodRays';
import { LensFlare } from './postfx/LensFlare';
import { MotionBlur } from './postfx/MotionBlur';
import type { OutputFeatures } from './postfx/Output';
import { OutputStage } from './postfx/Output';
import { TemporalAA } from './postfx/Taa';
import { Underwater } from './postfx/Underwater';
import type { UnderwaterState } from './postfx/Underwater';
import type { GameRenderer } from './renderer';

/**
 * A value for the scene pass' data attachments (velocity, normal, metal / roughness), zeroed (colour and
 * alpha) for transparent materials that don't write depth: precipitation, lightning, lens flares, editor
 * overlays. The attachments blend with the material's blending (see build), so such effects leave the
 * values of the surface behind them (the one in the depth buffer) instead of replacing its normal and
 * motion with their own. Depth-writing transparents (water) own their pixels like opaque surfaces.
 */
const surfaceData = Fn(
    ([value]: [THREE.Node<'vec3'>], builder: THREE.NodeBuilder) => {
        const material = builder.material;
        const owns = material?.transparent && !material.depthWrite ? 0 : 1;

        return vec4(value.mul(owns), owns);
    },
) as unknown as (value: THREE.Node<'vec3'>) => THREE.Node<'vec4'>;

/** GTAO parameters per ao_quality: resolution scale, AO samples, world radius. */
const AO_QUALITY = {
    low: { scale: 0.5, samples: 8, radius: 2 },
    medium: { scale: 0.75, samples: 12, radius: 2.5 },
    high: { scale: 1, samples: 16, radius: 3 },
} as const;

/** SSR resolution scale and ray march quality (0-1: steps per screen pixel of the ray). */
const SSR_QUALITY = {
    low: { scale: 0.5, quality: 0.35 },
    high: { scale: 1, quality: 0.6 },
} as const;

/** Camera jumps beyond these per frame are cuts: temporal history is reset. */
const CUT_DISTANCE = 25;
const CUT_ANGLE = THREE.MathUtils.degToRad(45);

/** Which effect passes exist (a change rebuilds the effect graph). */
type Structure = {
    aa: GraphicsSettings['anti_aliasing'];
    /** The scene renders below the output resolution (render scale / dynamic resolution). */
    upscale: boolean;
    ao: boolean;
    bloom: boolean;
    autoExposure: boolean;
    godRays: GraphicsSettings['god_rays'];
    contact: boolean;
    ssr: GraphicsSettings['ssr'];
    dof: GraphicsSettings['depth_of_field'];
    motionBlur: GraphicsSettings['motion_blur'];
    flare: boolean;
    /** The view under water (graphics underwater_effects). */
    underwater: 'off' | 'low' | 'high';
};

type Disposable = { dispose(): void };

type OutputKey = OutputFeatures & {
    toneMapping: THREE.ToneMapping;
    srgb: boolean;
};

/** TRAA / TAAU keep their history in a private target; resizing it makes the next frame reseed it. */
type TemporalNode = THREE.TempNode<'vec4'> & {
    getTextureNode(): TextureNode;
    _historyRenderTarget: THREE.RenderTarget;
};

type Effects = {
    frame: FrameContext;
    ao: GTAONode | null;
    aoScale: number;
    contact: ContactShadows | null;
    ssr: SSRNode | null;
    ssrScale: number;
    godRays: GodRays | null;
    composite: Composite | null;
    underwater: Underwater | null;
    /** Input of the underwater pass (what consumers read while it is bypassed). */
    underwaterInput: TextureNode | null;
    /** Temporal AA at the scene resolution (TAAU when upscaling is `temporal`). */
    taa: TemporalAA | null;
    temporal: TemporalNode | null;
    dof: DepthOfField | null;
    motionBlur: MotionBlur | null;
    /** Input of the motion blur (what consumers read while it is bypassed). */
    motionInput: TextureNode | null;
    exposure: AutoExposure | null;
    bloom: BloomNode | null;
    flare: LensFlare | null;
    /** Final HDR image. */
    hdr: TextureNode;
    sceneColor: TextureNode;
    /** Nodes to dispose with this graph. */
    owned: Disposable[];
};

/**
 * Post-processing on three.js' node-based RenderPipeline (WebGPU / WebGL 2). Stages exist only when
 * enabled; disabled stages cost nothing:
 *
 *  1. Scene        HDR (half float) colour + depth, with MRT attachments only where effects need them:
 *                  motion vectors (TAA / motion blur; skinned and instanced motion included), view
 *                  normals (GTAO, SSR), metalness / roughness (SSR). MSAA renders a 4× target.
 *  2. GTAO         ambient occlusion at a fraction of the scene resolution.
 *     Contact      screen-space contact shadows (½ res), SSR (½ or full res), light shafts (¼ / ½ res).
 *  3. Composite    HDR lighting composite: × AO × contact shadows, + reflections, + light shafts.
 *  4. TAA / TAAU   temporal AA (postfx/Taa.ts); below 1× render scale (render_scale × dynamic resolution)
 *                  the scene renders at the lower resolution and TAAU reconstructs the output resolution
 *                  (like UE's TSR).
 *                  Everything after this runs at the output resolution.
 *  5. DoF          physically based CoC, auto-focus, half resolution bokeh gather, full-res composite.
 *  6. Motion blur  motion vectors, shutter-based length (skipped for stills and on camera cuts).
 *  7. Exposure     eye adaptation metered on the final HDR image (GPU histogram: compute on WebGPU).
 *  8. Bloom        mip chain; threshold in display terms after exposure (bloom_threshold / exposure).
 *     Lens flare   sprites into a ½ res HDR target, occluded by depth and cloud brightness.
 *  9. Output       CA → + bloom + flare → × exposure × white balance → tone map → sRGB → sharpen →
 *                  3D LUT grade → saturation / contrast / vignette, then FXAA / SMAA (without TAA),
 *                  FSR 1 upscaling (below 1× without TAA), grain, dither and letterbox.
 *
 * The effect graph is rebuilt only when the set of stages changes, the output graph only when its
 * features change; everything else is uniforms.
 */
export class PostFx {
    /** Scene (internal) render resolution in pixels. */
    readonly renderSize = new THREE.Vector2(1, 1);
    /** Output (canvas drawing buffer) resolution in pixels. */
    readonly outputSize = new THREE.Vector2(1, 1);
    private readonly pipeline: THREE.RenderPipeline;
    private scenePass: THREE.PassNode;
    private readonly output = new OutputStage();
    private readonly black = solidTexture(0, 0, 0);
    private readonly white = solidTexture(1, 1, 1);
    private readonly bloomThreshold = uniform(DEFAULT_LOOK.bloomThreshold);
    private readonly bloomStrength = uniform(0.12);
    private readonly fsrSharpness = uniform(0.2);
    private effects: Effects | null = null;
    private structure: Structure | null = null;
    private structureKey = '';
    private outputKey = '';
    private outputOwned: Disposable[] = [];
    private names: string[] = [];
    private graphics: GraphicsSettings | null = null;
    private look: Look = { ...DEFAULT_LOOK };
    private light: LightSource | null = null;
    private focusPoint: THREE.Vector2 | null = null;
    /** The camera under (or at) the water surface this frame; null above water. */
    private underwaterState: UnderwaterState | null = null;
    /** An unlit editor view mode is shown (see setUnlitView). */
    private unlitView = false;
    private readonly savedWhiteBalance = new THREE.Vector3();
    /** Scene resolution relative to the output resolution. */
    private inputScale = 1;
    private readonly bufferSize = new THREE.Vector2();
    private aspect = 1;
    private frame = 0;
    // Matrices (un-jittered); no per-frame allocations.
    private readonly viewProj = new THREE.Matrix4();
    private readonly viewProjInverse = new THREE.Matrix4();
    private readonly prevViewProj = new THREE.Matrix4();
    private readonly prevPosition = new THREE.Vector3();
    private readonly prevForward = new THREE.Vector3();
    private readonly forward = new THREE.Vector3();
    private readonly lightDir = new THREE.Vector3();
    private readonly flareTmp = new THREE.Vector4();
    private hasHistory = false;

    constructor(
        private readonly renderer: GameRenderer,
        private readonly scene: THREE.Scene,
        private readonly camera: THREE.PerspectiveCamera,
    ) {
        this.scenePass = pass(scene, camera);
        this.scenePass.name = 'Scene';
        this.pipeline = new THREE.RenderPipeline(renderer);
        // Tone mapping and sRGB are part of the output graph (exposure, grading and AA come after them).
        this.pipeline.outputColorTransform = false;
    }

    /**
     * Depth of the scene pass (render resolution) as last rendered: read before this frame's
     * `render()` it holds the previous frame's depth (GPU occlusion culling builds its Hi-Z from it).
     */
    get depthTexture(): THREE.Texture {
        return this.scenePass.getTexture('depth');
    }

    /**
     * The scene pass renders multisampled: its colour is resolved and not kept, so nothing can be drawn
     * on top of it afterwards (two-phase occlusion culling skips its second phase).
     */
    get multisampled(): boolean {
        return this.structure?.aa === 'msaa';
    }

    /** Human readable list of the active passes (F10 menu / stats). */
    get passNames(): string[] {
        return this.names;
    }

    // ---------------------------------------------------------------- configuration

    configure(g: GraphicsSettings): void {
        this.graphics = g;
        this.rebuildIfNeeded();
    }

    /** Per-map artistic look (EnvironmentSettings "Camera & look"); missing fields fall back to defaults. */
    setLook(env: Partial<EnvironmentSettings>): void {
        this.look = lookFromEnvironment(env);
        this.rebuildIfNeeded();
    }

    setLightSource(light: LightSource): void {
        this.light = light;
    }

    /**
     * Focuses depth of field on the surface under a screen point (NDC, -1..1, +y up) — kept until
     * `clearFocusPoint`; the distance follows that point (auto-focus there) with a smooth focus pull.
     */
    focusAtScreen(ndcX: number, ndcY: number): void {
        this.focusPoint = new THREE.Vector2(
            THREE.MathUtils.clamp(ndcX * 0.5 + 0.5, 0, 1),
            THREE.MathUtils.clamp(0.5 - ndcY * 0.5, 0, 1),
        );
        this.effects?.dof?.focusUv.value.copy(this.focusPoint);
    }

    /** Back to the look's focus (manual distance, or auto-focus on the screen centre). */
    clearFocusPoint(): void {
        this.focusPoint = null;
        this.effects?.dof?.focusUv.value.set(0.5, 0.5);
    }

    /** Current focus distance in metres (async GPU read-back, no stall); null when DoF is off. */
    readFocusDistance(): Promise<number | null> {
        const dof = this.effects?.dof;

        return dof
            ? dof.readFocusDistance(this.renderer)
            : Promise.resolve(null);
    }

    /**
     * The water at the camera (null: above water, the underwater pass is skipped). Game sets it every
     * frame from Water.underwaterLook.
     */
    setUnderwater(state: UnderwaterState | null): void {
        this.underwaterState = state;
    }

    /** Whether the underwater view is drawn by the post pass (graphics underwater_effects not off). */
    get underwaterPass(): boolean {
        return !!this.effects?.underwater;
    }

    /**
     * The editor shows an unlit view mode (flat visualisation colours): the output keeps them readable
     * by bypassing exposure (base and eye adaptation), white balance, grading, bloom, lens effects and
     * the screen-space lighting composite. Uniforms only, so switching never rebuilds a shader.
     */
    setUnlitView(enabled: boolean): void {
        if (enabled !== this.unlitView) {
            this.unlitView = enabled;
            this.effects?.exposure?.reset();
        }
    }

    /** Drop temporal history (TAA, eye adaptation, focus) after a camera cut. */
    resetHistory(): void {
        this.hasHistory = false;
        this.resetTemporal();
        this.effects?.exposure?.reset();
        this.effects?.dof?.resetFocus();
    }

    /**
     * `pixelRatio` is the scene's pixel ratio; the output fills the canvas (renderer pixel ratio). Below
     * the canvas resolution the scene pass renders scaled down and TAAU / FSR 1 upscale it.
     */
    setSize(width: number, height: number, pixelRatio: number): void {
        const canvasRatio = this.renderer.getPixelRatio();
        this.renderSize.set(
            Math.max(1, Math.floor(width * pixelRatio)),
            Math.max(1, Math.floor(height * pixelRatio)),
        );
        this.outputSize.set(
            Math.max(1, Math.floor(width * canvasRatio)),
            Math.max(1, Math.floor(height * canvasRatio)),
        );
        this.aspect = width / Math.max(1, height);
        this.inputScale = Math.min(1, pixelRatio / Math.max(1e-3, canvasRatio));
        this.scenePass.setResolutionScale(this.inputScale);

        if (!this.rebuildIfNeeded()) {
            this.applyScales();
        }
    }

    dispose(): void {
        this.disposeEffects();
        this.pipeline.dispose();
        this.scenePass.dispose();
        this.black.dispose();
        this.white.dispose();
    }

    // ---------------------------------------------------------------- frame

    /**
     * Starts a new node frame for a still rendered outside the animation loop (captures): passes render
     * once per frame, so without this a second render in the same frame would reuse their results.
     */
    beginStill(): void {
        const renderer = this.renderer as unknown as {
            _nodes: { nodeFrame: { update(): void; frameId: number } };
            info: { frame: number };
        };
        renderer._nodes.nodeFrame.update();
        renderer.info.frame = renderer._nodes.nodeFrame.frameId;
    }

    render(dt: number, profiler?: GpuProfiler | null): void {
        const e = this.effects;
        const g = this.graphics;

        if (!e || !g) {
            return;
        }

        const camera = this.camera;
        const look = this.look;
        this.frame++;
        e.frame.frame.value = this.frame;
        this.output.frame.value = this.frame;

        // ---- camera matrices (un-jittered: TAA applies its view offset inside the pipeline), cuts
        camera.updateMatrixWorld();
        this.viewProj.multiplyMatrices(
            camera.projectionMatrix,
            camera.matrixWorldInverse,
        );
        camera.getWorldDirection(this.forward);
        const cut =
            !this.hasHistory ||
            camera.position.distanceTo(this.prevPosition) > CUT_DISTANCE ||
            this.forward.angleTo(this.prevForward) > CUT_ANGLE;

        if (cut && this.hasHistory) {
            this.resetTemporal();
        }

        const baseExposure =
            Math.max(1e-4, this.renderer.toneMappingExposure) *
            Math.pow(2, look.exposureCompensation);
        const light = this.light;
        const night = !!light && light.sunDirection.y < -0.05;

        if (light) {
            this.lightDir.copy(
                night ? light.moonDirection : light.sunDirection,
            );
        }

        // ---- contact shadows
        if (e.contact && e.composite) {
            let strength = 0;

            if (light && light.sun.intensity > 0.01) {
                const i = light.sun.intensity;
                strength = 0.6 * (i / (i + 0.6)) * (1 - light.darkness * 0.8);
                e.contact.setLight(this.lightDir, camera);
            }

            e.composite.contactStrength.value = strength;
            e.contact.pass.setBypass(strength > 0 ? null : this.white);
        }

        // ---- light shafts
        if (e.godRays && e.composite) {
            let k = 0;

            if (light) {
                const vis = e.godRays.locate(
                    this.lightDir,
                    camera,
                    this.viewProj,
                    baseExposure,
                );
                // Shafts fade out as the light source sets (none from below the horizon).
                const horizon = THREE.MathUtils.smoothstep(
                    this.lightDir.y,
                    -0.03,
                    0.03,
                );
                k =
                    vis *
                    horizon *
                    ((0.6 * (night ? 0.35 : 1) * (1 - light.darkness * 0.6)) /
                        baseExposure);
                // Sky around the light, stronger in haze; and the sunlit fog (see GodRays), which
                // grows with the fog density (weather included) and valley fog around the camera.
                const fog = light.fog.density;
                const valley = light.valleyFogAt?.(camera.position) ?? 0;
                e.godRays.skyWeight.value =
                    look.godRayIntensity *
                    (1 + Math.min(0.75, look.fogDensity / 0.001));
                const fogginess = Math.min(1.5, fog / 0.0005 + valley / 0.01);
                e.godRays.fogWeight.value =
                    0.7 *
                    look.fogShaftIntensity *
                    THREE.MathUtils.smoothstep(fogginess, 0.05, 1) *
                    Math.max(0.35, Math.min(1.2, fogginess));
                e.godRays.fogMedium.value = Math.min(
                    0.04,
                    Math.max(0.003, fog * 30 + valley * 0.5),
                );
                const c = light.sun.color;
                e.composite.rayColor.value.set(
                    (0.4 + 0.6 * c.r) * k,
                    (0.4 + 0.6 * c.g) * k,
                    (0.4 + 0.6 * c.b) * k,
                );
            }

            e.godRays.setActive(k > 1e-5, this.black);
        }

        // ---- depth of field
        if (e.dof) {
            e.dof.update(camera, {
                focusDistance: this.focusPoint ? 0 : look.dofFocusDistance,
                aperture: look.dofAperture,
                maxBlur: look.dofMaxBlur,
                height: this.outputSize.y,
                dt,
            });
        }

        // ---- under water (skipped above the surface)
        if (e.underwater && e.underwaterInput) {
            const input = e.underwaterInput;
            const state = this.underwaterState;
            e.underwater.pass.setBypass(
                state ? null : input.value,
                state
                    ? null
                    : (input as unknown as { passNode: THREE.Node }).passNode,
            );

            if (state) {
                e.underwater.set(state);
            }
        }

        // ---- motion blur (skipped on camera cuts and for stills rendered with dt 0)
        if (e.motionBlur && e.motionInput) {
            const input = e.motionInput;
            const active = !cut && dt > 0;
            e.motionBlur.pass.setBypass(
                active ? null : input.value,
                active
                    ? null
                    : (input as unknown as { passNode: THREE.Node }).passNode,
            );

            if (active) {
                this.viewProjInverse.copy(this.viewProj).invert();
                e.motionBlur.reprojection.value.multiplyMatrices(
                    this.prevViewProj,
                    this.viewProjInverse,
                );
                e.motionBlur.update(
                    look.motionBlurStrength,
                    dt,
                    this.outputSize.y,
                );
            }
        }

        // ---- eye adaptation, bloom, lens flare
        const unlit = this.unlitView;
        e.exposure?.update(
            dt,
            unlit ? 1 : baseExposure,
            unlit ? 0 : look.autoExposureMinEv,
            unlit ? 0 : look.autoExposureMaxEv,
            look.autoExposureSpeed,
        );
        this.bloomThreshold.value = look.bloomThreshold / baseExposure;

        if (e.flare) {
            let brightness = 0;

            if (light && !night && !unlit && this.locateFlare(e.flare)) {
                const sunUp = THREE.MathUtils.smoothstep(
                    light.sunDirection.y,
                    -0.02,
                    0.08,
                );
                brightness =
                    look.lensFlareIntensity *
                    Math.min(1, light.sun.intensity / 2.5) *
                    sunUp;
            }

            e.flare.setParams(
                brightness,
                baseExposure,
                this.aspect,
                this.black,
            );
        }

        // ---- output
        this.output.exposure.value = unlit ? 1 : baseExposure;
        this.updateOutputKey();
        profiler?.mark('Post-processing');

        if (e.composite) {
            e.composite.enabled.value = unlit ? 0 : 1;
        }

        if (e.taa) {
            this.renderer.getDrawingBufferSize(this.bufferSize);
            e.taa.begin(
                Math.max(1, Math.floor(this.bufferSize.x * this.inputScale)),
                Math.max(1, Math.floor(this.bufferSize.y * this.inputScale)),
            );
        }

        if (unlit) {
            this.renderNeutral();
        } else {
            this.pipeline.render();
        }

        e.taa?.end();

        // ---- history
        this.prevViewProj.copy(this.viewProj);
        this.prevPosition.copy(camera.position);
        this.prevForward.copy(this.forward);
        this.hasHistory = true;
    }

    // ---------------------------------------------------------------- internals

    /**
     * Renders the frame with the look's display adjustments neutral (unlit view modes). The values are
     * swapped for this render only: the output graph's feature key keeps seeing the real ones.
     */
    private renderNeutral(): void {
        const o = this.output;
        const scalars = [
            o.lutIntensity,
            o.saturation,
            o.contrast,
            o.vignette,
            o.grain,
            o.aberration,
            this.bloomStrength,
        ];
        const neutral = [0, 1, 1, 0, 0, 0, 0];
        const saved = scalars.map((u) => u.value);
        this.savedWhiteBalance.copy(o.whiteBalance.value);
        scalars.forEach((u, i) => (u.value = neutral[i]));
        o.whiteBalance.value.set(1, 1, 1);
        this.pipeline.render();
        scalars.forEach((u, i) => (u.value = saved[i]));
        o.whiteBalance.value.copy(this.savedWhiteBalance);
    }

    /** Projects the sun to the screen for the flare; false when it is behind or far off-screen. */
    private locateFlare(flare: LensFlare): boolean {
        const p = this.flareTmp.set(
            this.lightDir.x,
            this.lightDir.y,
            this.lightDir.z,
            0,
        );
        p.applyMatrix4(this.viewProj);

        if (p.w <= 1e-4) {
            return false;
        }

        const u = (p.x / p.w) * 0.5 + 0.5;
        const v = 0.5 - (p.y / p.w) * 0.5;
        flare.lightUv.value.set(u, v);

        return u > -0.2 && u < 1.2 && v > -0.2 && v < 1.2;
    }

    private resetTemporal(): void {
        const temporal = this.effects?.temporal;

        if (temporal) {
            temporal._historyRenderTarget.setSize(1, 1);
        }

        this.effects?.taa?.resetHistory();
    }

    /** Returns true when the graph was rebuilt. */
    private rebuildIfNeeded(): boolean {
        const g = this.graphics;

        if (!g) {
            return false;
        }

        const look = this.look;
        const s: Structure = {
            aa: antiAliasingMode(g),
            // At full scale TRAA resolves sharper than TAAU (which only pays off when upscaling).
            upscale: this.inputScale < 0.999,
            ao: !!g.ambient_occlusion,
            bloom: !!g.bloom && (g.bloom_intensity ?? 0.12) > 0.001,
            autoExposure: !!g.auto_exposure,
            godRays:
                (g.god_rays ?? 'off') !== 'off' &&
                (look.godRayIntensity > 0.001 || look.fogShaftIntensity > 0.001)
                    ? g.god_rays
                    : 'off',
            contact: !!g.contact_shadows,
            ssr: g.ssr ?? 'off',
            dof:
                (g.depth_of_field ?? 'off') !== 'off' && look.dofMaxBlur > 0.1
                    ? g.depth_of_field
                    : 'off',
            motionBlur:
                (g.motion_blur ?? 'off') !== 'off' &&
                look.motionBlurStrength > 0.001
                    ? g.motion_blur
                    : 'off',
            flare: !!g.lens_effects && look.lensFlareIntensity > 0.001,
            underwater: g.underwater_effects ?? 'high',
        };
        const key = JSON.stringify(s);
        let rebuilt = false;

        if (key !== this.structureKey) {
            this.structureKey = key;
            this.build(s);
            rebuilt = true;
        }

        this.updateUniforms();
        this.updateOutputKey(rebuilt);

        return rebuilt;
    }

    private build(s: Structure): void {
        this.disposeEffects();
        this.structure = s;
        const camera = this.camera;
        const taa = s.aa === 'taa';
        const samples = s.aa === 'msaa' ? 4 : 0;
        // A new scene pass per structure: its render target's attachments follow the MRT layout.
        this.scenePass.dispose();
        const sp = (this.scenePass = pass(this.scene, camera, { samples }));
        sp.name = 'Scene';
        sp.setResolutionScale(this.inputScale);

        // ---- scene pass attachments
        const needsVelocity = taa || s.motionBlur !== 'off';
        const needsNormal = s.ao || s.ssr !== 'off';
        const outputs: Record<string, THREE.Node> = { output };

        if (needsVelocity) {
            outputs.velocity = surfaceData(
                vec3(velocity as unknown as THREE.Node<'vec2'>, 0),
            );
        }

        if (needsNormal) {
            outputs.normal = surfaceData(packNormalToRGB(normalView));
        }

        if (s.ssr !== 'off') {
            outputs.metalrough = surfaceData(vec3(metalness, roughness, 0));
        }

        if (Object.keys(outputs).length > 1) {
            const attachments = mrt(outputs);

            // The data attachments blend like the colour (see surfaceData): opaque draws overwrite them,
            // effects drawn over the scene leave the surface's values underneath.
            for (const name of Object.keys(outputs)) {
                if (name !== 'output') {
                    attachments.setBlendMode(
                        name,
                        new THREE.BlendMode(THREE.MaterialBlending),
                    );
                }
            }

            sp.setMRT(attachments);
        } else {
            sp.setMRT(null);
        }

        if (needsNormal) {
            sp.getTexture('normal').type = THREE.UnsignedByteType;
        }

        if (s.ssr !== 'off') {
            sp.getTexture('metalrough').type = THREE.UnsignedByteType;
        }

        const sceneColor = sp.getTextureNode('output') as TextureNode;
        const depth = sp.getTextureNode('depth') as TextureNode;
        const velocityTex = needsVelocity
            ? (sp.getTextureNode('velocity') as TextureNode)
            : null;
        const normalTex = needsNormal
            ? (sp.getTextureNode('normal') as TextureNode)
            : null;
        const normal = normalTex
            ? (sample((uv: THREE.Node) =>
                  unpackRGBToNormal(normalTex.sample(uv)),
              ) as unknown as TextureNode)
            : null;
        const frame = new FrameContext(camera, depth);
        const owned: Disposable[] = [];
        const names = [samples ? 'Scene (MSAA 4×)' : 'Scene'];

        // ---- screen-space lighting at the scene resolution
        let aoNode: GTAONode | null = null;
        let aoTex: TextureNode | null = null;
        let aoScale = 1;

        if (s.ao) {
            const q =
                AO_QUALITY[this.graphics?.ao_quality ?? 'medium'] ??
                AO_QUALITY.medium;
            aoNode = ao(depth, normal!, camera);
            aoNode.useTemporalFiltering = taa;
            aoScale = q.scale;
            owned.push(aoNode);
            aoTex = aoNode.getTextureNode() as TextureNode;

            if (!taa) {
                // Without temporal accumulation the per-pixel rotation noise needs a spatial denoise.
                const denoised = rtt(denoise(aoTex, depth, normal!, camera));
                denoised.name = 'GTAO';
                owned.push(denoised);
                aoTex = denoised as unknown as TextureNode;
            }

            names.push('GTAO');
        }

        let contact: ContactShadows | null = null;

        if (s.contact) {
            contact = new ContactShadows(frame);
            owned.push(contact.pass);
            names.push('Contact shadows');
        }

        let ssrNode: SSRNode | null = null;
        let gloss: FloatNode | null = null;
        let ssrScale = 1;

        if (s.ssr !== 'off') {
            const q = SSR_QUALITY[s.ssr];
            const mr = sp.getTextureNode('metalrough') as TextureNode;
            // Wet / polished surfaces reflect: gloss from the material's roughness (terrain wetness drives
            // it), metals always.
            gloss = mr.r.max(mr.g.smoothstep(0.45, 0.08)) as FloatNode;
            ssrNode = ssr(sceneColor, depth, normal as never, {
                metalnessNode: gloss,
                roughnessNode: mr.g,
                camera,
            }) as unknown as SSRNode;
            ssrNode.quality.value = q.quality;
            ssrNode.maxDistance.value = 120;
            ssrNode.thickness.value = 0.5;
            ssrScale = q.scale;
            owned.push(ssrNode);
            names.push(`SSR ${s.ssr}`);
        }

        let godRays: GodRays | null = null;

        if (s.godRays !== 'off') {
            const light = this.light;
            godRays = new GodRays(
                s.godRays,
                frame,
                sceneColor,
                light?.cloudLight ? (p) => light.cloudLight!(p) : null,
            );
            owned.push(...godRays.passes);
            names.push(`Light shafts ${s.godRays}`);
        }

        let composite: Composite | null = null;

        if (aoTex || contact || ssrNode || godRays) {
            composite = new Composite(frame, {
                color: sceneColor,
                ao: aoTex,
                contact: contact
                    ? {
                          texture: contact.pass.getTextureNode(),
                          size: contact.pass.resolution,
                      }
                    : null,
                ssr:
                    ssrNode && gloss && normal
                        ? {
                              reflection: (
                                  ssrNode as unknown as {
                                      getTextureNode(): Vec4Node;
                                  }
                              ).getTextureNode(),
                              gloss,
                              normal: normal as unknown as Vec3Node,
                          }
                        : null,
                rays: godRays ? godRays.output.getTextureNode() : null,
            });
            owned.push(composite.pass);
            names.push('Composite');
        }

        let hdr: TextureNode = composite
            ? composite.pass.getTextureNode()
            : sceneColor;

        // ---- under water (before TAA: its noise-jittered shafts resolve there)
        let underwater: Underwater | null = null;
        let underwaterInput: TextureNode | null = null;

        if (s.underwater !== 'off') {
            underwaterInput = hdr;
            underwater = new Underwater(s.underwater, frame, hdr);
            owned.push(underwater.pass);
            hdr = underwater.pass.getTextureNode();
            names.push(`Underwater ${s.underwater}`);
        }

        // ---- anti-aliasing / temporal upscaling
        let temporal: TemporalNode | null = null;
        let taaPass: TemporalAA | null = null;

        if (taa && s.upscale) {
            temporal = taau(
                hdr,
                depth,
                velocityTex!,
                camera,
            ) as unknown as TemporalNode;
            owned.push(temporal);
            hdr = temporal.getTextureNode();
            names.push('TAAU');
        } else if (taa) {
            taaPass = new TemporalAA(
                hdr,
                depth,
                velocityTex!,
                this.output.exposure,
                camera,
            );
            owned.push(taaPass.pass);
            hdr = taaPass.pass.getTextureNode();
            names.push('TAA');
        }

        // ---- post effects (output resolution; the scene resolution for spatial upscaling)
        let dof: DepthOfField | null = null;

        if (s.dof !== 'off') {
            dof = new DepthOfField(s.dof, frame, hdr);

            if (this.focusPoint) {
                dof.focusUv.value.copy(this.focusPoint);
            }

            owned.push(...dof.passes);
            hdr = dof.output.getTextureNode();
            names.push(`DoF ${s.dof}`);
        }

        let motionBlur: MotionBlur | null = null;
        let motionInput: TextureNode | null = null;

        if (s.motionBlur !== 'off') {
            motionInput = hdr;
            motionBlur = new MotionBlur(s.motionBlur, frame, hdr, velocityTex!);
            owned.push(motionBlur.pass);
            hdr = motionBlur.pass.getTextureNode();
            names.push(`Motion blur ${s.motionBlur}`);
        }

        let exposure: AutoExposure | null = null;

        if (s.autoExposure) {
            exposure = new AutoExposure(hdr);
            names.push('Eye adaptation');
        }

        let bloomNode: BloomNode | null = null;

        if (s.bloom) {
            const eye = exposure?.multiplier ?? null;
            bloomNode = bloom(hdr, this.bloomStrength, 0.35) as BloomNode;
            // Threshold in display terms after eye adaptation, with a soft knee: a hard threshold makes
            // large sky regions pop in and out as the exposure changes.
            bloomNode.highPassFn = ({ input }) =>
                Fn(() => {
                    // NaN / Inf would be spread over the screen by the blur chain.
                    const c = input.rgb.clamp(0, 6e4);
                    const v = eye ? luma(c).mul(eye) : luma(c);
                    const t = this.bloomThreshold;
                    const alpha = v.smoothstep(t, t.mul(1.6));

                    return mix(vec4(0), vec4(c, 1), alpha);
                })() as never;
            owned.push(bloomNode);
            names.push('Bloom');
        }

        let flare: LensFlare | null = null;

        if (s.flare) {
            flare = new LensFlare(frame, sceneColor);
            owned.push(flare);
            names.push('Lens flare');
        }

        this.effects = {
            frame,
            ao: aoNode,
            aoScale,
            contact,
            ssr: ssrNode,
            ssrScale,
            godRays,
            composite,
            underwater,
            underwaterInput,
            taa: taaPass,
            temporal,
            dof,
            motionBlur,
            motionInput,
            exposure,
            bloom: bloomNode,
            flare,
            hdr,
            sceneColor,
            owned,
        };
        this.names = names;
        this.hasHistory = false;
        this.outputKey = '';
        this.applyScales();
    }

    /** Resolution of every pass relative to the drawing buffer (scene scale × the pass' own factor). */
    private applyScales(): void {
        const e = this.effects;
        const s = this.structure;

        if (!e || !s) {
            return;
        }

        const low = this.inputScale;
        // Spatial upscaling runs last: everything before it stays at the scene resolution.
        const post = s.aa === 'taa' ? 1 : low;

        if (e.ao) {
            e.ao.resolutionScale = e.aoScale * low;
        }

        if (e.contact) {
            e.contact.pass.scale = 0.5 * low;
        }

        if (e.ssr) {
            e.ssr.resolutionScale = e.ssrScale * low;
        }

        e.godRays?.setSceneScale(low);

        if (e.composite) {
            e.composite.pass.scale = low;
        }

        if (e.underwater) {
            e.underwater.pass.scale = low;
        }

        if (e.taa) {
            e.taa.pass.scale = low;
        }

        e.dof?.setScale(post);

        if (e.motionBlur) {
            e.motionBlur.pass.scale = post;
        }

        e.bloom?.setResolutionScale(0.5 * post);

        if (e.flare) {
            e.flare.scale = post;
        }

        for (const node of this.outputOwned) {
            (
                node as unknown as { setResolutionScale?(s: number): void }
            ).setResolutionScale?.(post);
        }
    }

    private updateUniforms(): void {
        const g = this.graphics;
        const e = this.effects;

        if (!g || !e) {
            return;
        }

        const look = this.look;

        if (e.ao) {
            const q = AO_QUALITY[g.ao_quality ?? 'medium'] ?? AO_QUALITY.medium;
            e.aoScale = q.scale;
            e.ao.radius.value = q.radius;
            e.ao.samples.value = q.samples;
            e.ao.distanceExponent.value = 1.5;
            e.ao.thickness.value = 2;
            e.ao.scale.value = 1;
        }

        this.bloomStrength.value = g.bloom_intensity ?? 0.12;
        this.fsrSharpness.value = THREE.MathUtils.clamp(g.sharpen ?? 0, 0, 1);

        const o = this.output;
        const lens = !!g.lens_effects;
        o.lut.value = colorGradeLut(look.colorGrade);
        o.lutIntensity.value = THREE.MathUtils.clamp(
            look.colorGradeIntensity,
            0,
            1,
        );
        whiteBalanceGains(look.whiteBalance, o.whiteBalance.value);
        o.saturation.value = g.saturation ?? 1;
        o.contrast.value = g.contrast ?? 1;
        o.vignette.value = g.vignette ?? 0;
        // TAA's resolve is slightly soft: a touch of adaptive sharpening restores it.
        o.sharpen.value = Math.max(
            g.sharpen ?? 0,
            antiAliasingMode(g) === 'taa' ? 0.25 : 0,
        );
        o.aberration.value = lens ? look.chromaticAberration : 0;
        o.grain.value = lens ? look.filmGrain : 0;
        this.applyScales();
    }

    /** Rebuilds the output graph when its features change (e.g. grain switched on). */
    private updateOutputKey(force = false): void {
        const g = this.graphics;
        const s = this.structure;
        const e = this.effects;

        if (!g || !s || !e) {
            return;
        }

        const o = this.output;
        const look = this.look;
        const spatialUpscale = s.upscale && s.aa !== 'taa';
        const key: OutputKey = {
            aberration: o.aberration.value > 0.001,
            sharpen: !spatialUpscale && o.sharpen.value > 0.001,
            lut:
                !!g.color_grading_lut &&
                look.colorGrade !== 'neutral' &&
                o.lutIntensity.value > 0.001,
            grade:
                Math.abs(o.saturation.value - 1) > 0.001 ||
                Math.abs(o.contrast.value - 1) > 0.001 ||
                o.vignette.value > 0.001,
            grain: o.grain.value > 0.001,
            letterbox: o.setLetterbox(look.letterbox, this.aspect),
            toneMapping: this.renderer.toneMapping,
            srgb:
                THREE.ColorManagement.getTransfer(
                    this.renderer.outputColorSpace,
                ) === THREE.SRGBTransfer,
        };
        const text = JSON.stringify(key);

        if (!force && text === this.outputKey) {
            return;
        }

        this.outputKey = text;
        this.buildOutput(s, e, key);
    }

    private buildOutput(s: Structure, e: Effects, key: OutputKey): void {
        for (const node of this.outputOwned) {
            node.dispose();
        }

        this.outputOwned = [];
        const owned = this.outputOwned;
        const post = s.aa === 'taa' ? 1 : this.inputScale;
        let color: Vec4Node = this.output.display(
            {
                hdr: e.hdr,
                bloom: e.bloom
                    ? (
                          e.bloom as unknown as {
                              getTextureNode(): TextureNode;
                          }
                      ).getTextureNode()
                    : null,
                flare: e.flare ? e.flare.getTextureNode() : null,
                eye: e.exposure?.multiplier ?? null,
            },
            key,
            key.toneMapping,
            key.srgb,
        );
        const names = this.names.filter(
            (n) =>
                n !== 'Output' && n !== 'FXAA' && n !== 'SMAA' && n !== 'FSR 1',
        );
        names.push('Output');

        const toTexture = (node: Vec4Node, name: string): TextureNode => {
            const t = rtt(node, null, null, { resolutionScale: post });
            t.name = name;
            owned.push(t);

            return t as unknown as TextureNode;
        };

        if (s.aa === 'fxaa' || s.aa === 'smaa') {
            const display = toTexture(color, 'Output');

            if (s.aa === 'fxaa') {
                color = fxaa(display) as unknown as Vec4Node;
            } else {
                const node = smaa(display);
                owned.push(node);
                color = node as unknown as Vec4Node;
            }

            names.push(s.aa.toUpperCase());
        }

        if (s.upscale && s.aa !== 'taa') {
            const node = fsr1(toTexture(color, 'Output'), this.fsrSharpness);
            owned.push(node);
            color = node as unknown as Vec4Node;
            names.push('FSR 1');
        }

        this.names = names;
        this.pipeline.outputNode = this.output.finish(color, key);
        this.pipeline.needsUpdate = true;
    }

    private disposeEffects(): void {
        const e = this.effects;

        if (!e) {
            return;
        }

        for (const node of [...e.owned, ...this.outputOwned]) {
            node.dispose();
        }

        e.exposure?.dispose();
        this.outputOwned = [];
        this.effects = null;
    }
}
