import { bounceSkyVisibility } from '../bounce/BounceLight';
import * as THREE from 'three/webgpu';
import {
    abs,
    attribute,
    cameraPosition,
    cameraViewMatrix,
    clamp,
    cross,
    dFdx,
    diffuseColor,
    dFdy,
    distance,
    dot,
    float,
    floor,
    Fn,
    hash,
    If,
    interleavedGradientNoise,
    length,
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
    screenCoordinate,
    sin,
    smoothstep,
    step,
    texture,
    textureSize,
    uniform,
    uniformArray,
    uv,
    varying,
    varyingProperty,
    vec2,
    vec3,
    vec4,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { FoliageKind } from '../../shared/types';
import { gnoise } from '../SkyDome';
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
/** Width of thinned-out small foliage: kept share ^ -THIN_WIDEN, at most THIN_WIDEN_MAX. */
const THIN_WIDEN = 0.4;
const THIN_WIDEN_MAX = 1.6;

/** Recent positions of the character(s) that push grass aside (see Foliage.setInteractors). */
export const INTERACTORS = 8;

/**
 * Width of the dithered LOD cross-fade band as a fraction of each switch distance (the band ends at
 * the switch). Also the fade band at the end of the foliage shadows.
 */
export const LOD_FADE_BAND = 0.12;

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
    /** Travelling gusts: x = strength (0 = steady wind), y = 1 / patch size (1/m). */
    gust: THREE.UniformNode<'vec2', THREE.Vector2>;
    /** Downwind offset of the gust field (m), accumulated so speed changes never jump. */
    gustOffset: THREE.UniformNode<'vec2', THREE.Vector2>;
    /** Character trail: xyz = position, w = push strength (0 = unused), newest first. */
    interactors: THREE.UniformArrayNode<'vec4'>;
    /** Radius (m) around an interactor within which grass bends away. */
    interactRadius: FloatUniform;
    /** Width of the dithered LOD cross-fade band (fraction of the switch distance; 0 = hard switches). */
    lodFade: FloatUniform;
    /** Per-frame dither offset (0-1) so TAA resolves the cross-fade; 0 keeps a fixed pattern. */
    ditherFrame: FloatUniform;
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
        gust: uniform(new THREE.Vector2(0.5, 1 / 40)),
        gustOffset: uniform(new THREE.Vector2()),
        interactors: uniformArray<'vec4'>(
            Array.from({ length: INTERACTORS }, () => new THREE.Vector4()),
            'vec4',
        ),
        interactRadius: uniform(0.9),
        lodFade: uniform(LOD_FADE_BAND),
        ditherFrame: uniform(0),
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
    /** How far the plant bends away from the character (0 = not at all, 1 = grass). */
    interact?: number;
    /**
     * Dithered LOD cross-fade of GPU-culled draws: the dither range [lo, hi) this draw keeps for an
     * instance at `pos` (the neighbouring LOD keeps the complement), or for the LOD0 shadow casters
     * (`shadow`) the fade at the end of the shadow reach. Null: no fade.
     */
    lodRange?: ((pos: Node<'vec3'>, shadow: boolean) => Node<'vec2'>) | null;
};

/**
 * Interpolated dither range of the LOD cross-fade: x = lower, y = upper bound of the kept dither
 * values, z = 1 when the dither may change every frame (main pass with TAA; never in shadow maps).
 */
const lodFadeVarying = () => varyingProperty('vec3', 'vFoliageLodFade');

/** 0 → 1 across the cross-fade band that ends at `at` (m). */
export function lodBandT(
    g: FoliageGlobals,
    d: Node<'float'>,
    at: Node<'float'>,
): Node<'float'> {
    const band = at.mul(g.lodFade).max(1e-3);

    return d.sub(at.sub(band)).div(band).clamp(0, 1);
}

/**
 * Discards the fragments this LOD leaves to its neighbour (screen-space dither, shadow maps too). The
 * mask is only part of the shader while cross-fades are on (see setLodFadeMask): a discard costs
 * early depth testing, so with hard switches it is left out.
 */
function lodFadeMask(material: THREE.NodeMaterial, g: FoliageGlobals): void {
    const range = lodFadeVarying();
    const n = interleavedGradientNoise(screenCoordinate.xy)
        .add(g.ditherFrame.mul(range.z))
        .fract();
    material.userData.lodFadeMask = n
        .greaterThanEqual(range.x)
        .and(n.lessThan(range.y)) as unknown as Node<'bool'>;
    setLodFadeMask(material, g.lodFade.value > 0);
}

