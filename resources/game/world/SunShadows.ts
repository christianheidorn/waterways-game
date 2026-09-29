import * as THREE from 'three/webgpu';
import {
    Fn,
    If,
    float,
    lightShadowMatrix,
    min,
    mix,
    nodeObject,
    shadowPositionWorld,
    smoothstep,
    vec4,
} from 'three/tsl';
import type { ShadowQuality } from '../shared/types';

const SHADOW_MAP_SIZES: Record<ShadowQuality, number> = {
    off: 0,
    low: 1024,
    medium: 2048,
    high: 4096,
    ultra: 8192,
};

/**
 * Half-size of the near cascade as a fraction of the shadow distance (at least NEAR_MIN_RADIUS). Its
 * map has half the far map's resolution, so it holds twice the far cascade's texel density.
 */
const NEAR_FRACTION = 0.25;
const NEAR_MIN_RADIUS = 20;
/** Near → far cross-fade at the near cascade's edge, in near shadow-map UV (0.5 = its centre). */
const BLEND_START = 0.02;
const BLEND_END = 0.1;
/** The far cascade is re-rendered when the focus has moved this fraction of the shadow distance… */
const FAR_MOVE = 0.06;
/** …or the light has turned by more than this (cosine of 0.1°)… */
const FAR_TURN_COS = Math.cos(THREE.MathUtils.degToRad(0.1));
/** …or the world was edited (at most this often, in seconds, while edits keep coming). */
const EDIT_INTERVAL = 0.2;

/**
 * The near cascade as the GPU foliage culling sees it: its shadow camera (identifies its shadow pass)
 * and the world → cascade matrix whose x / y span [-1, 1] over the cascade's map.
 */
export type ShadowCascade = {
    readonly camera: THREE.Camera;
    readonly box: THREE.Matrix4;
};

/**
 * Stand-in "light" of one cascade: position, target and shadow, as three's shadow nodes expect. It is
 * not a light, so the lighting never sees it; it sits in the scene (as three's CSM lights do) because
 * the water reflection pauses every shadow in the scene while it renders (see WaterReflection).
 */
type CascadeLight = THREE.Object3D & {
    readonly target: THREE.Object3D;
    readonly shadow: THREE.DirectionalLightShadow;
};

function cascadeLight(
    name: string,
    shadow: THREE.DirectionalLightShadow,
): CascadeLight {
    const light = Object.assign(new THREE.Object3D(), {
        target: new THREE.Object3D(),
        shadow,
    });
    light.name = name;
    light.castShadow = true;

    return light;
}

type RenderObjectFunction = ReturnType<
    THREE.ShadowNode['getShadowRenderObjectFunction']
>;

/**
 * Shadow node of the cached far cascade: renders only while its shadow's `autoUpdate` is set (a
 * requested refresh, cleared once drawn) and leaves out live casters (the character), whose shadow
 * would stay behind in the cached map when they move. The request uses `autoUpdate`, not `needsUpdate`:
 * the water reflection pauses `autoUpdate` shadows while it renders (its pass swaps the foliage draws
 * for reflection ones), so the refresh always happens in the main view.
 */
class CachedShadowNode extends THREE.ShadowNode {
    constructor(
        private readonly cascade: CascadeLight,
        private readonly isLive: (object: THREE.Object3D) => boolean,
    ) {
        super(cascade as unknown as THREE.Light, cascade.shadow);
    }

    override getShadowRenderObjectFunction(
        renderer: THREE.Renderer,
        shadow?: THREE.LightShadow,
    ): RenderObjectFunction {
        // Asked for once per map render, right before it draws: the requested refresh is done.
        this.cascade.shadow.autoUpdate = false;
        const render = super.getShadowRenderObjectFunction(renderer, shadow);

        return (...args) => {
            if (!this.isLive(args[0])) {
                render(...args);
            }
        };
    }
}

/**
 * The sun's shadow term: the near cascade inside its square (cross-fading to the far one at its edge),
 * the far cascade elsewhere. Each branch only samples the map it needs.
 */
class CascadeBlendNode extends THREE.ShadowBaseNode {
    constructor(
        sun: THREE.DirectionalLight,
        private readonly near: THREE.Node<'float'>,
        private readonly far: THREE.Node<'float'>,
        private readonly nearLight: CascadeLight,
    ) {
        super(sun);
        // Both cascades are placed by SunShadows.update() before the frame renders.
        this.updateBeforeType = 'none';
    }

