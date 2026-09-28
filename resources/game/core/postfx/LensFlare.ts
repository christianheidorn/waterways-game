import * as THREE from 'three';
import type { FrameUniforms } from './common';
import { colorTarget, FRAME_UNIFORMS, scaledSize } from './common';

const CELL = 128;
const CELLS = 4;

/** Procedural flare sprites in one atlas: 0 starburst glow, 1 hexagonal ghost, 2 soft disc, 3 halo ring. */
function createAtlas(): THREE.Texture {
    const canvas = document.createElement('canvas');
    canvas.width = CELL * CELLS;
    canvas.height = CELL;
    const ctx = canvas.getContext('2d')!;
    const c = CELL / 2;
    // Deterministic pseudo-random rays.
    let seed = 7;
    const rand = () => {
        seed = (seed * 16807) % 2147483647;

        return seed / 2147483647;
    };

    // 0: glow core + starburst streaks.
    ctx.save();
    ctx.translate(c, c);
    let g = ctx.createRadialGradient(0, 0, 0, 0, 0, c);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.05, 'rgba(255,255,255,0.6)');
    g.addColorStop(0.15, 'rgba(255,255,255,0.12)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.02)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(-c, -c, CELL, CELL);
    ctx.globalCompositeOperation = 'lighter';

    for (let i = 0; i < 36; i++) {
        const a = (i / 36) * Math.PI * 2 + rand() * 0.08;
        const len = c * (0.35 + rand() * 0.6);
        const width = 0.6 + rand() * 1.2;
        ctx.save();
        ctx.rotate(a);
        const rg = ctx.createLinearGradient(0, 0, len, 0);
        rg.addColorStop(0, `rgba(255,255,255,${0.25 + rand() * 0.3})`);
        rg.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = rg;
        ctx.beginPath();
        ctx.moveTo(0, -width);
        ctx.lineTo(len, 0);
        ctx.lineTo(0, width);
        ctx.fill();
        ctx.restore();
    }

    ctx.restore();

    // 1: hexagonal aperture ghost with a slightly brighter rim.
    ctx.save();
    ctx.translate(CELL + c, c);
    ctx.filter = 'blur(2px)';
    const hex = (r: number) => {
        ctx.beginPath();

        for (let i = 0; i < 6; i++) {
            const a = (i / 6) * Math.PI * 2 + 0.26;
            ctx[i === 0 ? 'moveTo' : 'lineTo'](
                Math.cos(a) * r,
                Math.sin(a) * r,
            );
        }

        ctx.closePath();
    };
    hex(c * 0.82);
    g = ctx.createRadialGradient(0, 0, 0, 0, 0, c * 0.82);
    g.addColorStop(0, 'rgba(255,255,255,0.35)');
    g.addColorStop(0.8, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0.8)');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();

    // 2: soft disc.
    ctx.save();
    ctx.translate(CELL * 2 + c, c);
    g = ctx.createRadialGradient(0, 0, 0, 0, 0, c);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.3, 'rgba(255,255,255,0.45)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(-c, -c, CELL, CELL);
    ctx.restore();

    // 3: thin halo ring.
    ctx.save();
    ctx.translate(CELL * 3 + c, c);
    g = ctx.createRadialGradient(0, 0, c * 0.7, 0, 0, c);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.7)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(-c, -c, CELL, CELL);
    ctx.restore();

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.NoColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;

    return texture;
}

/** [axis position (1 = light, 0 = centre, <0 = mirrored), size (screen heights), cell, x stretch, r, g, b]. */
const ELEMENTS: number[][] = [
    [1.0, 0.3, 0, 1, 0.5, 0.46, 0.4],
    [1.0, 0.022, 2, 12, 0.12, 0.17, 0.3],
    [0.72, 0.03, 1, 1, 0.08, 0.16, 0.09],
    [0.45, 0.075, 1, 1, 0.14, 0.09, 0.05],
    [0.28, 0.02, 2, 1, 0.12, 0.1, 0.06],
    [-0.15, 0.045, 1, 1, 0.05, 0.08, 0.14],
    [-0.35, 0.11, 1, 1, 0.08, 0.05, 0.12],
    [-0.55, 0.028, 2, 1, 0.06, 0.12, 0.08],
    [-0.8, 0.17, 1, 1, 0.03, 0.05, 0.1],
    [-1.1, 0.42, 3, 1, 0.03, 0.022, 0.04],
];

const FlareVertex = /* glsl */ `
    ${FRAME_UNIFORMS}
    uniform sampler2D tColor;
    uniform vec2 uLightUv;
    uniform float uAspect;
    uniform float uScale;
    uniform float uExposure;
    attribute vec2 corner;
    attribute vec4 params;
    attribute vec3 tint;
    varying vec2 vAtlasUv;
    varying vec3 vColor;

    void main() {
        // Occlusion: fraction of sky in a small disc around the light (soft when partly covered).
        float vis = 0.0;

        for (int i = 0; i < 16; i++) {
            float a = float(i) * 2.39996323;
            vec2 o = vec2(cos(a) / uAspect, sin(a)) * 0.012 * sqrt((float(i) + 0.5) / 16.0);
            vec2 uv = uLightUv + o;
            float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
            vis += isSky(textureLod(tDepth, uv, 0.0).x) ? inside : 0.0;
        }

        vis /= 16.0;
        // Clouds over the sun: the sky there is no longer blinding.
        float glare = luma(textureLod(tColor, clamp(uLightUv, vec2(0.0), vec2(1.0)), 0.0).rgb) * uExposure;
        vis *= smoothstep(1.2, 5.0, glare);
        vec2 edge = min(uLightUv, 1.0 - uLightUv);
        vis *= smoothstep(-0.05, 0.08, min(edge.x, edge.y));

        vec2 lightNdc = uLightUv * 2.0 - 1.0;
        vec2 center = lightNdc * params.x;
        vec2 offset = corner * params.y * vec2(params.w / uAspect, 1.0);
        // Ghosts brighten as the light moves off-centre (more internal reflection).
        float ghost = params.x < 0.99 ? 0.5 + 0.7 * length(lightNdc) : 1.0;
        vColor = tint * uScale * vis * ghost;
        vAtlasUv = vec2((corner.x * 0.5 + 0.5 + params.z) / ${CELLS.toFixed(1)}, corner.y * 0.5 + 0.5);
        gl_Position = vis > 0.001 ? vec4(center + offset, 0.0, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
    }
`;

