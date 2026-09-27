import * as THREE from 'three';

export type CloudQuality = 'off' | 'low' | 'medium' | 'high';

/** Octaves / light-march steps / cirrus layer per cloud quality. */
const CLOUD_DEFINES: Record<
    CloudQuality,
    { octaves: number; steps: number; cirrus: number; clouds: number }
> = {
    off: { octaves: 1, steps: 0, cirrus: 0, clouds: 0 },
    low: { octaves: 3, steps: 0, cirrus: 0, clouds: 1 },
    medium: { octaves: 4, steps: 2, cirrus: 1, clouds: 1 },
    high: { octaves: 6, steps: 4, cirrus: 1, clouds: 1 },
};

/**
 * Physically-inspired sky dome: Preetham scattering (as in three's Sky), a wind-driven fBm cloud layer
 * with self-shadowing towards the sun, storm darkening / overcast desaturation, stars and a moon at
 * night, a horizon band that blends into the scene fog, and lightning flashes lighting the clouds.
 */
export class SkyDome extends THREE.Mesh<THREE.BoxGeometry, THREE.ShaderMaterial> {
    readonly uniforms: {
        turbidity: THREE.IUniform<number>;
        rayleigh: THREE.IUniform<number>;
        mieCoefficient: THREE.IUniform<number>;
        mieDirectionalG: THREE.IUniform<number>;
        sunPosition: THREE.IUniform<THREE.Vector3>;
        moonPosition: THREE.IUniform<THREE.Vector3>;
        time: THREE.IUniform<number>;
        cloudCoverage: THREE.IUniform<number>;
        cloudDensity: THREE.IUniform<number>;
        cloudSoftness: THREE.IUniform<number>;
        cloudDarkness: THREE.IUniform<number>;
        cloudOffset: THREE.IUniform<THREE.Vector2>;
        overcast: THREE.IUniform<number>;
        night: THREE.IUniform<number>;
        horizonFog: THREE.IUniform<number>;
        horizonColor: THREE.IUniform<THREE.Color>;
        flash: THREE.IUniform<number>;
        flashDirection: THREE.IUniform<THREE.Vector3>;
        showSunDisc: THREE.IUniform<number>;
        showStars: THREE.IUniform<number>;
    };
    private quality: CloudQuality | null = null;

    constructor(quality: CloudQuality = 'medium', stars = true) {
        const uniforms = {
            turbidity: { value: 2 },
            rayleigh: { value: 1 },
            mieCoefficient: { value: 0.005 },
            mieDirectionalG: { value: 0.8 },
            sunPosition: { value: new THREE.Vector3(0, 1, 0) },
            moonPosition: { value: new THREE.Vector3(0, -1, 0) },
            time: { value: 0 },
            cloudCoverage: { value: 0.3 },
            cloudDensity: { value: 0.5 },
            cloudSoftness: { value: 0.3 },
            cloudDarkness: { value: 0 },
            cloudOffset: { value: new THREE.Vector2() },
            overcast: { value: 0 },
            night: { value: 0 },
            horizonFog: { value: 0 },
            horizonColor: { value: new THREE.Color() },
            flash: { value: 0 },
            flashDirection: { value: new THREE.Vector3(0, 1, 0) },
            showSunDisc: { value: 1 },
            showStars: { value: stars ? 1 : 0 },
        };
        const material = new THREE.ShaderMaterial({
            name: 'SkyDome',
            uniforms,
            vertexShader: SKY_VERTEX,
            fragmentShader: SKY_FRAGMENT,
            side: THREE.BackSide,
            depthWrite: false,
        });
        super(new THREE.BoxGeometry(1, 1, 1), material);
        this.uniforms = uniforms;
        this.frustumCulled = false;
        // Drawn after the opaque world so early-z skips every covered pixel.
        this.renderOrder = 1000;
        this.setCloudQuality(quality);
    }

