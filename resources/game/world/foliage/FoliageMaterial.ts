import * as THREE from 'three/webgpu';
import {
    attribute,
    cameraPosition,
    dFdx,
    diffuseColor,
    dFdy,
    distance,
    dot,
    float,
    Fn,
    hash,
    log2,
    materialAO,
    materialEmissive,
    materialOpacity,
    materialRoughness,
    mix,
    max,
    normalGeometry,
    normalize,
    normalLocal,
    normalViewGeometry,
    normalWorld,
    positionGeometry,
    positionPrevious,
    positionWorld,
    sin,
    smoothstep,
    step,
    texture,
    textureSize,
    uniform,
    uv,
    varying,
    vec2,
    vec3,
    vec4,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { FoliageKind } from '../../shared/types';
import { LIGHTING_ONLY_ALBEDO } from '../TerrainDebugView';

/**
 * Foliage node materials (WebGPU and WebGL 2): wind sway, distance fade, density falloff and the
 * per-instance LOD split, applied in the vertex stage on top of any standard material (procedural
 * vertex-coloured meshes, GLB models, impostor cards).
 *
 * Instances are affine 3×4 transforms stored as three rows (xyz = rotation × scale, w = translation)
 * plus a data vec4 (x = rank within its cell for the density fade). Where the rows come from is up to
 * the caller: per-instance vertex attributes (CPU-culled cells, WebGL 2 fallback) or storage buffers
 * indexed through the GPU-culled visibility lists (WebGPU).
 */

/** Fraction of instances that are mid-transition in the density fade. */
export const RANK_FADE = 0.12;

/**
 * Which side of the per-instance LOD0 / LOD1 split a material draws: 'near' keeps instances closer
 * than the split distance (LOD0), 'far' those beyond it (LOD1), 'none' draws everything.
 */
export type LodRole = 'near' | 'far' | 'none';

type FloatUniform = THREE.UniformNode<'float', number>;

/**
 * Colour of the ground under a world position (x, z), linear, vertex-stage safe: the terrain's
 * TerrainMaterial.groundColor. Foliage roots blend into it.
 */
export type GroundColorSource = (xz: Node<'vec2'>) => Node<'vec3'>;

/**
 * How far a kind's roots take the ground colour: `strength` at the base (0-1), fading out by
 * `height` (instance space, i.e. metres at scale 1).
 */
export type RootTint = { strength: number; height: number };

/** Uniforms shared by every foliage material (one set per Foliage instance). */
export type FoliageGlobals = {
    time: FloatUniform;
    /** Wind time of the previous frame (motion vectors of swaying foliage for TAA / motion blur). */
    prevTime: FloatUniform;
    wind: FloatUniform;
    /** Horizontal direction the wind blows towards (unit x/z). */
    windDir: THREE.UniformNode<'vec2', THREE.Vector2>;
    camPos: THREE.UniformNode<'vec3', THREE.Vector3>;
    fadeScale: FloatUniform;
    density: FloatUniform;
    /** Sky irradiance (hemisphere sky colour × intensity) for leaf translucency. */
    skyLight: THREE.UniformNode<'color', THREE.Color>;
    /** Sun (or moon) colour × intensity for leaf translucency. */
    sunLight: THREE.UniformNode<'color', THREE.Color>;
    /** Direction towards the sun / moon. */
    sunDir: THREE.UniformNode<'vec3', THREE.Vector3>;
    /** Terrain colour for the roots; null without a terrain (e.g. the foliage preview). */
    groundColor: GroundColorSource | null;
    /** 1 replaces the albedo with a neutral grey (the editor's lighting-only view). */
    lightingOnly: FloatUniform;
};

/** Per-type uniforms (updated in place, e.g. when the cull distance changes). */
export type FoliageTypeUniforms = {
    fadeEnd: FloatUniform;
    /** x = falloff start (fraction of the cull distance), y = density left at the cull distance. */
    falloff: THREE.UniformNode<'vec2', THREE.Vector2>;
    /** Per-instance LOD0 → LOD1 switch distance (m, 3D); huge when unused. */
    lodSplit: FloatUniform;
};

export function createFoliageGlobals(
    groundColor: GroundColorSource | null = null,
): FoliageGlobals {
    return {
        time: uniform(0),
        prevTime: uniform(0),
        wind: uniform(0.4),
        windDir: uniform(new THREE.Vector2(0.84, 0.54)),
        camPos: uniform(new THREE.Vector3()),
        fadeScale: uniform(1),
        density: uniform(1),
        skyLight: uniform(new THREE.Color(0.5, 0.6, 0.75)),
        sunLight: uniform(new THREE.Color(0, 0, 0)),
        sunDir: uniform(new THREE.Vector3(0, 1, 0)),
        groundColor,
        lightingOnly: uniform(0),
    };
}

export type InstanceRows = {
    row0: Node<'vec4'>;
    row1: Node<'vec4'>;
    row2: Node<'vec4'>;
    data: Node<'vec4'>;
};

/** Builds the instance rows inside the vertex stage (called within a TSL Fn). */
export type InstanceSource = () => InstanceRows;

/** Instance rows from per-instance vertex attributes (see foliageInstanceAttributes). */
export const attributeInstance: InstanceSource = () => ({
    row0: attribute('iRow0', 'vec4'),
    row1: attribute('iRow1', 'vec4'),
    row2: attribute('iRow2', 'vec4'),
    data: attribute('iData', 'vec4'),
});

/** Names of the per-instance attributes read by attributeInstance (4 floats each). */
export const INSTANCE_ATTRIBUTES = ['iRow0', 'iRow1', 'iRow2', 'iData'];

export type FoliageMaterialOptions = {
    globals: FoliageGlobals;
    uniforms: FoliageTypeUniforms;
    /** Wind response: 0 rocks, 0.35 trees, 1 grass / bushes. */
    stiffness: number;
    /** Distance fade starts earlier and the density falloff applies (small foliage). */
    fade: boolean;
    role: LodRole;
    instance: InstanceSource;
    /** Instance rows of the shadow pass when it draws a different instance list. */
    shadowInstance?: InstanceSource;
    /** Roots blend into the terrain colour (see rootTint); null for kinds that keep their own. */
    root: RootTint | null;
};

/** Wind sway, distance fade and density falloff for one instance source; returns the world position. */
function foliagePosition(
    options: FoliageMaterialOptions,
    source: InstanceSource,
): Node {
    const { globals: g, uniforms: u, stiffness, fade, role } = options;

    return Fn(() => {
        const { row0, row1, row2, data } = source();
        const r0 = row0.toVar();
        const r1 = row1.toVar();
        const r2 = row2.toVar();
        const instPos = vec3(r0.w, r1.w, r2.w).toVar();
        const phase = dot(instPos.xz, vec2(0.071, 0.113));
        const w = attribute('wind', 'float');
        const bend = w.mul(w).mul(g.wind).mul(stiffness);
        // Sway along the wind plus a steady lean downwind. Instances are randomly yawed, so the
        // world-space wind direction is brought into instance space first (transpose × wind).
        const windLocal = r0.xyz.mul(g.windDir.x).add(r2.xyz.mul(g.windDir.y));
        const windDir = normalize(windLocal.xz.add(vec2(1e-5))).toVar();
        const swayed = (time: Node<'float'>) => {
            const gust = sin(time.mul(0.7).add(instPos.x.mul(0.01)))
                .mul(0.5)
                .add(0.5);
            const sway = sin(time.mul(1.9).add(phase))
                .mul(0.6)
                .add(sin(time.mul(3.7).add(phase.mul(1.7))).mul(0.25))
                .mul(gust.mul(0.6).add(0.4));
            const lean = bend.mul(0.22).mul(gust.mul(0.5).add(0.5));
            const offset = windDir
                .mul(sway.mul(bend).mul(0.35).add(lean))
                .add(
                    vec2(windDir.y.negate(), windDir.x).mul(
                        sway.mul(bend).mul(0.1),
                    ),
                );
            const q = positionGeometry;

            return vec3(q.x.add(offset.x), q.y, q.z.add(offset.y));
        };
        const p = swayed(g.time).toVar();
        const pPrev = swayed(g.prevTime).toVar();
        const camDist = distance(instPos.xz, g.camPos.xz);
        const fadeEnd = u.fadeEnd.mul(g.fadeScale);
        const fadeK = float(1)
            .sub(smoothstep(fadeEnd.mul(fade ? 0.7 : 0.92), fadeEnd, camDist))
            .toVar();

        if (fade) {
            const densityT = g.density
                .mul(
                    float(1).sub(
                        float(1)
                            .sub(u.falloff.y)
                            .mul(
                                smoothstep(
                                    u.falloff.x.mul(fadeEnd),
                                    fadeEnd,
                                    camDist,
                                ),
                            ),
                    ),
                )
                .mul(1 + RANK_FADE);
            fadeK.mulAssign(
                float(1).sub(
                    smoothstep(densityT.sub(RANK_FADE), densityT, data.x),
                ),
            );
        }

        if (role !== 'none') {
            // Per-instance LOD0 / LOD1 split (CPU cells): each side keeps its own instances.
            const d = distance(instPos, g.camPos);
            fadeK.mulAssign(
                role === 'near' ? step(d, u.lodSplit) : step(u.lodSplit, d),
            );
        }

        p.mulAssign(fadeK);
        pPrev.mulAssign(fadeK);
        // Rotation × uniform scale: the transformed normal only needs renormalising.
        normalLocal.assign(
            normalize(
                vec3(
                    dot(r0.xyz, normalGeometry),
                    dot(r1.xyz, normalGeometry),
                    dot(r2.xyz, normalGeometry),
                ),
            ),
        );

        const toWorld = (v: Node<'vec3'>) =>
            vec3(
                dot(r0.xyz, v).add(r0.w),
                dot(r1.xyz, v).add(r1.w),
                dot(r2.xyz, v).add(r2.w),
            );
        // Velocity pass: without this, three would take the untransformed geometry as the previous
        // position (motion vectors pointing at the origin smear TAA / TAAU and motion blur).
        positionPrevious.assign(toWorld(pPrev));

        return toWorld(p);
    })();
}

/**
 * Terrain colour at the instance's root and how much of it this vertex takes, computed per vertex
 * (the ground is sampled at the instance origin: every vertex of an instance gets the same colour)
 * and interpolated: rgb = ground colour, a = blend weight. A varying of its own rather than part of
 * the position node, so the shadow pass (which only runs the position) never samples the terrain.
 */
function rootTint(
    options: FoliageMaterialOptions,
    root: RootTint,
    groundColor: GroundColorSource,
): Node<'vec4'> {
    return varying(
        Fn(() => {
            const { row0, row2 } = options.instance();
            const xz = vec2(row0.w, row2.w).toVar();
            // A little brightness jitter per instance (≈ 3 cm buckets), like the terrain's own
            // macro variation.
            const jitter = hash(dot(xz, vec2(37.1, 91.7)).abs());
            const ground = groundColor(xz).mul(jitter.mul(0.12).add(0.94));
            const weight = float(1)
                .sub(smoothstep(0, root.height, positionGeometry.y))
                .mul(root.strength);

            return vec4(ground, weight);
        })(),
        'vFoliageRoot',
    );
}

/** Indirect light left at the very base of a plant (blades shade each other's roots). */
const ROOT_OCCLUSION = 0.5;

/**
 * Foliage node material that can take the terrain's look near the ground (like a runtime virtual
 * texture read at the base of each blade): albedo blended towards the ground colour after the map and
 * vertex colours (so procedural and baked foliage both get it), a dull ground-like roughness, and
 * occlusion of the sky light, which would otherwise light the roots much brighter and bluer than the
 * ground around them. The shadow pass (a separate override material) skips all of it.
 */
class FoliageNodeMaterial extends THREE.MeshStandardNodeMaterial {
    private rootTint: Node<'vec4'> | null = null;

    setRootTint(tint: Node<'vec4'>): void {
        this.rootTint = tint;
        this.roughnessNode = mix(materialRoughness, 1, tint.a);
        const occlusion = mix(1, ROOT_OCCLUSION, tint.a);
        this.aoNode = this.aoMap ? materialAO.mul(occlusion) : occlusion;
    }

    override setupDiffuseColor(builder: THREE.NodeBuilder): void {
        super.setupDiffuseColor(builder);

        if (this.rootTint) {
            diffuseColor.rgb.assign(
                mix(diffuseColor.rgb, this.rootTint.rgb, this.rootTint.a),
            );
        }
    }
}

/** Node-material copy of any standard / node material (GLB materials are classic ones). */
export function toNodeMaterial<
    M extends THREE.MeshStandardNodeMaterial = THREE.MeshStandardNodeMaterial,
>(source: THREE.Material, material: M): M {
    material.copy(source as unknown as THREE.MeshStandardNodeMaterial);
    material.name = source.name;

    return material;
}

/**
 * Double-sided foliage keeps the geometry normal on back faces: blade and leaf-card normals are bent
 * upwards, flipping them would render the back of every blade dark.
 */
export function keepBackFaceNormals(material: THREE.NodeMaterial): void {
    const m = material as THREE.MeshStandardNodeMaterial;

    if (m.side === THREE.DoubleSide && !m.normalMap && !m.bumpMap) {
        m.normalNode = normalViewGeometry;
    }
}

/**
 * Alpha-tested leaf textures lose coverage in smaller mips (averaged alpha drops below the cutoff and
 * distant canopies turn bare); alpha is scaled up with the mip level.
 */
function mipAlphaBoost(material: THREE.MeshStandardNodeMaterial): void {
    const map = material.map;

    if (!map || material.alphaTest <= 0) {
        return;
    }

    const size = textureSize(texture(map)) as unknown as Node<'ivec2'>;
    const texel = uv().mul(vec2(size));
    const dx = dFdx(texel);
    const dy = dFdy(texel);
    const mip = log2(max(dot(dx, dx), dot(dy, dy)))
        .mul(0.5)
        .max(0);
    material.opacityNode = materialOpacity.mul(mip.mul(0.25).add(1));
}

/** Foliage material for one LOD (or material group) of a type. */
export function createFoliageMaterial(
    source: THREE.Material,
    options: FoliageMaterialOptions,
): THREE.MeshStandardNodeMaterial {
    const material = toNodeMaterial(source, new FoliageNodeMaterial());
    material.positionNode = foliagePosition(options, options.instance);

    if (options.root && options.globals.groundColor) {
        material.setRootTint(
            rootTint(options, options.root, options.globals.groundColor),
        );
    }

    if (options.shadowInstance) {
        material.castShadowPositionNode = foliagePosition(
            options,
            options.shadowInstance,
        );
    }

    keepBackFaceNormals(material);
    mipAlphaBoost(material);

    if (options.stiffness > 0) {
        leafTranslucency(material, options.globals);
    }

    lightingOnlyAlbedo(material, options.globals);

    return material;
}

/**
 * Lighting-only view: the diffuse colour is replaced after the material has set it up (texture,
 * vertex and instance colours included; alpha and its cutout stay), so only the lighting remains.
 */
function lightingOnlyAlbedo(
    material: THREE.MeshStandardNodeMaterial,
    g: FoliageGlobals,
): void {
    const setup = material.setupDiffuseColor.bind(material);
    material.setupDiffuseColor = (builder) => {
        setup(builder);
        diffuseColor.rgb.assign(
            mix(diffuseColor.rgb, vec3(LIGHTING_ONLY_ALBEDO), g.lightingOnly),
        );
    };
}

/**
 * Light transmitted through leaves and blades (thin, translucent): sky light passing through the
 * canopy, strongest on the undersides the sky doesn't reach directly, plus a glow when the sun or moon
 * is behind them. Without it, foliage lit only by the (dark) ground from below turns near-black under
 * overcast skies. Leaves are told apart from trunks and stems by the wind weight (rooted parts barely
 * sway) and by colour (bark isn't green).
 */
function leafTranslucency(
    material: THREE.MeshStandardNodeMaterial,
    g: FoliageGlobals,
): void {
    const albedo = diffuseColor.rgb;
    const green = albedo.g
        .sub(max(albedo.r, albedo.b))
        .div(max(albedo.g, 1e-3))
        .mul(4)
        .clamp(0, 1);
    const leaf = smoothstep(0.2, 0.45, attribute('wind', 'float')).mul(
        mix(0.35, 1, green),
    );
    const underside = normalWorld.y.mul(-0.5).add(0.5);
    const sky = g.skyLight.mul(mix(0.18, 0.45, underside));
    const toCamera = normalize(cameraPosition.sub(positionWorld));
    const backlit = max(dot(toCamera.negate(), g.sunDir), 0).pow(4);
    const sun = g.sunLight.mul(backlit.mul(0.25));
    material.emissiveNode = materialEmissive.add(
        albedo.mul(sky.add(sun)).mul(leaf),
    );
}

/**
 * Root tint per kind: strength at the base and the height it fades out by, as a fraction of the
 * LOD0 height. Grass takes the ground colour fully at the base, flowers and reeds up their stems a
 * little less, bushes and rocks only a hint where they meet the ground; trees keep their bark.
 */
const ROOT_TINT: Partial<
    Record<FoliageKind, { strength: number; fraction: number }>
> = {
    grass: { strength: 1, fraction: 0.38 },
    flower: { strength: 0.8, fraction: 0.3 },
    reed: { strength: 0.7, fraction: 0.25 },
    bush: { strength: 0.35, fraction: 0.18 },
    rock: { strength: 0.3, fraction: 0.12 },
};

/** Root tint of a kind whose LOD0 is `height` tall (instance space); null when it has none. */
export function rootTintFor(
    kind: FoliageKind,
    height: number,
): RootTint | null {
    const tint = ROOT_TINT[kind];

    return tint && height > 0
        ? { strength: tint.strength, height: height * tint.fraction }
        : null;
}

/** Wind response per kind: rocks are rigid, trees sway less than grass and bushes. */
export function windStiffness(kind: string): number {
    return kind === 'rock'
        ? 0
        : kind === 'conifer' || kind === 'broadleaf' || kind === 'palm'
          ? 0.35
          : 1;
}
