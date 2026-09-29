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
import { SimplexNoise } from '../util/noise';
import type { SplatMap } from './SplatMap';
import { TerrainDebugView } from './TerrainDebugView';
import { TERRAIN_SLOTS, TerrainTextures } from './TerrainTextures';

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
    wet: THREE.Texture,
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
    // x: roughness scale, y: normal strength, z: macro variation, w: unused
    const mat2 = Array.from(
        { length: 8 },
        () => new THREE.Vector4(1, 1, 0.5, 0),
    );
    const tint = Array.from({ length: 8 }, () => new THREE.Color(1, 1, 1));

    return {
        uSplat0: fixedTexture(splat.textures[0]),
        uSplat1: fixedTexture(splat.textures[1]),
        uNoise: fixedTexture(noise),
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
        uBrush: uniform(new THREE.Vector4(0, 0, 0, 0.5)),
        uBrushVisible: uniform(0),
        uBrushColor: uniform(new THREE.Color(0.25, 0.75, 1)),
        uGridVisible: uniform(0),
        // Global weather (Weather.ts): rain wetness and snow cover, 0-1.
        uWeatherWet: uniform(0),
        uSnowCover: uniform(0),
        /** CPU-side values behind the uniform arrays (edited in place by setLayers). */
        layers: { colorA, colorB, params, mat, mat2, tint },
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
    private readonly blankWet: THREE.DataTexture;
    /** Albedo of the splat surface (see setupDiffuseColor). */
    private surfaceColor!: THREE.Node<'vec4'>;

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
        this.blankWet = new THREE.DataTexture(
            new Uint8Array([0]),
            1,
            1,
            THREE.RedFormat,
        );
        this.blankWet.needsUpdate = true;

        this.uniforms = createUniforms(
            splat,
            size,
            resolution,
            this.textures,
            this.noise,
            this.blankWet,
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
                0,
            );
            tint[i]
                .set(layer.tint ?? '#ffffff')
                .multiply(new THREE.Color(ref?.tint ?? '#ffffff'));

            void this.textures.load(i, ref, layer.roughness);
        }

        for (let i = 0; i < TERRAIN_SLOTS; i++) {
            if (!used.has(i)) {
                this.textures.clear(i);
            }
        }
    }

    /** Weather-driven ground state: `wet` darkens and glosses everything (puddles on flat ground), `snow` whitens it. */
    setWeather(wet: number, snow: number): void {
        this.uniforms.uWeatherWet.value = wet;
        this.uniforms.uSnowCover.value = snow;
    }

    /** Wetness mask (R8, same grid as the splat map): 1 = soaked ground next to water. */
    setWetness(texture: THREE.Texture): void {
        this.uniforms.uWet.value = texture;
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
        this.blankWet.dispose();
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
            }
        };

        return textures;
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

        this.surfaceColor = Fn(() => {
            const s = terrainSurface(u);
            surfaceNormal.assign(s.normal);
            surfaceRoughness.assign(s.roughness);
            surfaceAO.assign(s.ao);
            surfaceBump.assign(s.bump);

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
function terrainSurface(u: TerrainUniforms) {
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

                // Gentle macro variation so large areas don't look uniform.
                col.mulAssign(
                    macro2.y
                        .sub(0.5)
                        .mul(m2.z.mul(0.25))
                        .add(macro.x.mul(0.12))
                        .add(0.9),
                );
                albedo.assign(col.mul(u.uTint.element(index)));
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
    const wet = u.uWet.sample(splatUv).x.toVar();
    albedo.mulAssign(mix(1, 0.55, wet));
    rough.assign(mix(rough, 0.12, wet.mul(0.85)));
    nrm.assign(normalize(mix(nrm, N, wet.mul(0.5))));

    // Weather: rain-soaked ground (porous darkening, glossy) with puddles in flat hollows.
    If(u.uWeatherWet.greaterThan(0.001), () => {
        const gw = u.uWeatherWet;
        const flatness = smoothstep(0.93, 0.99, N.y);
        const hollow = float(1)
            .sub(macro2.z)
            .mul(0.55)
            .add(float(1).sub(macro.y).mul(0.45));
        const puddle = smoothstep(
            float(0.76).sub(gw.mul(0.14)),
            float(0.82).sub(gw.mul(0.14)),
            hollow,
        )
            .mul(flatness)
            .mul(smoothstep(0.3, 0.8, gw))
            .mul(0.85)
            .toVar();
        albedo.mulAssign(mix(1, 0.62, gw.mul(float(1).sub(wet.mul(0.5)))));
        rough.assign(mix(rough, rough.mul(0.6), gw));
        albedo.mulAssign(mix(1, 0.75, puddle));
        rough.assign(mix(rough, 0.14, puddle));
        nrm.assign(normalize(mix(nrm, N, max(gw.mul(0.25), puddle))));
    });

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
    });

    return {
        albedo,
        normal: normalize(nrm),
        roughness: clamp(rough, 0.03, 1),
        ao,
        bump: bumpH,
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
