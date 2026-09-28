import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import type { ColorGrade } from '../../shared/types';

/** Scene lighting the post effects need (satisfied by world/Atmosphere). */
export type LightSource = {
    readonly sun: THREE.DirectionalLight;
    /** Direction towards the sun (below the horizon at night). */
    readonly sunDirection: THREE.Vector3;
    readonly moonDirection: THREE.Vector3;
    /** 0 = day, 1 = night. */
    readonly nightAmount: number;
    /** Overcast / storm darkness 0-1. */
    readonly darkness: number;
};

/** Artistic post-processing values (EnvironmentSettings "Camera & look"), with defaults filled in. */
export type Look = {
    colorGrade: ColorGrade;
    colorGradeIntensity: number;
    whiteBalance: number;
    exposureCompensation: number;
    autoExposureMinEv: number;
    autoExposureMaxEv: number;
    autoExposureSpeed: number;
    godRayIntensity: number;
    bloomThreshold: number;
    dofFocusDistance: number;
    dofAperture: number;
    dofMaxBlur: number;
    motionBlurStrength: number;
    lensFlareIntensity: number;
    chromaticAberration: number;
    filmGrain: number;
    letterbox: number;
    fogDensity: number;
};

export const FULLSCREEN_VERTEX = /* glsl */ `
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
    }`;

/**
 * GLSL helpers shared by the depth based effects. Expects the PostContext frame uniforms
 * (tDepth, uNear, uFar, uProjInv, uProj, uViewInv …) to be declared by `FRAME_UNIFORMS`.
 */
export const FRAME_UNIFORMS = /* glsl */ `
    uniform sampler2D tDepth;
    uniform float uNear;
    uniform float uFar;
    uniform mat4 uProj;
    uniform mat4 uProjInv;
    uniform mat4 uView;
    uniform mat4 uViewInv;
    uniform mat4 uReproj;
    uniform vec2 uResolution;
    uniform vec2 uTexel;
    uniform vec2 uJitter;
    uniform float uFrame;
    uniform float uTime;

    float rawDepth(vec2 uv) { return texture2D(tDepth, uv).x; }

    /** Positive view distance along -Z (metres) from a [0,1] depth buffer value. */
    float linearizeDepth(float d) {
        float z = d * 2.0 - 1.0;
        return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
    }

    float linearDepth(vec2 uv) { return linearizeDepth(rawDepth(uv)); }

    bool isSky(float d) { return d >= 0.9999999; }

    vec3 viewPosition(vec2 uv, float d) {
        vec4 p = uProjInv * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
        return p.xyz / p.w;
    }

    vec2 viewToUv(vec3 p) {
        vec4 c = uProj * vec4(p, 1.0);
        return c.xy / c.w * 0.5 + 0.5;
    }

    /** Interleaved gradient noise (Jimenez), animated per frame. */
    float ign(vec2 px) {
        px += 5.588238 * mod(uFrame, 64.0);
        return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715))));
    }

    /** View-space normal from depth: the smaller of the two one-sided differences per axis (clean edges). */
    vec3 viewNormal(vec2 uv, vec3 p) {
        vec3 l = viewPosition(uv - vec2(uTexel.x, 0.0), rawDepth(uv - vec2(uTexel.x, 0.0)));
        vec3 r = viewPosition(uv + vec2(uTexel.x, 0.0), rawDepth(uv + vec2(uTexel.x, 0.0)));
        vec3 b = viewPosition(uv - vec2(0.0, uTexel.y), rawDepth(uv - vec2(0.0, uTexel.y)));
        vec3 t = viewPosition(uv + vec2(0.0, uTexel.y), rawDepth(uv + vec2(0.0, uTexel.y)));
        vec3 dx = abs(r.z - p.z) < abs(p.z - l.z) ? r - p : p - l;
        vec3 dy = abs(t.z - p.z) < abs(p.z - b.z) ? t - p : p - b;
        return normalize(cross(dx, dy));
    }

    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

export type FrameUniforms = {
    tDepth: THREE.IUniform<THREE.Texture | null>;
    uNear: THREE.IUniform<number>;
    uFar: THREE.IUniform<number>;
    uProj: THREE.IUniform<THREE.Matrix4>;
    uProjInv: THREE.IUniform<THREE.Matrix4>;
    uView: THREE.IUniform<THREE.Matrix4>;
    uViewInv: THREE.IUniform<THREE.Matrix4>;
    uReproj: THREE.IUniform<THREE.Matrix4>;
    uResolution: THREE.IUniform<THREE.Vector2>;
    uTexel: THREE.IUniform<THREE.Vector2>;
    uJitter: THREE.IUniform<THREE.Vector2>;
    uFrame: THREE.IUniform<number>;
    uTime: THREE.IUniform<number>;
};

export function createFrameUniforms(): FrameUniforms {
    return {
        tDepth: { value: null },
        uNear: { value: 0.1 },
        uFar: { value: 1000 },
        uProj: { value: new THREE.Matrix4() },
        uProjInv: { value: new THREE.Matrix4() },
        uView: { value: new THREE.Matrix4() },
        uViewInv: { value: new THREE.Matrix4() },
        uReproj: { value: new THREE.Matrix4() },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uTexel: { value: new THREE.Vector2(1, 1) },
        uJitter: { value: new THREE.Vector2() },
        uFrame: { value: 0 },
        uTime: { value: 0 },
    };
}

/** A full-screen shader material that never touches depth and is never tone mapped by three. */
export function fullscreenMaterial(params: {
    name: string;
    uniforms: Record<string, THREE.IUniform>;
    fragmentShader: string;
    vertexShader?: string;
    defines?: Record<string, string | number | boolean>;
    blending?: THREE.Blending;
}): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
        name: params.name,
        uniforms: params.uniforms,
        defines: params.defines ?? {},
        vertexShader: params.vertexShader ?? FULLSCREEN_VERTEX,
        fragmentShader: params.fragmentShader,
        depthTest: false,
        depthWrite: false,
        blending: params.blending ?? THREE.NoBlending,
        toneMapped: false,
    });
}

/** Sets a material define, recompiling only when the value changes. */
export function setDefine(
    material: THREE.ShaderMaterial,
    name: string,
    value: number,
): void {
    if (material.defines[name] !== value) {
        material.defines[name] = value;
        material.needsUpdate = true;
    }
}

export function colorTarget(
    width: number,
    height: number,
    options: THREE.RenderTargetOptions = {},
): THREE.WebGLRenderTarget {
    const target = new THREE.WebGLRenderTarget(
        Math.max(1, width),
        Math.max(1, height),
        {
            type: THREE.HalfFloatType,
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            depthBuffer: false,
            generateMipmaps: false,
            ...options,
        },
    );
    target.texture.generateMipmaps = options.generateMipmaps ?? false;

    return target;
}

/** Shared single triangle used by every full-screen pass. */
export class Blitter {
    private readonly quad = new FullScreenQuad();

    constructor(readonly renderer: THREE.WebGLRenderer) {}

    draw(
        material: THREE.Material,
        target: THREE.WebGLRenderTarget | null,
        clear = false,
    ): void {
        this.renderer.setRenderTarget(target);

        if (clear) {
            this.renderer.clear(true, false, false);
        }

        this.quad.material = material;
        this.quad.render(this.renderer);
    }

    dispose(): void {
        this.quad.dispose();
    }
}

export function scaledSize(size: number, scale: number): number {
    return Math.max(1, Math.round(size * scale));
}