    setCloudQuality(quality: CloudQuality): void {
        if (quality === this.quality) {
            return;
        }

        this.quality = quality;
        const d = CLOUD_DEFINES[quality] ?? CLOUD_DEFINES.medium;
        this.material.defines = {
            CLOUDS: d.clouds,
            CLOUD_OCTAVES: d.octaves,
            CLOUD_LIGHT_STEPS: d.steps,
            CIRRUS: d.cirrus,
        };
        this.material.needsUpdate = true;
    }

    dispose(): void {
        this.geometry.dispose();
        this.material.dispose();
    }
}

// ---------------------------------------------------------------- CPU Preetham (for fog / light colours)

const TOTAL_RAYLEIGH = [
    5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5,
];
const MIE_CONST = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];
const CUTOFF_ANGLE = 1.6110731556870734;
const BETA_R = [0, 0, 0];
const BETA_M = [0, 0, 0];

export type SkyParams = {
    turbidity: number;
    rayleigh: number;
    mieCoefficient: number;
    mieDirectionalG: number;
};

/** Sun intensity for a zenith cosine (Preetham "earth shadow hack"). */
export function sunIntensity(zenithCos: number): number {
    const c = Math.min(1, Math.max(-1, zenithCos));

    return (
        1000 * Math.max(0, 1 - Math.exp(-((CUTOFF_ANGLE - Math.acos(c)) / 1.5)))
    );
}

function prepare(p: SkyParams): void {
    const mie = 0.434 * (0.2 * p.turbidity * 10e-18);

    for (let i = 0; i < 3; i++) {
        BETA_R[i] = TOTAL_RAYLEIGH[i] * p.rayleigh;
        BETA_M[i] = mie * MIE_CONST[i] * p.mieCoefficient;
    }
}

/** Atmospheric transmittance (0-1 per channel) looking along a direction with the given y. */
export function extinction(dirY: number, p: SkyParams, out: THREE.Color): THREE.Color {
    prepare(p);
    const zenith = Math.acos(Math.max(0, dirY));
    const inv =
        1 /
        (Math.cos(zenith) +
            0.15 * Math.pow(93.885 - (zenith * 180) / Math.PI, -1.253));

    return out.setRGB(
        Math.exp(-(BETA_R[0] * 8.4e3 + BETA_M[0] * 1.25e3) * inv),
        Math.exp(-(BETA_R[1] * 8.4e3 + BETA_M[1] * 1.25e3) * inv),
        Math.exp(-(BETA_R[2] * 8.4e3 + BETA_M[2] * 1.25e3) * inv),
    );
}

/** Radiance of the cloudless sky in a direction, in the same units as the sky shader (linear). */
export function skyRadiance(
    dir: THREE.Vector3,
    sun: THREE.Vector3,
    p: SkyParams,
    out: THREE.Color,
): THREE.Color {
    prepare(p);
    const sunE = sunIntensity(sun.y);
    const zenith = Math.acos(Math.max(0, dir.y));
    const inv =
        1 /
        (Math.cos(zenith) +
            0.15 * Math.pow(93.885 - (zenith * 180) / Math.PI, -1.253));
    const cosTheta = dir.dot(sun);
    const rc = cosTheta * 0.5 + 0.5;
    const rPhase = 0.05968310365946075 * (1 + rc * rc);
    const g = p.mieDirectionalG;
    const g2 = g * g;
    const mPhase =
        (0.07957747154594767 * (1 - g2)) /
        Math.pow(1 - 2 * g * cosTheta + g2, 1.5);
    const sunLow = Math.min(1, Math.max(0, Math.pow(1 - sun.y, 5)));
    const rgb = [0, 0, 0];

    for (let i = 0; i < 3; i++) {
        const fex = Math.exp(-(BETA_R[i] * 8.4e3 + BETA_M[i] * 1.25e3) * inv);
        const ratio =
            (BETA_R[i] * rPhase + BETA_M[i] * mPhase) / (BETA_R[i] + BETA_M[i]);
        let lin = Math.pow(sunE * ratio * (1 - fex), 1.5);
        lin *= 1 + (Math.sqrt(Math.max(0, sunE * ratio * fex)) - 1) * sunLow;
        rgb[i] = (lin + 0.1 * fex) * 0.04;
    }

    return out.setRGB(rgb[0], rgb[1] + 0.0003, rgb[2] + 0.00075);
}

