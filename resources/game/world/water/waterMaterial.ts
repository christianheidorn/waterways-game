import * as THREE from 'three/webgpu';
import type { Node, NodeBuilder } from 'three/webgpu';
import {
    abs,
    attribute,
    cameraFar,
    cameraNear,
    cameraPosition,
    cameraViewMatrix,
    clamp,
    cos,
    dot,
    exp,
    float,
    floor,
    Fn,
    fract,
    fwidth,
    If,
    int,
    ivec2,
    length,
    Loop,
    max,
    min,
    mix,
    modelWorldMatrix,
    normalize,
    perspectiveDepthToViewZ,
    positionGeometry,
    positionView,
    positionViewDirection,
    positionWorld,
    pow,
    screenUV,
    select,
    sin,
    smoothstep,
    sqrt,
    texture,
    textureLoad,
    uniform,
    uniformArray,
    varying,
    vec2,
    vec3,
    vec4,
    viewportTexture,
} from 'three/tsl';
import { depthPrecision, isSkyDepth } from '../../core/depth';
import { gnoise } from '../SkyDome';
import { rainRipples } from '../waterPatterns';
import { CASCADES, FFT_SIZE } from './spectrum';
import { BODY_ROWS, BODY_TABLE } from './WaterBodies';
import { COMPONENT_COUNT } from './WaveField';
import type { WaveFFT } from './WaveFFT';

/** Material inputs (TSL uniforms), updated from the environment, the weather and the wave field. */
export function createWaterUniforms() {
    return {
        time: uniform(0),
        shallow: uniform(new THREE.Color('#2fa3a0')),
        deep: uniform(new THREE.Color('#0b2f45')),
        clarity: uniform(4),
        /** Gusting wind strength (0-2) and the direction it blows towards (x, z). */
        wind: uniform(0.4),
        windDir: uniform(new THREE.Vector2(0.8, 0.6)),
        waveScale: uniform(8),
        waveStrength: uniform(0.6),
        waveSpeed: uniform(1),
        /** Ocean swell height (m) on the sea (environment wave_height). */
        oceanSwell: uniform(0.15),
        flowSpeed: uniform(1),
        refraction: uniform(0.5),
        foamEnabled: uniform(1),
        foamWidth: uniform(1.2),
        foamIntensity: uniform(0.6),
        rapids: uniform(1),
        foamBreakup: uniform(0.6),
        roughness: uniform(0.06),
        reflMatrix: uniform(new THREE.Matrix4()),
        reflLevel: uniform(0),
        hasReflection: uniform(0),
        rain: uniform(0),
        // Map grid: half size, samples per side and spacing of the water data textures.
        mapHalf: uniform(1e6),
        dataSize: uniform(1),
        dataSpacing: uniform(1),
        // Fine mesh: centre (x, z), half size where chunks give way to it, its xz scale.
        fineCenter: uniform(new THREE.Vector2()),
        fineHalf: uniform(0),
        fineScale: uniform(1),
        // Lighting for the subsurface glow.
        sunDir: uniform(new THREE.Vector3(0, 1, 0)),
        sunColor: uniform(new THREE.Color(1, 1, 1)),
        subsurface: uniform(1),
        whitecaps: uniform(1),
        // Travelling gusts (as the foliage): strength, 1 / patch size; downwind offset of the field.
        gust: uniform(new THREE.Vector2(0.5, 1 / 40)),
        gustOffset: uniform(new THREE.Vector2()),
        // Wind waves: mean square slope and standard deviation of height per cascade (reference spectrum).
        slopeVar: uniform(new THREE.Vector3()),
        heightStd: uniform(new THREE.Vector3()),
        // Sum-of-waves (WebGL 2): (kx, kz, amp, phase), (omega, cascade, 0, 0).
        compA: uniformArray(Array.from({ length: COMPONENT_COUNT }, () => new THREE.Vector4()), 'vec4'),
        compB: uniformArray(Array.from({ length: COMPONENT_COUNT }, () => new THREE.Vector4()), 'vec4'),
        /** Highlight pulse of the selected body (editor). */
        highlight: uniform(1),
    };
}

export type WaterUniforms = ReturnType<typeof createWaterUniforms>;

/** What an extra surface layer (see WaterSurfaceLayer) gets to work with. */
export type WaterLayerContext = {
    /** Undisplaced world position (x, z) of the surface point. */
    xz: Node<'vec2'>;
    /** Water time (s, scaled by the wave speed). */
    time: Node<'float'>;
    /** Water depth (m). */
    depth: Node<'float'>;
    /** The body's table row, its kind code (0 lake, 1 pond, 2 river, 3 sea) and surf flag (0/1). */
    row: Node<'float'>;
    kind: Node<'float'>;
    surf: Node<'float'>;
    /** Wind (x, z towards) and strength (0-2). */
    windDir: Node<'vec2'>;
    wind: Node<'float'>;
};

