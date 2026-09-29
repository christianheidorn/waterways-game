import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
    attribute,
    cameraPosition,
    clamp,
    cross,
    exp,
    float,
    length,
    normalize,
    positionGeometry,
    smoothstep,
    uniform,
    varying,
    vec2,
    vec3,
} from 'three/tsl';
import type { QualityLevel } from '../shared/types';
import type { PrecipitationWorld, SharedUniforms } from './PrecipitationCommon';
import { dropLight } from './PrecipitationCommon';

/** Splash slots per effects quality (the active count follows the rain intensity). */
const SPLASH_COUNT: Record<QualityLevel, number> = {
    low: 0,
    medium: 350,
    high: 800,
    epic: 1500,
};
/** Ground mist patches in heavy rain. */
const MIST_COUNT: Record<QualityLevel, number> = {
    low: 0,
    medium: 14,
    high: 26,
    epic: 40,
};
const SPLASH_RADIUS = 16;
const SPLASH_LIFE = 0.3;
const MIST_INNER = 5;
const MIST_OUTER = 42;

/**
 * Where the rain lands: short-lived splash crowns on the ground and on water around the camera, and a
 * low, drifting mist of spray in heavy rain. Splashes are respawned on the CPU (a height sample each;
 * a few thousand per second at most) and animated in the shader from their start time.
 */
export class RainSplashes {
    readonly group = new THREE.Group();
    private splash: THREE.Mesh<
        THREE.InstancedBufferGeometry,
        THREE.MeshBasicNodeMaterial
    >;
    private mist: THREE.Mesh<
        THREE.InstancedBufferGeometry,
        THREE.MeshBasicNodeMaterial
    >;
    private readonly splashOpacity = uniform(0);
    private readonly mistOpacity = uniform(0);
    private splashMax = 0;
    private mistMax = 0;
    private splashData = new Float32Array(0);
    private mistPlaced = false;
    private mistData = new Float32Array(0);
    private mistNormals = new Float32Array(0);
    private readonly wind = new THREE.Vector2();
    private readonly normal = new THREE.Vector3();

    constructor(
        private readonly world: PrecipitationWorld,
        private readonly shared: SharedUniforms,
        quality: QualityLevel,
    ) {
        this.group.name = 'RainSplashes';
        this.splash = new THREE.Mesh(
            new THREE.InstancedBufferGeometry(),
            this.createSplashMaterial(),
        );
        this.mist = new THREE.Mesh(
            new THREE.InstancedBufferGeometry(),
            this.createMistMaterial(),
        );

        for (const mesh of [this.splash, this.mist]) {
            mesh.frustumCulled = false;
            mesh.visible = false;
            this.group.add(mesh);
        }

        this.splash.renderOrder = 9;
        this.mist.renderOrder = 7;
        this.setQuality(quality);
    }

    setQuality(quality: QualityLevel): void {
        this.splashMax = SPLASH_COUNT[quality] ?? 0;
        this.mistMax = MIST_COUNT[quality] ?? 0;
        // x, y, z, start time (splashes) / x, y, z, size (mist); start = -1e9 → respawn at once.
        this.splashData = new Float32Array(this.splashMax * 4).fill(-1e9);
        this.mistData = new Float32Array(this.mistMax * 4);
        this.mistNormals = new Float32Array(this.mistMax * 3);
        this.mistPlaced = false;
        this.rebuild(this.splash, this.splashData, 'aSplash');
        this.rebuild(this.mist, this.mistData, 'aMist');
        this.mist.geometry.setAttribute(
            'aMistNormal',
            new THREE.InstancedBufferAttribute(this.mistNormals, 3).setUsage(
                THREE.DynamicDrawUsage,
            ),
        );
    }

    update(dt: number, camera: THREE.Vector3, rain: number): void {
        const time = this.shared.time.value;
        this.updateSplashes(time, camera, rain);
        this.updateMist(dt, camera, rain);
    }

    /** Horizontal wind (m/s) the mist drifts with. */
    setWind(wind: THREE.Vector2): void {
        this.wind.copy(wind);
    }

    dispose(): void {
        for (const mesh of [this.splash, this.mist]) {
            mesh.geometry.dispose();
            mesh.material.dispose();
        }
    }

