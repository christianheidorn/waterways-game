import * as THREE from 'three';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import type { Pass } from 'three/addons/postprocessing/Pass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { antiAliasingMode } from '../shared/graphicsPresets';
import type { EnvironmentSettings, GraphicsSettings } from '../shared/types';
import type { GpuProfiler } from './GpuProfiler';
import { AutoExposure } from './postfx/AutoExposure';
import {
    colorGradeLut,
    isColorGrade,
    whiteBalanceGains,
} from './postfx/ColorLut';
import type { LightSource, Look } from './postfx/common';
import { Blitter, colorTarget, createFrameUniforms } from './postfx/common';
import type { CompositeTerms } from './postfx/Composite';
import { Composite } from './postfx/Composite';
import { ContactShadows } from './postfx/ContactShadows';
import { DepthOfField } from './postfx/DepthOfField';
import { GodRays } from './postfx/GodRays';
import { LensFlare } from './postfx/LensFlare';
import { MotionBlur } from './postfx/MotionBlur';
import type { OutputParams } from './postfx/Output';
import { OutputStage } from './postfx/Output';
import type { TerrainSurface } from './postfx/Ssr';
import { Ssr } from './postfx/Ssr';
import { Taa } from './postfx/Taa';
import { VelocityBuffer } from './postfx/Velocity';

export type { LightSource, Look } from './postfx/common';

/** Look values for maps saved before the camera & look fields existed: neutral, effects subtle. */
export const DEFAULT_LOOK: Look = {
    colorGrade: 'neutral',
    colorGradeIntensity: 1,
    whiteBalance: 0,
    exposureCompensation: 0,
    autoExposureMinEv: -2,
    autoExposureMaxEv: 2,
    autoExposureSpeed: 1.5,
    godRayIntensity: 0.5,
    bloomThreshold: 4.5,
    dofFocusDistance: 0,
    dofAperture: 5.6,
    dofMaxBlur: 12,
    motionBlurStrength: 0.5,
    lensFlareIntensity: 0.3,
    chromaticAberration: 0,
    filmGrain: 0,
    letterbox: 0,
    fogDensity: 0.0002,
};

const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;

export function lookFromEnvironment(env: Partial<EnvironmentSettings>): Look {
    const d = DEFAULT_LOOK;

    return {
        colorGrade: isColorGrade(env.color_grade) ? env.color_grade : 'neutral',
        colorGradeIntensity: num(
            env.color_grade_intensity,
            d.colorGradeIntensity,
        ),
        whiteBalance: num(env.white_balance, d.whiteBalance),
        exposureCompensation: num(
            env.exposure_compensation,
            d.exposureCompensation,
        ),
        autoExposureMinEv: num(env.auto_exposure_min_ev, d.autoExposureMinEv),
        autoExposureMaxEv: num(env.auto_exposure_max_ev, d.autoExposureMaxEv),
        autoExposureSpeed: num(env.auto_exposure_speed, d.autoExposureSpeed),
        godRayIntensity: num(env.god_ray_intensity, d.godRayIntensity),
        bloomThreshold: num(env.bloom_threshold, d.bloomThreshold),
        dofFocusDistance: num(env.dof_focus_distance, d.dofFocusDistance),
        dofAperture: num(env.dof_aperture, d.dofAperture),
        dofMaxBlur: num(env.dof_max_blur, d.dofMaxBlur),
        motionBlurStrength: num(env.motion_blur_strength, d.motionBlurStrength),
        lensFlareIntensity: num(env.lens_flare_intensity, d.lensFlareIntensity),
        chromaticAberration: num(
            env.chromatic_aberration,
            d.chromaticAberration,
        ),
        filmGrain: num(env.film_grain, d.filmGrain),
        letterbox: num(env.letterbox, d.letterbox),
        fogDensity: num(env.fog_density, d.fogDensity),
    };
}

/** GTAO parameters per ao_quality: resolution scale, AO samples, denoise samples, world radius. */
const AO_QUALITY = {
    low: { scale: 0.5, samples: 8, pdSamples: 8, radius: 2 },
    medium: { scale: 0.75, samples: 12, pdSamples: 12, radius: 2.5 },
    high: { scale: 1, samples: 16, pdSamples: 16, radius: 3 },
} as const;

/**
 * GTAO that renders its AO buffers below the composer resolution and only produces the (denoised) AO
 * texture: it is applied in the HDR lighting composite instead of GTAO's own copy + blend passes.
 */
class ScaledGTAOPass extends GTAOPass {
    resolutionScale = 1;
    private fullWidth: number;
    private fullHeight: number;