    override setup(builder: THREE.NodeBuilder): THREE.Node {
        return Fn(() => {
            this.setupShadowPosition(builder);
            const uv = lightShadowMatrix(
                this.nearLight as unknown as THREE.Light,
            ).mul(vec4(shadowPositionWorld as THREE.Node<'vec3'>, 1)).xy;
            const edge = min(
                min(uv.x, uv.y),
                min(uv.x.oneMinus(), uv.y.oneMinus()),
            );
            const weight = smoothstep(BLEND_START, BLEND_END, edge).toVar();
            const shadow = float(1).toVar();

            If(weight.greaterThan(0), () => {
                shadow.assign(this.near);
            });

            If(weight.lessThan(1), () => {
                shadow.assign(mix(this.far, shadow, weight));
            });

            return shadow;
        })();
    }
}

/**
 * The sun's shadow as two cascades centred on the focus point, UE-style (a live near cascade over a
 * cached far one, like its virtual shadow maps cache static pages):
 *
 * - near: a quarter of the shadow distance, twice the texel density, re-rendered every frame with
 *   every caster (the character, wind-swaying grass and trees). GPU-culled foliage draws a list
 *   culled to this cascade (see ShadowCascade).
 * - far: the whole shadow distance, cached. It is only re-rendered when the focus has moved a few
 *   percent of the distance, the sun has turned by 0.1° (time-of-day scrubbing, weather, day / night)
 *   or the world was edited (invalidate()): every frame while the sun is scrubbed, a few times a
 *   minute while walking, never while standing. Wind sway is frozen in it, which is invisible at
 *   that distance.
 *
 * Both are texel-snapped in light space (no shimmering); the far one keeps its placement between
 * refreshes (three samples a map with the matrix it was rendered with).
 */
export class SunShadows {
    private readonly near: CascadeLight;
    private readonly far: CascadeLight;
    private readonly nearCascade: ShadowCascade;
    private readonly liveRoots: THREE.Object3D[] = [];
    private enabled = false;
    private distance = 220;
    private nearRadius = 55;
    /** Focus and light direction the far cascade was last placed for (valid: no refresh needed). */
    private farValid = false;
    private readonly farFocus = new THREE.Vector3();
    private readonly farDirection = new THREE.Vector3();
    private editPending = false;
    private editTimer = 0;
    // Scratch objects (no per-frame allocations).
    private readonly lightRot = new THREE.Matrix4();
    private readonly lightRotInv = new THREE.Matrix4();
    private readonly tmpMatrix = new THREE.Matrix4();
    private readonly tmpCenter = new THREE.Vector3();
    private readonly tmpDir = new THREE.Vector3();
    private readonly origin = new THREE.Vector3();
    private readonly up = new THREE.Vector3(0, 1, 0);

    constructor(sun: THREE.DirectionalLight, scene: THREE.Scene) {
        this.near = cascadeLight('Sun near', sun.shadow.clone());
        this.far = cascadeLight('Sun far', sun.shadow.clone());
        this.far.shadow.autoUpdate = false;
        scene.add(this.near, this.near.target, this.far, this.far.target);
        this.nearCascade = {
            camera: this.near.shadow.camera,
            box: new THREE.Matrix4(),
        };

        const near = shadowTerm(
            new THREE.ShadowNode(
                this.near as unknown as THREE.Light,
                this.near.shadow,
            ),
        );
        const far = shadowTerm(
            new CachedShadowNode(this.far, (object) => this.isLive(object)),
        );
        // Read by three's light node in place of the default single-map shadow.
        Object.assign(sun.shadow, {
            shadowNode: new CascadeBlendNode(sun, near, far, this.near),
        });
    }

    /** The near cascade for GPU foliage culling (null while shadows are off). */
    get cascade(): ShadowCascade | null {
        return this.enabled ? this.nearCascade : null;
    }

    /** Map resolution and reach (m, from the focus) of the shadow, per the graphics settings. */
    configure(quality: ShadowQuality, distance: number): void {
        const size = SHADOW_MAP_SIZES[quality];
        this.enabled = size > 0;
        this.distance = distance;
        this.nearRadius = Math.min(
            distance,
            Math.max(NEAR_MIN_RADIUS, distance * NEAR_FRACTION),
        );

        if (!this.enabled) {
            return;
        }

        setupCascade(
            this.near.shadow,
            this.nearRadius,
            Math.max(512, size / 2),
        );
        setupCascade(this.far.shadow, distance, size);
        this.farValid = false;
    }

