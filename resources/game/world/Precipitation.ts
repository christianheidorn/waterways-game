import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
    abs,
    atan,
    attribute,
    cameraPosition,
    cos,
    cross,
    dot,
    exp,
    float,
    fract,
    fwidth,
    hash,
    length,
    max,
    min,
    mix,
    mod,
    normalize,
    positionGeometry,
    positionWorld,
    pow,
    screenSize,
    sin,
    smoothstep,
    uniform,
    varying,
    vec2,
    vec3,
} from 'three/tsl';
import type { QualityLevel } from '../shared/types';
import type {
    PrecipitationLight,
    PrecipitationWorld,
    SharedUniforms,
} from './PrecipitationCommon';
import { createSharedUniforms, dropLight } from './PrecipitationCommon';
import { RainSplashes } from './RainSplashes';

/** Maximum particles per effects quality (the active count scales with intensity). */
const RAIN_COUNT: Record<QualityLevel, number> = {
    low: 3500,
    medium: 9000,
    high: 16000,
    epic: 28000,
};
const SNOW_COUNT: Record<QualityLevel, number> = {
    low: 3000,
    medium: 7000,
    high: 14000,
    epic: 24000,
};
/** Distant rain / snow curtains (cylinders around the camera) per effects quality. */
const CURTAIN_RADII: Record<QualityLevel, number[]> = {
    low: [],
    medium: [55],
    high: [30, 70],
    epic: [24, 48, 95],
};

const RAIN_BOX = new THREE.Vector3(44, 28, 44);
const SNOW_BOX = new THREE.Vector3(38, 24, 38);
const RAIN_FALL = 9.5;
const SNOW_FALL = 1.15;

function createLayerUniforms(box: THREE.Vector3) {
    return {
        offset: uniform(new THREE.Vector3()),
        box: uniform(box.clone()),
        velocity: uniform(new THREE.Vector3(0, -RAIN_FALL, 0)),
        opacity: uniform(0.3),
    };
}

type LayerUniforms = ReturnType<typeof createLayerUniforms>;
type FloatUniform = THREE.UniformNode<'float', number>;

type Layer = {
    mesh: THREE.Mesh<
        THREE.InstancedBufferGeometry,
        THREE.MeshBasicNodeMaterial
    >;
    uniforms: LayerUniforms;
    offset: THREE.Vector3;
    max: number;
};

type Curtain = {
    mesh: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicNodeMaterial>;
    opacity: FloatUniform;
};

/**
 * Rain and snow around the camera, animated on the GPU:
 *
 * - near particles: instanced camera-facing quads whose position is `seed * box + wind-driven offset`,
 *   wrapped into a box centred on the camera (world-stable while the camera moves). Rain streaks are
 *   stretched along the drop's motion relative to the eye (fall + wind − camera motion) over a short
 *   exposure, like motion blur; thin streaks keep a minimum on-screen width and fade instead
 *   (no sparkling sub-pixel lines);
 * - distant curtains: a few cylinders around the camera with a procedural, scrolling streak pattern
 *   that turns into a soft haze where it gets finer than a pixel; the scene fog swallows them;
 * - rain splashes and a low mist on the ground in heavy rain (RainSplashes);
 * - everything is lit like water drops: sky light, the horizon they refract, a forward-scattering
 *   glint towards the sun, and lightning flashes.
 *
 * The active counts follow the precipitation amount (light rain costs little); effects quality sets
 * the maximum counts, the number of curtains and the splashes.
 */
export class Precipitation {
    readonly group = new THREE.Group();
    private readonly shared = createSharedUniforms();
    private rain: Layer;
    private snow: Layer;
    private curtains: Curtain[] = [];
    private readonly curtainStyle = {
        /** 1 = rain streaks, 0 = snow flakes. */
        rain: uniform(1),
        wind: uniform(new THREE.Vector2()),
        fall: uniform(RAIN_FALL),
    };
    private readonly splashes: RainSplashes;
    private quality: QualityLevel = 'medium';
    private readonly lastCamPos = new THREE.Vector3();
    private hasLastCamPos = false;
    private readonly tmp = new THREE.Vector3();
    private readonly velocity = new THREE.Vector3();

