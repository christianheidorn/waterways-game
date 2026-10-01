import * as THREE from 'three/webgpu';
import {
    attribute,
    cameraPosition,
    clamp,
    cross,
    float,
    length,
    max,
    mix,
    normalize,
    positionGeometry,
    select,
    smoothstep,
    uniform,
    varying,
    vec2,
    vec3,
} from 'three/tsl';

/** Particle kinds: droplets fly on ballistic arcs and stretch with speed, spray puffs billow and fade. */
const DROP = 0;
const SPRAY = 1;
/** Pool size. */
const MAX_PARTICLES = 700;
const GRAVITY = 9.81;

type Particle = {
    x: number;
    y: number;
    z: number;
    vx: number;
    vy: number;
    vz: number;
    age: number;
    life: number;
    size: number;
    kind: number;
};

/**
 * Water splashes (docs/ROADMAP.md phase 12): CPU particles (a pool of a few hundred) drawn as one
 * instanced mesh of camera-facing quads. Droplets fly on ballistic arcs, stretched along their velocity,
 * and end where they fall back into the water (`onDropLanded`: tiny ripples); spray puffs billow out and
 * fade. The foam ring and the waves of an impact come from the ripple field (Ripples), not from here.
 */
export class Splashes {
    readonly mesh: THREE.Mesh<
        THREE.InstancedBufferGeometry,
        THREE.MeshBasicNodeMaterial
    >;
    /** Light on the particles (sky + sun), set every frame by the game. */
    readonly light = uniform(new THREE.Color(1, 1, 1));
    enabled = true;
    /** A droplet fell back into the water at (x, z). */
    onDropLanded: ((x: number, z: number, size: number) => void) | null = null;
    private readonly particles: Particle[] = [];
    private readonly posData = new Float32Array(MAX_PARTICLES * 4);
    private readonly velData = new Float32Array(MAX_PARTICLES * 4);

    constructor(
        /** Water surface height at a position (null where dry: drops land on the ground instead). */
        private readonly surfaceAt: (x: number, z: number) => number | null,
        private readonly groundAt: (x: number, z: number) => number,
    ) {
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
        geometry.setIndex([0, 1, 2, 0, 2, 3]);

        for (const [name, data] of [
            ['aSplashPos', this.posData],
            ['aSplashVel', this.velData],
        ] as const) {
            const attr = new THREE.InstancedBufferAttribute(data, 4);
            attr.setUsage(THREE.DynamicDrawUsage);
            geometry.setAttribute(name, attr);
        }

        geometry.instanceCount = 0;
        this.mesh = new THREE.Mesh(geometry, this.createMaterial());
        this.mesh.name = 'WaterSplashes';
        this.mesh.frustumCulled = false;
        this.mesh.renderOrder = 9;
        this.mesh.visible = false;
    }

    get count(): number {
        return this.particles.length;
    }

    /**
     * An impact on the water at (x, y, z): `strength` 0-2 (splashStrength), `size` the footprint (m).
     * Droplets are thrown up and out in a crown, spray puffs billow; `vx` / `vz` carry the object's motion.
     */
    splash(
        x: number,
        y: number,
        z: number,
        strength: number,
        size = 0.5,
        vx = 0,
        vz = 0,
    ): void {
        if (!this.enabled || strength <= 0.01) {
            return;
        }

        const s = Math.min(2, strength);
        const drops = Math.round(10 + 60 * s);
        const r = Math.max(0.1, size * 0.5);

        for (let i = 0; i < drops; i++) {
            const a = Math.random() * Math.PI * 2;
            const out = (0.6 + Math.random() * 1.6) * (0.6 + s);
            const up = (1.8 + Math.random() * 3.2) * (0.5 + s * 0.8);
            this.emit(
                x + Math.cos(a) * r * Math.random(),
                y + 0.02,
                z + Math.sin(a) * r * Math.random(),
                Math.cos(a) * out + vx * 0.3,
                up,
                Math.sin(a) * out + vz * 0.3,
                0.025 + Math.random() * 0.03 * (1 + s),
                3,
                DROP,
            );
        }

        const puffs = Math.round(2 + 6 * s);

        for (let i = 0; i < puffs; i++) {
            const a = Math.random() * Math.PI * 2;
            const out = 0.4 + Math.random() * 0.8;
            this.emit(
                x + Math.cos(a) * r * 0.5,
                y + 0.1,
                z + Math.sin(a) * r * 0.5,
                Math.cos(a) * out + vx * 0.2,
                (1 + Math.random() * 2) * (0.5 + s),
                Math.sin(a) * out + vz * 0.2,
                (0.25 + Math.random() * 0.25) * (0.6 + s * 0.6),
                0.5 + Math.random() * 0.4,
                SPRAY,
            );
        }
    }

    /** Spray kicked up at the shins while wading (`speed` m/s, heading vx, vz normalised). */
    kick(
        x: number,
        y: number,
        z: number,
        speed: number,
        dirX: number,
        dirZ: number,
        count: number,
    ): void {
        if (!this.enabled) {
            return;
        }

        for (let i = 0; i < count; i++) {
            const a = (Math.random() - 0.5) * 2.2;
            const c = Math.cos(a);
            const s = Math.sin(a);
            const fx = dirX * c - dirZ * s;
            const fz = dirX * s + dirZ * c;
            const out = speed * (0.3 + Math.random() * 0.5);
            this.emit(
                x + fx * 0.15,
                y + 0.03,
                z + fz * 0.15,
                fx * out,
                0.8 + Math.random() * 1.6 * Math.min(1.5, speed / 2),
                fz * out,
                0.018 + Math.random() * 0.02,
                2,
                DROP,
            );
        }
    }

