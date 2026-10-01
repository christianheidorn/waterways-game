import * as THREE from 'three/webgpu';
import {
    abs,
    cameraViewMatrix,
    clamp,
    cross,
    dFdx,
    dFdy,
    dot,
    float,
    floor,
    Fn,
    fract,
    fwidth,
    If,
    max,
    min,
    mix,
    nodeObject,
    normalize,
    normalWorldGeometry,
    output,
    positionView,
    positionWorld,
    pow,
    property,
    select,
    sign,
    sin,
    smoothstep,
    sqrt,
    step,
    uniform,
    uniformArray,
    vec2,
    vec3,
    vec4,
} from 'three/tsl';
import type { TerrainLayer, TerrainMaterialRef } from '../shared/types';
import { mulberry32, SimplexNoise } from '../util/noise';
import type { SplatMap } from './SplatMap';
import { TerrainDebugView } from './TerrainDebugView';
import { TERRAIN_SLOTS, TerrainTextures } from './TerrainTextures';
import { causticPattern, rainRipples } from './waterPatterns';
import { WATER_DEPTH_RANGE } from './Wetness';
import type { ShoreEffectsHook } from './water/Surf';

export type BrushOverlay = {
    x: number;
    z: number;
    radius: number;
    falloff: number;
    visible: boolean;
    color: THREE.Color;
};

/**
 * Layers shaded per pixel. The splat map may blend all 8 layers, but a pixel rarely has more than
 * two or three: the strongest four are picked per pixel and only those are sampled, which keeps
 * the texture fetches (and the shader) bounded no matter how many layers the map uses.
 */
const SHADED_LAYERS = 4;

/** Splat weight below which a layer is not shaded at all. */
const MIN_WEIGHT = 0.004;

type Float = THREE.Node<'float'>;
type Vec2 = THREE.Node<'vec2'>;
type Vec3 = THREE.Node<'vec3'>;
type Vec4 = THREE.Node<'vec4'>;

/**
 * Texture node that is never updated per draw. The terrain samples its data textures hundreds of
 * times per shader, and every sample is a texture node that three updates on each draw (UV
 * transform matrix, and on WebGL 2 a y-flip uniform) — the bulk of a terrain draw's CPU cost. None
 * of that changes here: the UVs are the shader's own and the y-flip of a data texture is always
 * off (the uniform's default). Samples (`.sample()` clones) keep the class.
 */
class FixedTextureNode extends THREE.TextureNode {}

Object.defineProperty(FixedTextureNode.prototype, 'updateType', {
    get: () => THREE.NodeUpdateType.NONE,
    // Assigned by the node constructor and set up; ignored.
    set: () => {},
});

function fixedTexture(value: THREE.Texture): THREE.TextureNode {
    return nodeObject(new FixedTextureNode(value));
}

function createUniforms(
    splat: SplatMap,
    size: number,
    resolution: number,
    textures: TerrainTextures,
    noise: THREE.Texture,
    macro: THREE.Texture,
    wet: THREE.Texture,
    trail: THREE.Texture,
) {
    const colorA = Array.from({ length: 8 }, () => new THREE.Color());
    const colorB = Array.from({ length: 8 }, () => new THREE.Color());
    // x: noise scale (m), y: variation, z: roughness, w: bump
    const params = Array.from(
        { length: 8 },
        () => new THREE.Vector4(8, 0.5, 0.9, 0.5),
    );
    // x: slot enabled, y: has material, z: tile size (m), w: height contrast
    const mat = Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, 4, 1));
    // x: roughness scale, y: normal strength, z: variation, w: large-scale (macro) variation
    const mat2 = Array.from(
        { length: 8 },
        () => new THREE.Vector4(1, 1, 0.5, 0),
    );
    const tint = Array.from({ length: 8 }, () => new THREE.Color(1, 1, 1));
    // Average albedo per layer (what the ground reads as from a distance; see groundColor).
    const ground = Array.from({ length: 8 }, () => new THREE.Color());

    return {
        uSplat0: fixedTexture(splat.textures[0]),
        uSplat1: fixedTexture(splat.textures[1]),
        uNoise: fixedTexture(noise),
        uMacro: fixedTexture(macro),
        uAlbedoArr: fixedTexture(textures.albedoRough),
        uDetailArr: fixedTexture(textures.normalAoHeight),
        uWet: fixedTexture(wet),
        uMapHalf: uniform(size / 2),
        uCell: uniform(size / (resolution - 1)),
        uRes: uniform(resolution),
        uColorA: uniformArray<'color'>(colorA, 'color'),
        uColorB: uniformArray<'color'>(colorB, 'color'),
        uParams: uniformArray<'vec4'>(params, 'vec4'),
        uMat: uniformArray<'vec4'>(mat, 'vec4'),
        uMat2: uniformArray<'vec4'>(mat2, 'vec4'),
        uTint: uniformArray<'color'>(tint, 'color'),
        uGround: uniformArray<'color'>(ground, 'color'),
        uBrush: uniform(new THREE.Vector4(0, 0, 0, 0.5)),
        uBrushVisible: uniform(0),
        uBrushColor: uniform(new THREE.Color(0.25, 0.75, 1)),
        uGridVisible: uniform(0),
        // Global weather (Weather.ts): rain wetness and snow cover, 0-1.
        uWeatherWet: uniform(0),
        uSnowCover: uniform(0),
        // Puddle fill (0-1, Weather: fills in rain, dries afterwards) and the current rain (ripples).
        uPuddle: uniform(0),
        uRain: uniform(0),
        // Seconds (animations) and the direction towards the sun / moon (caustic projection).
        uTime: uniform(0),
        uSunDir: uniform(new THREE.Vector3(0, 1, 0)),
        // Caustics: x intensity, y cell size (m), z depth reached (m), w enabled (graphics).
        uCaustics: uniform(new THREE.Vector4(0.8, 2.5, 4, 1)),
        // Footprints in snow (SnowTrail): print depth texture, its window (x / z centre, y size,
        // w active) and the print depth setting (0 = off).
        uTrail: fixedTexture(trail),
        uTrailInfo: uniform(new THREE.Vector4(0, 0, 51.2, 0)),
        uTrailDepth: uniform(0),
        /** CPU-side values behind the uniform arrays (edited in place by setLayers). */
        layers: { colorA, colorB, params, mat, mat2, tint, ground },
    };
}