    constructor(world: PrecipitationWorld, quality: QualityLevel = 'medium') {
        this.group.name = 'Precipitation';
        this.quality = quality;
        this.rain = this.createLayer(RAIN_COUNT[quality], RAIN_BOX, rainNodes);
        this.snow = this.createLayer(SNOW_COUNT[quality], SNOW_BOX, snowNodes);
        this.splashes = new RainSplashes(world, this.shared, quality);
        this.group.add(this.splashes.group);
        this.buildCurtains();
    }

    setQuality(quality: QualityLevel): void {
        const q = RAIN_COUNT[quality] ? quality : 'medium';

        if (q === this.quality) {
            return;
        }

        this.quality = q;
        this.rebuild(this.rain, RAIN_COUNT[q]);
        this.rebuild(this.snow, SNOW_COUNT[q]);
        this.splashes.setQuality(q);
        this.buildCurtains();
    }

    /**
     * @param rain  0-1 rain intensity
     * @param snow  0-1 snowfall intensity
     * @param wind  horizontal wind (m/s-ish, x/z)
     * @param light light hitting the particles
     */
    update(
        dt: number,
        camera: THREE.Camera,
        rain: number,
        snow: number,
        wind: THREE.Vector2,
        light: PrecipitationLight,
        hidden: boolean,
    ): void {
        const s = this.shared;
        const cam = this.tmp.setFromMatrixPosition(camera.matrixWorld);
        s.camPos.value.copy(cam);
        s.time.value += dt;

        // Camera velocity, smoothed; a jump (teleport, camera cut) is not motion.
        if (this.hasLastCamPos && dt > 0) {
            const v = this.velocity
                .copy(cam)
                .sub(this.lastCamPos)
                .divideScalar(dt);

            if (v.length() > 60) {
                v.set(0, 0, 0);
            }

            s.camVelocity.value.lerp(v, 1 - Math.exp(-dt / 0.08));
        }

        this.lastCamPos.copy(cam);
        this.hasLastCamPos = true;

        if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
            const fov = THREE.MathUtils.degToRad(
                (camera as THREE.PerspectiveCamera).fov,
            );
            // Divided by the render height in the shader (screenSize).
            s.pixelAngle.value = 2 * Math.tan(fov / 2);
        }

        s.ambient.value.set(light.ambient.r, light.ambient.g, light.ambient.b);
        s.sky.value.set(light.sky.r, light.sky.g, light.sky.b);
        s.sun.value.set(light.sun.r, light.sun.g, light.sun.b);
        s.sunDirection.value.copy(light.sunDirection);
        s.flash.value = light.flash;
        s.flashDirection.value.copy(light.flashDirection);