    constructor(
        scene: THREE.Scene,
        camera: THREE.PerspectiveCamera,
        width: number,
        height: number,
    ) {
        super(scene, camera, width, height);
        // (Without this the first setResolutionScale resized the AO buffers to 1×1.)
        this.fullWidth = width;
        this.fullHeight = height;
    }

    override setSize(width: number, height: number): void {
        this.fullWidth = width;
        this.fullHeight = height;
        super.setSize(
            Math.max(1, Math.round(width * this.resolutionScale)),
            Math.max(1, Math.round(height * this.resolutionScale)),
        );
    }

    setResolutionScale(scale: number): void {
        if (scale !== this.resolutionScale) {
            this.resolutionScale = scale;
            this.setSize(this.fullWidth, this.fullHeight);
        }
    }
}

/**
 * Bloom-only UnrealBloomPass: bright-pass (threshold judged after eye adaptation, via the shared
 * exposure texture), mip blur chain and mip composite. The result is added in the output pass instead
 * of being blended back into the HDR buffer (one full-resolution pass less).
 */
const BloomHighPass = /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tExposure;
    uniform vec3 defaultColor;
    uniform float defaultOpacity;
    uniform float luminosityThreshold;
    uniform float smoothWidth;
    varying vec2 vUv;

    void main() {
        vec4 texel = texture2D(tDiffuse, vUv);

        // NaN / Inf would be spread over the screen by the blur chain.
        if (any(isnan(texel.rgb)) || any(isinf(texel.rgb))) {
            texel = vec4(0.0);
        }

        float v = dot(texel.rgb, vec3(0.2126, 0.7152, 0.0722));
        #if AUTO_EXPOSURE
            v *= texture2D(tExposure, vec2(0.5)).r;
        #endif
        float alpha = smoothstep(luminosityThreshold, luminosityThreshold + smoothWidth, v);
        gl_FragColor = mix(vec4(defaultColor, defaultOpacity), vec4(min(texel.rgb, vec3(6.0e4)), 1.0), alpha);
    }
