import * as THREE from 'three';

/**
 * Global exponential height fog + sun in-scattering, layered on top of three.js' distance fog.
 *
 * Instead of touching every material, the fog shader chunks are patched once (at import time) so all
 * built-in materials, materials extended through onBeforeCompile (terrain, water, foliage) and custom
 * ShaderMaterials that include the fog chunks get it. The world position is reconstructed from
 * `mvPosition`, so instancing and skinning work too.
 *
 * The extra uniforms are shared by reference: three.js clones ShaderLib uniforms per material, but
 * `cloneUniforms` keeps plain objects (anything that is not a Vector/Color/…) by reference, and the
 * uniform setters accept any `{x, y, z, w}`. So the objects below are the single source of truth.
 * Materials without these uniforms read zeros, which disables both effects.
 */

/** x: world height of the fog base, y: falloff (1/m), z: density at the base (1/m), w: unused. */
export const heightFogParams = { x: 0, y: 0.01, z: 0, w: 0 };
/** Sun direction (xyz, normalised) and in-scattering strength (w). */
export const fogSunParams = { x: 0, y: 1, z: 0, w: 0 };
/** Linear colour added to the fog towards the sun. */
export const fogSunColor = { x: 1, y: 0.8, z: 0.6 };

const PARS_VERTEX = /* glsl */ `
#ifdef USE_FOG
	varying float vFogDepth;
	varying vec3 vFogWorldPos;
#endif
`;

const VERTEX = /* glsl */ `
#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	// World position from view space: the view matrix is a rigid transform, so its inverse is R^T (v - t).
	vFogWorldPos = ( mvPosition.xyz - viewMatrix[ 3 ].xyz ) * mat3( viewMatrix );
#endif
`;

const PARS_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	varying vec3 vFogWorldPos;
	uniform vec4 hfParams;
	uniform vec4 hfSun;
	uniform vec3 hfSunColor;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
#endif
`;

const FRAGMENT = /* glsl */ `
#ifdef USE_FOG
	#ifdef FOG_EXP2
		float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
	#else
		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
	#endif
	vec3 fogRay = vFogWorldPos - cameraPosition;
	float fogRayLen = max( length( fogRay ), 1e-3 );
	if ( hfParams.z > 0.0 ) {
		// Analytic integral of density(h) = d0 * exp(-k (h - h0)) along the view ray.
		float k = hfParams.y;
		float camH = clamp( cameraPosition.y - hfParams.x, -40.0 / k, 80.0 / k );
		float t = k * fogRay.y;
		float lineIntegral = abs( t ) > 1e-3 ? ( 1.0 - exp( - t ) ) / t : 1.0 - 0.5 * t;
		float amount = hfParams.z * exp( - k * camH ) * lineIntegral * fogRayLen;
		fogFactor = 1.0 - ( 1.0 - fogFactor ) * exp( - max( amount, 0.0 ) );
	}
	vec3 fogTint = fogColor;
	if ( hfSun.w > 0.0 ) {
		float sunAmount = max( dot( fogRay / fogRayLen, hfSun.xyz ), 0.0 );
		fogTint += hfSunColor * ( pow( sunAmount, 8.0 ) * hfSun.w );
	}
	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogTint, fogFactor );
#endif
`;

let installed = false;

/** Patch the fog chunks and shared uniforms (idempotent; must run before materials compile). */
export function installHeightFog(): void {
    if (installed) {
        return;
    }

    installed = true;
    const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
    chunks.fog_pars_vertex = PARS_VERTEX;
    chunks.fog_vertex = VERTEX;
    chunks.fog_pars_fragment = PARS_FRAGMENT;
    chunks.fog_fragment = FRAGMENT;

    const extra = {
        hfParams: { value: heightFogParams },
        hfSun: { value: fogSunParams },
        hfSunColor: { value: fogSunColor },
    };
    Object.assign(THREE.UniformsLib.fog, extra);

    for (const shader of Object.values(THREE.ShaderLib)) {
        if ('fogDensity' in shader.uniforms) {
            Object.assign(shader.uniforms, extra);
        }
    }
}

installHeightFog();