/** Adds (or removes) a foliage material's cross-fade mask; the material recompiles on change. */
export function setLodFadeMask(
    material: THREE.Material,
    enabled: boolean,
): void {
    const m = material as THREE.NodeMaterial;
    const mask = (m.userData.lodFadeMask as Node<'bool'> | undefined) ?? null;
    const next = enabled ? mask : null;

    if (mask && m.maskNode !== next) {
        m.maskNode = next;
        m.needsUpdate = true;
    }
}

/**
 * Travelling gust field (0-1) at a world position: gradient noise scrolled downwind, so gust fronts
 * sweep across fields and canopies as visible waves.
 */
function gustField(
    g: FoliageGlobals,
    xz: Node<'vec2'>,
    offset: Node<'vec2'>,
    time: Node<'float'>,
): Node<'float'> {
    const p = xz.sub(offset).mul(g.gust.y).toVar();
    const n = gnoise(p)
        .mul(0.65)
        .add(gnoise(p.mul(2.3).add(vec2(17.3, time.mul(0.05)))).mul(0.35));

    return smoothstep(-0.15, 0.6, n);
}

/** Horizontal push away from the character trail (world x / z, length ≤ 1). */
function interactionPush(g: FoliageGlobals, pos: Node<'vec3'>): Node<'vec2'> {
    const push = vec2(0).toVar();

    for (let i = 0; i < INTERACTORS; i++) {
        const q = g.interactors.element(i);
        const d = pos.xz.sub(q.xz);
        const dist = length(d);
        const near = float(1)
            .sub(smoothstep(g.interactRadius.mul(0.25), g.interactRadius, dist))
            .mul(q.w)
            .mul(step(abs(pos.y.sub(q.y)), 2.5));
        push.addAssign(d.div(dist.max(1e-3)).mul(near));
    }

    return push.div(length(push).max(1));
}

/**
 * Wind sway (with travelling gusts), grass bending around the character, distance fade, density
 * falloff and the LOD cross-fade range for one instance source; returns the world position. `shadow`
 * builds the variant of the shadow pass (its own instance list and fade).
 */