    /** Objects (and their descendants) that move on their own: only the near cascade draws them. */
    addLiveCaster(object: THREE.Object3D): void {
        this.liveRoots.push(object);
    }

    /** Casters changed (sculpting, foliage edits, ground cover regrowth): refresh the far cascade. */
    invalidate(): void {
        this.editPending = true;
    }

    /** Places the cascades around the focus; `direction` points towards the light. */
    update(dt: number, focus: THREE.Vector3, direction: THREE.Vector3): void {
        if (!this.enabled) {
            return;
        }

        this.lightRot.lookAt(
            this.origin,
            this.tmpDir.copy(direction).negate(),
            this.up,
        );
        this.lightRotInv.copy(this.lightRot).invert();

        const nearCenter = this.place(
            this.near,
            focus,
            direction,
            this.nearRadius,
        );
        // World → near cascade square (x, y in [-1, 1]) for the foliage culling.
        const r = this.nearRadius;
        this.nearCascade.box
            .copy(this.lightRotInv)
            .premultiply(
                this.tmpMatrix.makeTranslation(-nearCenter.x, -nearCenter.y, 0),
            )
            .premultiply(this.tmpMatrix.makeScale(1 / r, 1 / r, 1));

        this.editTimer -= dt;
        const last = this.farFocus;
        const refresh =
            !this.farValid ||
            Math.hypot(focus.x - last.x, focus.z - last.z) >
                this.distance * FAR_MOVE ||
            this.farDirection.dot(direction) < FAR_TURN_COS ||
            (this.editPending && this.editTimer <= 0);

        if (refresh) {
            this.place(this.far, focus, direction, this.distance);
            this.farValid = true;
            last.copy(focus);
            this.farDirection.copy(direction);
            this.editPending = false;
            this.editTimer = EDIT_INTERVAL;
            // Rendered with this frame's main view; cleared by CachedShadowNode once drawn.
            this.far.shadow.autoUpdate = true;
        }
    }

    private isLive(object: THREE.Object3D): boolean {
        for (let o: THREE.Object3D | null = object; o; o = o.parent) {
            if (this.liveRoots.includes(o)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Centres a cascade on the focus, snapped to its texels in light space so the map content doesn't
     * shimmer as the focus moves. Returns the snapped centre in light space.
     */
    private place(
        light: CascadeLight,
        focus: THREE.Vector3,
        direction: THREE.Vector3,
        radius: number,
    ): THREE.Vector3 {
        const texel = (radius * 2) / light.shadow.mapSize.x;
        const center = this.tmpCenter
            .copy(focus)
            .applyMatrix4(this.lightRotInv);
        center.x = Math.round(center.x / texel) * texel;
        center.y = Math.round(center.y / texel) * texel;
        const x = center.x;
        const y = center.y;
        center.applyMatrix4(this.lightRot);

        light.target.position.copy(center);
        light.position
            .copy(center)
            .addScaledVector(direction, radius * 3 + 1500);
        light.updateMatrixWorld();
        light.target.updateMatrixWorld();

        return center.set(x, y, 0);
    }
}

/** A shadow node as the float light factor it computes (three's typings leave it untyped). */
function shadowTerm(node: THREE.ShadowNode): THREE.Node<'float'> {
    return nodeObject(node) as unknown as THREE.Node<'float'>;
}

/** Orthographic frustum, map size and texel-relative biases of one cascade. */
function setupCascade(
    shadow: THREE.DirectionalLightShadow,
    radius: number,
    size: number,
): void {
    // The shadow node resizes its map to mapSize on the next render.
    shadow.mapSize.set(size, size);
    const cam = shadow.camera;
    cam.left = cam.bottom = -radius;
    cam.right = cam.top = radius;
    cam.near = 1;
    cam.far = radius * 6 + 4000;
    cam.updateProjectionMatrix();

    // Biases in shadow-map texels, not fixed values: the depth bias is normalised to the (km-long)
    // depth range, so a constant one pushed shadows ~2 m away from their casters and small objects
    // (the player, rocks, bushes) cast no shadow on the ground or themselves. Half a texel of depth
    // bias plus 1.5 texels along the normal keep flat ground at a grazing sun free of acne.
    const texel = (radius * 2) / size;
    shadow.bias = -(texel * 0.5) / (cam.far - cam.near);
    shadow.normalBias = texel * 1.5;
}
