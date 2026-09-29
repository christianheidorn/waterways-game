import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
    abs,
    attribute,
    cameraPosition,
    cos,
    cross,
    length,
    max,
    mod,
    normalize,
    positionGeometry,
    sin,
    smoothstep,
    uniform,
    varying,
    vec2,
    vec3,
} from 'three/tsl';
import type { QualityLevel } from '../shared/types';

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

const RAIN_BOX = new THREE.Vector3(44, 28, 44);
const SNOW_BOX = new THREE.Vector3(38, 24, 38);

type LayerUniforms = ReturnType<typeof createLayerUniforms>;

type Layer = {
    mesh: THREE.Mesh<
        THREE.InstancedBufferGeometry,
        THREE.MeshBasicNodeMaterial
    >;
    uniforms: LayerUniforms;
    offset: THREE.Vector3;
    max: number;
};

/**
 * Rain streaks and snow flakes around the camera, fully animated on the GPU: every particle is an
 * instanced quad whose position is `seed * box + wind-driven offset`, wrapped into a box centred on
 * the camera. Particles stay fixed in the world while the camera moves, and the active instance
 * count follows the precipitation amount, so light rain costs little.
 */
export class Precipitation {
    readonly group = new THREE.Group();
    private rain: Layer;
    private snow: Layer;
    private quality: QualityLevel = 'medium';

    constructor(quality: QualityLevel = 'medium') {
        this.group.name = 'Precipitation';
        this.quality = quality;
        this.rain = this.createLayer(RAIN_COUNT[quality], RAIN_BOX, rainNodes);
        this.snow = this.createLayer(SNOW_COUNT[quality], SNOW_BOX, snowNodes);
    }

    setQuality(quality: QualityLevel): void {
        const q = RAIN_COUNT[quality] ? quality : 'medium';

        if (q === this.quality) {
            return;
        }

        this.quality = q;
        this.rebuild(this.rain, RAIN_COUNT[q]);
        this.rebuild(this.snow, SNOW_COUNT[q]);
    }

    /**
     * @param rain  0-1 rain intensity
     * @param snow  0-1 snowfall intensity
     * @param wind  horizontal wind (m/s-ish, x/z)
     * @param light colour of the ambient light hitting the particles
     */
    update(
        dt: number,
        camera: THREE.Camera,
        rain: number,
        snow: number,
        wind: THREE.Vector2,
        light: THREE.Color,
        hidden: boolean,
    ): void {
        this.updateLayer(
            this.rain,
            dt,
            camera,
            hidden ? 0 : rain,
            wind.x * 2.4,
            -9.5,
            wind.y * 2.4,
            light,
            0.45,
        );
        this.updateLayer(
            this.snow,
            dt,
            camera,
            hidden ? 0 : snow,
            wind.x * 1.6,
            -1.15,
            wind.y * 1.6,
            light,
            0.9,
        );
    }

    dispose(): void {
        for (const layer of [this.rain, this.snow]) {
            layer.mesh.geometry.dispose();
            layer.mesh.material.dispose();
        }
    }

    private updateLayer(
        layer: Layer,
        dt: number,
        camera: THREE.Camera,
        amount: number,
        vx: number,
        vy: number,
        vz: number,
        light: THREE.Color,
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
        u.camPos.value.setFromMatrixPosition(camera.matrixWorld);
        u.time.value += dt;
        u.color.value.copy(light);
        // Light rain is fainter as well as sparser.
        u.opacity.value = opacity * (0.55 + 0.45 * Math.min(1, amount * 1.5));
    }

    private createLayer(
        max: number,
        box: THREE.Vector3,
        nodes: (u: LayerUniforms) => ParticleNodes,
    ): Layer {
        const uniforms = createLayerUniforms(box);
        const shape = nodes(uniforms);
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
        material.alphaTest = 0.003;
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

function createLayerUniforms(box: THREE.Vector3) {
    return {
        camPos: uniform(new THREE.Vector3()),
        offset: uniform(new THREE.Vector3()),
        box: uniform(box.clone()),
        velocity: uniform(new THREE.Vector3(0, -9, 0)),
        time: uniform(0),
        color: uniform(new THREE.Color(1, 1, 1)),
        opacity: uniform(0.3),
    };
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
    u: LayerUniforms,
    extra: Node<'vec3'>,
): { centre: Node<'vec3'>; fade: Node<'float'> } {
    const p = seed.xyz.mul(u.box).add(u.offset).add(extra);
    const half = u.box.mul(0.5);
    const rel = mod(p.sub(u.camPos).add(half), u.box).sub(half);
    const edge = abs(rel).div(half);
    const fade = smoothstep(0.7, 1, max(edge.x, max(edge.y, edge.z)))
        .oneMinus()
        .mul(smoothstep(0.8, 3.5, length(rel)));

    return { centre: u.camPos.add(rel), fade };
}

/** Rain: streaks along the velocity, facing the camera. */
function rainNodes(u: LayerUniforms): ParticleNodes {
    const { centre, fade } = particleCentre(u, vec3(0));
    const dir = normalize(u.velocity);
    // Streak length = distance travelled during a ~1/40 s exposure, varied per drop.
    const len = length(u.velocity).mul(seed.w.mul(0.04).add(0.05));
    const toCam = normalize(cameraPosition.sub(centre));
    const side = normalize(cross(dir, toCam));
    // Keep distant drops at least ~1 px wide instead of letting them alias away.
    const dist = length(cameraPosition.sub(centre));
    const width = max(seed.w.mul(0.006).add(0.011), dist.mul(0.0014));
    const position = centre
        .add(side.mul(positionGeometry.x.mul(width)))
        .sub(dir.mul(len.mul(positionGeometry.y)));
    const vFade = varying(fade.mul(seed.w.mul(0.4).add(0.6)));

    const uv = vec2(positionGeometry.x.add(0.5), positionGeometry.y);
    const across = abs(uv.x.mul(2).sub(1)).oneMinus();
    const along = smoothstep(0, 0.25, uv.y).mul(
        smoothstep(0.6, 1, uv.y).oneMinus(),
    );

    return {
        position,
        color: u.color.mul(1.8).add(0.03),
        opacity: across.mul(along).mul(vFade).mul(u.opacity),
    };
}

/** Snow: round flakes that tumble on top of the wind drift. */
function snowNodes(u: LayerUniforms): ParticleNodes {
    const phase = seed.w.mul(6.2831);
    const sway = vec3(
        sin(u.time.mul(seed.w.add(0.7)).add(phase)),
        0,
        cos(u.time.mul(seed.x.add(0.6)).add(phase.mul(1.3))),
    ).mul(0.35);
    const { centre, fade } = particleCentre(u, sway);
    const toCam = normalize(cameraPosition.sub(centre));
    const right = normalize(cross(vec3(0, 1, 0), toCam));
    const up = cross(toCam, right);
    const dist = length(cameraPosition.sub(centre));
    const size = max(seed.w.mul(0.035).add(0.025), dist.mul(0.0014));
    const q = vec2(positionGeometry.x, positionGeometry.y.sub(0.5));
    const position = centre.add(right.mul(q.x).add(up.mul(q.y)).mul(size));
    const vFade = varying(fade);

    const d = length(q.mul(2));

    return {
        position,
        color: u.color.mul(2.6).add(0.08),
        opacity: smoothstep(0.35, 1, d).oneMinus().mul(vFade).mul(u.opacity),
    };
}