// ---------------------------------------------------------------- shaders

const SKY_VERTEX = /* glsl */ `
uniform vec3 sunPosition;
uniform float rayleigh;
uniform float turbidity;
uniform float mieCoefficient;

varying vec3 vWorldPosition;
varying vec3 vSunDirection;
varying vec3 vBetaR;
varying vec3 vBetaM;
varying float vSunE;
varying vec3 vSunFex;

const float e = 2.718281828459045;
const float pi = 3.141592653589793;
const vec3 totalRayleigh = vec3( 5.804542996261093E-6, 1.3562911419845635E-5, 3.0265902468824876E-5 );
const vec3 MieConst = vec3( 1.8399918514433978E14, 2.7798023919660528E14, 4.0790479543861094E14 );
const float cutoffAngle = 1.6110731556870734;
const float steepness = 1.5;
const float EE = 1000.0;

float sunIntensity( float zenithAngleCos ) {
	zenithAngleCos = clamp( zenithAngleCos, -1.0, 1.0 );
	return EE * max( 0.0, 1.0 - pow( e, -( ( cutoffAngle - acos( zenithAngleCos ) ) / steepness ) ) );
}

vec3 totalMie( float T ) {
	float c = ( 0.2 * T ) * 10E-18;
	return 0.434 * c * MieConst;
}

void main() {
	vec4 worldPosition = modelMatrix * vec4( position, 1.0 );
	vWorldPosition = worldPosition.xyz;
	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
	gl_Position.z = gl_Position.w;

	vSunDirection = normalize( sunPosition );
	vSunE = sunIntensity( vSunDirection.y );
	vBetaR = totalRayleigh * rayleigh;
	vBetaM = totalMie( turbidity ) * mieCoefficient;

	// Transmittance towards the sun (reddens cloud lighting at sunset).
	float zs = acos( max( 0.0, vSunDirection.y ) );
	float invS = 1.0 / ( cos( zs ) + 0.15 * pow( 93.885 - ( ( zs * 180.0 ) / pi ), -1.253 ) );
	vSunFex = exp( -( vBetaR * 8.4E3 + vBetaM * 1.25E3 ) * invS );
}
`;