export type TerrainUniforms = ReturnType<typeof createUniforms>;

/**
 * PBR terrain material: a MeshStandardNodeMaterial whose surface comes from
 *
 * - 8-layer splat blending with height-based transitions,
 * - per-layer PBR materials from the studio library (albedo, normal, roughness, AO, height)
 *   packed into texture arrays, sampled with anti-tiling (randomised offsets per noise cell),
 *   triplanar projection on steep slopes and a far-distance detail blend,
 * - procedural colour/noise shading for layers without a material,
 * - wet ground near water and after rain (darker, glossier: the roughness output feeds the
 *   screen-space reflections), snow cover, an editor brush overlay and grid,
 * - the editor's view modes (TerrainDebugView: lighting only, layers, slope, height, foliage
 *   density, wireframe).
 */
export class TerrainMaterial extends THREE.MeshStandardNodeMaterial {
    readonly uniforms: TerrainUniforms;
    /** Editor view modes (see TerrainDebugView). */
    readonly debug: TerrainDebugView;
    private textures: TerrainTextures;
    private layers: TerrainLayer[] = [];
    private readonly noise: THREE.DataTexture;
    private readonly macroNoise: THREE.DataTexture;
    private readonly blankWet: THREE.DataTexture;
    private readonly blankTrail: THREE.DataTexture;
    /** Albedo of the splat surface (see setupDiffuseColor). */
    private surfaceColor!: THREE.Node<'vec4'>;
    /** Beach surf on the ground (swash, wet sand, foam), from the water. */
    private shoreEffects: ShoreEffectsHook | null = null;

    constructor(
        splat: SplatMap,
        size: number,
        resolution: number,
        textureSize = 1024,
    ) {
        super({ roughness: 1, metalness: 0, envMapIntensity: 0.45 });
        this.name = 'Terrain';

        this.textures = this.createTextures(textureSize);
        this.noise = createNoiseTexture();
        this.macroNoise = createMacroTexture();
        // Placeholders until the real textures are connected; their formats and filters match
        // (the shader's sampling mode is chosen from the first texture a node sees).
        this.blankWet = new THREE.DataTexture(
            new Uint8Array(4),
            1,
            1,
            THREE.RGBAFormat,
        );
        this.blankWet.minFilter = this.blankWet.magFilter = THREE.LinearFilter;
        this.blankWet.needsUpdate = true;
        this.blankTrail = new THREE.DataTexture(
            new Uint8Array(1),
            1,
            1,
            THREE.RedFormat,
        );
        this.blankTrail.minFilter = this.blankTrail.magFilter =
            THREE.LinearFilter;
        this.blankTrail.wrapS = this.blankTrail.wrapT = THREE.RepeatWrapping;
        this.blankTrail.needsUpdate = true;

        this.uniforms = createUniforms(
            splat,
            size,
            resolution,
            this.textures,
            this.noise,
            this.macroNoise,
            this.blankWet,
            this.blankTrail,
        );
        this.debug = new TerrainDebugView(size);
        this.buildNodes();
    }

    get textureSize(): number {
        return this.textures.size;
    }

    /** Change the resolution of the material texture arrays (reloads all materials). */
    setTextureSize(size: number): void {
        if (size === this.textures.size) {
            return;
        }

        this.textures.dispose();
        this.textures = this.createTextures(size);
        this.uniforms.uAlbedoArr.value = this.textures.albedoRough;
        this.uniforms.uDetailArr.value = this.textures.normalAoHeight;
        this.setLayers(this.layers);
    }

    setLayers(layers: TerrainLayer[]): void {
        this.layers = layers;
        const { colorA, colorB, params, mat, mat2, tint } =
            this.uniforms.layers;
        const used = new Set<number>();

        for (let i = 0; i < TERRAIN_SLOTS; i++) {
            mat[i].x = 0;
        }

        for (const layer of layers) {
            const i = layer.slot;
            used.add(i);
            colorA[i].set(layer.color);
            colorB[i].set(layer.color_secondary);
            params[i].set(
                Math.max(0.1, layer.noise_scale),
                layer.variation,
                layer.roughness,
                layer.bump,
            );

            const ref = layerMaterial(layer);
            const tile = Math.max(
                0.05,
                layer.texture_scale || ref?.tile_size || 4,
            );
            mat[i].set(
                1,
                this.textures.isReady(i) && ref ? 1 : 0,
                tile,
                ref?.height_contrast ?? 1,
            );
            mat2[i].set(
                (layer.roughness_scale ?? 1) * (ref?.roughness_scale ?? 1),
                (layer.normal_strength ?? 1) * (ref?.normal_strength ?? 1),
                layer.variation,
                Math.max(0, layer.macro_variation ?? 1),
            );
            tint[i]
                .set(layer.tint ?? '#ffffff')
                .multiply(new THREE.Color(ref?.tint ?? '#ffffff'));

            void this.textures.load(i, ref, layer.roughness);
            this.updateGroundColor(i);
        }

        for (let i = 0; i < TERRAIN_SLOTS; i++) {
            if (!used.has(i)) {
                this.textures.clear(i);
            }
        }
    }

