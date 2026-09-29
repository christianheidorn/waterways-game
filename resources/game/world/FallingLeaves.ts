import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
    abs,
    attribute,
    cos,
    float,
    Fn,
    max,
    mix,
    mod,
    normalize,
    normalLocal,
    positionGeometry,
    positionPrevious,
    select,
    sin,
    smoothstep,
    uniform,
    uv,
    vec3,
} from 'three/tsl';
import type { QualityLevel } from '../shared/types';

/** Maximum leaves per effects quality (the active count follows the amount). */
const LEAF_COUNT: Record<QualityLevel, number> = {
    low: 200,
    medium: 400,
    high: 650,
    epic: 1000,
};

/** Volume around the camera the leaves wrap in (m). */
const BOX = new THREE.Vector3(22, 10, 22);
/** The box sits mostly above the eye: leaves under the ground are wasted. */
const LIFT = 2.5;
/** Mean sink rate of a fluttering leaf (m/s). */
const FALL = 0.85;

/** Autumn palette (linear-ish sRGB, converted once). */
const PALETTE = ['#c4661d', '#a8331c', '#d9a331', '#7c4f27'].map(
    (c) => new THREE.Color(c),
);

/**
 * Autumn leaves blowing through the air around the camera: a few hundred instanced, two-sided leaf
 * cards animated entirely on the GPU. Each leaf sinks slowly, drifts with the wind (faster in gusts),
 * sways from side to side and tumbles about its own random axis. Positions wrap in a box centred on
 * the camera (world-stable while it moves) and shrink away at the box edges, so leaves never pop.
 * Leaves are lit like foliage (sun, sky, shadows, fog) and have motion vectors for TAA.
 */
export class FallingLeaves {
    readonly mesh: THREE.Mesh<
        THREE.InstancedBufferGeometry,
        THREE.MeshStandardNodeMaterial
    >;
    private readonly u = {
        camPos: uniform(new THREE.Vector3()),
        time: uniform(0),
        prevTime: uniform(0),
        /** Accumulated drift (wind + fall), and last frame's for motion vectors. */
        offset: uniform(new THREE.Vector3()),
        prevOffset: uniform(new THREE.Vector3()),
        box: uniform(BOX.clone()),
        /** 0 calm … 1 gusty: faster tumbling and wider sway. */
        gust: uniform(0),
    };
    private quality: QualityLevel = 'medium';
    private readonly offset = new THREE.Vector3();

    constructor(quality: QualityLevel = 'medium') {
        this.quality = quality;
        const material = new THREE.MeshStandardNodeMaterial({
            name: 'FallingLeaves',
            side: THREE.DoubleSide,
            roughness: 0.75,
            alphaTest: 0.5,
        });
        this.mesh = new THREE.Mesh(
            createGeometry(LEAF_COUNT[quality]),
            material,
        );
        this.mesh.name = 'FallingLeaves';
        this.mesh.frustumCulled = false;
        this.mesh.receiveShadow = true;
        this.mesh.visible = false;
        this.buildMaterial(material);
    }

    setQuality(quality: QualityLevel): void {
        const q = LEAF_COUNT[quality] ? quality : 'medium';

        if (q === this.quality) {
            return;
        }

        this.quality = q;
        this.mesh.geometry.dispose();
        this.mesh.geometry = createGeometry(LEAF_COUNT[q]);
    }

    /**
     * @param amount 0-1 (the environment's falling_leaves, blended)
     * @param wind   horizontal wind (x / z, m/s-ish, gusts included)
     */
    update(
        dt: number,
        camera: THREE.Camera,
        amount: number,
        wind: THREE.Vector2,
        hidden: boolean,
    ): void {
        const count = hidden
            ? 0
            : Math.round(
                  LEAF_COUNT[this.quality] *
                      THREE.MathUtils.clamp(amount, 0, 1),
              );
        const geometry = this.mesh.geometry;
        geometry.instanceCount = Math.min(
            count,
            geometry.userData.max as number,
        );
        this.mesh.visible = geometry.instanceCount > 0;

        const u = this.u;
        u.prevTime.value = u.time.value;
        u.time.value += dt;
        u.prevOffset.value.copy(this.offset);
        // Leaves ride the wind a little slower than the air itself.
        this.offset.x += wind.x * 1.6 * dt;
        this.offset.y -= FALL * dt;
        this.offset.z += wind.y * 1.6 * dt;

        // Keep the offset small (the shader wraps it into the box anyway); shift both frames alike.
        for (const axis of ['x', 'y', 'z'] as const) {
            const size = BOX[axis] * 4;

            if (Math.abs(this.offset[axis]) > size) {
                const shift = Math.sign(this.offset[axis]) * size;
                this.offset[axis] -= shift;
                u.prevOffset.value[axis] -= shift;
            }
        }

        u.offset.value.copy(this.offset);
        u.gust.value = THREE.MathUtils.clamp(wind.length() / 2.5, 0, 1);
        camera.getWorldPosition(u.camPos.value);
    }

