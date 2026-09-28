import * as THREE from 'three/webgpu';
import {
    attribute,
    float,
    Fn,
    ivec2,
    passTexture,
    texture,
    uniform,
    varying,
    vec2,
    vec4,
} from 'three/tsl';
import type { FrameContext, TextureNode, Vec4Node } from './common';
import { luma, ScreenPass } from './common';

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

/**
 * Screen-space lens flare for the sun: procedural sprites (glow + starburst, anamorphic streak,
 * hexagonal ghosts along the axis through the screen centre, halo ring) drawn additively into a half
 * resolution HDR target that the output pass adds before tone mapping (so it blooms and grades like
 * real light). Occlusion is measured in a 1×1 pass against the depth buffer and the sky brightness at
 * the sun, so terrain, trees and clouds hide it smoothly; hidden sprites are culled in the vertex stage.
 */
export class LensFlare extends THREE.TempNode {
    /** 1×1 occlusion: r = visible fraction of the sun disc. */
    readonly visibility = new ScreenPass('Lens flare', {
        size: [1, 1],
        filter: THREE.NearestFilter,
    });
    /** Light position in screen UV (TSL convention, origin top left). */
    readonly lightUv = uniform(new THREE.Vector2(0.5, 0.5));
    private readonly aspect = uniform(1);
    private readonly brightness = uniform(1);
    private readonly exposure = uniform(1);
    private readonly target: THREE.RenderTarget;
    private readonly mesh: THREE.Mesh;
    private readonly material = new THREE.NodeMaterial();
    private readonly atlas = createAtlas();
    private readonly camera = new THREE.OrthographicCamera();
    private readonly output: TextureNode;
    private readonly clearColor = new THREE.Color();
    /** Post chain scale relative to the drawing buffer. */
    scale = 1;
    private hidden: THREE.Texture | null = null;

    constructor(f: FrameContext, sceneColor: TextureNode) {
        super('vec4');
        this.updateBeforeType = THREE.NodeUpdateType.FRAME;
        this.target = new THREE.RenderTarget(1, 1, {
            depthBuffer: false,
            type: THREE.HalfFloatType,
            generateMipmaps: false,
        });
        this.target.texture.name = 'Lens flare';
        this.output = passTexture(
            this as unknown as THREE.PassNode,
            this.target.texture,
        ) as unknown as TextureNode;

        this.visibility.fragment = Fn(() => {
            const vis = float(0).toVar();

            for (let i = 0; i < 16; i++) {
                const a = i * 2.39996323;
                const r = 0.012 * Math.sqrt((i + 0.5) / 16);
                const p = this.lightUv
                    .add(
                        vec2(
                            float(Math.cos(a) * r).div(this.aspect),
                            Math.sin(a) * r,
                        ),
                    )
                    .toVar();
                const inside = p
                    .greaterThanEqual(vec2(0))
                    .all()
                    .and(p.lessThanEqual(vec2(1)).all());
                vis.addAssign(
                    inside
                        .and(f.isSky(f.rawDepth(p)))
                        .select(float(1), float(0)),
                );
            }

            vis.divAssign(16);
            // Clouds over the sun: the sky there is no longer blinding.
            const glare = luma(
                sceneColor.sample(this.lightUv.clamp(0, 1)).rgb,
            ).mul(this.exposure);
            vis.mulAssign(glare.smoothstep(1.2, 5));
            const edge = this.lightUv.min(this.lightUv.oneMinus());
            vis.mulAssign(edge.x.min(edge.y).smoothstep(-0.05, 0.08));

            return vec4(vis, 0, 0, 1);
        })() as Vec4Node;

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

        const corner = attribute<'vec2'>('corner', 'vec2');
        const param = attribute<'vec4'>('params', 'vec4');
        const tint = attribute<'vec3'>('tint', 'vec3');
        const vis = this.visibility.getTextureNode().load(ivec2(0, 0)).x;
        // Light position in NDC (y up).
        const lightNdc = this.lightUv.mul(vec2(2, -2)).add(vec2(-1, 1));
        // Ghosts brighten as the light moves off-centre (more internal reflection).
        const ghost = param.x
            .lessThan(0.99)
            .select(lightNdc.length().mul(0.7).add(0.5), float(1));
        const color = varying(tint.mul(this.brightness).mul(vis).mul(ghost));
        const atlasUv = varying(
            vec2(
                corner.x.mul(0.5).add(0.5).add(param.z).div(CELLS),
                corner.y.mul(0.5).add(0.5),
            ),
        );
        const position = lightNdc
            .mul(param.x)
            .add(corner.mul(param.y).mul(vec2(param.w.div(this.aspect), 1)));
        const m = this.material;
        m.name = 'Lens flare';
        m.vertexNode = vis
            .greaterThan(0.001)
            .select(vec4(position, 0, 1), vec4(2, 2, 2, 1));
        m.fragmentNode = vec4(texture(this.atlas, atlasUv).rgb.mul(color), 1);
        m.blending = THREE.AdditiveBlending;
        m.transparent = true;
        m.depthTest = false;
        m.depthWrite = false;
        this.mesh = new THREE.Mesh(geometry, m);
        this.mesh.name = 'Lens flare';
        this.mesh.frustumCulled = false;
    }

    getTextureNode(): TextureNode {
        return this.output;
    }

    /**
     * `brightness` is the flare strength in display units (intensity × light strength), `exposure` the
     * display exposure used to convert to HDR scene units and to judge the sky's brightness. A zero
     * brightness skips the pass (consumers read `black`).
     */
    setParams(
        brightness: number,
        exposure: number,
        aspect: number,
        black: THREE.Texture,
    ): void {
        this.brightness.value = brightness / Math.max(1e-4, exposure);
        this.exposure.value = exposure;
        this.aspect.value = aspect;
        this.hidden = brightness > 0 ? null : black;
        this.visibility.setBypass(this.hidden);
    }

    override updateBefore(frame: THREE.NodeFrame): boolean | undefined {
        if (this.hidden) {
            this.output.value = this.hidden;

            return undefined;
        }

        const renderer = frame.renderer as THREE.Renderer;
        renderer.getDrawingBufferSize(size);
        const w = Math.max(1, Math.round(size.x * 0.5 * this.scale));
        const h = Math.max(1, Math.round(size.y * 0.5 * this.scale));

        if (this.target.width !== w || this.target.height !== h) {
            this.target.setSize(w, h);
        }

        state = THREE.RendererUtils.resetRendererState(renderer, state);
        renderer.getClearColor(this.clearColor);
        renderer.setRenderTarget(this.target);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, false, false);
        renderer.render(this.mesh, this.camera);
        THREE.RendererUtils.restoreRendererState(renderer, state);
        this.output.value = this.target.texture;

        return undefined;
    }

    override setup(): THREE.Node {
        return this.output;
    }

    override dispose(): void {
        super.dispose();
        this.visibility.dispose();
        this.target.dispose();
        this.mesh.geometry.dispose();
        this.material.dispose();
        this.atlas.dispose();
    }
}

const size = new THREE.Vector2();
let state: ReturnType<typeof THREE.RendererUtils.resetRendererState>;