        const r = hidden ? 0 : rain;
        const sn = hidden ? 0 : snow;
        this.updateLayer(
            this.rain,
            dt,
            r,
            wind.x * 2.4,
            -RAIN_FALL,
            wind.y * 2.4,
            0.9,
        );
        this.updateLayer(
            this.snow,
            dt,
            sn,
            wind.x * 1.6,
            -SNOW_FALL,
            wind.y * 1.6,
            0.9,
        );
        this.updateCurtains(cam, r, sn, wind);
        this.splashes.setWind(wind);
        this.splashes.update(dt, cam, r);
    }

    dispose(): void {
        for (const layer of [this.rain, this.snow]) {
            layer.mesh.geometry.dispose();
            layer.mesh.material.dispose();
        }

        this.disposeCurtains();
        this.splashes.dispose();
    }

    private updateLayer(
        layer: Layer,
        dt: number,
        amount: number,
        vx: number,
        vy: number,
        vz: number,
        opacity: number,
    ): void {
        const count = Math.floor(
            layer.max * THREE.MathUtils.clamp(amount, 0, 1),
        );
        layer.mesh.visible = count > 16;

        if (!layer.mesh.visible) {
            return;
        }

        const u = layer.uniforms;
        const box = u.box.value;
        layer.mesh.geometry.instanceCount = count;
        u.velocity.value.set(vx, vy, vz);
        // Offset accumulated on the CPU and kept inside the box so float precision never degrades.
        const o = layer.offset;
        o.x = (o.x + vx * dt) % box.x;
        o.y = (o.y + vy * dt) % box.y;
        o.z = (o.z + vz * dt) % box.z;
        u.offset.value.copy(o);
        // Light rain is fainter as well as sparser.
        u.opacity.value = opacity * (0.55 + 0.45 * Math.min(1, amount * 1.5));
    }

    private updateCurtains(
        cam: THREE.Vector3,
        rain: number,
        snow: number,
        wind: THREE.Vector2,
    ): void {
        const amount = Math.max(rain, snow);
        const style = this.curtainStyle;
        style.rain.value = rain >= snow ? 1 : 0;
        style.fall.value = rain >= snow ? RAIN_FALL : SNOW_FALL;
        style.wind.value.copy(wind).multiplyScalar(rain >= snow ? 2.4 : 1.6);

        for (const c of this.curtains) {
            // Only heavier precipitation reads as curtains in the distance.
            const k = THREE.MathUtils.smoothstep(amount, 0.2, 0.8);
            c.mesh.visible = k > 0.01;
            c.opacity.value = k;
            c.mesh.position.set(cam.x, cam.y + 12, cam.z);
        }
    }

    private buildCurtains(): void {
        this.disposeCurtains();

        for (const radius of CURTAIN_RADII[this.quality]) {
            const opacity = uniform(0);
            const material = new THREE.MeshBasicNodeMaterial({
                transparent: true,
                depthWrite: false,
                side: THREE.BackSide,
            });
            const nodes = curtainNodes(
                this.shared,
                this.curtainStyle,
                radius,
                opacity,
            );
            material.colorNode = nodes.color;
            material.opacityNode = nodes.opacity;
            material.alphaTest = 0.002;
            const mesh = new THREE.Mesh(
                new THREE.CylinderGeometry(radius, radius, 70, 48, 1, true),
                material,
            );
            mesh.name = 'RainCurtain';
            mesh.frustumCulled = false;
            // Farthest first, all before the near streaks.
            mesh.renderOrder = 8 - radius / 1000;
            mesh.visible = false;
            this.group.add(mesh);
            this.curtains.push({ mesh, opacity });
        }
    }

    private disposeCurtains(): void {
        for (const c of this.curtains) {
            c.mesh.removeFromParent();
            c.mesh.geometry.dispose();
            c.mesh.material.dispose();
        }

        this.curtains = [];
    }

    private createLayer(
        max: number,
        box: THREE.Vector3,
        nodes: (s: SharedUniforms, u: LayerUniforms) => ParticleNodes,
    ): Layer {
        const uniforms = createLayerUniforms(box);
        const shape = nodes(this.shared, uniforms);
        const material = new THREE.MeshBasicNodeMaterial({
            transparent: true,
            depthWrite: false,
            blending: THREE.NormalBlending,
            side: THREE.DoubleSide,
            fog: false,
        });
        material.positionNode = shape.position;
        material.colorNode = shape.color;
        material.opacityNode = shape.opacity;
        // Faint fragments are skipped: they would still overwrite the velocity / normal attachments.
        material.alphaTest = 0.004;
        const mesh = new THREE.Mesh(this.createGeometry(max), material);
        mesh.frustumCulled = false;
        mesh.renderOrder = 10;
        mesh.visible = false;
        this.group.add(mesh);

        return { mesh, uniforms, offset: new THREE.Vector3(), max };
    }

    private rebuild(layer: Layer, max: number): void {
        layer.mesh.geometry.dispose();
        layer.mesh.geometry = this.createGeometry(max);
        layer.max = max;
    }

    private createGeometry(count: number): THREE.InstancedBufferGeometry {
        const geometry = new THREE.InstancedBufferGeometry();
        // Unit quad: x across (-0.5..0.5), y along the particle (0..1).
        geometry.setAttribute(
            'position',
            new THREE.BufferAttribute(
                new Float32Array([
                    -0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0,
                ]),
                3,
            ),
        );
        geometry.setIndex([0, 1, 2, 0, 2, 3]);
        const seeds = new Float32Array(count * 4);

        for (let i = 0; i < seeds.length; i++) {
            seeds[i] = Math.random();
        }

        geometry.setAttribute(
            'aSeed',
            new THREE.InstancedBufferAttribute(seeds, 4),
        );
        geometry.instanceCount = 0;

        return geometry;
    }
}

