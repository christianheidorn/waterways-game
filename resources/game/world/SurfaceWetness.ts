import * as THREE from 'three/webgpu';
import {
    materialColor,
    materialRoughness,
    mix,
    normalWorld,
    smoothstep,
    uniform,
} from 'three/tsl';

/** Rain wetness of exposed surfaces (0 = dry, 1 = soaked), driven by Weather. */
export const surfaceWetness = uniform(0);

/**
 * Rain on props and characters: soaked surfaces are darker (water fills the pores / fabric) and glossier,
 * like the wet terrain. Upward-facing surfaces get wet first, overhangs stay drier. The material's own
 * colour, textures and roughness stay the base, so it works on any standard node material.
 */
export function applyWetness(
    material: THREE.MeshStandardNodeMaterial,
    base: {
        color: THREE.Node<'vec3'> | THREE.Node<'color'>;
        roughness: THREE.Node<'float'>;
    } = { color: materialColor, roughness: materialRoughness },
): void {
    const exposure = smoothstep(-0.6, 0.6, normalWorld.y).mul(0.5).add(0.5);
    const wet = surfaceWetness.mul(exposure);
    material.colorNode = base.color.mul(mix(1, 0.58, wet));
    material.roughnessNode = mix(base.roughness, 0.28, wet.mul(0.75));
}

/**
 * A lit, wettable node material for a model material (glTF loads classic materials): standard and
 * physical materials keep all their maps and factors; unlit (KHR_materials_unlit) and legacy ones
 * become standard so the model sits in the scene lighting like everything else.
 */
export function toLitNodeMaterial(
    source: THREE.Material,
): THREE.MeshStandardNodeMaterial {
    const material = (source as THREE.MeshPhysicalMaterial)
        .isMeshPhysicalMaterial
        ? new THREE.MeshPhysicalNodeMaterial()
        : new THREE.MeshStandardNodeMaterial();

    // Copies every property both share (colour, maps, factors, alpha, side...).
    material.copy(source as unknown as THREE.MeshStandardNodeMaterial);
    material.name = source.name;
    applyWetness(material);

    return material;
}
