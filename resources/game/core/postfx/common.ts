import * as THREE from 'three/webgpu';
import {
    context,
    getScreenPosition,
    getViewPosition,
    interleavedGradientNoise,
    passTexture,
    perspectiveDepthToViewZ,
    reference,
    screenCoordinate,
    texture,
    uniform,
    vec2,
    vec3,
    vec4,
} from 'three/tsl';
import type { ColorGrade } from '../../shared/types';

export type FloatNode = THREE.Node<'float'>;
export type Vec2Node = THREE.Node<'vec2'>;
export type Vec3Node = THREE.Node<'vec3'>;
export type Vec4Node = THREE.Node<'vec4'>;
export type TextureNode = THREE.TextureNode;

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

/**
 * Depth buffer access and view-space reconstruction shared by the depth based effects. Camera matrices
 * are referenced (not copied), so they always match the scene render, including the TAA jitter.
 * Screen UVs follow the TSL convention (origin top left) on both backends.
 */
export class FrameContext {
    readonly near: FloatNode;
    readonly far: FloatNode;
    readonly projection: THREE.UniformNode<'mat4', THREE.Matrix4>;
    readonly projectionInverse: THREE.UniformNode<'mat4', THREE.Matrix4>;
    /** Camera world matrix (view → world). */
    readonly cameraWorld: THREE.UniformNode<'mat4', THREE.Matrix4>;
    /** Frame counter for animated noise. */
    readonly frame = uniform(0);

    constructor(
        camera: THREE.PerspectiveCamera,
        /** Scene depth (hardware depth texture of the scene pass). */
        readonly depth: TextureNode,
    ) {
        this.near = reference('near', 'float', camera) as unknown as FloatNode;
        this.far = reference('far', 'float', camera) as unknown as FloatNode;
        this.projection = uniform(camera.projectionMatrix);
        this.projectionInverse = uniform(camera.projectionMatrixInverse);
        this.cameraWorld = uniform(camera.matrixWorld);
    }

    rawDepth(uv: Vec2Node): FloatNode {
        return this.depth.sample(uv).r as FloatNode;
    }

    /** Positive distance along the view axis in metres. */
    linearize(depth: FloatNode): FloatNode {
        return perspectiveDepthToViewZ(depth, this.near, this.far).negate();
    }

    linearDepth(uv: Vec2Node): FloatNode {
        return this.linearize(this.rawDepth(uv));
    }

    isSky(depth: FloatNode): THREE.Node<'bool'> {
        return depth.greaterThanEqual(0.9999999);
    }

    viewPosition(uv: Vec2Node, depth: FloatNode): Vec3Node {
        return getViewPosition(uv, depth, this.projectionInverse);
    }

    viewToUv(p: Vec3Node): Vec2Node {
        return getScreenPosition(p, this.projection);
    }

    /**
     * View-space normal from depth: the smaller of the two one-sided differences per axis (clean edges).
     * `texel` is one pixel of the depth buffer in UV units.
     */
    viewNormal(uv: Vec2Node, p: Vec3Node, texel: Vec2Node): Vec3Node {
        const at = (o: Vec2Node) => {
            const q = uv.add(o);

            return this.viewPosition(q, this.rawDepth(q));
        };
        const dx = vec2(texel.x, 0);
        const dy = vec2(0, texel.y);
        const l = at(dx.negate());
        const r = at(dx);
        const b = at(dy.negate());
        const t = at(dy);
        const hx = r.z.sub(p.z).abs().lessThan(p.z.sub(l.z).abs());
        const hy = t.z.sub(p.z).abs().lessThan(p.z.sub(b.z).abs());
        const ddx = hx.select(r.sub(p), p.sub(l));
        // Screen UV y points down: flip the vertical difference so the normal faces the camera.
        const ddy = hy.select(p.sub(t), b.sub(p));

        return ddx.cross(ddy).normalize();
    }

    /** Interleaved gradient noise (Jimenez), animated per frame. */
    noise(salt: number | FloatNode = 0): FloatNode {
        const offset = this.frame.add(salt).mod(64).mul(5.588238);

        return interleavedGradientNoise(screenCoordinate.add(offset));
    }
}

export function luma(c: Vec3Node): FloatNode {
    return c.dot(vec3(0.2126, 0.7152, 0.0722));
}

type ScreenPassOptions = {
    /** Size relative to the renderer's drawing buffer (ignored with `size`). */
    scale?: number;
    /** Fixed size in pixels. */
    size?: [number, number];
    type?: THREE.TextureDataType;
    filter?: THREE.MagnificationTextureFilter;
    /** Keeps the previous frame's result readable through `previous` (ping-pong targets). */
    feedback?: boolean;
};

const quad = new THREE.QuadMesh(new THREE.NodeMaterial());
const drawingSize = new THREE.Vector2();
let rendererState: ReturnType<typeof THREE.RendererUtils.resetRendererState>;