    dispose(): void {
        this.mesh.geometry.dispose();
        this.mesh.material.dispose();
    }

    private buildMaterial(material: THREE.MeshStandardNodeMaterial): void {
        const u = this.u;
        const seed = attribute<'vec4'>('aSeed', 'vec4');
        const half = u.box.mul(0.5);

        /** World position of this vertex at a given time and drift (the mesh sits at the origin). */
        const place = (time: Node<'float'>, offset: Node<'vec3'>) => {
            const phase = seed.w.mul(6.283);
            const rate = seed.x.mul(0.8).add(0.7);
            // Side-to-side sway (falling-leaf "pendulum") and a little bobbing.
            const sway = vec3(
                sin(time.mul(rate).add(phase)),
                sin(time.mul(rate.mul(2)).add(phase)).mul(0.35),
                cos(time.mul(rate.mul(0.8)).add(phase.mul(1.7))),
            ).mul(u.gust.mul(0.6).add(0.4));
            const p = seed.xyz.mul(u.box).add(offset).add(sway);
            const centre = u.camPos.add(vec3(0, LIFT, 0));
            const rel = mod(p.sub(centre).add(half), u.box).sub(half);
            const edge = abs(rel).div(half);
            // Shrink away at the box edges (alpha-tested leaves can't fade) and right at the eye.
            const fade = smoothstep(0.82, 1, max(edge.x, max(edge.y, edge.z)))
                .oneMinus()
                .mul(smoothstep(0.3, 1.2, rel.length()));

            // Tumbling about a random axis.
            const axis = normalize(seed.wzy.mul(2).sub(1).add(vec3(1e-3)));
            const angle = time
                .mul(seed.y.mul(2.5).add(1.2).mul(u.gust.mul(0.8).add(0.6)))
                .add(phase);
            // 11-19 cm: a bit larger than most real leaves so they still read at a few metres.
            const size = seed.z.mul(0.08).add(0.11).mul(fade);
            const local = positionGeometry.mul(size);
            const rotated = rotate(local, axis, angle);

            return {
                position: centre.add(rel).add(rotated),
                normal: rotate(vec3(0, 0, 1), axis, angle),
            };
        };

        material.positionNode = Fn(() => {
            const now = place(u.time, u.offset);
            normalLocal.assign(now.normal);
            // Motion vectors: the same leaf last frame (TAA, motion blur).
            positionPrevious.assign(place(u.prevTime, u.prevOffset).position);

            return now.position;
        })();

        // Leaf outline on the card: pointed ellipse, with a darker midrib.
        const x = uv().x.mul(2).sub(1);
        const y = uv().y.mul(2).sub(1);
        const width = float(1).sub(y.mul(y)).mul(0.6);
        const inside = abs(x).lessThan(width).and(abs(y).lessThan(0.98));
        material.opacityNode = select(inside, float(1), float(0));

        const c = seed.x;
        const base = mix(
            mix(color(PALETTE[0]), color(PALETTE[1]), smoothstep(0.2, 0.45, c)),
            mix(color(PALETTE[2]), color(PALETTE[3]), smoothstep(0.55, 0.8, c)),
            smoothstep(0.35, 0.65, seed.y),
        );
        const rib = smoothstep(0.08, 0.02, abs(x)).mul(0.25);
        material.colorNode = base.mul(float(1).sub(rib));
    }
}

function color(c: THREE.Color): Node<'vec3'> {
    return vec3(c.r, c.g, c.b);
}

/** Rodrigues rotation of `v` about the unit `axis` by `angle`. */
function rotate(
    v: Node<'vec3'>,
    axis: Node<'vec3'>,
    angle: Node<'float'>,
): Node<'vec3'> {
    const c = cos(angle);
    const s = sin(angle);

    return v
        .mul(c)
        .add(axis.cross(v).mul(s))
        .add(axis.mul(axis.dot(v).mul(c.oneMinus())));
}

function createGeometry(count: number): THREE.InstancedBufferGeometry {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute(
        'position',
        new THREE.BufferAttribute(
            new Float32Array([
                -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
            ]),
            3,
        ),
    );
    geometry.setAttribute(
        'uv',
        new THREE.BufferAttribute(
            new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
            2,
        ),
    );
    geometry.setAttribute(
        'normal',
        new THREE.BufferAttribute(
            new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
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
    geometry.userData.max = count;

    return geometry;
}
