import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { dot, float, pow, uniform, vec3 } from 'three/tsl';
import type { Heightfield } from './Heightfield';

/** Light reaching the particles, from the Atmosphere (all linear HDR). */
export type PrecipitationLight = {
    /** Sky + sun irradiance on a drop (diffuse-ish lighting). */
    ambient: THREE.Color;
    /** Horizon / fog radiance: what a drop refracts from behind it. */
    sky: THREE.Color;
    /** Direct sun (or moon) colour × intensity and the direction towards it. */
    sun: THREE.Color;
    sunDirection: THREE.Vector3;
    /** Lightning flash level and the direction towards it. */
    flash: number;
    flashDirection: THREE.Vector3;
};

export type PrecipitationWorld = {
    heights: Heightfield;
    waterLevelAt: (x: number, z: number) => number | null;
};

/** Uniforms shared by every precipitation material (updated once per frame). */
export function createSharedUniforms() {
    return {
        camPos: uniform(new THREE.Vector3()),
        /** Smoothed camera velocity (m/s): streaks follow the motion relative to the eye. */
        camVelocity: uniform(new THREE.Vector3()),
        /** Angular size of a pixel (radians): thin particles stay ≥ ~1.5 px wide, fading instead. */
        pixelAngle: uniform(0.002),
        time: uniform(0),
        // Linear RGB colours (as vectors: they are summed with other vec3 nodes).
        ambient: uniform(new THREE.Vector3()),
        sky: uniform(new THREE.Vector3()),
        sun: uniform(new THREE.Vector3()),
        sunDirection: uniform(new THREE.Vector3(0, 1, 0)),
        flash: uniform(0),
        flashDirection: uniform(new THREE.Vector3(0, 1, 0)),
    };
}

export type SharedUniforms = ReturnType<typeof createSharedUniforms>;

/**
 * Light on a water drop / flake seen from `viewDir` (eye → particle): sky light (weighted by
 * `diffuse`), the horizon it refracts, a forward-scattering glint when looking towards the sun (backlit rain glows), and the
 * lightning flash, strongest towards the strike.
 */
export function dropLight(
    s: SharedUniforms,
    viewDir: Node<'vec3'>,
    diffuse: number,
    refracted: number,
    glint: number,
): Node<'vec3'> {
    const cosSun = dot(viewDir, s.sunDirection);
    // Henyey-Greenstein, g = 0.7 (normalised to 1 at 90°, so the scale reads as a multiplier).
    const g = 0.7;
    const hg = pow(float(1 + g * g).sub(cosSun.mul(2 * g)), -1.5).mul(
        Math.pow(1 + g * g, 1.5),
    );
    const cosFlash = dot(viewDir, s.flashDirection).mul(0.5).add(0.5);

    const flash = s.flash.mul(cosFlash.mul(1.5).add(0.5));

    return s.ambient
        .mul(diffuse)
        .add(s.sky.mul(refracted))
        .add(s.sun.mul(hg.mul(glint)))
        .add(vec3(0.75, 0.8, 1).mul(flash));
}