    /** One drop falling from a wet character. */
    drip(x: number, y: number, z: number): void {
        if (!this.enabled) {
            return;
        }

        this.emit(
            x,
            y,
            z,
            (Math.random() - 0.5) * 0.1,
            -0.2,
            (Math.random() - 0.5) * 0.1,
            0.012 + Math.random() * 0.008,
            2,
            DROP,
        );
    }

    update(dt: number): void {
        const list = this.particles;
        let w = 0;

        for (let i = 0; i < list.length; i++) {
            const p = list[i];
            p.age += dt;

            if (p.kind === DROP) {
                p.vy -= GRAVITY * dt;
                p.x += p.vx * dt;
                p.y += p.vy * dt;
                p.z += p.vz * dt;

                if (p.vy < 0) {
                    const water = this.surfaceAt(p.x, p.z);
                    const floor = water ?? this.groundAt(p.x, p.z);

                    if (p.y <= floor) {
                        if (water !== null) {
                            this.onDropLanded?.(p.x, p.z, p.size);
                        }

                        continue;
                    }
                }
            } else {
                // Spray slows in the air and rises a little.
                const drag = Math.exp(-dt * 3);
                p.vx *= drag;
                p.vz *= drag;
                p.vy = p.vy * drag - GRAVITY * 0.15 * dt;
                p.x += p.vx * dt;
                p.y += p.vy * dt;
                p.z += p.vz * dt;
                p.size *= 1 + dt * 1.2;
            }

            if (p.age < p.life) {
                list[w++] = p;
            }
        }

        list.length = w;
        const geometry = this.mesh.geometry;
        this.mesh.visible = w > 0;
        geometry.instanceCount = w;

        if (!w) {
            return;
        }

        const pos = this.posData;
        const vel = this.velData;

        for (let i = 0; i < w; i++) {
            const p = list[i];
            const o = i * 4;
            pos[o] = p.x;
            pos[o + 1] = p.y;
            pos[o + 2] = p.z;
            pos[o + 3] = p.size;
            vel[o] = p.vx;
            vel[o + 1] = p.vy;
            vel[o + 2] = p.vz;
            // Fade (0-1 of life) and kind packed: kind + age / life (≤ 0.999).
            vel[o + 3] = p.kind + Math.min(0.999, p.age / p.life);
        }

        for (const name of ['aSplashPos', 'aSplashVel']) {
            const attr = geometry.getAttribute(
                name,
            ) as THREE.InstancedBufferAttribute;
            attr.clearUpdateRanges();
            attr.addUpdateRange(0, w * 4);
            attr.needsUpdate = true;
        }
    }

    clear(): void {
        this.particles.length = 0;
        this.mesh.geometry.instanceCount = 0;
        this.mesh.visible = false;
    }

    dispose(): void {
        this.mesh.geometry.dispose();
        this.mesh.material.dispose();
    }

    private emit(
        x: number,
        y: number,
        z: number,
        vx: number,
        vy: number,
        vz: number,
        size: number,
        life: number,
        kind: number,
    ): void {
        const p: Particle = {
            x,
            y,
            z,
            vx,
            vy,
            vz,
            age: 0,
            life,
            size,
            kind,
        };

        if (this.particles.length < MAX_PARTICLES) {
            this.particles.push(p);
        } else {
            // Recycle the oldest-looking slot.
            this.particles[Math.floor(Math.random() * MAX_PARTICLES)] = p;
        }
    }

    private createMaterial(): THREE.MeshBasicNodeMaterial {
        const pos = attribute<'vec4'>('aSplashPos', 'vec4');
        const vel = attribute<'vec4'>('aSplashVel', 'vec4');
        const centre = pos.xyz;
        const size = pos.w;
        const kind = vel.w.floor();
        const age = vel.w.fract();
        const isDrop = select(kind.lessThan(0.5), float(1), float(0));
        const toCam = normalize(cameraPosition.sub(centre));
        const speed = length(vel.xyz);
        // Droplets stretch along their motion (motion blur), puffs face the camera.
        const moving = isDrop.mul(smoothstep(0.5, 1.5, speed));
        const axis = normalize(
            mix(
                normalize(cross(toCam, normalize(cross(vec3(0, 1, 0), toCam)))),
                vel.xyz.div(max(speed, 1e-3)),
                moving,
            ),
        );
        const side = normalize(cross(axis, toCam));
        const stretch = float(1).add(
            moving.mul(clamp(speed.mul(0.016).div(size), 0, 5)),
        );
        const position = centre
            .add(side.mul(positionGeometry.x.mul(size)))
            .add(axis.mul(positionGeometry.y.mul(size.mul(stretch))));
        const vAge = varying(age);
        const vDrop = varying(isDrop);
        const p = vec2(positionGeometry.x, positionGeometry.y).mul(2);
        const r = length(p);
        const dropShape = smoothstep(1, 0.35, r);
        const puffShape = smoothstep(1, 0, r).mul(smoothstep(1, 0, r));
        const shape = mix(puffShape.mul(0.35), dropShape.mul(0.85), vDrop);
        const life = mix(
            vAge.oneMinus().mul(vAge.oneMinus()),
            smoothstep(1, 0.7, vAge),
            vDrop,
        );
        const material = new THREE.MeshBasicNodeMaterial({
            transparent: true,
            depthWrite: false,
        });
        material.positionNode = position;
        // Water lit by sky and sun, a little brighter in the droplets' cores (glints).
        material.colorNode = this.light.mul(
            mix(float(0.9), float(1.25), vDrop.mul(smoothstep(0.6, 0, r))),
        );
        material.opacityNode = shape.mul(life);
        material.alphaTest = 0.004;

        return material;
    }
}