/**
 * An extra source of waves, ripples or foam on the water (beach surf, interaction ripples, wakes, …).
 * Displacement is evaluated per vertex, slope and foam per pixel; `sample` is the CPU counterpart for
 * gameplay (WaveSample: height, normal, velocity are added to).
 */
export type WaterSurfaceLayer = {
    name: string;
    /** World-space offset (m) added to the surface point. */
    displacement?: (ctx: WaterLayerContext) => Node<'vec3'>;
    /** Height slope (∂h/∂x, ∂h/∂z) added to the waves'. */
    slope?: (ctx: WaterLayerContext) => Node<'vec2'>;
    /** Foam coverage (0-1), combined with the rest by max. */
    foam?: (ctx: WaterLayerContext) => Node<'float'>;
    /** CPU: add this layer's height / slope / velocity at a world position. */
    sample?: (x: number, z: number, time: number, out: { height: number; slopeX: number; slopeZ: number; velocity: THREE.Vector3 }) => void;
};

/** Long directional swells of the open sea: direction, wavelength (m) and relative amplitude. */
const SWELLS: { dir: [number, number]; length: number; amp: number }[] = [
    { dir: [1, 0.25], length: 42, amp: 0.6 },
    { dir: [0.7, -0.7], length: 23, amp: 0.3 },
    { dir: [0.2, 1], length: 13, amp: 0.1 },
];

/** Displacement of each cascade fades out with distance (m): beyond it the mesh can't carry it. */
const CASCADE_FADE: [number, number][] = [
    [700, 1400],
    [30, 56],
    [4, 7.5],
];

/**
 * MeshStandardNodeMaterial with two water-specific hooks: the planar reflection replaces the
 * environment radiance near the reflected level, and the water blends into the scene underneath at
 * the waterline (soft shores).
 */
export class WaterMaterial extends THREE.MeshStandardNodeMaterial {
    planarNode: Node<'vec3'> | null = null;
    planarWeightNode: Node<'float'> | null = null;
    underNode: Node<'vec3'> | null = null;
    shoreNode: Node<'float'> | null = null;
    sceneDepth: THREE.DepthTexture | null = null;

    override setup(builder: NodeBuilder): void {
        if (this.sceneDepth) {
            this.sceneDepth.type = builder.renderer.reversedDepthBuffer ? THREE.FloatType : THREE.UnsignedIntType;
        }

        super.setup(builder);
    }

    override setupEnvironment(builder: NodeBuilder): THREE.EnvironmentNode | null {
        const env = super.setupEnvironment(builder);

        if (!this.planarNode || !this.planarWeightNode) {
            return env;
        }

        return new PlanarEnvironmentNode(env?.envNode ?? null, this.planarNode, this.planarWeightNode);
    }

    override setupOutput(builder: NodeBuilder, outputNode: Node): Node {
        if (!this.underNode || !this.shoreNode) {
            return super.setupOutput(builder, outputNode);
        }

        const rgba = outputNode as Node<'vec4'>;

        return super.setupOutput(builder, vec4(mix(this.underNode, rgba.rgb, this.shoreNode), rgba.a));
    }
}

/** Sky environment lighting whose specular radiance is then blended towards the planar reflection. */
class PlanarEnvironmentNode extends THREE.EnvironmentNode {
    constructor(
        envNode: Node | null,
        private readonly planar: Node<'vec3'>,
        private readonly weight: Node<'float'>,
    ) {
        super(envNode);
    }

    override setup(builder: NodeBuilder): undefined {
        if (this.envNode) {
            super.setup(builder);
        }

        const radiance = (builder.context as { radiance: Node<'vec3'> }).radiance;
        radiance.assign(mix(radiance, this.planar, this.weight));

        return undefined;
    }
}

/** Nodes shared by every water material variant (one scene copy per frame, however many variants). */
export type WaterSharedNodes = {
    sceneColor: (uv: Node<'vec2'>) => Node<'vec3'>;
    sceneDepth: THREE.DepthTexture;
    sceneDepthNode: THREE.ViewportDepthTextureNode;
};

export function createSharedNodes(): WaterSharedNodes {
    const colorTarget = new THREE.FramebufferTexture(1, 1);
    colorTarget.name = 'Water scene colour';
    colorTarget.minFilter = THREE.LinearFilter;
    colorTarget.magFilter = THREE.LinearFilter;
    colorTarget.generateMipmaps = false;
    const sceneColorBase = viewportTexture(screenUV, null, colorTarget);
    const sceneDepth = new THREE.DepthTexture(1, 1);

    return {
        sceneColor: (uv) => sceneColorBase.sample(uv).rgb as Node<'vec3'>,
        sceneDepth,
        sceneDepthNode: new THREE.ViewportDepthTextureNode(screenUV, null, sceneDepth),
    };
}