    /**
     * Terrain colour at a world position (x, z) as it reads from a few metres away: the layers'
     * average albedos weighted by the splat map, darkened where the ground is wet (shores, rain) and
     * whitened by snow cover. Foliage blends its roots into it. Built from this material's uniforms
     * (layer edits, material loads and weather apply without rebuilding the caller's shader); safe in
     * the vertex stage (explicit LOD, 3 texture samples).
     */
    groundColor(xz: Vec2): Vec3 {
        const u = this.uniforms;

        return Fn(() => {
            const splatUv = xz
                .add(u.uMapHalf)
                .div(u.uCell)
                .add(0.5)
                .div(u.uRes)
                .toVar();
            const s0 = u.uSplat0.sample(splatUv).level(float(0)).toVar();
            const s1 = u.uSplat1.sample(splatUv).level(float(0)).toVar();
            const weights = [s0.x, s0.y, s0.z, s0.w, s1.x, s1.y, s1.z, s1.w];
            let sum: Float = float(0);
            let color: Vec3 = vec3(0);

            // Cubed weights: the terrain's height blend lets the dominant layer cover most of a
            // mixed texel, a plain weighted average would look washed out next to it.
            weights.forEach((weight, i) => {
                const w = weight
                    .mul(weight)
                    .mul(weight)
                    .mul(u.uMat.element(i).x);
                sum = sum.add(w);
                color = color.add(u.uGround.element(i).mul(w));
            });

            const total = sum.toVar();
            // No enabled layer here: the first layer's colour (as the terrain shader does).
            const ground = vec3(0).toVar();
            ground.assign(u.uColorA.element(0));

            If(total.greaterThan(1e-5), () => {
                ground.assign(color.div(total));
            });

            // Wetness, rain and snow as in terrainSurface (flat ground, averaged puddles).
            const wet = u.uWet.sample(splatUv).level(float(0)).x.toVar();
            ground.mulAssign(mix(1, 0.55, wet));
            ground.mulAssign(
                mix(1, 0.62, u.uWeatherWet.mul(float(1).sub(wet.mul(0.5)))),
            );
            const cover = u.uSnowCover.mul(float(1).sub(wet.mul(0.8)));
            const snow = smoothstep(
                0,
                0.25,
                cover.mul(1.4).sub(float(1).sub(cover).mul(0.3)),
            );

            return mix(ground, vec3(0.86, 0.89, 0.93), snow);
        })();
    }

    /** Surf on the beaches (Water.surf.terrainHook): swash sheet, wet sand and foam; null removes it. */
    setShoreEffects(hook: ShoreEffectsHook | null): void {
        this.shoreEffects = hook;
        this.buildNodes();
        this.needsUpdate = true;
    }

    /** Weather-driven ground state: `wet` darkens and glosses everything (puddles on flat ground), `snow` whitens it. */
    setWeather(wet: number, snow: number): void {
        this.uniforms.uWeatherWet.value = wet;
        this.uniforms.uSnowCover.value = snow;
    }

    /**
     * Ground state texture (Wetness: RGBA8 on the splat grid): R wetness next to water, G water depth,
     * B puddle potential.
     */
    setWetness(texture: THREE.Texture): void {
        this.uniforms.uWet.value = texture;
    }

    /** Puddle fill (0-1) and the rain falling on them (0-1, ripples). */
    setPuddles(fill: number, rain: number): void {
        this.uniforms.uPuddle.value = fill;
        this.uniforms.uRain.value = rain;
    }

    /** Animation time (s) and the direction towards the sun or moon. */
    setFrame(time: number, lightDirection: THREE.Vector3): void {
        this.uniforms.uTime.value = time;
        this.uniforms.uSunDir.value.copy(lightDirection).normalize();
    }

    /** Caustics on shallow beds (environment) and the graphics switch. */
    setCaustics(
        intensity: number,
        scale: number,
        depth: number,
        enabled: boolean,
    ): void {
        this.uniforms.uCaustics.value.set(
            intensity,
            scale,
            depth,
            enabled && intensity > 0 ? 1 : 0,
        );
    }

    /** Footprints in snow: the trail texture and its window (shared vector, updated by SnowTrail). */
    setTrail(texture: THREE.Texture, info: THREE.Vector4): void {
        this.uniforms.uTrail.value = texture;
        this.uniforms.uTrailInfo.value = info;
    }

    /** Print depth (0 = no footprints). */
    setTrailDepth(depth: number): void {
        this.uniforms.uTrailDepth.value = depth;
    }

    setBrush(brush: BrushOverlay): void {
        this.uniforms.uBrush.value.set(
            brush.x,
            brush.z,
            brush.radius,
            brush.falloff,
        );
        this.uniforms.uBrushVisible.value = brush.visible ? 1 : 0;
        this.uniforms.uBrushColor.value.copy(brush.color);
    }

    hideBrush(): void {
        this.uniforms.uBrushVisible.value = 0;
    }

    setGridVisible(visible: boolean): void {
        this.uniforms.uGridVisible.value = visible ? 1 : 0;
    }

    override dispose(): void {
        this.noise.dispose();
        this.macroNoise.dispose();
        this.blankWet.dispose();
        this.blankTrail.dispose();
        this.textures.dispose();
        this.debug.dispose();
        super.dispose();
    }

    private createTextures(size: number): TerrainTextures {
        const textures = new TerrainTextures(size);
        textures.onSlotReady = (slot, ready) => {
            const mat = this.uniforms?.layers.mat;

            if (mat) {
                mat[slot].y = ready ? 1 : 0;
                this.updateGroundColor(slot);
            }
        };

        return textures;
    }

    /**
     * Average albedo of a layer as the terrain shader renders it: its material's average × tint, or
     * the procedural colour pair at the layer's average mix. Both get the mean of the macro
     * variation (≈ 0.97).
     */
    private updateGroundColor(slot: number): void {
        const { colorA, colorB, params, mat, tint, ground } =
            this.uniforms.layers;

        if (mat[slot].y > 0.5) {
            ground[slot]
                .copy(this.textures.averages[slot])
                .multiply(tint[slot]);
        } else {
            // Noise mix: smoothstep(t) averages 0.5, weighted by the variation (see terrainSurface).
            const variation = params[slot].y;
            ground[slot]
                .copy(colorA[slot])
                .lerp(colorB[slot], 0.25 + 0.25 * variation);
        }

        ground[slot].multiplyScalar(0.97);
    }

    /** Puddle coverage of the shaded pixel (0-1), written by the surface evaluation. */
    private readonly puddleProperty = property('float', 'terrainPuddle');

    /** Puddles reflect the sky like the water does: the environment radiance is raised over them. */
    override setupEnvironment(
        builder: THREE.NodeBuilder,
    ): THREE.EnvironmentNode | null {
        const env = super.setupEnvironment(builder);

        if (!env) {
            return env;
        }

        return new PuddleEnvironmentNode(env.envNode, this.puddleProperty);
    }

    /**
     * The surface colour is set up here rather than as `colorNode`: three's shadow pass multiplies
     * the depth output by `colorNode.a`, which would run the whole splat shading (hundreds of texture
     * samples, and as many per-draw texture node updates on the CPU) for an opaque shadow caster.
     */
    override setupDiffuseColor(builder: THREE.NodeBuilder): void {
        this.colorNode = this.surfaceColor;
        super.setupDiffuseColor(builder);
        this.colorNode = null;
    }