const FlareFragment = /* glsl */ `
    uniform sampler2D tAtlas;
    varying vec2 vAtlasUv;
    varying vec3 vColor;

    void main() {
        gl_FragColor = vec4(texture2D(tAtlas, vAtlasUv).rgb * vColor, 1.0);
    }
`;

/**
 * Screen-space lens flare for the sun: procedural sprites (glow + starburst, anamorphic streak,
 * hexagonal ghosts along the axis through the screen centre, halo ring) drawn additively into a half
 * resolution HDR target that the output pass adds before tone mapping (so it blooms and grades like
 * real light). Occlusion is tested in the vertex shader against the depth buffer and the sky
 * brightness at the sun, so terrain, trees and clouds hide it smoothly.
 *
 * (three's Lensflare object was evaluated: it copies the framebuffer for occlusion, which breaks with
 * multisampled HDR targets, and it would be jittered / blurred by TAA and depth of field.)
 */
export class LensFlare {
    private readonly target: THREE.WebGLRenderTarget;
    private readonly mesh: THREE.Mesh;
    private readonly material: THREE.ShaderMaterial;
    private readonly atlas: THREE.Texture;
    private readonly camera = new THREE.OrthographicCamera();
    readonly lightUv = new THREE.Vector2();
    private readonly clearColor = new THREE.Color();

    constructor(uniforms: FrameUniforms, width: number, height: number) {
        this.target = colorTarget(
            scaledSize(width, 0.5),
            scaledSize(height, 0.5),
        );
        this.atlas = createAtlas();
        const corners: number[] = [];
        const params: number[] = [];
        const tints: number[] = [];
        const index: number[] = [];

        ELEMENTS.forEach((e, i) => {
            for (const [x, y] of [
                [-1, -1],
                [1, -1],
                [1, 1],
                [-1, 1],
            ]) {
                corners.push(x, y);
                params.push(e[0], e[1], e[2], e[3]);
                tints.push(e[4], e[5], e[6]);
            }

            index.push(
                i * 4,
                i * 4 + 1,
                i * 4 + 2,
                i * 4,
                i * 4 + 2,
                i * 4 + 3,
            );
        });

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
            'position',
            new THREE.Float32BufferAttribute(
                new Float32Array((corners.length / 2) * 3),
                3,
            ),
        );
        geometry.setAttribute(
            'corner',
            new THREE.Float32BufferAttribute(corners, 2),
        );
        geometry.setAttribute(
            'params',
            new THREE.Float32BufferAttribute(params, 4),
        );
        geometry.setAttribute(
            'tint',
            new THREE.Float32BufferAttribute(tints, 3),
        );
        geometry.setIndex(index);
        this.material = new THREE.ShaderMaterial({
            name: 'WaterwaysLensFlare',
            uniforms: {
                ...uniforms,
                tColor: { value: null },
                tAtlas: { value: this.atlas },
                uLightUv: { value: this.lightUv },
                uAspect: { value: 1 },
                uScale: { value: 1 },
                uExposure: { value: 1 },
            },
            vertexShader: FlareVertex,
            fragmentShader: FlareFragment,
            blending: THREE.AdditiveBlending,
            depthTest: false,
            depthWrite: false,
            transparent: true,
            toneMapped: false,
        });
        this.mesh = new THREE.Mesh(geometry, this.material);
        this.mesh.frustumCulled = false;
    }

    get texture(): THREE.Texture {
        return this.target.texture;
    }

    setSize(width: number, height: number): void {
        this.target.setSize(scaledSize(width, 0.5), scaledSize(height, 0.5));
    }

    /**
     * `scale` is the flare brightness in display units (intensity × light strength); `exposure` the
     * display exposure used to convert to HDR scene units and to judge the sky's brightness.
     */
    render(
        renderer: THREE.WebGLRenderer,
        sceneColor: THREE.Texture,
        scale: number,
        exposure: number,
        aspect: number,
    ): void {
        const u = this.material.uniforms;
        u.tColor.value = sceneColor;
        u.uAspect.value = aspect;
        u.uScale.value = scale / Math.max(1e-4, exposure);
        u.uExposure.value = exposure;
        renderer.getClearColor(this.clearColor);
        const alpha = renderer.getClearAlpha();
        renderer.setRenderTarget(this.target);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, false, false);
        renderer.render(this.mesh, this.camera);
        renderer.setClearColor(this.clearColor, alpha);
    }

    dispose(): void {
        this.target.dispose();
        this.mesh.geometry.dispose();
        this.material.dispose();
        this.atlas.dispose();
    }
}