export type WaterMaterialOptions = {
    u: WaterUniforms;
    shared: WaterSharedNodes;
    /** Tileable ripple normal map (RGB) + foam noise (A). */
    waveTexture: THREE.Texture;
    levelTexture: THREE.Texture;
    dataTexture: THREE.Texture;
    bodyTable: THREE.Texture;
    /** WebGPU FFT waves (null: sum of waves). */
    fft: WaveFFT | null;
    layers: readonly WaterSurfaceLayer[];
};

/** The water material and its planar reflection texture node (for swapping in the reflection). */
export function createWaterMaterial(o: WaterMaterialOptions): { material: WaterMaterial; reflection: THREE.TextureNode } {
    const { u, fft } = o;
    const material = new WaterMaterial({ color: 0xffffff, metalness: 0, envMapIntensity: 1 });
    // Drawn after the opaque scene (it reads it back); alpha stays 1, so blending is a plain overwrite.
    material.transparent = true;
    material.depthWrite = true;
    material.name = fft ? 'Water (FFT)' : 'Water';
    material.sceneDepth = o.shared.sceneDepth;

    const waveTime = u.time.mul(u.waveSpeed);
    const fine = attribute<'float'>('waterFine', 'float');

    // ---- grid lookups
    const gridOf = (xz: Node<'vec2'>) => xz.add(u.mapHalf).div(u.dataSpacing);
    const insideMap = (xz: Node<'vec2'>) => max(abs(xz.x), abs(xz.y)).lessThan(u.mapHalf);
    /** depth, flow x, flow z (bilinear); outside the map deep still water. */
    const dataAt = (xz: Node<'vec2'>) => {
        const d = texture(o.dataTexture, gridOf(xz).add(0.5).div(u.dataSize));

        return select(insideMap(xz), vec3(d.x, d.y, d.z), vec3(40, 0, 0));
    };
    const rowAt = (xz: Node<'vec2'>) => {
        const g = clamp(floor(gridOf(xz).add(0.5)), 0, u.dataSize.sub(1));

        return select(insideMap(xz), textureLoad(o.dataTexture, ivec2(int(g.x), int(g.y))).w, float(0));
    };
    const tableAt = (row: Node<'float'>, entry: number) => textureLoad(o.bodyTable, ivec2(int(clamp(floor(row.add(0.5)), 0, BODY_ROWS - 1)), int(entry)));
    /** Surface level (bilinear between the 4 samples) and the cell mask at a world position. */
    const levelAt = (xz: Node<'vec2'>) => {
        const g = clamp(gridOf(xz), 0, u.dataSize.sub(1.001));
        const i = floor(g);
        const f = g.sub(i);
        const at = (dx: number, dz: number) => textureLoad(o.levelTexture, ivec2(int(i.x).add(int(dx)), int(i.y).add(int(dz)))).x;

        return mix(mix(at(0, 0), at(1, 0), f.x), mix(at(0, 1), at(1, 1), f.x), f.y);
    };
    const cellMask = (xz: Node<'vec2'>) => {
        const g = clamp(floor(gridOf(xz)), 0, u.dataSize.sub(2));

        return textureLoad(o.levelTexture, ivec2(int(g.x), int(g.y))).y;
    };

    // ---- vertex
    const geomWorld = modelWorldMatrix.mul(vec4(positionGeometry, 1)).xyz;
    // Fine mesh: the height comes from the level texture.
    const baseY = select(fine.greaterThan(0.5), levelAt(geomWorld.xz), geomWorld.y);
    const baseXZ = geomWorld.xz;
    const vData = dataAt(baseXZ);
    const vRow = rowAt(baseXZ);
    const vWaves = tableAt(vRow, BODY_TABLE.waves);
    const vMisc = tableAt(vRow, BODY_TABLE.misc);
    const camDist = length(baseXZ.sub(cameraPosition.xz));
    // Calm towards the map edge: chunks meet the coarse ocean ring there (no cracks along the seam).
    const edgeCalm = smoothstep(0, 60, u.mapHalf.sub(max(abs(baseXZ.x), abs(baseXZ.y))));
    const vFade = smoothstep(0.25, 2.5, vData.x).mul(edgeCalm);
    const ctxFor = (xz: Node<'vec2'>, depth: Node<'float'>, row: Node<'float'>, misc: Node<'vec4'>): WaterLayerContext => ({
        xz,
        time: waveTime,
        depth,
        row,
        kind: misc.z,
        surf: misc.y,
        windDir: u.windDir,
        wind: u.wind,
    });

    const cascadeW = (v: Node<'vec4'>, i: number) => [v.x, v.y, v.z][i];
    const sumWave = (i: Node<'int'>, fn: (a: Node<'vec4'>, amp: Node<'float'>, k: Node<'float'>, phi: Node<'float'>) => void) => {
        const a = u.compA.element(i) as unknown as Node<'vec4'>;
        const b = u.compB.element(i) as unknown as Node<'vec4'>;
        const cascade = int(b.y);
        // The chop cascade only up close; swell and wind waves farther out.
        const reach = select(
            cascade.equal(2),
            smoothstep(CASCADE_FADE[1][0] * 4, CASCADE_FADE[1][1] * 4, camDist).oneMinus(),
            smoothstep(CASCADE_FADE[0][0], CASCADE_FADE[0][1], camDist).oneMinus(),
        );
        const w = select(cascade.equal(0), vWaves.x, select(cascade.equal(1), vWaves.y, vWaves.z)).mul(reach);
        const k = max(length(a.xy), 1e-4);
        fn(a, a.z.mul(w), k, dot(a.xy, baseXZ).sub(b.x.mul(waveTime)).add(a.w));
    };
    const isSea = select(vMisc.z.greaterThan(2.5), float(1), float(0));
    const swellAmp = u.oceanSwell.mul(isSea).mul(smoothstep(0.5, 4, vData.x));
    /** Ocean swell on the sea (kind 3) and the open water around the map: (height, slope x, slope z). */
    const swell = (): Node<'vec3'> => {
        let h: Node<'float'> = float(0);
        let grad: Node<'vec2'> = vec2(0);

        SWELLS.forEach((s, i) => {
            const len = Math.hypot(s.dir[0], s.dir[1]);
            const dir = vec2(s.dir[0] / len, s.dir[1] / len);
            const k = (Math.PI * 2) / s.length;
            const speed = Math.sqrt(9.81 / k);
            const arg = dot(dir, baseXZ).sub(waveTime.mul(speed)).mul(k);
            const group = sin(dot(vec2(dir.y.negate(), dir.x), baseXZ).mul((Math.PI * 2) / (s.length * 4.7)).add(i * 1.7))
                .mul(sin(dot(dir, baseXZ).mul((Math.PI * 2) / (s.length * 7.3))))
                .mul(0.4)
                .add(0.6);
            const a = swellAmp.mul(group).mul(s.amp);
            h = h.add(sin(arg).mul(a));
            grad = grad.add(dir.mul(cos(arg).mul(a.mul(k))));
        });

        return vec3(h, grad);
    };
    const swellNode = swell();

    const disp = Fn(() => {
        const d = vec3(0, swellNode.x, 0).toVar();
        const chop = vWaves.w;

        if (fft) {
            CASCADES.forEach((c, i) => {
                const [f0, f1] = CASCADE_FADE[i];
                const w = cascadeW(vWaves, i).mul(smoothstep(f0, f1, camDist).oneMinus());
                const t = texture(fft.displacement[i], baseXZ.div(c.length)).level(float(0));
                d.addAssign(vec3(t.x.mul(chop), t.y, t.z.mul(chop)).mul(w));
            });
        } else {
            Loop(COMPONENT_COUNT, ({ i }: { i: Node<'int'> }) => {
                sumWave(i, (a, amp, k, phi) => {
                    const sn = sin(phi).mul(amp).mul(chop);
                    d.addAssign(vec3(a.x.div(k).mul(sn).negate(), cos(phi).mul(amp), a.y.div(k).mul(sn).negate()));
                });
            });
        }

        for (const layer of o.layers) {
            if (layer.displacement) {
                d.addAssign(layer.displacement(ctxFor(baseXZ, vData.x, vRow, vMisc)));
            }
        }

        return d.mul(vFade);
    })();
    /** Sum of waves: analytic slopes (x, z) and Jacobian diagonal (x, z); FFT: only the swell's slope. */
    const slopeJac = Fn(() => {
        const slope = swellNode.yz.toVar();
        const jac = vec2(1).toVar();

        if (!fft) {
            const chop = vWaves.w;
            Loop(COMPONENT_COUNT, ({ i }: { i: Node<'int'> }) => {
                sumWave(i, (a, amp, k, phi) => {
                    slope.subAssign(a.xy.mul(sin(phi).mul(amp)));
                    jac.subAssign(vec2(a.x.mul(a.x), a.y.mul(a.y)).div(k).mul(cos(phi).mul(amp).mul(chop)));
                });
            });
        }

        return vec4(slope.mul(vFade), mix(vec2(1), jac, vFade));
    })();
    const worldPos = vec3(baseXZ.x, baseY, baseXZ.y).add(disp);
    // Back to local space (the fine mesh is scaled in x / z).
    const localScale = select(fine.greaterThan(0.5), u.fineScale, float(1));
    material.positionNode = vec3(
        positionGeometry.x.add(disp.x.div(localScale)),
        select(fine.greaterThan(0.5), worldPos.y, positionGeometry.y.add(disp.y)),
        positionGeometry.z.add(disp.z.div(localScale)),
    );
    const vBase = varying(baseXZ, 'vWaterBase');
    const vHeight = varying(disp.y, 'vWaterHeight');
    const vFine = varying(fine, 'vWaterFine');
    const vSlope = varying(slopeJac.xy, 'vWaterSlope');
    const vJac = varying(slopeJac.zw, 'vWaterJac');

    // ---- fragment
    const wave = (uv: Node<'vec2'>) => texture(o.waveTexture, uv);
    const waveNormal = (uv: Node<'vec2'>) => wave(uv).xyz.mul(2).sub(1);
    const pos = positionWorld;
    const base = vBase;
    const viewDist = length(positionView);
    const fragDepth = positionView.z.negate();

    // Fine mesh only where the chunks draw water; chunks give way to the fine mesh around the camera
    // (with a little overlap, so there is never a gap between the two).
    const cheb = max(abs(base.x.sub(u.fineCenter.x)), abs(base.y.sub(u.fineCenter.y)));
    const fineKeep = cellMask(base).greaterThan(0.5).and(cheb.lessThanEqual(u.fineHalf)).and(insideMap(base));
    const chunkKeep = cheb.greaterThanEqual(u.fineHalf.sub(u.dataSpacing.mul(1.5)));
    material.maskNode = select(vFine.greaterThan(0.5), fineKeep, chunkKeep);

    const fData = dataAt(base);
    const waterFlow = vec2(fData.y, fData.z);
    const row = rowAt(base);
    const bodyWaves = tableAt(row, BODY_TABLE.waves);
    const bodyShallow = tableAt(row, BODY_TABLE.shallow);
    const bodyDeep = tableAt(row, BODY_TABLE.deep);
    const bodyMisc = tableAt(row, BODY_TABLE.misc);
    const ctx = ctxFor(base, fData.x, row, bodyMisc);

    // Per-body colours (flags in the shallow entry's alpha: 1 shallow, 2 deep).
    const flags = bodyShallow.w;
    const shallowColor = select(fract(flags.mul(0.5)).greaterThan(0.25), vec3(bodyShallow.xyz), (u.shallow as unknown as Node<'vec3'>)) as Node<'vec3'>;
    const deepColor = select(flags.greaterThan(1.5), vec3(bodyDeep.xyz), (u.deep as unknown as Node<'vec3'>)) as Node<'vec3'>;
    const clarity = max(select(bodyDeep.w.greaterThan(0), bodyDeep.w, u.clarity), 0.05);

    // Scene behind the water (shared copies).
    const sceneColor = o.shared.sceneColor;
    const sceneDistance = (uv: Node<'vec2'>) => {
        const depth = o.shared.sceneDepthNode.sample(uv).x;

        return select(isSkyDepth(depth), float(1e6), perspectiveDepthToViewZ(depth, cameraNear, cameraFar).negate());
    };
    const resolvable = (thickness: Node<'float'>) => max(thickness, depthPrecision(fragDepth, cameraNear).mul(4));
    const viewDir = normalize(cameraPosition.sub(pos));
    const cosV = max(abs(viewDir.y), 0.08);
    const thickness = resolvable(max(sceneDistance(screenUV).sub(fragDepth), 0));
    const vertical = thickness.mul(cosV);

    // ---- wind, gusts (catspaws) and wave weights here
    const wind = u.windDir;
    const exposure = bodyMisc.x;
    // Travelling gust field (as over the vegetation): darker, rougher patches of ripples sweep downwind.
    const gp = base.sub(u.gustOffset).mul(u.gust.y).toVar();
    const gustNoise = gnoise(gp).mul(0.65).add(gnoise(gp.mul(2.3).add(vec2(17.3, u.time.mul(0.05)))).mul(0.35));
    const gustField = smoothstep(-0.15, 0.6, gustNoise);
    const catspaw = mix(float(1), gustField.mul(1.5).add(0.25), clamp(u.gust.x, 0, 1).mul(min(exposure, 1)));
    // Ripples grow with the wind (glassy in a calm), on exposed water.
    const ripple = smoothstep(0.02, 0.6, u.wind.mul(exposure)).mul(0.85).add(0.15).mul(catspaw);

    // ---- foam (shore, rapids, river streaks; whitecaps below)
    const bubblesA = wave(pos.xz.div(3.3).add(wind.mul(waveTime.mul(0.015))).add(waterFlow.mul(waveTime.mul(0.2)))).a;
    const bubblesB = wave(pos.xz.div(1.7).sub(wind.yx.mul(waveTime.mul(0.022)))).a;
    const bubbles = bubblesA.mul(0.6).add(bubblesB.mul(0.4));
    const foamWidth = max(u.foamWidth, 0.05);
    const edge = smoothstep(0, foamWidth, vertical).oneMinus();
    const patchNoise = wave(pos.xz.div(29).add(wind.mul(waveTime.mul(0.006))).add(waterFlow.mul(waveTime.mul(0.02))))
        .x.add(wave(pos.xz.div(11.3).sub(wind.yx.mul(waveTime.mul(0.01)))).y)
        .mul(0.5)
        .toVar();
    const patches = smoothstep(0.36, 0.62, patchNoise);
    const breakup = mix(1, patches, clamp(u.foamBreakup, 0, 1));
    const lap = sin(waveTime.mul(1.3).sub(vertical.mul(5).div(foamWidth))).mul(0.5).add(0.5);
    const lace = smoothstep(mix(0.72, 0.18, edge), mix(0.9, 0.42, edge), bubbles.add(edge.mul(lap).mul(0.12))).mul(edge);
    const rollPhase = vertical.div(foamWidth).mul(4.5).add(waveTime.mul(1.1)).add(patchNoise.mul(9));
    const rolls = smoothstep(0.6, 0.95, sin(rollPhase).mul(0.5).add(0.5))
        .mul(smoothstep(0, 0.4, edge))
        .mul(smoothstep(0.25, 0.5, bubbles))
        .mul(0.7);
    const contact = smoothstep(0.02, 0.12, vertical).oneMinus().mul(smoothstep(0.1, 0.35, bubbles));
    const shoreFoam = u.foamEnabled.mul(max(contact.mul(0.85), lace.add(rolls).mul(breakup)));
    const flowSpeed = length(waterFlow);
    const flowUv = pos.xz.div(4.1);
    const flowVec = waterFlow.mul(u.flowSpeed).mul(0.35);
    const fph0 = fract(waveTime.mul(0.12));
    const fph1 = fract(waveTime.mul(0.12).add(0.5));
    const streakDir = waterFlow.div(max(flowSpeed, 1e-3)).mul(0.09);
    const smeared = (uv: Node<'vec2'>) => wave(uv).a.add(wave(uv.add(streakDir)).a).add(wave(uv.sub(streakDir)).a).div(3);
    const carried = mix(smeared(flowUv.sub(flowVec.mul(fph0))), smeared(flowUv.sub(flowVec.mul(fph1)).add(0.37)), abs(fph0.sub(0.5)).mul(2));
    const streaks = u.rapids.mul(smoothstep(0.38, 0.7, carried)).mul(smoothstep(0.2, 0.5, flowSpeed)).mul(mix(1, patches, 0.6)).mul(0.45);
    const rapids = u.rapids.mul(smoothstep(0.45, 1, flowSpeed)).mul(smoothstep(0.25, 0.6, bubbles.mul(0.5).add(carried.mul(0.5))));
    const foamFade = smoothstep(40, 220, viewDist).oneMinus();

    // ---- wind waves: slopes, Jacobian (whitecaps) and sub-pixel slope variance (roughness)
    // (Plain expressions, no shader variables: this runs outside a function scope.)
    let fftSlope: Node<'vec2'> = vec2(0);
    let fftJac: Node<'vec2'> = vec2(1);
    let lostVariance: Node<'float'> = float(0);
    let minJacobian: Node<'float'> = float(1);
    const fragFade = smoothstep(0.25, 2.5, fData.x);
    const chop = bodyWaves.w;

    if (fft) {
        CASCADES.forEach((c, i) => {
            const uv = base.div(c.length);
            // The chop cascade carries the catspaws.
            const wc = cascadeW(bodyWaves, i).mul(fragFade).mul(i === 2 ? catspaw : float(1));
            const d = texture(fft.derivatives[i], uv);
            fftSlope = fftSlope.add(d.xy.mul(wc));
            fftJac = fftJac.add(vec2(d.z, d.z).mul(wc.mul(chop)));
            // Texels per pixel: beyond ~1 the mip chain averages slopes away; that variance goes into
            // the roughness instead (stable glints instead of sparkling aliasing).
            const rate = fwidth(uv.mul(FFT_SIZE));
            const lost = smoothstep(0.6, 4, max(rate.x, rate.y));
            lostVariance = lostVariance.add(cascadeW(vec4(u.slopeVar, 0), i).mul(wc.mul(wc)).mul(lost));
            // Whitecaps: the persistent Jacobian, scaled to this body's waves (linearised).
            if (i < 2) {
                const jp = d.w;
                minJacobian = min(minJacobian, float(1).sub(float(1).sub(jp).mul(wc.mul(chop))));
            }
        });
    } else {
        fftSlope = vSlope;
        fftJac = vJac;
        minJacobian = min(vJac.x, vJac.y);
        // Unmodelled small waves (the sum keeps only the strongest).
        lostVariance = u.slopeVar.z.mul(bodyWaves.z.mul(bodyWaves.z)).mul(fragFade).mul(0.5);
    }

    // Whitecaps: where the surface folds (Jacobian < ~0.5) foam breaks out and lingers.
    const capCover = smoothstep(0.55, -0.15, minJacobian).mul(u.whitecaps);
    const whitecap = smoothstep(0.25, 0.75, capCover.mul(bubbles.mul(0.9).add(0.55))).mul(smoothstep(60, 400, viewDist).oneMinus().mul(0.7).add(0.3));

    let layerFoam: Node<'float'> = float(0);
    let layerSlope: Node<'vec2'> = vec2(0);

    for (const layer of o.layers) {
        if (layer.foam) {
            layerFoam = max(layerFoam, layer.foam(ctx));
        }

        if (layer.slope) {
            layerSlope = layerSlope.add(layer.slope(ctx));
        }
    }

    const foam = clamp(
        shoreFoam.add(rapids).add(streaks).mul(u.foamIntensity).mul(1.5).mul(foamFade).add(whitecap).add(layerFoam),
        0,
        1,
    );

    // Water body colour (in-scattering): shallow → deep with optical depth.
    const optical = exp(thickness.negate().div(clarity)).oneMinus();
    const body = mix(shallowColor, deepColor, smoothstep(0, 1, optical));
    material.colorNode = vec4(mix(body.mul(optical).mul(0.9), vec3(0.9, 0.93, 0.95), foam), 1);
    // Roughness: the setting, rain, and the slope variance of waves too small to see (Toksvig-like).
    const alpha0 = u.roughness.add(u.rain.mul(0.05)).pow(2);
    const alpha = sqrt(alpha0.mul(alpha0).add(lostVariance.mul(0.5)));
    material.roughnessNode = mix(sqrt(alpha), 0.6, foam);

    // ---- normals
    const worldNormal = Fn(() => {
        const uv = pos.xz.div(max(u.waveScale, 0.1));
        // River flow mapping: two phases of the same layer, cross-faded to hide the reset.
        const flow = waterFlow.mul(u.flowSpeed).mul(0.9);
        const ph0 = fract(waveTime.mul(0.25));
        const ph1 = fract(waveTime.mul(0.25).add(0.5));
        const fw = abs(ph0.sub(0.5)).mul(2);
        const flowN = mix(waveNormal(uv.sub(flow.mul(ph0))), waveNormal(uv.sub(flow.mul(ph1)).add(0.5)), fw);
        const hasFlow = smoothstep(0.02, 0.2, flowSpeed);
        const tiles = (scale: number) => {
            const rate = fwidth(uv.mul(scale));

            return smoothstep(0.03, 0.12, max(rate.x, rate.y)).oneMinus();
        };
        const fine = waveNormal(uv.mul(3.1).add(vec2(wind.y.negate(), wind.x).mul(waveTime.mul(0.05))));
        const fineSlope = fine.xy.div(fine.z).mul(0.45).mul(smoothstep(20, 150, viewDist).oneMinus()).mul(tiles(3.1));
        const strength = u.waveStrength.mul(0.35).mul(ripple);
        const calmShallow = smoothstep(0, 0.4, vertical).mul(0.7).add(0.3);
        const ripples = Fn(() => {
            if (fft) {
                // FFT: the spectrum carries the waves; the texture adds capillary ripples and river flow.
                const flowSlope = flowN.xy.div(flowN.z).mul(tiles(1)).mul(hasFlow);

                return fineSlope.add(flowSlope).mul(strength);
            }

            // Sum of waves: the ripple texture in octaves carries the small waves (as before).
            const big = waveNormal(uv.mul(0.27).add(wind.mul(waveTime.mul(0.011))));
            const rotated = vec2(uv.x.mul(0.8).sub(uv.y.mul(0.6)), uv.x.mul(0.6).add(uv.y.mul(0.8)));
            const mid = mix(waveNormal(rotated.mul(0.9).sub(wind.mul(waveTime.mul(0.023)))), flowN, hasFlow);
            const bigWeight = tiles(0.27);
            const broad = waveNormal(vec2(uv.x.mul(0.6).add(uv.y.mul(0.8)), uv.y.mul(0.6).sub(uv.x.mul(0.8))).mul(0.071).add(wind.mul(waveTime.mul(0.004))));
            const fade = mix(1, 0.35, smoothstep(60, 900, viewDist));

            return big.xy
                .div(big.z)
                .mul(bigWeight.mul(0.9))
                .add(broad.xy.div(broad.z).mul(bigWeight.oneMinus().mul(tiles(0.071)).mul(0.9)))
                .add(mid.xy.div(mid.z).mul(tiles(0.9)))
                .add(fineSlope)
                .mul(strength.mul(fade));
        })();
        const slope = ripples.mul(foam.mul(0.7).oneMinus()).mul(calmShallow).toVar();

        If(u.rain.greaterThan(0.001), () => {
            slope.addAssign(rainRipples(pos.xz, u.time).mul(u.rain.mul(0.35).mul(smoothstep(12, 60, viewDist).oneMinus())));
        });

        // Wind waves (FFT or the sum), with the horizontal squeeze of choppy crests.
        const waveSlope = fftSlope.div(max(fftJac, vec2(0.2))).add(layerSlope);

        return normalize(vec3(waveSlope.x.add(slope.x).negate(), 1, waveSlope.y.add(slope.y).negate()));
    })();
    const normal = worldNormal.transformDirection(cameraViewMatrix);
    material.normalNode = normal;

    // ---- refraction & absorption
    const offset = vec2(normal.x, normal.y.negate()).mul(u.refraction.mul(0.08).mul(smoothstep(0, 2.5, thickness)));
    const bentUv = clamp(screenUV.add(offset), 0.001, 0.999);
    const refractUv = select(sceneDistance(bentUv).lessThan(fragDepth), screenUV, bentUv);
    const refractThickness = resolvable(max(sceneDistance(refractUv).sub(fragDepth), 0));
    const sigma = vec3(1).sub(clamp(shallowColor.mul(1.4), 0, 0.98)).mul(1.6).div(clarity).add(float(0.02).div(clarity));
    const transmittance = exp(sigma.negate().mul(refractThickness));
    const nDotV = clamp(dot(normal, positionViewDirection), 0, 1);
    const fresnel = pow(nDotV.oneMinus(), 5).mul(0.98).add(0.02);

    // ---- subsurface glow: light scattered through thin wave crests, strongest looking towards the sun.
    const amplitude = max(dot(bodyWaves.xyz, u.heightStd), 0.01);
    const crest = smoothstep(0, amplitude.mul(2.2), vHeight.add(amplitude.mul(0.3)));
    const towardsSun = pow(clamp(dot(viewDir.negate(), normalize(u.sunDir.add(worldNormal.mul(0.4)))), 0, 1), 3);
    const sunUp = smoothstep(-0.05, 0.15, u.sunDir.y);
    const sss = shallowColor
        .mul((u.sunColor as unknown as Node<'vec3'>))
        .mul(crest.mul(towardsSun.mul(0.9).add(0.12)))
        .mul(u.subsurface.mul(0.35).mul(sunUp))
        .mul(fresnel.oneMinus())
        .mul(foam.oneMinus());
    // Editor: the selected body pulses softly.
    const selected = bodyMisc.w.mul(sin(u.time.mul(4)).mul(0.5).add(0.5)).mul(u.highlight);

    material.emissiveNode = sceneColor(refractUv)
        .mul(transmittance)
        .mul(fresnel.oneMinus())
        .mul(foam.oneMinus())
        .add(sss)
        .add(vec3(0.05, 0.35, 0.6).mul(selected.mul(0.35)));

    // ---- planar reflection of the dominant level
    const reflClip = u.reflMatrix.mul(vec4(pos.x, u.reflLevel, pos.z, 1));
    const reflUv = clamp(
        reflClip.xy.div(reflClip.w).add(vec2(normal.x, normal.y.negate()).mul(u.refraction.mul(0.02).add(0.012))),
        0.001,
        0.999,
    );
    const placeholder = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    placeholder.minFilter = placeholder.magFilter = THREE.LinearFilter;
    placeholder.needsUpdate = true;
    const reflection = texture(placeholder, reflUv);
    material.planarNode = reflection.rgb;
    material.planarWeightNode = u.hasReflection.mul(smoothstep(0.4, 2, abs(pos.y.sub(u.reflLevel))).oneMinus());

    material.underNode = sceneColor(screenUV);
    material.shoreNode = smoothstep(0, 0.18, vertical);

    return { material, reflection };
}