    /**
     * The surface is evaluated once, in the colour node, and handed to the normal / roughness / AO
     * nodes through shader-global properties (so the lighting and MRT outputs never re-run it).
     */
    private buildNodes(): void {
        const u = this.uniforms;
        const surfaceNormal = property('vec3', 'terrainNormal');
        const surfaceRoughness = property('float', 'terrainRoughness');
        const surfaceAO = property('float', 'terrainAO');
        const surfaceBump = property('float', 'terrainBump');
        const surfacePuddle = this.puddleProperty;

        this.surfaceColor = Fn(() => {
            const s = terrainSurface(u, this.shoreEffects);
            surfaceNormal.assign(s.normal);
            surfaceRoughness.assign(s.roughness);
            surfaceAO.assign(s.ao);
            surfaceBump.assign(s.bump);
            surfacePuddle.assign(s.puddle);

            return vec4(this.debug.albedo(s.albedo), 1);
        })();

        this.roughnessNode = surfaceRoughness;
        this.aoNode = mix(1, surfaceAO, 0.85);

        this.normalNode = Fn(() => {
            const n = normalize(
                cameraViewMatrix.mul(vec4(surfaceNormal, 0)).xyz,
            );
            // Procedural bump for layers without a material; faded with distance to avoid moiré.
            const bumpFade = float(1).sub(
                smoothstep(40, 260, positionView.length()),
            );
            const dH = vec2(dFdx(surfaceBump), dFdy(surfaceBump)).mul(
                bumpFade.mul(0.22),
            );

            return perturbNormal(positionView, n, dH);
        })();

        const overlay = Fn(() => {
            const glow = vec3(0).toVar();
            const wp = positionWorld.xz;

            If(u.uBrushVisible.greaterThan(0.5), () => {
                const b = u.uBrush;
                const d = wp.sub(b.xy).length().toVar();
                const px = fwidth(d).mul(1.5).toVar();
                const outer = float(1).sub(smoothstep(0, px, abs(d.sub(b.z))));
                const innerR = b.z.mul(float(1).sub(b.w)).toVar();
                const inner = float(1)
                    .sub(smoothstep(0, px, abs(d.sub(innerR))))
                    .mul(0.6);
                const fill = float(1)
                    .sub(smoothstep(innerR, b.z, d))
                    .mul(step(d, b.z))
                    .mul(0.12);
                const centre = float(1).sub(
                    smoothstep(0, px.mul(2), d.sub(px.mul(2))),
                );
                glow.addAssign(
                    u.uBrushColor.mul(outer.add(inner).add(fill).add(centre)),
                );
            });

            If(u.uGridVisible.greaterThan(0.5), () => {
                const cell = wp.div(100).toVar();
                const g = abs(fract(cell.sub(0.5)).sub(0.5)).div(fwidth(cell));
                const line = float(1).sub(g.x.min(g.y).min(1));
                glow.addAssign(vec3(0.6 * 0.25).mul(line));
            });

            return glow;
        })();
        this.emissiveNode = overlay;

        const splatUv = positionWorld.xz
            .add(u.uMapHalf)
            .div(u.uCell)
            .add(0.5)
            .div(u.uRes);
        this.outputNode = this.debug.output(output, overlay, {
            splat0: u.uSplat0.sample(splatUv),
            splat1: u.uSplat1.sample(splatUv),
            mat: u.uMat,
            mapHalf: u.uMapHalf,
            cell: u.uCell,
            density: fixedTexture(this.debug.density.texture),
        });
    }
}

/** Environment lighting whose specular radiance is raised where puddles mirror the sky. */
class PuddleEnvironmentNode extends THREE.EnvironmentNode {
    constructor(
        envNode: THREE.Node | null,
        private readonly puddle: Float,
    ) {
        super(envNode);
    }

    override setup(builder: THREE.NodeBuilder): undefined {
        super.setup(builder);
        const radiance = (builder.context as { radiance: Vec3 }).radiance;
        // The terrain's environment intensity (0.45) suits rough ground; still water reflects it all.
        radiance.mulAssign(mix(1, 1.9, this.puddle));

        return undefined;
    }
}

/** Tangent-space normal from the packed detail map (OpenGL convention; v grows southwards on the ground). */
function unpackNormal(detail: Vec4, strength: Float): Vec3 {
    const xy = detail.xy.mul(2).sub(1).mul(strength).toVar();

    return vec3(
        xy.x,
        xy.y.negate(),
        sqrt(max(float(1).sub(dot(xy, xy)), 0.05)),
    );
}

/** Bump mapping from screen-space height derivatives (Mikkelsen), front faces only. */
function perturbNormal(surfPos: Vec3, surfNorm: Vec3, dHdxy: Vec2): Vec3 {
    const sigmaX = normalize(dFdx(surfPos));
    const sigmaY = normalize(dFdy(surfPos));
    const r1 = cross(sigmaY, surfNorm).toVar();
    const r2 = cross(surfNorm, sigmaX).toVar();
    const det = dot(sigmaX, r1).toVar();
    const grad = sign(det).mul(r1.mul(dHdxy.x).add(r2.mul(dHdxy.y)));

    return normalize(abs(det).mul(surfNorm).sub(grad));
}

/** One shaded layer: its surface and the inputs of the height blend. */
type LayerSample = {
    weight: Float;
    valid: THREE.Node<'bool'>;
    albedo: Vec3;
    normal: Vec3;
    roughness: Float;
    ao: Float;
    height: Float;
    bump: Float;
};

