import * as THREE from 'three/webgpu';
import {
    cameraPosition,
    exp,
    float,
    Fn,
    max,
    mix,
    output,
    positionView,
    positionWorld,
    pow,
    select,
    uniform,
    vec4,
} from 'three/tsl';

/**
 * Global exponential height fog + sun in-scattering, layered on top of the exp² distance fog.
 *
 * One TSL fog node assigned to `scene.fogNode`: three.js applies it at the end of every node material
 * (terrain, water, foliage, characters, effects) that has `fog` enabled, so nothing has to opt in.
 * The world position comes from the material's own position chain, so instancing, skinning and vertex
 * displacement (wind) are accounted for.
 *
 * The parameter objects below are the single source of truth (Atmosphere writes them every relight);
 * the uniforms read them by reference.
 */

/** x: world height of the fog base, y: falloff (1/m), z: density at the base (1/m), w: unused. */
export const heightFogParams = new THREE.Vector4(0, 0.01, 0, 0);
/** Sun direction (xyz, normalised) and in-scattering strength (w). */
export const fogSunParams = new THREE.Vector4(0, 1, 0, 0);
/** Linear colour added to the fog towards the sun. */
export const fogSunColor = new THREE.Vector3(1, 0.8, 0.6);

const hfParams = uniform(heightFogParams);
const hfSun = uniform(fogSunParams);
const hfSunColor = uniform(fogSunColor);

/** Scene fog node for the given distance fog (colour and density are read from it every frame). */
export function createHeightFogNode(fog: THREE.FogExp2): THREE.Node {
    const fogColor = uniform(fog.color);
    const fogDensity = uniform(fog.density).onRenderUpdate(() => fog.density);

    return Fn(() => {
        const depth = positionView.z.negate();
        const distanceFog = float(1).sub(
            exp(fogDensity.mul(fogDensity).mul(depth).mul(depth).negate()),
        );

        const ray = positionWorld.sub(cameraPosition).toVar();
        const rayLen = max(ray.length(), 1e-3);

        // Analytic integral of density(h) = d0 · exp(-k (h - h0)) along the view ray; zero density
        // leaves the distance fog untouched, so no branch is needed.
        const k = hfParams.y;
        const camH = cameraPosition.y
            .sub(hfParams.x)
            .clamp(float(-40).div(k), float(80).div(k));
        const t = k.mul(ray.y);
        const lineIntegral = select(
            t.abs().greaterThan(1e-3),
            float(1).sub(exp(t.negate())).div(t),
            float(1).sub(t.mul(0.5)),
        );
        const amount = hfParams.z
            .mul(exp(k.negate().mul(camH)))
            .mul(lineIntegral)
            .mul(rayLen);
        const factor = float(1).sub(
            float(1)
                .sub(distanceFog)
                .mul(exp(max(amount, 0).negate())),
        );

        // Forward scattering towards the sun tints the fog (warm glow at dawn / dusk).
        const sunAmount = max(ray.div(rayLen).dot(hfSun.xyz), 0);
        const tint = hfSunColor
            .mul(pow(sunAmount, 8).mul(hfSun.w))
            .add(fogColor);

        return vec4(mix(output.rgb, tint, factor), output.a);
    })();
}