`;

const BLUR_X = new THREE.Vector2(1, 0);
const BLUR_Y = new THREE.Vector2(0, 1);

class Bloom {
    readonly pass: UnrealBloomPass;

    constructor(
        width: number,
        height: number,
        exposure: THREE.IUniform,
        autoExposure: boolean,
    ) {
        this.pass = new UnrealBloomPass(
            new THREE.Vector2(width, height),
            0.12,
            0.35,
            DEFAULT_LOOK.bloomThreshold,
        );
        const m = this.pass.materialHighPassFilter;
        m.fragmentShader = BloomHighPass;
        m.uniforms.tExposure = exposure;
        m.defines = { AUTO_EXPOSURE: autoExposure ? 1 : 0 };
        m.needsUpdate = true;
    }

    get texture(): THREE.Texture {
        return this.pass.renderTargetsHorizontal[0].texture;
    }

    setSize(width: number, height: number): void {
        this.pass.setSize(width, height);
    }

    render(blitter: Blitter, input: THREE.Texture): void {
        const p = this.pass;
        const hp = p.highPassUniforms as Record<string, THREE.IUniform>;
        hp.tDiffuse.value = input;
        hp.luminosityThreshold.value = p.threshold;
        // Soft knee: a hard threshold makes large sky regions pop in and out as exposure changes.
        hp.smoothWidth.value = p.threshold * 0.6;
        blitter.draw(p.materialHighPassFilter, p.renderTargetBright);

        let source = p.renderTargetBright;

        for (let i = 0; i < p.nMips; i++) {
            const blur = p.separableBlurMaterials[i];
            blur.uniforms.colorTexture.value = source.texture;
            blur.uniforms.direction.value = BLUR_X;
            blitter.draw(blur, p.renderTargetsHorizontal[i]);
            blur.uniforms.colorTexture.value =
                p.renderTargetsHorizontal[i].texture;
            blur.uniforms.direction.value = BLUR_Y;
            blitter.draw(blur, p.renderTargetsVertical[i]);
            source = p.renderTargetsVertical[i];
        }

        const c = p.compositeMaterial.uniforms;
        c.bloomStrength.value = p.strength;
        c.bloomRadius.value = p.radius;
        c.bloomTintColors.value = p.bloomTintColors;
        blitter.draw(p.compositeMaterial, p.renderTargetsHorizontal[0]);
    }

    dispose(): void {
        this.pass.dispose();
    }
}

/** Camera jumps beyond these per frame are cuts: temporal history is reset. */
const CUT_DISTANCE = 25;
const CUT_ANGLE = THREE.MathUtils.degToRad(45);

type Structure = {
    aa: GraphicsSettings['anti_aliasing'];
    ao: boolean;
    /** GTAO with its own normal pre-pass (a second scene render); otherwise normals from depth. */
    aoNormals: boolean;
    bloom: boolean;
    autoExposure: boolean;
    godRays: GraphicsSettings['god_rays'];
    contact: boolean;
    ssr: GraphicsSettings['ssr'];
    dof: GraphicsSettings['depth_of_field'];
    motionBlur: GraphicsSettings['motion_blur'];
    flare: boolean;
};

/**
 * Post-processing pipeline. Order (each stage exists only when enabled; disabled stages cost nothing):
 *
 *  1. Scene        HDR (half float) colour + depth texture; projection jittered (Halton) when TAA is on.
 *                  MSAA renders into a multisampled target whose colour and depth are resolved.
 *     Velocity     dynamic objects (player) → screen motion, only with TAA / motion blur.
 *  2. GTAO         ambient occlusion buffers (scaled resolution).
 *     Contact      screen-space contact shadows (½ res), SSR (½ or full res), god rays (¼ / ½ res).
 *  3. Composite    HDR lighting composite: × AO × contact shadows, + reflections, + god rays.
 *  4. TAA          temporal resolve in HDR (perceptual weighting, variance clipping, Catmull-Rom history);
 *                  everything before it may be noisy per frame (dithered ray marches), TAA resolves it.
 *  5. DoF          physically based CoC, auto-focus, half resolution bokeh gather, full-res composite.
 *  6. Motion blur  camera + object motion vectors, shutter-based length.
 *  7. Exposure     eye adaptation metered on the final HDR image (GPU histogram, 1×1 feedback).
 *  8. Bloom        mip chain; threshold in display terms after exposure (bloom_threshold / exposure).
 *     Lens flare   sprites into a ½ res HDR target, occluded by depth and cloud brightness.
 *  9. Output       one pass: CA → + bloom + flare → × exposure × white balance → tone map → sRGB →
 *                  sharpen → 3D LUT grade → saturation / contrast / vignette → grain → letterbox.
 * 10. FXAA / SMAA  on the display image (not with TAA / MSAA).
 *
 * The chain renders at the effective (dynamic) resolution; the final pass upscales to the canvas. The
 * structure (which stages exist) is rebuilt only when settings change it; everything else is uniforms.
 */
export class PostFx {
    readonly renderSize = new THREE.Vector2(1, 1);
    private readonly uniforms = createFrameUniforms();
    /** Eye adaptation result (1×1, r = multiplier) shared by TAA, bloom and output. */
    private readonly exposureUniform: THREE.IUniform<THREE.Texture | null> = {
        value: null,
    };
    private readonly blitter: Blitter;
    private sceneTarget: THREE.WebGLRenderTarget;
    private ping: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null =
        null;
    private ldrTarget: THREE.WebGLRenderTarget | null = null;
    private readonly output: OutputStage;
    private composite: Composite | null = null;
    private ao: ScaledGTAOPass | null = null;
    private bloom: Bloom | null = null;
    private autoExposure: AutoExposure | null = null;
    private godRays: GodRays | null = null;
    private contact: ContactShadows | null = null;
    private ssr: Ssr | null = null;
    private taa: Taa | null = null;
    private dof: DepthOfField | null = null;
    private motionBlur: MotionBlur | null = null;
    private flare: LensFlare | null = null;
    private velocity: VelocityBuffer | null = null;
    private aaPass: FXAAPass | SMAAPass | null = null;
    private structure: Structure | null = null;
    private structureKey = '';
    private names: string[] = [];
    private graphics: GraphicsSettings | null = null;
    private look: Look = { ...DEFAULT_LOOK };
    private light: LightSource | null = null;
    private terrainSurface: TerrainSurface | null = null;
    private waterDepth: THREE.Texture | null = null;
    private dynamicObjects: THREE.Object3D[] = [];
    private focusPoint: THREE.Vector2 | null = null;
    private width = 1;
    private height = 1;
    private frame = 0;
    // Matrices (un-jittered unless named otherwise); no per-frame allocations.
    private readonly projection = new THREE.Matrix4();
    private readonly projectionInverse = new THREE.Matrix4();
    private readonly jittered = new THREE.Matrix4();
    private readonly jitteredInverse = new THREE.Matrix4();
    private readonly viewProj = new THREE.Matrix4();
    private readonly viewProjInverse = new THREE.Matrix4();
    private readonly prevViewProj = new THREE.Matrix4();
    private readonly prevPosition = new THREE.Vector3();
    private readonly prevForward = new THREE.Vector3();
    private readonly forward = new THREE.Vector3();
    private hasHistory = false;
    private cameraMoved = false;
    private readonly whiteBalance = new THREE.Vector3(1, 1, 1);
    private readonly rayColor = new THREE.Vector3();
    private readonly lightDir = new THREE.Vector3();
    // Per-frame parameter objects, reused (no allocations in the frame loop).
    private readonly compositeTerms: CompositeTerms = {
        ao: null,
        contact: null,
        contactStrength: 0,
        ssr: null,
        rays: null,
        rayColor: this.rayColor,
    };
    private readonly outputParams: OutputParams = {
        exposure: 1,
        whiteBalance: this.whiteBalance,
        lut: null,
        lutIntensity: 1,
        saturation: 1,
        contrast: 1,
        vignette: 0,
        sharpen: 0,
        aberration: 0,
        grain: 0,
        letterbox: 0,
        bloom: null,
        flare: null,
        autoExposure: false,
    };

    constructor(
        private readonly renderer: THREE.WebGLRenderer,
        private readonly scene: THREE.Scene,
        private readonly camera: THREE.Camera,
    ) {
        this.blitter = new Blitter(renderer);
        this.sceneTarget = this.createSceneTarget(1, 1, 0);
        this.output = new OutputStage(
            this.exposureUniform,
            this.uniforms.uFrame,
        );
    }

    /** Human readable list of the active passes (F10 menu / stats). */
    get passNames(): string[] {
        return this.names;
    }

    // ---------------------------------------------------------------- configuration

    configure(g: GraphicsSettings): void {
        this.graphics = g;
        this.rebuildIfNeeded();
        this.updateUniforms();
    }

    /** Per-map artistic look (EnvironmentSettings "Camera & look"); missing fields fall back to defaults. */
    setLook(env: Partial<EnvironmentSettings>): void {
        this.look = lookFromEnvironment(env);
        this.rebuildIfNeeded();
        this.updateUniforms();
    }

    setLightSource(light: LightSource): void {
        this.light = light;
    }

    /** Terrain material uniforms (wetness inputs) the SSR gloss mask mirrors. */
    setTerrainSurface(surface: TerrainSurface | null): void {
        this.terrainSurface = surface;
        this.ssr?.setSurface(surface);
    }

    /** Depth of the water pre-pass (scene without water) this frame; lets SSR skip water. */
    setWaterDepth(depth: THREE.Texture | null): void {
        this.waterDepth = depth;
    }

    /** Objects that move on their own (the player): rendered into the velocity buffer. */
    setDynamicObjects(objects: THREE.Object3D[]): void {
        this.dynamicObjects = objects;
        this.velocity?.setObjects(objects);
    }

    /**
     * Focuses depth of field on the surface under a screen point (NDC, -1..1, +y up) — kept until
     * `clearFocusPoint`; the distance follows that point (auto-focus there) with a smooth focus pull.
     */
    focusAtScreen(ndcX: number, ndcY: number): void {
        this.focusPoint = new THREE.Vector2(
            THREE.MathUtils.clamp(ndcX * 0.5 + 0.5, 0, 1),
            THREE.MathUtils.clamp(ndcY * 0.5 + 0.5, 0, 1),
        );
        this.dof?.focusUv.copy(this.focusPoint);
    }

    /** Back to the look's focus (manual distance, or auto-focus on the screen centre). */
    clearFocusPoint(): void {
        this.focusPoint = null;
        this.dof?.focusUv.set(0.5, 0.5);
    }

    /** Current focus distance in metres (async GPU read-back, no stall); null when DoF is off. */
    readFocusDistance(): Promise<number | null> {
        return this.dof
            ? this.dof.readFocusDistance(this.renderer)
            : Promise.resolve(null);
    }

    /** Drop temporal history (TAA, eye adaptation, focus) after a camera cut. */
    resetHistory(): void {
        this.hasHistory = false;
        this.taa?.reset();
        this.autoExposure?.reset();
        this.dof?.reset();
    }

    setSize(width: number, height: number, pixelRatio: number): void {
        this.width = width;
        this.height = height;
        const w = Math.max(1, Math.floor(width * pixelRatio));
        const h = Math.max(1, Math.floor(height * pixelRatio));

        if (w === this.renderSize.x && h === this.renderSize.y) {
            return;
        }

        this.renderSize.set(w, h);
        this.sceneTarget.setSize(w, h);
        this.ping?.[0].setSize(w, h);
        this.ping?.[1].setSize(w, h);
        this.ldrTarget?.setSize(w, h);
        this.ao?.setSize(w, h);
        this.bloom?.setSize(w, h);
        this.godRays?.setSize(w, h);
        this.contact?.setSize(w, h);
        this.ssr?.setSize(w, h);
        this.taa?.setSize(w, h);
        this.dof?.setSize(w, h);
        this.flare?.setSize(w, h);
        this.velocity?.setSize(w, h);
        this.aaPass?.setSize(w, h);
        this.uniforms.uResolution.value.set(w, h);
        this.uniforms.uTexel.value.set(1 / w, 1 / h);
    }

    dispose(): void {
        this.disposeEffects();
        this.sceneTarget.dispose();
        this.output.dispose();
        this.blitter.dispose();
    }

    // ---------------------------------------------------------------- frame

    render(dt: number, profiler?: GpuProfiler | null): void {
        const p = profiler ?? null;
        const renderer = this.renderer;
        const camera = this.camera as THREE.PerspectiveCamera;
        const s = this.structure;

        if (!s) {
            return;
        }

        const u = this.uniforms;
        const w = this.renderSize.x;
        const h = this.renderSize.y;
        const look = this.look;
        this.frame++;
        u.uFrame.value = this.frame;
        u.uTime.value += dt;

        // ---- camera matrices, cut detection, reprojection
        camera.updateMatrixWorld();
        this.projection.copy(camera.projectionMatrix);
        this.projectionInverse.copy(camera.projectionMatrixInverse);
        this.viewProj.multiplyMatrices(
            this.projection,
            camera.matrixWorldInverse,
        );
        camera.getWorldDirection(this.forward);
        const cut =
            !this.hasHistory ||
            camera.position.distanceTo(this.prevPosition) > CUT_DISTANCE ||
            this.forward.angleTo(this.prevForward) > CUT_ANGLE;

        if (cut) {
            this.taa?.reset();
            u.uReproj.value.identity();
            this.cameraMoved = false;
        } else {
            this.viewProjInverse.copy(this.viewProj).invert();
            u.uReproj.value.multiplyMatrices(
                this.prevViewProj,
                this.viewProjInverse,
            );
            this.cameraMoved = !this.nearIdentity(u.uReproj.value);
        }

        u.uNear.value = camera.near;
        u.uFar.value = camera.far;
        u.uView.value.copy(camera.matrixWorldInverse);
        u.uViewInv.value.copy(camera.matrixWorld);

        // ---- jitter (main render only)
        if (this.taa) {
            const j = this.taa.nextJitter();
            this.jittered.copy(this.projection);
            this.jittered.elements[8] -= (2 * j.x) / w;
            this.jittered.elements[9] -= (2 * j.y) / h;
            this.jitteredInverse.copy(this.jittered).invert();
            camera.projectionMatrix.copy(this.jittered);
            camera.projectionMatrixInverse.copy(this.jitteredInverse);
            u.uJitter.value.set(j.x / w, j.y / h);
        } else {
            this.jittered.copy(this.projection);
            this.jitteredInverse.copy(this.projectionInverse);
            u.uJitter.value.set(0, 0);
        }

        u.uProj.value.copy(this.jittered);
        u.uProjInv.value.copy(this.jitteredInverse);

        // ---- 1. scene
        p?.mark('Scene + shadows');
        renderer.setRenderTarget(this.sceneTarget);
        renderer.clear();
        renderer.render(this.scene, camera);
        u.tDepth.value = this.sceneTarget.depthTexture;

        const velocity =
            this.velocity && this.velocity.active ? this.velocity : null;
        if (velocity) {
            p?.mark('Velocity');
            velocity.render(renderer, camera);
        }

        // ---- 2. AO (still jittered, consistent with the depth it reconstructs from)
        if (this.ao) {
            p?.mark('Ambient occlusion');
        }

        this.ao?.render(
            renderer,
            this.sceneTarget,
            this.sceneTarget,
            dt,
            false,
        );

        if (this.taa) {
            camera.projectionMatrix.copy(this.projection);
            camera.projectionMatrixInverse.copy(this.projectionInverse);
        }

        const baseExposure =
            Math.max(1e-4, renderer.toneMappingExposure) *
            Math.pow(2, look.exposureCompensation);
        const light = this.light;
        const night = light && light.sunDirection.y < -0.05;

        if (light) {
            this.lightDir.copy(
                night ? light.moonDirection : light.sunDirection,
            );
        }

        // ---- 3. screen-space lighting terms + composite
        let current: THREE.WebGLRenderTarget = this.sceneTarget;

        if (this.composite) {
            let contactStrength = 0;

            if (this.contact && light && light.sun.intensity > 0.01) {
                const i = light.sun.intensity;
                contactStrength =
                    0.6 * (i / (i + 0.6)) * (1 - light.darkness * 0.8);
                p?.mark('Contact shadows');
                this.contact.render(this.lightDir, camera);
            }

            if (this.ssr) {
                p?.mark('Screen-space reflections');
            }

            this.ssr?.render(this.sceneTarget.texture, this.waterDepth);
            this.rayColor.set(0, 0, 0);

            if (this.godRays && light) {
                const vis = this.godRays.locate(
                    this.lightDir,
                    camera,
                    this.viewProj,
                );

                // Shafts fade out as the light source sets (none from below the horizon).
                const horizon = THREE.MathUtils.smoothstep(
                    this.lightDir.y,
                    -0.03,
                    0.03,
                );

                if (vis * horizon > 0.001) {
                    p?.mark('Light shafts');
                    this.godRays.render(this.sceneTarget.texture, baseExposure);
                    const c = light.sun.color;
                    const k =
                        (0.6 *
                            look.godRayIntensity *
                            vis *
                            horizon *
                            (night ? 0.35 : 1) *
                            (1 + Math.min(0.75, look.fogDensity / 0.001)) *
                            (1 - light.darkness * 0.6)) /
                        baseExposure;
                    this.rayColor.set(
                        (0.4 + 0.6 * c.r) * k,
                        (0.4 + 0.6 * c.g) * k,
                        (0.4 + 0.6 * c.b) * k,
                    );
                }
            }

            const terms = this.compositeTerms;
            terms.ao = this.ao ? this.ao.pdRenderTarget.texture : null;
            terms.contact = this.contact ? this.contact.texture : null;
            terms.contactStrength = contactStrength;
            terms.ssr = this.ssr ? this.ssr.texture : null;
            terms.rays = this.godRays ? this.godRays.texture : null;
            p?.mark('Composite');
            this.composite.set(current.texture, terms);
            const next = this.other(current);
            this.blitter.draw(this.composite.material, next);
            current = next;
        }

        // Post-TAA effects work on the un-jittered image.
        u.uProj.value.copy(this.projection);
        u.uProjInv.value.copy(this.projectionInverse);
        u.uJitter.value.set(0, 0);

        // ---- 4. TAA
        if (this.taa) {
            p?.mark('TAA');
            current = this.taa.render(
                current.texture,
                baseExposure,
                s.autoExposure,
                velocity ? velocity.target.texture : null,
            );
        }

        // ---- 5. depth of field
        if (this.dof) {
            p?.mark('Depth of field');
            const next = this.other(current);
            this.dof.render(current.texture, next, camera, {
                focusDistance: this.focusPoint ? 0 : look.dofFocusDistance,
                aperture: look.dofAperture,
                maxBlur: look.dofMaxBlur,
                height: h,
                dt,
            });
            current = next;
        }

        // ---- 6. motion blur (skipped while nothing moves, on camera cuts and for stills rendered with dt 0)
        if (
            this.motionBlur &&
            !cut &&
            dt > 0 &&
            (this.cameraMoved || velocity)
        ) {
            p?.mark('Motion blur');
            const next = this.other(current);
            this.motionBlur.render(current.texture, next, {
                strength: look.motionBlurStrength,
                dt,
                height: h,
                velocity: velocity ? velocity.target.texture : null,
            });
            current = next;
        }

        // ---- 7. eye adaptation
        if (this.autoExposure) {
            p?.mark('Eye adaptation');
        }

        this.autoExposure?.update(
            current.texture,
            dt,
            baseExposure,
            look.autoExposureMinEv,
            look.autoExposureMaxEv,
            look.autoExposureSpeed,
        );

        // ---- 8. bloom, lens flare
        if (this.bloom) {
            p?.mark('Bloom');
            this.bloom.pass.threshold = look.bloomThreshold / baseExposure;
            this.bloom.render(this.blitter, current.texture);
        }

        if (this.flare) {
            p?.mark('Lens flare');
            let scale = 0;

            if (light && !night && this.locateFlare()) {
                const sunUp = THREE.MathUtils.smoothstep(
                    light.sunDirection.y,
                    -0.02,
                    0.08,
                );
                scale =
                    look.lensFlareIntensity *
                    Math.min(1, light.sun.intensity / 2.5) *
                    sunUp;
            }

            this.flare.render(
                renderer,
                this.sceneTarget.texture,
                scale,
                baseExposure,
                this.width / Math.max(1, this.height),
            );
        }

        // ---- 9. output (+ 10. AA)
        p?.mark('Output + AA');
        this.updateOutput(current.texture, baseExposure);

        if (this.aaPass && this.ldrTarget) {
            this.blitter.draw(this.output.material, this.ldrTarget);
            this.aaPass.renderToScreen = true;
            this.aaPass.render(
                renderer,
                null as never,
                this.ldrTarget,
                dt,
                false,
            );
        } else {
            this.blitter.draw(this.output.material, null);
        }

        // ---- history
        this.prevViewProj.copy(this.viewProj);
        this.prevPosition.copy(camera.position);
        this.prevForward.copy(this.forward);
        this.hasHistory = true;
        this.velocity?.commit();
    }

    // ---------------------------------------------------------------- internals

    /** Projects the light to the screen for the flare; false when it is behind or far off-screen. */
    private locateFlare(): boolean {
        const p = this.flareTmp.set(
            this.lightDir.x,
            this.lightDir.y,
            this.lightDir.z,
            0,
        );
        p.applyMatrix4(this.viewProj);

        if (!this.flare || p.w <= 1e-4) {
            return false;
        }

        const uv = this.flare.lightUv.set(
            (p.x / p.w) * 0.5 + 0.5,
            (p.y / p.w) * 0.5 + 0.5,
        );

        return uv.x > -0.2 && uv.x < 1.2 && uv.y > -0.2 && uv.y < 1.2;
    }

    private readonly flareTmp = new THREE.Vector4();

    private nearIdentity(m: THREE.Matrix4): boolean {
        const e = m.elements;

        for (let i = 0; i < 16; i++) {
            if (Math.abs(e[i] - (i % 5 === 0 ? 1 : 0)) > 1e-5) {
                return false;
            }
        }

        return true;
    }

    private other(target: THREE.WebGLRenderTarget): THREE.WebGLRenderTarget {
        if (!this.ping) {
            const { x, y } = this.renderSize;
            this.ping = [colorTarget(x, y), colorTarget(x, y)];
        }

        return target === this.ping[0] ? this.ping[1] : this.ping[0];
    }

    private updateOutput(input: THREE.Texture, baseExposure: number): void {
        const g = this.graphics;
        const look = this.look;
        const s = this.structure!;

        if (!g) {
            return;
        }

        const lens = g.lens_effects;
        const lut =
            g.color_grading_lut &&
            look.colorGrade !== 'neutral' &&
            look.colorGradeIntensity > 0.001
                ? colorGradeLut(look.colorGrade)
                : null;
        whiteBalanceGains(look.whiteBalance, this.whiteBalance);
        const p = this.outputParams;
        p.exposure = baseExposure;
        p.lut = lut;
        p.lutIntensity = THREE.MathUtils.clamp(look.colorGradeIntensity, 0, 1);
        p.saturation = g.saturation ?? 1;
        p.contrast = g.contrast ?? 1;
        p.vignette = g.vignette ?? 0;
        // TAA's resolve is slightly soft: a touch of adaptive sharpening restores it.
        p.sharpen = Math.max(g.sharpen ?? 0, s.aa === 'taa' ? 0.25 : 0);
        p.aberration = lens ? look.chromaticAberration : 0;
        p.grain = lens ? look.filmGrain : 0;
        p.letterbox = look.letterbox;
        p.bloom = this.bloom ? this.bloom.texture : null;
        p.flare = this.flare ? this.flare.texture : null;
        p.autoExposure = s.autoExposure;
        this.output.update(
            this.renderer,
            input,
            p,
            this.renderSize.x,
            this.renderSize.y,
            this.width / Math.max(1, this.height),
        );
    }

    private rebuildIfNeeded(): void {
        const g = this.graphics;

        if (!g) {
            return;
        }

        const look = this.look;
        const aa = antiAliasingMode(g);
        const s: Structure = {
            aa,
            ao: !!g.ambient_occlusion,
            aoNormals: !!g.ambient_occlusion && g.ao_quality === 'high',
            bloom: !!g.bloom && (g.bloom_intensity ?? 0.12) > 0.001,
            autoExposure: !!g.auto_exposure,
            godRays:
                (g.god_rays ?? 'off') !== 'off' && look.godRayIntensity > 0.001
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
        };
        const key = JSON.stringify(s);

        if (key !== this.structureKey) {
            this.structureKey = key;
            this.build(s);
        }
    }

    private createSceneTarget(
        width: number,
        height: number,
        samples: number,
    ): THREE.WebGLRenderTarget {
        const depth = new THREE.DepthTexture(width, height);
        depth.type = THREE.UnsignedIntType;

        return new THREE.WebGLRenderTarget(width, height, {
            type: THREE.HalfFloatType,
            samples,
            depthTexture: depth,
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
        });
    }

    private build(s: Structure): void {
        this.disposeEffects();
        const u = this.uniforms;
        const { x: w, y: h } = this.renderSize;
        const samples = s.aa === 'msaa' ? 4 : 0;
        this.structure = s;

        if (this.sceneTarget.samples !== samples) {
            this.sceneTarget.dispose();
            this.sceneTarget = this.createSceneTarget(w, h, samples);
        }

        const names = ['Scene'];

        if (
            this.dynamicObjects.length &&
            (s.aa === 'taa' || s.motionBlur !== 'off')
        ) {
            this.velocity = new VelocityBuffer(
                w,
                h,
                u.tDepth,
                this.prevViewProj,
                this.viewProj,
            );
            this.velocity.setObjects(this.dynamicObjects);
        }

        if (s.ao) {
            this.ao = new ScaledGTAOPass(
                this.scene,
                this.camera as THREE.PerspectiveCamera,
                w,
                h,
            );
            this.ao.output = GTAOPass.OUTPUT.Off;

            if (!s.aoNormals) {
                // Normals reconstructed from the scene depth: no second scene render for a normal buffer.
                this.ao.setGBuffer(this.sceneTarget.depthTexture!);
            }

            names.push(s.aoNormals ? 'GTAO (normal pass)' : 'GTAO');
        }

        if (s.contact) {
            this.contact = new ContactShadows(u, this.blitter, w, h);
            names.push('Contact shadows');
        }

        if (s.ssr !== 'off') {
            this.ssr = new Ssr(s.ssr, u, this.blitter, w, h);
            this.ssr.setSurface(this.terrainSurface);
            names.push(`SSR ${s.ssr}`);
        }

        if (s.godRays !== 'off') {
            this.godRays = new GodRays(s.godRays, u, this.blitter, w, h);
            names.push(`God rays ${s.godRays}`);
        }

        if (s.ao || s.contact || s.ssr !== 'off' || s.godRays !== 'off') {
            this.composite = new Composite(u);
        }

        if (s.aa === 'taa') {
            this.taa = new Taa(u, this.exposureUniform, this.blitter, w, h);
            names.push('TAA');
        }

        if (s.dof !== 'off') {
            this.dof = new DepthOfField(s.dof, u, this.blitter, w, h);

            if (this.focusPoint) {
                this.dof.focusUv.copy(this.focusPoint);
            }

            names.push(`DoF ${s.dof}`);
        }

        if (s.motionBlur !== 'off') {
            this.motionBlur = new MotionBlur(s.motionBlur, u, this.blitter);
            names.push(`Motion blur ${s.motionBlur}`);
        }

        if (s.autoExposure) {
            this.autoExposure = new AutoExposure(
                this.exposureUniform,
                this.blitter,
            );
            names.push('Eye adaptation');
        }

        if (s.bloom) {
            this.bloom = new Bloom(w, h, this.exposureUniform, s.autoExposure);
            names.push('Bloom');
        }

        if (s.flare) {
            this.flare = new LensFlare(u, w, h);
            names.push('Lens flare');
        }

        names.push('Output');

        if (s.aa === 'fxaa' || s.aa === 'smaa') {
            this.aaPass = s.aa === 'fxaa' ? new FXAAPass() : new SMAAPass();
            this.aaPass.setSize(w, h);
            this.ldrTarget = colorTarget(w, h, {
                type: THREE.UnsignedByteType,
            });
            names.push(s.aa.toUpperCase());
        }

        if (s.aa === 'msaa') {
            names.push('(MSAA 4×)');
        }

        this.names = names;
        this.hasHistory = false;
    }

    private updateUniforms(): void {
        const g = this.graphics;

        if (!g) {
            return;
        }

        if (this.ao) {
            const q = AO_QUALITY[g.ao_quality ?? 'medium'] ?? AO_QUALITY.medium;
            this.ao.setResolutionScale(q.scale);
            this.ao.updateGtaoMaterial({
                radius: q.radius,
                distanceExponent: 1.5,
                thickness: 2,
                scale: 1,
                samples: q.samples,
            });
            this.ao.updatePdMaterial({ samples: q.pdSamples });
        }

        if (this.bloom) {
            this.bloom.pass.strength = g.bloom_intensity ?? 0.12;
        }
    }

    private disposeEffects(): void {
        const passes: (Pass | null)[] = [this.ao, this.aaPass];

        for (const pass of passes) {
            pass?.dispose();
        }

        for (const effect of [
            this.composite,
            this.bloom,
            this.autoExposure,
            this.godRays,
            this.contact,
            this.ssr,
            this.taa,
            this.dof,
            this.motionBlur,
            this.flare,
            this.velocity,
        ]) {
            effect?.dispose();
        }

        this.ping?.[0].dispose();
        this.ping?.[1].dispose();
        this.ldrTarget?.dispose();
        this.ping = null;
        this.ldrTarget = null;
        this.ao = null;
        this.aaPass = null;
        this.composite = null;
        this.bloom = null;
        this.autoExposure = null;
        this.godRays = null;
        this.contact = null;
        this.ssr = null;
        this.taa = null;
        this.dof = null;
        this.motionBlur = null;
        this.flare = null;
        this.velocity = null;
        this.exposureUniform.value = null;
    }
}
