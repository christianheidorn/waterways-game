import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { Pass } from 'three/addons/postprocessing/Pass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { antiAliasingMode } from '../shared/graphicsPresets';
import type { GraphicsSettings } from '../shared/types';

/** GTAO parameters per ao_quality: resolution scale, AO samples, denoise samples, world radius. */
const AO_QUALITY = {
    low: { scale: 0.5, samples: 8, pdSamples: 8, radius: 2 },
    medium: { scale: 0.75, samples: 12, pdSamples: 12, radius: 2.5 },
    high: { scale: 1, samples: 16, pdSamples: 16, radius: 3 },
} as const;

/** GTAO that can render its AO buffers below the composer resolution (the blend stays full-res). */
class ScaledGTAOPass extends GTAOPass {
    resolutionScale = 1;
    private fullWidth = 1;
    private fullHeight = 1;

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
 * Display-referred colour grading (after tone mapping + sRGB, like UE's tonemapper stage): contrast
 * around mid grey, saturation around luminance, vignette, and an optional neighbourhood-clamped unsharp
 * mask (CAS-like, no halos). Grading in scene-linear HDR was tried first, but vignette and sharpening
 * vanished in bright regions once ACES compressed them.
 */
const GradingShader = {
    name: 'WaterwaysGradingShader',
    defines: { SHARPEN: 0 },
    uniforms: {
        tDiffuse: { value: null as THREE.Texture | null },
        texel: { value: new THREE.Vector2(1, 1) },
        aspect: { value: 1 },
        saturation: { value: 1 },
        contrast: { value: 1 },
        vignette: { value: 0 },
        sharpen: { value: 0 },
    },
    vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
    fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform vec2 texel;
        uniform float aspect;
        uniform float saturation;
        uniform float contrast;
        uniform float vignette;
        uniform float sharpen;
        varying vec2 vUv;

        void main() {
            vec4 base = texture2D(tDiffuse, vUv);
            vec3 col = base.rgb;

            #if SHARPEN
                vec3 n = texture2D(tDiffuse, vUv + vec2(0.0, texel.y)).rgb;
                vec3 s = texture2D(tDiffuse, vUv - vec2(0.0, texel.y)).rgb;
                vec3 e = texture2D(tDiffuse, vUv + vec2(texel.x, 0.0)).rgb;
                vec3 w = texture2D(tDiffuse, vUv - vec2(texel.x, 0.0)).rgb;
                vec3 lo = min(col, min(min(n, s), min(e, w)));
                vec3 hi = max(col, max(max(n, s), max(e, w)));
                vec3 blur = (n + s + e + w) * 0.25;
                col = clamp(col + (col - blur) * sharpen * 2.5, lo, hi);
            #endif

            float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
            col = mix(vec3(luma), col, saturation);
            col = (col - 0.5) * contrast + 0.5;

            vec2 d = (vUv - 0.5) * vec2(aspect, 1.0);
            float r = length(d) / length(vec2(aspect, 1.0) * 0.5);
            col *= 1.0 - vignette * 0.75 * smoothstep(0.25, 1.0, r);

            gl_FragColor = vec4(clamp(col, 0.0, 1.0), base.a);
        }`,
};

function gradingActive(g: GraphicsSettings): boolean {
    return (
        (g.sharpen ?? 0) > 0.001 ||
        (g.vignette ?? 0) > 0.001 ||
        Math.abs((g.saturation ?? 1) - 1) > 0.001 ||
        Math.abs((g.contrast ?? 1) - 1) > 0.001
    );
}

/**
 * Post-processing chain: Render → GTAO → Bloom → Output (tone map + sRGB) → Grading → FXAA / SMAA.
 *
 * GTAO and bloom work on scene-linear HDR. Grading, FXAA and SMAA expect display-referred (tone mapped,
 * sRGB) input, so they follow the OutputPass; AA runs last so it also smooths sharpening artefacts. MSAA is a
 * multisampled scene target instead. Passes that would be no-ops are left out; the composer is only
 * rebuilt when that structure changes, everything else updates uniforms.
 *
 * The composer can render below the canvas resolution (dynamic resolution): the final pass draws to the
 * full-size canvas and upscales with bilinear filtering.
 */
export class PostFx {
    composer: EffectComposer;
    private structure = '';
    private aoPass: ScaledGTAOPass | null = null;
    private bloomPass: UnrealBloomPass | null = null;
    private gradePass: ShaderPass | null = null;
    private msaa = false;
    private width = 1;
    private height = 1;
    private pixelRatio = 1;
    readonly renderSize = new THREE.Vector2(1, 1);

    constructor(
        private readonly renderer: THREE.WebGLRenderer,
        private readonly scene: THREE.Scene,
        private readonly camera: THREE.Camera,
    ) {
        this.composer = new EffectComposer(renderer);
    }

    /** Human readable list of the active passes (debugging / stats). */
    get passNames(): string[] {
        return this.composer.passes
            .map((p): string =>
                p instanceof RenderPass
                    ? 'Scene'
                    : p instanceof GTAOPass
                      ? 'GTAO'
                      : p instanceof UnrealBloomPass
                        ? 'Bloom'
                        : p instanceof FXAAPass
                          ? 'FXAA'
                          : p instanceof SMAAPass
                            ? 'SMAA'
                            : p instanceof OutputPass
                              ? 'Output'
                              : p === this.gradePass
                                ? 'Grade'
                                : 'Pass',
            )
            .concat(this.msaa ? ['(MSAA 4×)'] : []);
    }

    configure(g: GraphicsSettings): void {
        const aa = antiAliasingMode(g);
        const bloom = g.bloom && (g.bloom_intensity ?? 0.12) > 0.001;
        const structure = [
            aa,
            g.ambient_occlusion ? 'ao' : '-',
            bloom ? 'bloom' : '-',
            gradingActive(g) ? 'grade' : '-',
        ].join('|');

        if (structure !== this.structure) {
            this.structure = structure;
            this.build(aa, g.ambient_occlusion, bloom, gradingActive(g));
        }

        this.updateUniforms(g);
    }

    setSize(width: number, height: number, pixelRatio: number): void {
        this.width = width;
        this.height = height;
        this.pixelRatio = pixelRatio;
        this.composer.setPixelRatio(pixelRatio);
        this.composer.setSize(width, height);
        this.renderSize.set(
            Math.max(1, Math.floor(width * pixelRatio)),
            Math.max(1, Math.floor(height * pixelRatio)),
        );
        this.updateGradeSize();
    }

    render(dt: number): void {
        this.composer.render(dt);
    }

    dispose(): void {
        this.disposePasses();
        this.composer.dispose();
    }

    private build(
        aa: GraphicsSettings['anti_aliasing'],
        ao: boolean,
        bloom: boolean,
        grade: boolean,
    ): void {
        this.disposePasses();
        this.composer.dispose();

        const w = Math.max(1, Math.floor(this.width * this.pixelRatio));
        const h = Math.max(1, Math.floor(this.height * this.pixelRatio));
        const target = new THREE.WebGLRenderTarget(w, h, {
            type: THREE.HalfFloatType,
            samples: aa === 'msaa' ? 4 : 0,
        });
        const composer = new EffectComposer(this.renderer, target);
        composer.setPixelRatio(this.pixelRatio);
        composer.setSize(this.width, this.height);
        composer.addPass(new RenderPass(this.scene, this.camera));
        this.aoPass = null;
        this.bloomPass = null;
        this.gradePass = null;

        if (ao) {
            this.aoPass = new ScaledGTAOPass(
                this.scene,
                this.camera as THREE.PerspectiveCamera,
                w,
                h,
            );
            this.aoPass.blendIntensity = 0.8;
            composer.addPass(this.aoPass);
        }

        if (bloom) {
            this.bloomPass = new UnrealBloomPass(
                new THREE.Vector2(w, h),
                0.12,
                0.45,
                3.5,
            );
            composer.addPass(this.bloomPass);
        }

        composer.addPass(new OutputPass());

        if (grade) {
            this.gradePass = new ShaderPass(GradingShader);
            composer.addPass(this.gradePass);
        }

        if (aa === 'fxaa') {
            composer.addPass(new FXAAPass());
        } else if (aa === 'smaa') {
            composer.addPass(new SMAAPass());
        }

        this.composer = composer;
        this.msaa = aa === 'msaa';
        this.updateGradeSize();
    }

    private updateUniforms(g: GraphicsSettings): void {
        if (this.aoPass) {
            const q = AO_QUALITY[g.ao_quality ?? 'medium'] ?? AO_QUALITY.medium;
            this.aoPass.setResolutionScale(q.scale);
            this.aoPass.updateGtaoMaterial({
                radius: q.radius,
                distanceExponent: 1.5,
                thickness: 2,
                scale: 1,
                samples: q.samples,
            });
            this.aoPass.updatePdMaterial({ samples: q.pdSamples });
        }

        if (this.bloomPass) {
            this.bloomPass.strength = g.bloom_intensity ?? 0.12;
        }

        if (this.gradePass) {
            const u = this.gradePass.uniforms;
            u.saturation.value = g.saturation ?? 1;
            u.contrast.value = g.contrast ?? 1;
            u.vignette.value = g.vignette ?? 0;
            u.sharpen.value = g.sharpen ?? 0;
            const sharpen = (g.sharpen ?? 0) > 0.001 ? 1 : 0;
            const material = this.gradePass.material;

            if (material.defines.SHARPEN !== sharpen) {
                material.defines.SHARPEN = sharpen;
                material.needsUpdate = true;
            }
        }
    }

    private updateGradeSize(): void {
        if (!this.gradePass) {
            return;
        }

        const u = this.gradePass.uniforms;
        (u.texel.value as THREE.Vector2).set(
            1 / this.renderSize.x,
            1 / this.renderSize.y,
        );
        u.aspect.value = this.renderSize.x / this.renderSize.y;
    }

    private disposePasses(): void {
        for (const pass of this.composer.passes as Pass[]) {
            pass.dispose();
        }
    }
}