/** Splat, layer and weather evaluation (fragment stage). */
function terrainSurface(
    u: TerrainUniforms,
    shoreEffects: ShoreEffectsHook | null = null,
) {
    const wpos = positionWorld.toVar();
    const wp = wpos.xz.toVar();
    const N = normalize(normalWorldGeometry).toVar();
    const splatUv = wp
        .add(u.uMapHalf)
        .div(u.uCell)
        .add(0.5)
        .div(u.uRes)
        .toVar();
    const s0 = u.uSplat0.sample(splatUv).toVar();
    const s1 = u.uSplat1.sample(splatUv).toVar();
    const splatWeights = [s0.x, s0.y, s0.z, s0.w, s1.x, s1.y, s1.z, s1.w];

    const dist = positionView.length().toVar();
    const macro = u.uNoise.sample(wp.div(420)).toVar();
    const macro2 = u.uNoise.sample(wp.div(97)).toVar();
    // Large-scale variation (see the layers' macro_variation): broad brightness and hue patches from
    // a few hundred metres down to ~25 m, shared by all layers.
    const macroA = u.uMacro.sample(wp.div(2300).add(0.37)).toVar();
    const macroB = u.uMacro.sample(wp.div(610).add(0.71)).toVar();
    const macroLum = macroA.x
        .sub(0.5)
        .mul(0.6)
        .add(macroB.y.sub(0.5).mul(0.45))
        .add(macro2.z.sub(0.5).mul(0.12))
        .toVar();
    const macroHue = macroA.z
        .sub(0.5)
        .mul(1.5)
        .add(macroB.w.sub(0.5).mul(0.7))
        .toVar();
    // Drier / lusher patches: saturation.
    const macroSat = macroA.w.sub(0.5).add(macroB.x.sub(0.5).mul(0.5)).toVar();
    // Seen from further away the variation grows (up close the texture detail dominates anyway) and
    // material layers lean towards their average colour, which hides their repeat.
    const macroAmount = mix(0.6, 1.15, smoothstep(25, 450, dist)).toVar();
    const detailBlend = smoothstep(110, 750, dist).mul(0.6).toVar();
    const tileNoise = u.uNoise.sample(wp.div(61)).w.toVar();

    // Triplanar weights for steep ground (cliffs); flat ground only uses the top projection.
    const tw = pow(abs(N), vec3(4)).toVar();
    tw.divAssign(tw.x.add(tw.y).add(tw.z));
    const steep = tw.y.lessThan(0.97).toVar();
    const axisSign = sign(N).toVar();

    // Screen-space derivatives of world position (mip selection with explicit gradients; every
    // lookup below may run in divergent control flow).
    const dpx = dFdx(wpos).toVar();
    const dpy = dFdy(wpos).toVar();

    // Anti-tiling cell offsets (shared by all layers): see the layer lookups below.
    const tileCell = tileNoise.mul(8).toVar();
    const tileFract = fract(tileCell).toVar();
    const offsetA = sin(vec2(3, 7).mul(floor(tileCell))).toVar();
    const offsetB = sin(vec2(3, 7).mul(floor(tileCell).add(1))).toVar();

    const farFade = smoothstep(35, 220, dist).toVar();
    const normalFade = float(1)
        .sub(smoothstep(60, 450, dist).mul(0.75))
        .toVar();

    // ---- pick the strongest layers (insertion into a sorted list, branch-free)
    const topW = Array.from({ length: SHADED_LAYERS }, () => float(-1).toVar());
    const topI = Array.from({ length: SHADED_LAYERS }, () => float(0).toVar());

    for (let i = 0; i < TERRAIN_SLOTS; i++) {
        const w = splatWeights[i].mul(u.uMat.element(i).x).toVar();

        for (let k = SHADED_LAYERS - 1; k >= 0; k--) {
            if (k === 0) {
                topI[0].assign(
                    select(w.greaterThan(topW[0]), float(i), topI[0]),
                );
                topW[0].assign(max(topW[0], w));
            } else {
                const above = w.greaterThan(topW[k - 1]);
                topI[k].assign(
                    select(
                        above,
                        topI[k - 1],
                        select(w.greaterThan(topW[k]), float(i), topI[k]),
                    ),
                );
                topW[k].assign(select(above, topW[k - 1], max(topW[k], w)));
            }
        }
    }

    // ---- pass 1: sample the selected layers
    const samples: LayerSample[] = [];

    for (let k = 0; k < SHADED_LAYERS; k++) {
        const albedo = vec3(0).toVar();
        const normal = vec3(N).toVar();
        const roughness = float(1).toVar();
        const ao = float(1).toVar();
        const height = float(0.5).toVar();
        const bump = float(0).toVar();
        const valid = topW[k].greaterThanEqual(MIN_WEIGHT).toVar();
        const index = topI[k].toInt().toVar();

        If(valid, () => {
            const m = u.uMat.element(index).toVar();
            const m2 = u.uMat2.element(index).toVar();

            If(m.y.greaterThan(0.5), () => {
                const tile = m.z;
                const uvT = wp.div(tile).toVar();
                const gx = dpx.xz.div(tile).toVar();
                const gy = dpy.xz.div(tile).toVar();
                const albedoAt = (uv: Vec2, ddx: Vec2, ddy: Vec2) =>
                    u.uAlbedoArr.sample(uv).depth(index).grad(ddx, ddy);
                const detailAt = (uv: Vec2, ddx: Vec2, ddy: Vec2) =>
                    u.uDetailArr.sample(uv).depth(index).grad(ddx, ddy);

                // Anti-tiling: two lookups with per-cell random offsets, cross-faded by a
                // low-frequency noise (after Inigo Quilez, "texture repetition", technique 3).
                // Albedo+rough and detail use the same blend so the maps stay consistent.
                const a1 = albedoAt(uvT.add(offsetA), gx, gy).toVar();
                const b1 = albedoAt(uvT.add(offsetB), gx, gy).toVar();
                const a2 = detailAt(uvT.add(offsetA), gx, gy);
                const b2 = detailAt(uvT.add(offsetB), gx, gy);
                const t = smoothstep(
                    0.2,
                    0.8,
                    tileFract.sub(dot(a1.xyz.sub(b1.xyz), vec3(0.1))),
                ).toVar();
                const ar = mix(a1, b1, t).toVar();
                const dt = mix(a2, b2, t).toVar();

                // Far away, blend with a 4× larger lookup to break visible repetition.
                If(farFade.greaterThan(0), () => {
                    const far = albedoAt(
                        uvT.mul(0.23).add(0.31),
                        gx.mul(0.23),
                        gy.mul(0.23),
                    );
                    ar.assign(
                        vec4(mix(ar.xyz, far.xyz, farFade.mul(0.5)), ar.w),
                    );
                });

                const strength = m2.y.mul(normalFade).toVar();
                const tnY = unpackNormal(dt, strength).toVar();
                const col = ar.xyz.toVar();
                const rough = ar.w.toVar();
                const occ = dt.z.toVar();
                const h = dt.w.toVar();
                // Whiteout-blended triplanar normal (Ben Golus); top projection only on flat ground.
                const nSum = vec3(
                    tnY.x.add(N.x),
                    abs(tnY.z).mul(N.y),
                    tnY.y.add(N.z),
                )
                    .mul(tw.y)
                    .toVar();

                If(steep, () => {
                    col.mulAssign(tw.y);
                    rough.mulAssign(tw.y);
                    occ.mulAssign(tw.y);
                    h.mulAssign(tw.y);

                    // Side projections with a negligible weight are skipped.
                    If(tw.x.greaterThan(0.01), () => {
                        const uvX = vec2(
                            wpos.z.mul(axisSign.x),
                            wpos.y.negate(),
                        ).div(tile);
                        const gxX = vec2(
                            dpx.z.mul(axisSign.x),
                            dpx.y.negate(),
                        ).div(tile);
                        const gyX = vec2(
                            dpy.z.mul(axisSign.x),
                            dpy.y.negate(),
                        ).div(tile);
                        const arX = albedoAt(uvX, gxX, gyX).toVar();
                        const dtX = detailAt(uvX, gxX, gyX).toVar();
                        const tnX = unpackNormal(dtX, strength).toVar();
                        const nX = vec3(
                            abs(tnX.z).mul(N.x),
                            tnX.y.negate().add(N.y),
                            tnX.x.mul(axisSign.x).add(N.z),
                        );
                        nSum.addAssign(nX.mul(tw.x));
                        col.addAssign(arX.xyz.mul(tw.x));
                        rough.addAssign(arX.w.mul(tw.x));
                        occ.addAssign(dtX.z.mul(tw.x));
                        h.addAssign(dtX.w.mul(tw.x));
                    });

                    If(tw.z.greaterThan(0.01), () => {
                        const uvZ = vec2(
                            wpos.x.negate().mul(axisSign.z),
                            wpos.y.negate(),
                        ).div(tile);
                        const gxZ = vec2(
                            dpx.x.negate().mul(axisSign.z),
                            dpx.y.negate(),
                        ).div(tile);
                        const gyZ = vec2(
                            dpy.x.negate().mul(axisSign.z),
                            dpy.y.negate(),
                        ).div(tile);
                        const arZ = albedoAt(uvZ, gxZ, gyZ).toVar();
                        const dtZ = detailAt(uvZ, gxZ, gyZ).toVar();
                        const tnZ = unpackNormal(dtZ, strength).toVar();
                        const nZ = vec3(
                            tnZ.x.mul(axisSign.z.negate()).add(N.x),
                            tnZ.y.negate().add(N.y),
                            abs(tnZ.z).mul(N.z),
                        );
                        nSum.addAssign(nZ.mul(tw.z));
                        col.addAssign(arZ.xyz.mul(tw.z));
                        rough.addAssign(arZ.w.mul(tw.z));
                        occ.addAssign(dtZ.z.mul(tw.z));
                        h.addAssign(dtZ.w.mul(tw.z));
                    });
                });

                albedo.assign(
                    mix(
                        col.mul(u.uTint.element(index)),
                        u.uGround.element(index).div(0.97),
                        detailBlend.mul(min(m2.w, 1)),
                    ),
                );
                normal.assign(normalize(nSum));
                roughness.assign(clamp(rough.mul(m2.x), 0.03, 1));
                ao.assign(occ);
                height.assign(clamp(h.sub(0.5).mul(m.w).add(0.5), 0, 1));
            }).Else(() => {
                // Procedural fallback: two colours mixed by noise.
                const p = u.uParams.element(index).toVar();
                const scale = p.x;
                const n = u.uNoise
                    .sample(wp.div(scale))
                    .grad(dpx.xz.div(scale), dpy.xz.div(scale))
                    .toVar();
                const fineScale = scale.mul(0.23);
                const nFine = u.uNoise
                    .sample(wp.div(fineScale))
                    .grad(dpx.xz.div(fineScale), dpy.xz.div(fineScale))
                    .toVar();
                const t = clamp(
                    n.z
                        .mul(0.65)
                        .add(nFine.x.mul(0.35))
                        .sub(0.5)
                        .mul(p.y.mul(3).add(1))
                        .add(0.5),
                    0,
                    1,
                );
                const c = mix(
                    u.uColorA.element(index),
                    u.uColorB.element(index),
                    smoothstep(0.2, 0.8, t)
                        .mul(p.y)
                        .add(float(1).sub(p.y).mul(0.25)),
                )
                    .mul(nFine.y.mul(0.16).add(0.92))
                    .mul(
                        macro.x
                            .mul(0.2)
                            .add(macro2.y.sub(0.5).mul(0.08))
                            .add(0.88),
                    );
                albedo.assign(c);
                roughness.assign(p.z);
                height.assign(n.x.mul(0.6).add(n.y.mul(0.4)));
                bump.assign(height.mul(p.w));
            });

            // Large-scale variation: brighter / darker and warmer / cooler patches.
            const amount = m2.w.mul(macroAmount).toVar();
            const hue = macroHue.mul(amount);
            const grey = dot(albedo, vec3(0.2126, 0.7152, 0.0722));
            albedo.assign(
                max(mix(albedo, vec3(grey), macroSat.mul(amount).mul(0.7)), 0),
            );
            albedo.mulAssign(
                vec3(
                    hue.mul(0.1).add(1),
                    hue.mul(0.03).add(1),
                    hue.mul(-0.11).add(1),
                ).mul(max(macroLum.mul(amount).add(1), 0.3)),
            );
        });

        samples.push({
            weight: topW[k],
            valid,
            albedo,
            normal,
            roughness,
            ao,
            height,
            bump,
        });
    }

    // ---- pass 2: height-based blend weights (sharp, natural transitions)
    const scores = samples.map((s) =>
        select(s.valid, s.weight.add(s.height.mul(0.5)), float(-1)).toVar(),
    );
    const best = scores.reduce<Float>((a, b) => max(a, b), float(-1)).toVar();
    const blend = samples.map((s, k) =>
        select(
            s.valid,
            max(scores[k].sub(best).add(0.18), 0),
            float(0),
        ).toVar(),
    );
    const total = blend.reduce<Float>((a, b) => a.add(b), float(0)).toVar();

    // Nothing to blend (no enabled layer here): the first layer's colour.
    const albedo = vec3(0).toVar();
    albedo.assign(u.uColorA.element(0));
    const nrm = vec3(N).toVar();
    const rough = float(0.9).toVar();
    const ao = float(1).toVar();
    const bumpH = float(0).toVar();

    If(total.greaterThanEqual(1e-4), () => {
        const inv = float(1).div(total).toVar();
        let a: Vec3 = vec3(0);
        let n: Vec3 = vec3(0);
        let r: Float = float(0);
        let o: Float = float(0);
        let b: Float = float(0);

        samples.forEach((s, k) => {
            const w = blend[k].mul(inv);
            a = a.add(s.albedo.mul(w));
            n = n.add(s.normal.mul(w));
            r = r.add(s.roughness.mul(w));
            o = o.add(s.ao.mul(w));
            b = b.add(s.bump.mul(w));
        });

        albedo.assign(a);
        nrm.assign(n);
        rough.assign(r);
        ao.assign(o);
        bumpH.assign(b);
    });

    // Wet ground along water: darker, glossier, smoother.
    const ground = u.uWet.sample(splatUv).toVar();
    const wet = ground.x.toVar();
    albedo.mulAssign(mix(1, 0.55, wet));
    rough.assign(mix(rough, 0.12, wet.mul(0.85)));
    nrm.assign(normalize(mix(nrm, N, wet.mul(0.5))));

    // Caustics: the waves focus sunlight into a moving network of bright filaments on shallow beds,
    // projected along the light direction through the water above.
    If(u.uCaustics.w.greaterThan(0.5).and(ground.y.greaterThan(0.001)), () => {
        const c = u.uCaustics;
        const depth = ground.y.mul(WATER_DEPTH_RANGE).toVar();
        const sun = u.uSunDir;
        const shift = sun.xz.div(max(sun.y, 0.3)).mul(depth);
        const p = wp.add(shift).div(max(c.y, 0.1));
        const pattern = causticPattern(p, u.uTime.mul(0.45));
        const reach = smoothstep(0.02, 0.35, depth).mul(
            float(1).sub(smoothstep(c.z.mul(0.3), c.z, depth)),
        );
        const visible = smoothstep(0.02, 0.25, sun.y).mul(
            float(1).sub(smoothstep(45, 160, dist)),
        );
        albedo.mulAssign(
            pattern.mul(c.x).mul(reach).mul(visible).mul(3).add(1),
        );
    });

    // Under water the bed has no sun glint of its own (water against wet sediment barely reflects):
    // the wet gloss fades out below the first few centimetres.
    rough.assign(
        mix(
            rough,
            0.75,
            smoothstep(0.02, 0.12, ground.y.mul(WATER_DEPTH_RANGE)),
        ),
    );

    // Weather: rain-soaked ground (porous darkening, glossy).
    If(u.uWeatherWet.greaterThan(0.001), () => {
        const gw = u.uWeatherWet;
        albedo.mulAssign(mix(1, 0.62, gw.mul(float(1).sub(wet.mul(0.5)))));
        rough.assign(mix(rough, rough.mul(0.6), gw));
        nrm.assign(normalize(mix(nrm, N, gw.mul(0.25))));
    });

    // Puddles: rain collects in hollows (the ground's puddle potential, from the terrain's shape,
    // with some noise for natural outlines) and rises with the fill level; still water mirrors the
    // sky (see PuddleEnvironmentNode) and ripples while it rains.
    const puddle = float(0).toVar();

    If(u.uPuddle.greaterThan(0.001), () => {
        const flatness = smoothstep(0.95, 0.995, N.y);
        const shape = float(1)
            .sub(macro2.z)
            .mul(0.55)
            .add(float(1).sub(macro.y).mul(0.45));
        const score = ground.z
            .mul(0.85)
            .add(shape.sub(0.5).mul(0.5))
            .add(tileNoise.sub(0.5).mul(0.08))
            .toVar();
        const level = float(1).sub(u.uPuddle.mul(0.78)).toVar();
        puddle.assign(smoothstep(level, level.add(0.04), score).mul(flatness));
        // A darker, soaked rim around the water.
        const rim = smoothstep(level.sub(0.12), level, score)
            .mul(flatness)
            .mul(puddle.oneMinus());
        albedo.mulAssign(mix(1, 0.68, rim));
        rough.assign(mix(rough, 0.22, rim));
        albedo.mulAssign(mix(1, 0.3, puddle));
        rough.assign(mix(rough, 0.02, puddle));
        const surface = vec3(N).toVar();

        If(u.uRain.greaterThan(0.001), () => {
            const slope = rainRipples(wp, u.uTime).mul(
                u.uRain.mul(0.45).mul(float(1).sub(smoothstep(12, 45, dist))),
            );
            surface.assign(
                normalize(vec3(slope.x.negate(), 1, slope.y.negate())),
            );
        });

        nrm.assign(normalize(mix(nrm, surface, puddle)));
    });

    // Beach surf: sand darkened and glossy where the swash was, the thin sheet running up and back
    // (a film of water: dark, mirror-smooth, flat) and its foam edge and bubbles.
    if (shoreEffects) {
        const fx = shoreEffects(wpos);
        albedo.mulAssign(mix(vec3(1), vec3(0.5, 0.52, 0.55), fx.wet));
        rough.assign(mix(rough, 0.3, fx.gloss.mul(0.85)));
        albedo.assign(
            mix(albedo, albedo.mul(vec3(0.5, 0.6, 0.66)), fx.sheet.mul(0.7)),
        );
        rough.assign(mix(rough, 0.07, fx.sheet));
        nrm.assign(normalize(mix(nrm, N, max(fx.sheet, fx.gloss.mul(0.4)))));
        albedo.assign(mix(albedo, vec3(0.9, 0.92, 0.93), fx.foam));
        rough.assign(mix(rough, 0.65, fx.foam));
        puddle.assign(max(puddle, fx.sheet.mul(fx.foam.oneMinus()).mul(0.35)));
    }

    // Snow settles on flatter ground first; thinner near water.
    If(u.uSnowCover.greaterThan(0.001), () => {
        const cover = u.uSnowCover.mul(float(1).sub(wet.mul(0.8))).toVar();
        const lie = smoothstep(
            0.55,
            0.85,
            N.y
                .add(macro2.x.sub(0.5).mul(0.25))
                .add(tileNoise.sub(0.5).mul(0.1)),
        );
        const snow = smoothstep(
            0,
            0.25,
            lie.mul(cover).mul(1.4).sub(float(1).sub(cover).mul(0.3)),
        ).toVar();
        albedo.assign(
            mix(
                albedo,
                vec3(0.86, 0.89, 0.93).mul(macro.x.mul(0.08).add(0.94)),
                snow,
            ),
        );
        rough.assign(mix(rough, 0.55, snow));
        nrm.assign(normalize(mix(nrm, N, snow.mul(0.7))));
        ao.assign(mix(ao, 1, snow.mul(0.6)));
        puddle.mulAssign(snow.oneMinus());

        // Footprints: pressed (darker, bluish, shadowed) hollows in the snow around the character.
        const ti = u.uTrailInfo;

        If(ti.w.greaterThan(0.5).and(u.uTrailDepth.greaterThan(0.001)), () => {
            const rel = wp.sub(vec2(ti.x, ti.z));
            const inside = float(1).sub(
                smoothstep(
                    ti.y.mul(0.42),
                    ti.y.mul(0.48),
                    max(abs(rel.x), abs(rel.y)),
                ),
            );
            const uvT = wp.div(ti.y).toVar();
            const texel = 1 / 1024;
            const trail = (o: Vec2) =>
                u.uTrail.sample(uvT.add(o)).level(float(0)).x;
            const d0 = trail(vec2(0, 0));
            const dx = trail(vec2(texel, 0)).sub(trail(vec2(-texel, 0)));
            const dz = trail(vec2(0, texel)).sub(trail(vec2(0, -texel)));
            const amount = inside.mul(snow).mul(u.uTrailDepth).toVar();
            const press = d0.mul(amount).toVar();
            albedo.assign(
                mix(albedo, albedo.mul(vec3(0.7, 0.77, 0.88)), press.mul(0.9)),
            );
            ao.assign(mix(ao, ao.mul(0.7), press));
            rough.assign(mix(rough, 0.4, press));
            nrm.assign(
                normalize(nrm.add(vec3(dx, 0, dz).mul(amount.mul(1.6)))),
            );
        });
    });

    return {
        albedo,
        normal: normalize(nrm),
        roughness: clamp(rough, 0.03, 1),
        ao,
        bump: bumpH,
        puddle,
    };
}