/** World-space vertex position, colour and opacity of one particle layer. */
type ParticleNodes = {
    position: Node<'vec3'>;
    color: Node<'vec3'>;
    opacity: Node<'float'>;
};

const seed = attribute<'vec4'>('aSeed', 'vec4');

/**
 * Particle centre wrapped into a box around the camera (world-stable while the camera moves), and a
 * fade at the box edges and very close to the eye.
 */
function particleCentre(
    s: SharedUniforms,
    u: LayerUniforms,
    extra: Node<'vec3'>,
): { centre: Node<'vec3'>; fade: Node<'float'> } {
    const p = seed.xyz.mul(u.box).add(u.offset).add(extra);
    const half = u.box.mul(0.5);
    const rel = mod(p.sub(s.camPos).add(half), u.box).sub(half);
    const edge = abs(rel).div(half);
    const fade = smoothstep(0.65, 1, max(edge.x, max(edge.y, edge.z)))
        .oneMinus()
        .mul(smoothstep(0.6, 2.5, length(rel)));

    return { centre: s.camPos.add(rel), fade };
}

/**
 * Rain: streaks along the drop's motion relative to the eye (a ~1/25 s exposure), camera facing
 * around that axis. Streaks thinner than ~1.5 px are drawn at that width with proportionally less
 * opacity, so distant rain turns into a soft, even haze instead of flickering needles.
 */
function rainNodes(s: SharedUniforms, u: LayerUniforms): ParticleNodes {
    const { centre, fade } = particleCentre(s, u, vec3(0));
    const rel = u.velocity.sub(s.camVelocity);
    const speed = max(length(rel), 0.5);
    const dir = rel.div(speed);
    const toCam = cameraPosition.sub(centre);
    const dist = max(length(toCam), 0.1);
    const across = cross(dir, toCam.div(dist));
    // Looking straight along the motion the streak degenerates to a dot: keep a tiny side vector.
    const side = normalize(across.add(vec3(1e-4, 0, 1e-4)));
    const pixel = dist.mul(s.pixelAngle).div(screenSize.y);
    // Physical width of a motion-blurred drop (a few mm), shown at ≥ 1.5 px.
    const width = seed.w.mul(0.004).add(0.005);
    const drawnWidth = max(width, pixel.mul(1.5));
    const coverage = width.div(drawnWidth);
    const len = max(speed.mul(seed.w.mul(0.03).add(0.04)), pixel.mul(4));
    const position = centre
        .add(side.mul(positionGeometry.x.mul(drawnWidth)))
        .sub(dir.mul(len.mul(positionGeometry.y)));
    // Nearer drops are a little larger and brighter; far ones less so (they are thinner as well).
    const vFade = varying(
        fade.mul(seed.w.mul(0.4).add(0.6)).mul(min(coverage.mul(1.6), 1)),
    );
    const vColor = varying(
        dropLight(s, toCam.div(dist).negate(), 0.45, 0.85, 0.35),
    );

    // Soft profile across; bright head (the drop) with a tapering tail (its motion blur).
    const x = positionGeometry.x.mul(2);
    const profile = x.mul(x).oneMinus().max(0);
    const y = positionGeometry.y;
    const along = smoothstep(0, 0.1, y).mul(pow(y.oneMinus(), 1.2));

    return {
        position,
        color: vColor,
        opacity: profile.mul(along).mul(vFade).mul(u.opacity),
    };
}