/**
 * One full-screen draw into its own render target, as a node: consumers sample `getTextureNode()` and
 * the pass renders (once per frame) right before the first draw that reads it. The render target and
 * the draw are named after the pass (the GPU profiler attributes its time by that name).
 *
 * A pass can be bypassed at runtime without rebuilding the graph: consumers then read a replacement
 * texture (e.g. the unmodified input, or a neutral 1×1 texture) and nothing is drawn.
 */
export class ScreenPass extends THREE.TempNode {
    /** Size relative to the drawing buffer. */
    scale: number;
    /** Pixel size of this pass' target (set before each draw). */
    readonly resolution = uniform(new THREE.Vector2(1, 1));
    /** The effect: a vec4 fragment node, sampling its inputs at `uv()`. */
    fragment: Vec4Node | null = null;
    /** Last frame's result (feedback passes only). */
    readonly previous: TextureNode;
    private readonly targets: THREE.RenderTarget[];
    private index = 0;
    private readonly material = new THREE.NodeMaterial();
    private readonly output: TextureNode;
    private readonly fixedSize: [number, number] | null;
    private replacement: THREE.Texture | null = null;
    private replacementSource: THREE.Node | null = null;

    constructor(
        readonly passName: string,
        options: ScreenPassOptions = {},
    ) {
        super('vec4');
        this.updateBeforeType = THREE.NodeUpdateType.FRAME;
        this.scale = options.scale ?? 1;
        this.fixedSize = options.size ?? null;
        const filter = options.filter ?? THREE.LinearFilter;
        const count = options.feedback ? 2 : 1;
        this.targets = Array.from({ length: count }, () => {
            const target = new THREE.RenderTarget(1, 1, {
                depthBuffer: false,
                type: options.type ?? THREE.HalfFloatType,
                minFilter: filter,
                magFilter: filter,
                generateMipmaps: false,
            });
            target.texture.name = passName;

            return target;
        });
        this.material.name = passName;
        this.previous = texture(this.targets[count - 1].texture);
        this.output = passTexture(
            this as unknown as THREE.PassNode,
            this.targets[0].texture,
        ) as unknown as TextureNode;
    }

    getTextureNode(): TextureNode {
        return this.output;
    }

    /** The texture currently holding this pass' result. */
    get texture(): THREE.Texture {
        return this.output.value;
    }

    get renderTarget(): THREE.RenderTarget {
        return this.targets[this.index];
    }

    /**
     * Skip the draw and let consumers read `replacement` instead (null resumes). `source` is the pass
     * node that produces the replacement; it is updated in this pass' place so it is current this frame.
     */
    setBypass(
        replacement: THREE.Texture | null,
        source: THREE.Node | null = null,
    ): void {
        this.replacement = replacement;
        this.replacementSource = source;
    }

    override updateBefore(frame: THREE.NodeFrame): boolean | undefined {
        if (this.replacement) {
            if (this.replacementSource) {
                frame.updateBeforeNode(this.replacementSource);
            }

            const image = this.replacement.image as {
                width?: number;
                height?: number;
            } | null;
            this.resolution.value.set(image?.width ?? 1, image?.height ?? 1);
            this.output.value = this.replacement;

            return undefined;
        }

        const renderer = frame.renderer as THREE.Renderer;
        let width: number;
        let height: number;

        if (this.fixedSize) {
            [width, height] = this.fixedSize;
        } else {
            renderer.getDrawingBufferSize(drawingSize);
            // Floored like the scene pass, so passes at the scene scale match its buffers texel for texel.
            width = Math.max(1, Math.floor(drawingSize.x * this.scale));
            height = Math.max(1, Math.floor(drawingSize.y * this.scale));
        }

        const feedback = this.targets.length > 1;
        const write = this.targets[feedback ? 1 - this.index : 0];

        if (feedback) {
            this.previous.value = this.targets[this.index].texture;
        }

        for (const target of this.targets) {
            if (target.width !== width || target.height !== height) {
                target.setSize(width, height);
            }
        }

        this.resolution.value.set(width, height);
        rendererState = THREE.RendererUtils.resetRendererState(
            renderer,
            rendererState,
        );
        renderer.setRenderTarget(write);
        quad.material = this.material;
        quad.name = this.passName;
        quad.render(renderer);
        THREE.RendererUtils.restoreRendererState(renderer, rendererState);

        if (feedback) {
            this.index = 1 - this.index;
        }

        this.output.value = write.texture;

        return undefined;
    }

    override setup(builder: THREE.NodeBuilder): THREE.Node {
        const shared = (
            builder as unknown as { getSharedContext(): object }
        ).getSharedContext();
        this.material.contextNode = context(shared) as never;
        this.material.fragmentNode = this.fragment ?? vec4(0);
        this.material.needsUpdate = true;

        return this.output;
    }

    override dispose(): void {
        super.dispose();

        for (const target of this.targets) {
            target.dispose();
        }

        this.material.dispose();
    }
}

/** 1×1 textures for bypassed passes (neutral inputs of the composite). */
export function solidTexture(r: number, g: number, b: number, a = 1) {
    const t = new THREE.DataTexture(
        new Uint8Array([r * 255, g * 255, b * 255, a * 255]),
        1,
        1,
    );
    t.needsUpdate = true;

    return t;
}