/** The material a layer renders with: its library material, or its legacy uploaded albedo. */
function layerMaterial(layer: TerrainLayer): TerrainMaterialRef | null {
    if (layer.material?.maps.albedo) {
        return layer.material;
    }

    if (layer.texture_url) {
        return {
            id: -1,
            name: layer.name,
            maps: {
                albedo: layer.texture_url,
                normal: null,
                roughness: null,
                ao: null,
                height: null,
            },
            tile_size: layer.texture_scale,
            tint: '#ffffff',
            roughness_scale: 1,
            normal_strength: 1,
            height_contrast: 1,
        };
    }

    return null;
}

/**
 * Smooth, isotropic tiling noise for the large-scale variation: per channel a sum of plane waves with
 * integer wave vectors (1-10 cycles per tile, so it tiles exactly) and a 1/f^1.3 spectrum, normalised
 * to 0..1. R/G/B/A are independent.
 */
function createMacroTexture(): THREE.DataTexture {
    const size = 128;
    const data = new Uint8Array(size * size * 4);
    const rand = mulberry32(9157);
    const field = new Float32Array(size * size);
    const tau = Math.PI * 2;

    for (let c = 0; c < 4; c++) {
        const waves: { kx: number; ky: number; amp: number; phase: number }[] =
            [];

        while (waves.length < 40) {
            const k = 1 + Math.pow(rand(), 1.5) * 9;
            const a = rand() * tau;
            const kx = Math.round(Math.cos(a) * k);
            const ky = Math.round(Math.sin(a) * k);

            if (kx !== 0 || ky !== 0) {
                waves.push({
                    kx,
                    ky,
                    amp: Math.pow(Math.hypot(kx, ky), -1.3),
                    phase: rand() * tau,
                });
            }
        }

        let lo = Infinity;
        let hi = -Infinity;

        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                let v = 0;

                for (const w of waves) {
                    v +=
                        Math.sin(
                            (tau * (w.kx * x + w.ky * y)) / size + w.phase,
                        ) * w.amp;
                }

                field[y * size + x] = v;
                lo = Math.min(lo, v);
                hi = Math.max(hi, v);
            }
        }

        for (let i = 0; i < size * size; i++) {
            data[i * 4 + c] = Math.round(((field[i] - lo) / (hi - lo)) * 255);
        }
    }

    const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;

    return texture;
}