const SKY_FRAGMENT = /* glsl */ `
varying vec3 vWorldPosition;
varying vec3 vSunDirection;
varying vec3 vBetaR;
varying vec3 vBetaM;
varying float vSunE;
varying vec3 vSunFex;

uniform float mieDirectionalG;
uniform vec3 moonPosition;
uniform float time;
uniform float cloudCoverage;
uniform float cloudDensity;
uniform float cloudSoftness;
uniform float cloudDarkness;
uniform vec2 cloudOffset;
uniform float overcast;
uniform float night;
uniform float horizonFog;
uniform vec3 horizonColor;
uniform float flash;
uniform vec3 flashDirection;
uniform float showSunDisc;
uniform float showStars;

const float pi = 3.141592653589793;
const float rayleighZenithLength = 8.4E3;
const float mieZenithLength = 1.25E3;
const float sunAngularDiameterCos = 0.9999566769464484;
const float THREE_OVER_SIXTEENPI = 0.05968310365946075;
const float ONE_OVER_FOURPI = 0.07957747154594767;

float rayleighPhase( float cosTheta ) {
	return THREE_OVER_SIXTEENPI * ( 1.0 + pow( cosTheta, 2.0 ) );
}

float hgPhase( float cosTheta, float g ) {
	float g2 = pow( g, 2.0 );
	float inverse = 1.0 / pow( 1.0 - 2.0 * g * cosTheta + g2, 1.5 );
	return ONE_OVER_FOURPI * ( ( 1.0 - g2 ) * inverse );
}

// Sinless hashes (stable across GPUs).
vec2 hash22( vec2 i ) {
	vec3 p = fract( i.xyx * vec3( 0.1031, 0.1030, 0.0973 ) );
	p += dot( p, p.yzx + 33.33 );
	return fract( ( p.xx + p.yz ) * p.zy ) * 2.0 - 1.0;
}

float hash13( vec3 p3 ) {
	p3 = fract( p3 * 0.1031 );
	p3 += dot( p3, p3.zyx + 31.32 );
	return fract( ( p3.x + p3.y ) * p3.z );
}

float gnoise( vec2 p ) {
	vec2 i = floor( p );
	vec2 f = fract( p );
	vec2 u = f * f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 );
	float a = dot( hash22( i ), f );
	float b = dot( hash22( i + vec2( 1.0, 0.0 ) ), f - vec2( 1.0, 0.0 ) );
	float c = dot( hash22( i + vec2( 0.0, 1.0 ) ), f - vec2( 0.0, 1.0 ) );
	float d = dot( hash22( i + vec2( 1.0, 1.0 ) ), f - vec2( 1.0, 1.0 ) );
	return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y ) * 1.6;
}

const mat2 octaveRot = mat2( 0.8, -0.6, 0.6, 0.8 );

// Cloud density (0-1) at a point of the cloud plane.
float cloudField( vec2 p, int octaves ) {
	float sum = 0.0;
	float amp = 0.55;
	float norm = 0.0;
	float evolve = time * 0.004;
	for ( int i = 0; i < CLOUD_OCTAVES; i ++ ) {
		if ( i >= octaves ) break;
		sum += amp * gnoise( p + evolve * float( i + 1 ) );
		norm += amp;
		amp *= 0.5;
		p = octaveRot * p * 2.03 + 7.31;
	}
	return sum / norm * 0.5 + 0.5;
}

float cloudShape( float n, float coverage, float soft ) {
	float threshold = 1.0 - coverage;
	return smoothstep( threshold - soft * 0.2, threshold + soft, n );
}

void main() {
	vec3 direction = normalize( vWorldPosition - cameraPosition );

	// ---- Preetham sky (three.js Sky)
	float zenithAngle = acos( max( 0.0, direction.y ) );
	float inverse = 1.0 / ( cos( zenithAngle ) + 0.15 * pow( 93.885 - ( ( zenithAngle * 180.0 ) / pi ), -1.253 ) );
	float sR = rayleighZenithLength * inverse;
	float sM = mieZenithLength * inverse;
	vec3 Fex = exp( -( vBetaR * sR + vBetaM * sM ) );
	float cosTheta = dot( direction, vSunDirection );
	float rPhase = rayleighPhase( cosTheta * 0.5 + 0.5 );
	vec3 betaRTheta = vBetaR * rPhase;
	float mPhase = hgPhase( cosTheta, mieDirectionalG );
	vec3 betaMTheta = vBetaM * mPhase;
	vec3 Lin = pow( vSunE * ( ( betaRTheta + betaMTheta ) / ( vBetaR + vBetaM ) ) * ( 1.0 - Fex ), vec3( 1.5 ) );
	Lin *= mix( vec3( 1.0 ), pow( vSunE * ( ( betaRTheta + betaMTheta ) / ( vBetaR + vBetaM ) ) * Fex, vec3( 1.0 / 2.0 ) ), clamp( pow( 1.0 - vSunDirection.y, 5.0 ), 0.0, 1.0 ) );
	vec3 L0 = vec3( 0.1 ) * Fex;
	vec3 sky = ( Lin + L0 ) * 0.04 + vec3( 0.0, 0.0003, 0.00075 );

	// ---- night sky: faint airglow gradient, stars and the moon
	float up = max( direction.y, 0.0 );
	vec3 nightSky = mix( vec3( 0.0024, 0.0034, 0.0062 ), vec3( 0.0006, 0.0010, 0.0026 ), sqrt( up ) );
	float moonCos = dot( direction, moonPosition );
	float moonDisc = smoothstep( 0.99962, 0.99972, moonCos );
	vec3 moon = vec3( 0.0 );
	if ( night > 0.0 ) {
		// Craters: a little noise on the disc.
		float maria = gnoise( ( direction.xz - moonPosition.xz ) * 900.0 ) * 0.25 + 0.85;
		moon = vec3( 0.9, 0.92, 1.0 ) * ( moonDisc * maria * 1.6 + pow( max( moonCos, 0.0 ), 900.0 ) * 0.06 + pow( max( moonCos, 0.0 ), 30.0 ) * 0.01 );
	}
	float stars = 0.0;
	if ( showStars > 0.5 && night > 0.0 && direction.y > 0.0 ) {
		vec3 sp = direction * 180.0;
		vec3 cell = floor( sp );
		float h = hash13( cell );
		if ( h > 0.93 ) {
			vec3 centre = cell + 0.5 + ( vec3( hash13( cell + 1.7 ), hash13( cell + 5.3 ), hash13( cell + 9.1 ) ) - 0.5 ) * 0.6;
			float d = length( sp - centre );
			float twinkle = 0.7 + 0.3 * sin( time * ( 2.0 + h * 6.0 ) + h * 40.0 );
			stars = smoothstep( 0.2, 0.0, d ) * pow( ( h - 0.93 ) / 0.07, 3.0 ) * twinkle;
		}
		// Milky-way-ish band of haze.
		float band = exp( -pow( dot( direction, normalize( vec3( 0.3, 0.4, 0.86 ) ) ) * 3.2, 2.0 ) );
		nightSky += vec3( 0.0012, 0.0013, 0.0019 ) * band * ( gnoise( direction.xz * 9.0 ) * 0.5 + 0.6 );
		stars *= smoothstep( 0.0, 0.15, direction.y );
	}
	sky += ( nightSky + moon + vec3( 0.03, 0.032, 0.04 ) * stars ) * night;

	// Solar disc.
	float sundisc = clamp( ( cosTheta - sunAngularDiameterCos ) * 50000.0, 0.0, 1.0 ) * showSunDisc;
	vec3 sunDiscColor = ( 760.0 * sundisc ) * min( vSunE * Fex, 80.0 ) * 0.04;

	// ---- overcast: desaturate and dim the clear-sky scattering
	float lum = dot( sky, vec3( 0.2126, 0.7152, 0.0722 ) );
	sky = mix( sky, vec3( lum ) * vec3( 0.93, 0.97, 1.04 ), overcast * 0.85 ) * ( 1.0 - overcast * 0.25 );

	// Sunlight and ambient reaching the cloud layer.
	vec3 sunLight = vSunE * vSunFex * 0.0088;
	float moonUp = smoothstep( -0.05, 0.2, moonPosition.y );
	vec3 moonLight = vec3( 0.05, 0.06, 0.085 ) * night * moonUp;
	float skyLum = dot( ( Lin + L0 ) * 0.04, vec3( 0.2126, 0.7152, 0.0722 ) );
	vec3 ambient = mix( vec3( skyLum ) * vec3( 0.75, 0.85, 1.0 ), vec3( skyLum ), overcast ) * 1.3 + nightSky * 2.0 * night;

	vec3 color = sky + sunDiscColor;

	#if CLOUDS == 1
	if ( direction.y > -0.02 && cloudCoverage > 0.001 ) {
		float dy = max( direction.y, 0.0 );
		// Curved cloud plane: features shrink towards the horizon without exploding.
		vec2 uv = direction.xz / ( dy + 0.09 ) * 0.9 + cloudOffset;
		float n = cloudField( uv, CLOUD_OCTAVES );
		// Large scale coverage variation: clear gaps next to dense banks (less so when overcast).
		float cov = clamp( cloudCoverage + gnoise( uv * 0.16 + 2.3 ) * 0.22 * ( 1.0 - overcast ), 0.0, 1.0 );
		float mask = cloudShape( n, cov, cloudSoftness );
		float thickness = max( 0.0, n - ( 1.0 - cov ) );

		// Self shadowing: march a few steps towards the sun through the density field.
		float shadow = 0.0;
		#if CLOUD_LIGHT_STEPS > 0
		vec2 stepDir = vSunDirection.xz * 0.12 / ( max( vSunDirection.y, 0.05 ) + 0.4 );
		for ( int i = 1; i <= CLOUD_LIGHT_STEPS; i ++ ) {
			float ns = cloudField( uv + stepDir * float( i ), CLOUD_OCTAVES > 3 ? 3 : CLOUD_OCTAVES );
			shadow += max( 0.0, ns - ( 1.0 - cov ) );
		}
		shadow /= float( CLOUD_LIGHT_STEPS );
		#else
		shadow = thickness * 0.8;
		#endif
		float density = cloudDensity * ( 0.6 + overcast * 1.6 );
		float beer = exp( -shadow * 6.0 * density - overcast * 1.2 );
		float powder = 1.0 - exp( -thickness * 10.0 );
		float silver = clamp( 0.51 / pow( 1.49 - cosTheta * 1.4, 1.5 ), 0.0, 3.0 );
		float edge = mask * ( 1.0 - mask ) * 4.0;
		float sunVis = smoothstep( -0.06, 0.08, vSunDirection.y );

		vec3 direct = sunLight * sunVis * ( beer * mix( 0.55, 1.0, powder ) * 0.9 + silver * edge * 0.35 * beer );
		vec3 amb = ambient * mix( 1.0, 0.55, clamp( thickness * 2.5, 0.0, 1.0 ) ) * ( 0.8 + 0.2 * dy );
		vec3 cloudColor = direct + amb + moonLight * ( 0.4 + beer );
		// Storm clouds: thick, dark bases.
		cloudColor *= 1.0 - cloudDarkness * mix( 0.45, 0.85, clamp( thickness * 3.0, 0.0, 1.0 ) );

		// Lightning lights the clouds from inside, strongest around the strike.
		float flashLobe = pow( max( dot( direction, flashDirection ), 0.0 ), 6.0 );
		cloudColor += vec3( 0.75, 0.8, 1.0 ) * flash * ( 0.25 + 2.5 * flashLobe ) * ( 0.4 + thickness * 2.0 );

		float alpha = mask * ( 1.0 - exp( -( thickness + 0.05 ) * density * 14.0 ) );
		alpha = clamp( alpha, 0.0, 1.0 ) * smoothstep( -0.02, 0.06, direction.y );

		// Aerial perspective: distant clouds dissolve into the haze.
		float haze = exp( -dy * 9.0 );
		cloudColor = mix( cloudColor, sky, haze * 0.55 * ( 1.0 - overcast * 0.5 ) );

		color = mix( color, cloudColor, alpha );

		#if CIRRUS == 1
		// Thin high cirrus streaks.
		vec2 cuv = direction.xz / ( dy + 0.25 ) * vec2( 0.9, 3.5 ) + cloudOffset * 0.6;
		float c = gnoise( cuv * 1.4 ) * 0.5 + gnoise( cuv * 3.1 + 4.0 ) * 0.25;
		float cirrus = smoothstep( 0.1, 0.6, c ) * ( 1.0 - alpha ) * smoothstep( 0.02, 0.25, dy ) * clamp( cloudCoverage * 2.0, 0.0, 1.0 ) * ( 1.0 - overcast );
		color += ( sunLight * sunVis * 0.25 + ambient * 0.8 ) * cirrus * 0.5;
		#endif
	}
	#endif

	// Overcast with clouds disabled: a flat grey deck.
	#if CLOUDS == 0
	color = mix( color, ambient * ( 1.0 - cloudDarkness * 0.6 ) + vec3( 0.75, 0.8, 1.0 ) * flash * 0.4, overcast * smoothstep( -0.02, 0.1, direction.y ) );
	#endif

	// Lightning brightens the whole sky a little.
	color += vec3( 0.55, 0.6, 0.8 ) * flash * 0.12 * ( 1.0 + overcast );

	// Horizon band that matches the scene fog so distant terrain melts into the sky.
	float band = exp( -abs( direction.y ) * mix( 14.0, 3.0, horizonFog * horizonFog ) );
	color = mix( color, horizonColor, clamp( horizonFog * band, 0.0, 1.0 ) );
	// Below the horizon: fog colour (never the black lower hemisphere).
	color = mix( color, horizonColor, smoothstep( 0.0, -0.08, direction.y ) );

	gl_FragColor = vec4( color, 1.0 );

	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`;