    private updateSplashes(
        time: number,
        camera: THREE.Vector3,
        rain: number,
    ): void {
        const count = Math.floor(
            this.splashMax * THREE.MathUtils.clamp(rain * 1.3, 0, 1),
        );
        this.splash.visible = count > 8 && rain > 0.05;
        this.splashOpacity.value = Math.min(1, rain * 1.5);

        if (!this.splash.visible) {
            return;
        }

        const data = this.splashData;
        const heights = this.world.heights;

        for (let i = 0; i < count; i++) {
            const o = i * 4;
            const age = time - data[o + 3];

            if (age < SPLASH_LIFE) {
                continue;
            }

            // Uniform over the disc around the camera; a fresh slot starts at a random phase.
            const a = Math.random() * Math.PI * 2;
            const r = SPLASH_RADIUS * Math.sqrt(0.02 + Math.random() * 0.98);
            const x = camera.x + Math.cos(a) * r;
            const z = camera.z + Math.sin(a) * r;
            const ground = heights.sample(x, z);
            const water = this.world.waterLevelAt(x, z);
            data[o] = x;
            data[o + 1] = water !== null && water > ground ? water : ground;
            data[o + 2] = z;
            data[o + 3] =
                age > SPLASH_LIFE * 4
                    ? time - Math.random() * SPLASH_LIFE
                    : time + Math.random() * 0.05;
        }

        const geometry = this.splash.geometry;
        geometry.instanceCount = count;
        const attr = geometry.getAttribute(
            'aSplash',
        ) as THREE.InstancedBufferAttribute;
        attr.clearUpdateRanges();
        attr.addUpdateRange(0, count * 4);
        attr.needsUpdate = true;
    }

    private updateMist(dt: number, camera: THREE.Vector3, rain: number): void {
        const k = THREE.MathUtils.smoothstep(rain, 0.45, 0.95);
        this.mist.visible = this.mistMax > 0 && k > 0.01;
        this.mistOpacity.value = k;

        if (!this.mist.visible) {
            return;
        }

        const data = this.mistData;
        const heights = this.world.heights;

        for (let i = 0; i < this.mistMax; i++) {
            const o = i * 4;
            data[o] += this.wind.x * 0.6 * dt;
            data[o + 2] += this.wind.y * 0.6 * dt;
            const d = Math.hypot(data[o] - camera.x, data[o + 2] - camera.z);

            if (this.mistPlaced && d > MIST_INNER * 0.5 && d < MIST_OUTER) {
                continue;
            }

            const a = Math.random() * Math.PI * 2;
            const r = THREE.MathUtils.lerp(
                MIST_INNER,
                MIST_OUTER,
                Math.sqrt(Math.random()),
            );
            const x = camera.x + Math.cos(a) * r;
            const z = camera.z + Math.sin(a) * r;
            data[o] = x;
            data[o + 2] = z;
            data[o + 3] = 5 + Math.random() * 6;
        }

        this.mistPlaced = true;
        // Follow the ground under drifting patches, lying parallel to it (cheap: three samples each).
        const normals = this.mistNormals;

        for (let i = 0; i < this.mistMax; i++) {
            const o = i * 4;
            const x = data[o];
            const z = data[o + 2];
            const h = heights.sample(x, z);
            const water = this.world.waterLevelAt(x, z);

            const onWater = water !== null && water >= h;
            data[o + 1] = onWater ? water : h;
            const n = onWater
                ? this.normal.set(0, 1, 0)
                : this.normal
                      .set(
                          h - heights.sample(x + 2, z),
                          2,
                          h - heights.sample(x, z + 2),
                      )
                      .normalize();
            n.toArray(normals, i * 3);
        }

        const geometry = this.mist.geometry;
        geometry.instanceCount = this.mistMax;
        geometry.getAttribute('aMist').needsUpdate = true;
        geometry.getAttribute('aMistNormal').needsUpdate = true;
    }

    private rebuild(
        mesh: THREE.Mesh<THREE.InstancedBufferGeometry>,
        data: Float32Array,
        name: string,
    ): void {
        mesh.geometry.dispose();
        const geometry = new THREE.InstancedBufferGeometry();
        // Unit quad: x across (-0.5..0.5), y up / along (0..1).
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
        const attr = new THREE.InstancedBufferAttribute(data, 4);
        attr.setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute(name, attr);
        geometry.instanceCount = 0;
        mesh.geometry = geometry;
    }