/** Snow: round flakes that tumble on top of the wind drift. */
function snowNodes(s: SharedUniforms, u: LayerUniforms): ParticleNodes {
    const phase = seed.w.mul(6.2831);
    const sway = vec3(
        sin(s.time.mul(seed.w.add(0.7)).add(phase)),
        0,
        cos(s.time.mul(seed.x.add(0.6)).add(phase.mul(1.3))),
    ).mul(0.35);
    const { centre, fade } = particleCentre(s, u, sway);
    const toCam = cameraPosition.sub(centre);
    const dist = max(length(toCam), 0.1);
    const toCamN = toCam.div(dist);
    const right = normalize(cross(vec3(0, 1, 0), toCamN));
    const up = cross(toCamN, right);
    const pixel = dist.mul(s.pixelAngle).div(screenSize.y);
    const size = seed.w.mul(0.035).add(0.025);
    const drawn = max(size, pixel.mul(2));
    const coverage = size.div(drawn);
    const q = vec2(positionGeometry.x, positionGeometry.y.sub(0.5));
    const position = centre.add(right.mul(q.x).add(up.mul(q.y)).mul(drawn));
    const vFade = varying(fade.mul(min(coverage.mul(coverage).mul(2), 1)));
    // Flakes scatter much more than they refract: bright, with a soft glint towards the sun.
    const vColor = varying(dropLight(s, toCamN.negate(), 1, 0.3, 0.2));

    const d = length(q.mul(2));

    return {
        position,
        color: vColor.mul(2.4).add(0.02),
        opacity: smoothstep(0.35, 1, d).oneMinus().mul(vFade).mul(u.opacity),
    };
}

/**
 * Distant precipitation on the inside of a cylinder around the camera: columns of streaks (rain) or
 * flakes (snow) at world-stable angles, falling and slanting with the wind. Where the pattern gets
 * finer than a pixel it fades to its average, a soft sheet of rain; the vertical ends fade out.
 */
function curtainNodes(
    s: SharedUniforms,
    style: {
        rain: FloatUniform;
        wind: THREE.UniformNode<'vec2', THREE.Vector2>;
        fall: FloatUniform;
    },
    radius: number,
    opacity: FloatUniform,
): { color: Node<'vec3'>; opacity: Node<'float'> } {
    const rel = positionWorld.sub(s.camPos);
    const theta = atan(rel.z, rel.x);
    // Tangential wind slants the columns; it also moves the pattern sideways.
    const tangent = vec2(sin(theta).negate(), cos(theta));
    const windT = dot(style.wind, tangent);
    const fall = style.fall;
    const isRain = style.rain;
    const layerSeed = radius * 0.137;
    // Arc length (m) and height, in the falling frame.
    const u0 = theta.mul(radius).add(rel.y.mul(windT).div(fall));
    const v0 = positionWorld.y.add(s.time.mul(fall));

    const layer = (spacing: number, dash: number, k: number) => {
        const cu = u0.div(spacing).add(layerSeed * k);
        const col = cu.floor();
        const r = hash(col.add(k * 17.0));
        const r2 = hash(col.add(k * 31.0 + 5));
        const x = fract(cu).sub(0.5).sub(r2.sub(0.5).mul(0.6));
        // Rain: long thin streaks; snow: small round flakes (a few cm).
        const widthK = mix(0.1, 0.12, isRain);
        const across = exp(x.mul(x).div(widthK.mul(widthK)).negate());
        const segment = mix(float(1.6), float(dash), isRain);
        const f = fract(v0.add(r.mul(97)).div(segment).add(r2));
        const streak = mix(
            smoothstep(0, 0.022, abs(f.sub(0.5))).oneMinus(),
            smoothstep(0, 0.08, f).mul(smoothstep(0.2, 0.5, f).oneMinus()),
            isRain,
        );
        const pattern = across.mul(streak).mul(r.mul(0.6).add(0.4));
        // Pixel footprint of a column (or a flake): finer than ~1 px → the pattern's average coverage.
        const footprint = max(
            fwidth(cu),
            fwidth(v0).mul(isRain.oneMinus().mul(20)),
        );
        const average = mix(0.03, 0.12, isRain);

        return mix(pattern, float(average), smoothstep(0.35, 1.2, footprint));
    };

    const density = layer(0.45, 5, 1).add(layer(0.8, 8, 2).mul(0.7));
    // Fade the open ends of the cylinder (it is 70 m high around the eye).
    const h = rel.y;
    const ends = smoothstep(-24, -12, h).mul(smoothstep(20, 46, h).oneMinus());
    const alpha = density
        .mul(ends)
        .mul(opacity)
        .mul(mix(0.45, 0.22, isRain));
    const viewDir = normalize(rel);

    // Close to the sky's own colour: sheets of rain grey out the dark land behind them but barely
    // show against the sky (snow is brighter than the sky).
    return {
        color: dropLight(s, viewDir, 0.45, 1, 0.25).mul(mix(1.8, 0.95, isRain)),
        opacity: alpha,
    };
}