/** Tiling multi-octave noise texture: R/G/B/A = four independent tileable noise fields. */
function createNoiseTexture(): THREE.DataTexture {
    const size = 256;
    const data = new Uint8Array(size * size * 4);
    const fields = [
        new SimplexNoise(11),
        new SimplexNoise(23),
        new SimplexNoise(37),
        new SimplexNoise(51),
    ];
    const freqs = [4, 8, 16, 2];

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            // Map onto a torus so the texture tiles seamlessly.
            const a = (x / size) * Math.PI * 2;
            const b = (y / size) * Math.PI * 2;

            for (let c = 0; c < 4; c++) {
                const f = freqs[c] / (Math.PI * 2);
                const nx = Math.cos(a) * f;
                const ny = Math.sin(a) * f;
                const nz = Math.cos(b) * f;
                const nw = Math.sin(b) * f;
                // 4D torus embedding approximated with two 2D lookups.
                const n =
                    fields[c].fbm(nx * 3 + nz * 1.7, ny * 3 + nw * 1.7, 4) *
                        0.6 +
                    fields[c].noise2D(nz * 5 + 11.3, nw * 5 - 7.1) * 0.4;
                data[(y * size + x) * 4 + c] = Math.max(
                    0,
                    Math.min(255, Math.round((n * 0.5 + 0.5) * 255)),
                );
            }
        }
    }

    const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;

    return texture;
}