    /**
     * A splash crown facing the camera (upright): a rim that widens and a few droplets thrown up on
     * ballistic arcs, fading over the splash's life.
     */
    private createSplashMaterial(): THREE.MeshBasicNodeMaterial {
        const s = this.shared;
        const data = attribute<'vec4'>('aSplash', 'vec4');
        const centre = data.xyz;
        const age = clamp(s.time.sub(data.w).div(SPLASH_LIFE), 0, 1);
        const toCam = cameraPosition.sub(centre);
        const dist = length(toCam);
        const right = normalize(cross(vec3(0, 1, 0), toCam));
        // Seeded by position: size and droplet spread vary per splash.
        const rnd = centre.x
            .mul(12.9898)
            .add(centre.z.mul(78.233))
            .sin()
            .mul(43758.5453);
        const variation = rnd.fract();
        const size = variation.mul(0.1).add(0.12).mul(age.mul(0.6).add(0.5));
        const position = centre
            .add(right.mul(positionGeometry.x.mul(size)))
            .add(vec3(0, positionGeometry.y.mul(size.mul(0.8)), 0));
        const vAge = varying(age);
        const vFade = varying(
            smoothstep(0.6, 1.5, dist).mul(
                smoothstep(SPLASH_RADIUS * 0.6, SPLASH_RADIUS, dist).oneMinus(),
            ),
        );
        const vSpread = varying(variation);
        const vColor = varying(
            dropLight(s, toCam.div(dist).negate(), 0.6, 0.8, 0.4),
        );

        // Fragment: quad coordinates, x -1..1, y 0..1 (up).
        const p = vec2(positionGeometry.x.mul(2), positionGeometry.y);
        const t = vAge;
        // Crown: the upper half of a widening, thinning ring around a point just below the ground.
        const ringR = t.mul(0.5).add(0.25);
        const thickness = t.oneMinus().mul(0.1).add(0.05);
        const ring = smoothstep(
            0,
            thickness,
            length(p.mul(vec2(1, 1.4)).sub(vec2(0, -0.1)))
                .sub(ringR)
                .abs(),
        )
            .oneMinus()
            .mul(smoothstep(0, 0.2, p.y));
        let drops: Node<'float'> = float(0);

        for (let k = 0; k < 5; k++) {
            const dirX = (k - 2) / 2;
            const up = 1.1 + ((k * 7) % 5) * 0.12;
            const c = vec2(
                t.mul(dirX * 0.75).mul(vSpread.mul(0.5).add(0.75)),
                t
                    .mul(up)
                    .sub(t.mul(t).mul(up * 0.95))
                    .add(0.05),
            );
            drops = drops.add(
                smoothstep(0.02, 0.06, length(p.sub(c))).oneMinus(),
            ) as Node<'float'>;
        }

        const shape = ring.mul(0.5).add(drops.mul(0.8));
        const life = t.oneMinus().mul(t.oneMinus());
        const material = new THREE.MeshBasicNodeMaterial({
            transparent: true,
            depthWrite: false,
        });
        material.positionNode = position;
        material.colorNode = vColor.mul(1.4);
        material.opacityNode = shape
            .mul(life)
            .mul(vFade)
            .mul(this.splashOpacity)
            .mul(0.55);
        material.alphaTest = 0.004;

        return material;
    }

    /** Low spray mist: large, soft patches lying just above the ground, lit like the drops. */
    private createMistMaterial(): THREE.MeshBasicNodeMaterial {
        const s = this.shared;
        const data = attribute<'vec4'>('aMist', 'vec4');
        const n = attribute<'vec3'>('aMistNormal', 'vec3');
        const tangent = normalize(cross(n, vec3(0, 0, 1)));
        const bitangent = cross(tangent, n);
        const q = vec2(positionGeometry.x, positionGeometry.y.sub(0.5));
        const position = data.xyz
            .add(tangent.mul(q.x.mul(data.w)))
            .add(bitangent.mul(q.y.mul(data.w)))
            .add(n.mul(0.35));
        const centre = data.xyz;
        const toCam = cameraPosition.sub(centre);
        const dist = length(toCam.xz);
        const vFade = varying(
            smoothstep(MIST_INNER * 0.6, MIST_INNER * 1.6, dist).mul(
                smoothstep(MIST_OUTER * 0.7, MIST_OUTER, dist).oneMinus(),
            ),
        );
        const vColor = varying(
            dropLight(s, normalize(toCam).negate(), 0.3, 1, 0.15),
        );
        const r2 = q.dot(q).mul(4);
        const material = new THREE.MeshBasicNodeMaterial({
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
        });
        material.positionNode = position;
        material.colorNode = vColor.mul(1.1);
        material.opacityNode = exp(r2.mul(-3))
            .sub(exp(float(-3)))
            .max(0)
            .mul(vFade)
            .mul(this.mistOpacity)
            .mul(0.07);
        material.alphaTest = 0.002;

        return material;
    }
}