function foliagePosition(
    options: FoliageMaterialOptions,
    source: InstanceSource,
    shadow = false,
): Node {
    const { globals: g, uniforms: u, stiffness, fade } = options;
    const interact = options.interact ?? 0;

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
        // Travelling gusts: patches of stronger wind sweep downwind (calmer between them). Evaluated
        // once (also for last frame's position: the field moves a few centimetres per frame).
        const field = gustField(g, instPos.xz, g.gustOffset, g.time).toVar();
        const swayed = (time: Node<'float'>) => {
            const gust = sin(time.mul(0.7).add(instPos.x.mul(0.01)))
                .mul(0.5)
                .add(0.5);
            const gusting = float(1)
                .add(g.gust.x.mul(field.mul(1.5).sub(0.4)))
                .max(0.1);
            const sway = sin(time.mul(1.9).add(phase))
                .mul(0.6)
                .add(sin(time.mul(3.7).add(phase.mul(1.7))).mul(0.25))
                .mul(gust.mul(0.6).add(0.4))
                .mul(gusting);
            const lean = bend
                .mul(0.22)
                .mul(gust.mul(0.5).add(0.5))
                .mul(gusting)
                .add(bend.mul(0.25).mul(g.gust.x).mul(field));
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

        if (interact > 0) {
            // Bent away from the character: tips move furthest, roots stay put (the push is
            // brought into instance space like the wind).
            const push = vec2(0).toVar();

            // Skipped while there is no character (editor camera) or the switch is off.
            If(g.interactors.element(0).w.greaterThan(0), () => {
                push.assign(interactionPush(g, instPos).mul(interact));
            });

            const amount = length(push);
            const local = r0.xyz.mul(push.x).add(r2.xyz.mul(push.y)).xz;
            const dir = local.div(length(local).max(1e-5)).mul(amount);
            const h = positionGeometry.y.max(0);
            const bent = vec3(
                dir.x.mul(h).mul(0.85),
                h.mul(amount.mul(amount).mul(-0.45)),
                dir.y.mul(h).mul(0.85),
            );
            p.addAssign(bent);
            pPrev.addAssign(bent);
        }

        const camDist = distance(instPos.xz, g.camPos.xz);
        const fadeEnd = u.fadeEnd.mul(g.fadeScale);
        const fadeK = float(1)
            .sub(smoothstep(fadeEnd.mul(fade ? 0.7 : 0.92), fadeEnd, camDist))
            .toVar();

        if (fade) {
            // Share of the instances kept at this distance (1 near the camera, falloff.y far away).
            const kept = float(1)
                .sub(
                    float(1)
                        .sub(u.falloff.y)
                        .mul(
                            smoothstep(
                                u.falloff.x.mul(fadeEnd),
                                fadeEnd,
                                camDist,
                            ),
                        ),
                )
                .toVar();
            const densityT = g.density.mul(kept).mul(1 + RANK_FADE);
            fadeK.mulAssign(
                float(1).sub(
                    smoothstep(densityT.sub(RANK_FADE), densityT, data.x),
                ),
            );
            // Fewer, slightly wider blades: the survivors widen as the density thins out, so the
            // ground stays about as covered (half the blades → about 1.3× as wide).
            const widen = kept.max(0.05).pow(-THIN_WIDEN).min(THIN_WIDEN_MAX);
            p.assign(vec3(p.x.mul(widen), p.y, p.z.mul(widen)));
            pPrev.assign(vec3(pPrev.x.mul(widen), pPrev.y, pPrev.z.mul(widen)));
        }

        fadeK.mulAssign(lodSplitFade(options, instPos, shadow));

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
 * The per-instance LOD split of the CPU cells and the dithered LOD cross-fade: returns 0 for
 * instances this draw leaves out entirely, and sets the dither range of the rest (lodFadeVarying).
 *
 * - GPU-culled draws get their range from `options.lodRange` (the culling pass lists instances in the
 *   band for both LODs).
 * - CPU cells split LOD0 / LOD1 per instance: 'near' keeps instances up to the split and fades them
 *   out over the band before it, 'far' fades in over that band. Their shadows (LOD0 only) fade out
 *   over the same band.
 */
function lodSplitFade(
    options: FoliageMaterialOptions,
    instPos: Node<'vec3'>,
    shadow: boolean,
): Node<'float'> {
    const { globals: g, uniforms: u, role } = options;
    const range = lodFadeVarying();
    const temporal = shadow ? 0 : 1;

    if (options.lodRange) {
        range.assign(vec3(options.lodRange(instPos, shadow), temporal));

        return float(1);
    }

    if (role === 'none') {
        return float(1);
    }

    const d = distance(instPos, g.camPos);
    const t = lodBandT(g, d, u.lodSplit);

    if (role === 'near') {
        range.assign(vec3(t, 2, temporal));

        return step(d, u.lodSplit);
    }

    range.assign(vec3(-1, t, temporal));
    const band = u.lodSplit.mul(g.lodFade);

    return step(u.lodSplit.sub(band), d);
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

/** The material cross-fades (or splits) LODs per instance and needs the dither mask. */
function hasLodFade(options: FoliageMaterialOptions): boolean {
    return !!options.lodRange || options.role !== 'none';
}

/** Foliage material for one LOD (or material group) of a type. */
export function createFoliageMaterial(
    source: THREE.Material,
    options: FoliageMaterialOptions,
): THREE.MeshStandardNodeMaterial {
    const material = toNodeMaterial(source, new FoliageNodeMaterial());
    const octahedral = octahedralImpostorInfo(source);
    // Trees (the kinds without a root tint): the bounce light's probes, ~10 m apart, average a crown
    // into its cell and would shade the outer leaves like the inner ones; they keep part of the sky.
    material.userData.bounceOcclusion = options.root ? 1 : TREE_SKY_OCCLUSION;

    if (octahedral) {
        octahedralImpostor(material, octahedral, options);
        leafTranslucency(material, options.globals);
        lightingOnlyAlbedo(material, options.globals);

        return material;
    }

    material.positionNode = foliagePosition(options, options.instance);

    if (hasLodFade(options)) {
        lodFadeMask(material, options.globals);
        // The shadow pass fades its casters with a range of its own (no temporal dither).
        material.castShadowPositionNode = foliagePosition(
            options,
            options.shadowInstance ?? options.instance,
            true,
        );
    }

    if (options.root && options.globals.groundColor) {
        material.setRootTint(
            rootTint(options, options.root, options.globals.groundColor),
        );
    }

    if (options.shadowInstance && !hasLodFade(options)) {
        material.castShadowPositionNode = foliagePosition(
            options,
            options.shadowInstance,
            true,
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

/** How much of the bounce light's sky occlusion tree crowns take (see createFoliageMaterial). */
const TREE_SKY_OCCLUSION = 0.6;

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
    const occlusion = Number(material.userData.bounceOcclusion ?? 1);
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
    // Less sky gets through where the bounce light's probes see little of it (under other crowns).
    const sky = g.skyLight
        .mul(mix(0.18, 0.45, underside))
        .mul(bounceSkyVisibility(occlusion));
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

/** How far a kind bends away from the character: grass and flowers fully, bushes a little. */
export function interactionStrength(kind: string): number {
    return kind === 'grass' || kind === 'flower'
        ? 1
        : kind === 'reed'
          ? 0.8
          : kind === 'bush'
            ? 0.3
            : 0;
}

/** Wind response per kind: rocks are rigid, trees sway less than grass and bushes. */
export function windStiffness(kind: string): number {
    return kind === 'rock'
        ? 0
        : kind === 'conifer' || kind === 'broadleaf' || kind === 'palm'
          ? 0.35
          : 1;
}

// ---------------------------------------------------------------- octahedral impostors

/**
 * Bake data of an octahedral impostor material (FoliageBaker, glTF material extras): `frames` × `frames`
 * views over the upper hemisphere (hemi-octahedral layout, a view at every grid vertex), each an
 * orthographic image of the model's bounding sphere (`center`, `radius`, instance space) in `map`
 * (albedo, alpha = coverage) and `normalMap` (rgb = instance-space normal, a = depth).
 */
export type OctahedralImpostorInfo = {
    frames: number;
    radius: number;
    center: THREE.Vector3;
    map: THREE.Texture;
    normalMap: THREE.Texture | null;
};

export function octahedralImpostorInfo(
    material: THREE.Material,
): OctahedralImpostorInfo | null {
    const data = material.userData as {
        impostor?: string;
        frames?: number;
        radius?: number;
        center?: number[];
    };
    const m = material as THREE.MeshStandardMaterial;

    if (
        data?.impostor !== 'octahedral' ||
        !m.map ||
        !data.frames ||
        !data.radius ||
        data.center?.length !== 3
    ) {
        return null;
    }

    return {
        frames: data.frames,
        radius: data.radius,
        center: new THREE.Vector3(
            data.center[0],
            data.center[1],
            data.center[2],
        ),
        map: m.map,
        normalMap: m.normalMap ?? null,
    };
}

/** Upper-hemisphere octahedral encoding of a direction (y up, y ≥ 0) → [-1, 1]². */
function hemiOctEncode(d: Node<'vec3'>): Node<'vec2'> {
    const p = d.xz.div(abs(d.x).add(abs(d.y)).add(abs(d.z)));

    return vec2(p.x.add(p.y), p.x.sub(p.y));
}

function hemiOctDecode(e: Node<'vec2'>): Node<'vec3'> {
    const x = e.x.add(e.y).mul(0.5);
    const z = e.x.sub(e.y).mul(0.5);

    return normalize(vec3(x, float(1).sub(abs(x)).sub(abs(z)), z));
}

/** Right axis of a view looking along -dir with +y up (as the baker's cameras). */
function viewRight(dir: Node<'vec3'>): Node<'vec3'> {
    return normalize(cross(vec3(0, 1, 0), dir).add(vec3(1e-5, 0, 0)));
}

/**
 * Octahedral impostor (far LOD of baked trees and bushes): a camera-facing quad per instance that
 * shows the 4 baked views around the view direction (in instance space), blended bilinearly, with
 * the baked normals lit like the mesh. The quad covers the bounding sphere; each view's texture
 * coordinates come from projecting the quad onto that view's plane (exact for orthographic views, so
 * they interpolate linearly), clamped to the view's cell in the fragment stage.
 */
function octahedralImpostor(
    material: FoliageNodeMaterial,
    info: OctahedralImpostorInfo,
    options: FoliageMaterialOptions,
): void {
    const { globals: g, uniforms: u } = options;
    const n = info.frames;
    const radius = float(info.radius);
    const center = vec3(info.center.x, info.center.y, info.center.z);
    const cellA = varyingProperty('vec4', 'vOctCellA');
    const cellB = varyingProperty('vec4', 'vOctCellB');
    const weights = varyingProperty('vec4', 'vOctWeights');
    const grid = varyingProperty('vec2', 'vOctGrid');
    const row0 = varyingProperty('vec3', 'vOctRow0');
    const row1 = varyingProperty('vec3', 'vOctRow1');
    const row2 = varyingProperty('vec3', 'vOctRow2');

    material.positionNode = Fn(() => {
        const rows = options.instance();
        const r0 = rows.row0.toVar();
        const r1 = rows.row1.toVar();
        const r2 = rows.row2.toVar();
        const instPos = vec3(r0.w, r1.w, r2.w).toVar();
        // Camera in instance space (rotation × uniform scale: inverse = transpose / scale²).
        const d = g.camPos.sub(instPos);
        const s2 = dot(r0.xyz, r0.xyz);
        const camLocal = r0.xyz
            .mul(d.x)
            .add(r1.xyz.mul(d.y))
            .add(r2.xyz.mul(d.z))
            .div(s2);
        const toCam = camLocal.sub(center).toVar();
        // Seen from below: the horizon views.
        const view = normalize(
            vec3(toCam.x, max(toCam.y, 0), toCam.z).add(vec3(0, 1e-4, 0)),
        ).toVar();
        const right = viewRight(view).toVar();
        const up = cross(view, right).toVar();
        const corner = uv().mul(2).sub(1);
        const local = center
            .add(right.mul(corner.x).add(up.mul(corner.y)).mul(radius))
            .toVar();

        // The 4 views around the view direction and their bilinear weights.
        const cell = hemiOctEncode(view)
            .mul(0.5)
            .add(0.5)
            .mul(n - 1)
            .toVar();
        const g0 = clamp(floor(cell), 0, n - 2).toVar();
        const f = cell.sub(g0).clamp(0, 1).toVar();
        weights.assign(
            vec4(
                f.x.oneMinus().mul(f.y.oneMinus()),
                f.x.mul(f.y.oneMinus()),
                f.x.oneMinus().mul(f.y),
                f.x.mul(f.y),
            ),
        );
        grid.assign(g0);
        const frameUv = (ox: number, oy: number) => {
            const dir = hemiOctDecode(
                g0
                    .add(vec2(ox, oy))
                    .div(n - 1)
                    .mul(2)
                    .sub(1),
            ).toVar();
            const x = viewRight(dir).toVar();
            const y = cross(dir, x);
            const rel = local.sub(center);

            // Within the view's cell: u to the right, v down (image rows top first).
            return vec2(
                dot(rel, x).div(radius).mul(0.5).add(0.5),
                float(0.5).sub(dot(rel, y).div(radius).mul(0.5)),
            );
        };
        cellA.assign(vec4(frameUv(0, 0), frameUv(1, 0)));
        cellB.assign(vec4(frameUv(0, 1), frameUv(1, 1)));
        row0.assign(r0.xyz);
        row1.assign(r1.xyz);
        row2.assign(r2.xyz);

        // Distance fade, the LOD split and cross-fade, as for mesh LODs.
        const camDist = distance(instPos.xz, g.camPos.xz);
        const fadeEnd = u.fadeEnd.mul(g.fadeScale);
        const fadeK = float(1)
            .sub(smoothstep(fadeEnd.mul(0.92), fadeEnd, camDist))
            .toVar();
        fadeK.mulAssign(lodSplitFade(options, instPos, false));

        const p = local.mul(fadeK);
        normalLocal.assign(normalize(toCam));
        const world = vec3(
            dot(r0.xyz, p).add(r0.w),
            dot(r1.xyz, p).add(r1.w),
            dot(r2.xyz, p).add(r2.w),
        );
        positionPrevious.assign(world);

        return world;
    })();

    // premultiplied: rgb weighted by coverage (colour of the covered texels only where views differ).
    const sample = (map: THREE.Texture, premultiplied = false) => {
        const at = (ox: number, oy: number, local: Node<'vec2'>) => {
            const t = texture(
                map,
                grid.add(vec2(ox, oy)).add(local.clamp(0.002, 0.998)).div(n),
            );

            return premultiplied ? vec4(t.rgb.mul(t.a), t.a) : t;
        };

        return at(0, 0, cellA.xy)
            .mul(weights.x)
            .add(at(1, 0, cellA.zw).mul(weights.y))
            .add(at(0, 1, cellB.xy).mul(weights.z))
            .add(at(1, 1, cellB.zw).mul(weights.w));
    };

    const albedo = sample(info.map, true).toVar();
    material.colorNode = vec4(
        albedo.rgb.div(max(albedo.a, 1e-3)).mul(uniform(material.color)),
        1,
    );
    material.opacityNode = albedo.a;
    material.map = null;

    if (info.normalMap) {
        const nm = sample(info.normalMap).rgb.mul(2).sub(1);
        const nWorld = normalize(
            vec3(dot(row0, nm), dot(row1, nm), dot(row2, nm)),
        );
        material.normalNode = normalize(
            cameraViewMatrix.mul(vec4(nWorld, 0)).xyz,
        );
    }

    material.normalMap = null;
    material.side = THREE.FrontSide;

    if (hasLodFade(options)) {
        lodFadeMask(material, g);
    }

    if (material.alphaTest <= 0) {
        material.alphaTest = 0.5;
    }
}
