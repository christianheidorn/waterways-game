import * as THREE from 'three';
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

type Layer = {
    mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
    uniforms: {
        uCamPos: THREE.IUniform<THREE.Vector3>;
        uOffset: THREE.IUniform<THREE.Vector3>;
        uBox: THREE.IUniform<THREE.Vector3>;
        uVelocity: THREE.IUniform<THREE.Vector3>;
        uTime: THREE.IUniform<number>;
        uColor: THREE.IUniform<THREE.Color>;
        uOpacity: THREE.IUniform<number>;
    };
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
        this.rain = this.createLayer(
            RAIN_COUNT[quality],
            RAIN_BOX,
            RAIN_VERTEX,
            RAIN_FRAGMENT,
        );
        this.snow = this.createLayer(
            SNOW_COUNT[quality],
            SNOW_BOX,
            SNOW_VERTEX,
            SNOW_FRAGMENT,
        );
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
            0.55,
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
        const box = u.uBox.value;
        layer.mesh.geometry.instanceCount = count;
        u.uVelocity.value.set(vx, vy, vz);
        // Offset accumulated on the CPU and kept inside the box so float precision never degrades.
        const o = layer.offset;
        o.x = (o.x + vx * dt) % box.x;
        o.y = (o.y + vy * dt) % box.y;
        o.z = (o.z + vz * dt) % box.z;
        u.uOffset.value.copy(o);
        u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
        u.uTime.value += dt;
        u.uColor.value.copy(light);
        // Light rain is fainter as well as sparser.
        u.uOpacity.value = opacity * (0.55 + 0.45 * Math.min(1, amount * 1.5));
    }

    private createLayer(
        max: number,
        box: THREE.Vector3,
        vertexShader: string,
        fragmentShader: string,
    ): Layer {
        const uniforms = {
            uCamPos: { value: new THREE.Vector3() },
            uOffset: { value: new THREE.Vector3() },
            uBox: { value: box.clone() },
            uVelocity: { value: new THREE.Vector3(0, -9, 0) },
            uTime: { value: 0 },
            uColor: { value: new THREE.Color(1, 1, 1) },
            uOpacity: { value: 0.3 },
        };
        const material = new THREE.ShaderMaterial({
            uniforms,
            vertexShader,
            fragmentShader,
            transparent: true,
            depthWrite: false,
            blending: THREE.NormalBlending,
            side: THREE.DoubleSide,
        });
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

const COMMON_VERTEX = /* glsl */ `
uniform vec3 uCamPos;
uniform vec3 uOffset;
uniform vec3 uBox;
uniform vec3 uVelocity;
uniform float uTime;
attribute vec4 aSeed;
varying vec2 vUv;
varying float vFade;

// Particle centre wrapped into a box around the camera (world-stable while the camera moves).
vec3 particleCentre(vec3 extra) {
    vec3 p = aSeed.xyz * uBox + uOffset + extra;
    vec3 rel = mod(p - uCamPos + uBox * 0.5, uBox) - uBox * 0.5;
    // Fade at the box edges and very close to the eye.
    vec3 edge = abs(rel) / (uBox * 0.5);
    vFade = (1.0 - smoothstep(0.7, 1.0, max(edge.x, max(edge.y, edge.z)))) * smoothstep(0.8, 3.5, length(rel));
    return uCamPos + rel;
}
`;

const RAIN_VERTEX = /* glsl */ `
${COMMON_VERTEX}
void main() {
    vec3 centre = particleCentre(vec3(0.0));
    vec3 vel = uVelocity;
    vec3 dir = normalize(vel);
    // Streak length = distance travelled during a ~1/40 s exposure, varied per drop.
    float len = length(vel) * (0.05 + aSeed.w * 0.04);
    vec3 toCam = normalize(cameraPosition - centre);
    vec3 side = normalize(cross(dir, toCam));
    float width = 0.011 + aSeed.w * 0.006;
    // Keep distant drops at least ~1 px wide instead of letting them alias away.
    float dist = length(cameraPosition - centre);
    width = max(width, dist * 0.0014);
    vec3 world = centre + side * position.x * width - dir * len * position.y;
    vUv = vec2(position.x + 0.5, position.y);
    vFade *= 0.6 + aSeed.w * 0.4;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const RAIN_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vUv;
varying float vFade;
void main() {
    float across = 1.0 - abs(vUv.x * 2.0 - 1.0);
    float along = smoothstep(0.0, 0.25, vUv.y) * (1.0 - smoothstep(0.6, 1.0, vUv.y));
    float a = across * along * vFade * uOpacity;
    if (a < 0.003) discard;
    gl_FragColor = vec4(uColor * 1.8 + 0.03, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

const SNOW_VERTEX = /* glsl */ `
${COMMON_VERTEX}
void main() {
    // Flakes tumble: a small per-flake swirl on top of the wind drift.
    float ph = aSeed.w * 6.2831;
    vec3 sway = vec3(sin(uTime * (0.7 + aSeed.w) + ph), 0.0, cos(uTime * (0.6 + aSeed.x) + ph * 1.3)) * 0.35;
    vec3 centre = particleCentre(sway);
    vec3 toCam = normalize(cameraPosition - centre);
    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
    vec3 up = cross(toCam, right);
    float size = 0.025 + aSeed.w * 0.035;
    float dist = length(cameraPosition - centre);
    size = max(size, dist * 0.0014);
    vec2 q = vec2(position.x, position.y - 0.5);
    vec3 world = centre + (right * q.x + up * q.y) * size;
    vUv = q * 2.0;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const SNOW_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vUv;
varying float vFade;
void main() {
    float d = length(vUv);
    float a = (1.0 - smoothstep(0.35, 1.0, d)) * vFade * uOpacity;
    if (a < 0.003) discard;
    gl_FragColor = vec4(uColor * 2.6 + 0.08, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;
