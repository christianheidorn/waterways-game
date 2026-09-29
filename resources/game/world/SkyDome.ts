import * as THREE from 'three/webgpu';
import {
    abs,
    acos,
    cameraPosition,
    cameraProjectionMatrix,
    clamp,
    cos,
    dot,
    exp,
    float,
    floor,
    Fn,
    fract,
    If,
    length,
    max,
    min,
    mix,
    modelViewMatrix,
    normalize,
    positionLocal,
    positionWorld,
    pow,
    sin,
    smoothstep,
    sqrt,
    uniform,
    vec2,
    vec3,
    vec4,
} from 'three/tsl';
import { farDepth } from '../core/depth';

type Float = THREE.Node<'float'>;
type Vec2 = THREE.Node<'vec2'>;
type Vec3 = THREE.Node<'vec3'>;
type Vec4 = THREE.Node<'vec4'>;

export type CloudQuality = 'off' | 'low' | 'medium' | 'high';

/** Octaves / light-march steps / cirrus layer per cloud quality. */
const CLOUD_QUALITY: Record<
    CloudQuality,
    { octaves: number; steps: number; cirrus: boolean; clouds: boolean }
> = {
    off: { octaves: 1, steps: 0, cirrus: false, clouds: false },
    low: { octaves: 3, steps: 0, cirrus: false, clouds: true },
    medium: { octaves: 4, steps: 2, cirrus: true, clouds: true },
    high: { octaves: 6, steps: 4, cirrus: true, clouds: true },
};

type SkyUniforms = ReturnType<typeof createUniforms>;

function createUniforms(stars: boolean) {
    return {
        turbidity: uniform(2),
        rayleigh: uniform(1),
        mieCoefficient: uniform(0.005),
        mieDirectionalG: uniform(0.8),
        sunPosition: uniform(new THREE.Vector3(0, 1, 0)),
        moonPosition: uniform(new THREE.Vector3(0, -1, 0)),
        time: uniform(0),
        cloudCoverage: uniform(0.3),
        cloudDensity: uniform(0.5),
        cloudSoftness: uniform(0.3),
        cloudDarkness: uniform(0),
        cloudOffset: uniform(new THREE.Vector2()),
        overcast: uniform(0),
        night: uniform(0),
        horizonFog: uniform(0),
        horizonColor: uniform(new THREE.Color()),
        deckColor: uniform(new THREE.Color(1, 1, 1)),
        flash: uniform(0),
        flashDirection: uniform(new THREE.Vector3(0, 1, 0)),
        showSunDisc: uniform(1),
        showStars: uniform(stars ? 1 : 0),
    };
}

/**
 * Physically-inspired sky dome: Preetham scattering (as in three's Sky), a wind-driven fBm cloud layer
 * with self-shadowing towards the sun, storm darkening / overcast desaturation, stars and a moon at
 * night, a horizon band that blends into the scene fog, and lightning flashes lighting the clouds.
 *
 * Everything that only depends on the uniforms (scattering coefficients, sun intensity, transmittance
 * towards the sun) is evaluated once per draw on the CPU instead of per pixel.
 */
export class SkyDome extends THREE.Mesh<
    THREE.BoxGeometry,
    THREE.MeshBasicNodeMaterial
> {
    readonly uniforms: SkyUniforms;
    private readonly derived: DerivedUniforms;
    private quality: CloudQuality | null = null;

    constructor(quality: CloudQuality = 'medium', stars = true) {
        const material = new THREE.MeshBasicNodeMaterial({
            name: 'SkyDome',
            side: THREE.BackSide,
            depthWrite: false,
        });
        material.fog = false;
        material.lights = false;
        // Projected onto the far plane: never clipped by the camera far distance.
        const clip = cameraProjectionMatrix
            .mul(modelViewMatrix)
            .mul(vec4(positionLocal, 1));
        material.vertexNode = vec4(clip.xy, clip.w.mul(farDepth()), clip.w);
        super(new THREE.BoxGeometry(1, 1, 1), material);
        this.uniforms = createUniforms(stars);
        this.derived = createDerived(this.uniforms);
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
        this.material.colorNode = skyColor(
            this.uniforms,
            this.derived,
            CLOUD_QUALITY[quality] ?? CLOUD_QUALITY.medium,
        );
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
const MIE_CONST = [
    1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14,
];
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

/** Inverse optical path length factor for a view direction with the given y (Preetham). */
function inversePath(dirY: number): number {
    const zenith = Math.acos(Math.max(0, dirY));

    return (
        1 /
        (Math.cos(zenith) +
            0.15 * Math.pow(93.885 - (zenith * 180) / Math.PI, -1.253))
    );
}

/** Atmospheric transmittance (0-1 per channel) looking along a direction with the given y. */
export function extinction(
    dirY: number,
    p: SkyParams,
    out: THREE.Color,
): THREE.Color {
    prepare(p);
    const inv = inversePath(dirY);

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
    const inv = inversePath(dir.y);
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

// ---------------------------------------------------------------- per-draw constants

type DerivedUniforms = ReturnType<typeof createDerived>;

/** Uniform-only terms of the sky shader, recomputed on the CPU before each draw. */
function createDerived(u: SkyUniforms) {
    const params = (): SkyParams => ({
        turbidity: u.turbidity.value,
        rayleigh: u.rayleigh.value,
        mieCoefficient: u.mieCoefficient.value,
        mieDirectionalG: u.mieDirectionalG.value,
    });
    const sunDir = new THREE.Vector3();
    const fex = new THREE.Color();

    return {
        sunDirection: uniform(new THREE.Vector3(0, 1, 0)).onRenderUpdate(
            (_, self) => self.value.copy(u.sunPosition.value).normalize(),
        ),
        sunE: uniform(0).onRenderUpdate(() =>
            sunIntensity(sunDir.copy(u.sunPosition.value).normalize().y),
        ),
        betaR: uniform(new THREE.Vector3()).onRenderUpdate((_, self) => {
            prepare(params());

            return self.value.fromArray(BETA_R);
        }),
        betaM: uniform(new THREE.Vector3()).onRenderUpdate((_, self) => {
            prepare(params());

            return self.value.fromArray(BETA_M);
        }),
        // Transmittance towards the sun (reddens cloud lighting at sunset).
        sunFex: uniform(new THREE.Vector3()).onRenderUpdate((_, self) => {
            sunDir.copy(u.sunPosition.value).normalize();
            extinction(sunDir.y, params(), fex);

            return self.value.set(fex.r, fex.g, fex.b);
        }),
    };
}

// ---------------------------------------------------------------- shader

const LUMA = vec3(0.2126, 0.7152, 0.0722);

// Sinless hashes (stable across GPUs).
const hash22 = Fn(([i]: [Vec2]) => {
    const p = fract(
        vec3(i.x, i.y, i.x).mul(vec3(0.1031, 0.103, 0.0973)),
    ).toVar();
    p.addAssign(dot(p, p.yzx.add(33.33)));

    return fract(p.xx.add(p.yz).mul(p.zy)).mul(2).sub(1);
}).setLayout({
    name: 'skyHash22',
    type: 'vec2',
    inputs: [{ name: 'i', type: 'vec2' }],
});

const hash13 = Fn(([p]: [Vec3]) => {
    const p3 = fract(p.mul(0.1031)).toVar();
    p3.addAssign(dot(p3, p3.zyx.add(31.32)));

    return fract(p3.x.add(p3.y).mul(p3.z));
}).setLayout({
    name: 'skyHash13',
    type: 'float',
    inputs: [{ name: 'p', type: 'vec3' }],
});

/** Gradient noise, roughly -1..1. */
const gnoise = Fn(([p]: [Vec2]) => {
    const i = floor(p).toVar();
    const f = fract(p).toVar();
    const u = f
        .mul(f)
        .mul(f)
        .mul(f.mul(f.mul(6).sub(15)).add(10));
    const a = dot(hash22(i), f);
    const b = dot(hash22(i.add(vec2(1, 0))), f.sub(vec2(1, 0)));
    const c = dot(hash22(i.add(vec2(0, 1))), f.sub(vec2(0, 1)));
    const d = dot(hash22(i.add(vec2(1, 1))), f.sub(vec2(1, 1)));

    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y).mul(1.6);
}).setLayout({
    name: 'skyNoise',
    type: 'float',
    inputs: [{ name: 'p', type: 'vec2' }],
});

const cloudFields = new Map<number, (p: Vec2, time: Float) => Float>();

/** Cloud density (0-1) at a point of the cloud plane: `octaves` rotated fBm octaves that evolve over time. */
function cloudField(octaves: number) {
    let fn = cloudFields.get(octaves);

    if (!fn) {
        const layout = Fn(([start, time]: [Vec2, Float]) => {
            const p = vec2(start).toVar();
            const evolve = time.mul(0.004);
            // Accumulated in statement order: `p` changes between octaves.
            const sum = float(0).toVar();
            let amp = 0.55;
            let norm = 0;

            for (let i = 0; i < octaves; i++) {
                sum.addAssign(gnoise(p.add(evolve.mul(i + 1))).mul(amp));
                norm += amp;
                amp *= 0.5;

                if (i < octaves - 1) {
                    // p = mat2(0.8, -0.6, 0.6, 0.8) · p · 2.03 + 7.31
                    p.assign(
                        vec2(
                            p.x.mul(0.8).add(p.y.mul(0.6)),
                            p.x.mul(-0.6).add(p.y.mul(0.8)),
                        )
                            .mul(2.03)
                            .add(7.31),
                    );
                }
            }

            return sum.div(norm).mul(0.5).add(0.5);
        }).setLayout({
            name: `skyCloudField${octaves}`,
            type: 'float',
            inputs: [
                { name: 'start', type: 'vec2' },
                { name: 'time', type: 'float' },
            ],
        });
        fn = (p, time) => layout(p, time);
        cloudFields.set(octaves, fn);
    }

    return fn;
}

type CloudSettings = (typeof CLOUD_QUALITY)[CloudQuality];

function skyColor(u: SkyUniforms, d: DerivedUniforms, q: CloudSettings): Vec4 {
    return Fn(() => {
        const direction = normalize(positionWorld.sub(cameraPosition)).toVar();
        const sunDirection = d.sunDirection;

        // ---- Preetham sky (three.js Sky)
        const zenithAngle = acos(max(0, direction.y));
        const inverse = float(1).div(
            cos(zenithAngle).add(
                pow(
                    float(93.885).sub(zenithAngle.mul(180 / Math.PI)),
                    -1.253,
                ).mul(0.15),
            ),
        );
        const fex = exp(
            d.betaR
                .mul(inverse.mul(8.4e3))
                .add(d.betaM.mul(inverse.mul(1.25e3)))
                .negate(),
        ).toVar();
        const cosTheta = dot(direction, sunDirection).toVar();
        const rc = cosTheta.mul(0.5).add(0.5);
        const rPhase = rc.mul(rc).add(1).mul(0.05968310365946075);
        const g = u.mieDirectionalG;
        const g2 = g.mul(g);
        const mPhase = float(1)
            .sub(g2)
            .mul(0.07957747154594767)
            .div(pow(float(1).sub(g.mul(2).mul(cosTheta)).add(g2), 1.5));
        const ratio = d.betaR
            .mul(rPhase)
            .add(d.betaM.mul(mPhase))
            .div(d.betaR.add(d.betaM))
            .mul(d.sunE)
            .toVar();
        const lin = pow(ratio.mul(float(1).sub(fex)), vec3(1.5)).mul(
            mix(
                vec3(1),
                sqrt(ratio.mul(fex)),
                clamp(pow(float(1).sub(sunDirection.y), 5), 0, 1),
            ),
        );
        const clearSky = lin.add(fex.mul(0.1)).mul(0.04).toVar();
        const sky = clearSky.add(vec3(0, 0.0003, 0.00075)).toVar();

        // ---- night sky: faint airglow gradient, stars and the moon
        const up = max(direction.y, 0);
        const nightSky = mix(
            vec3(0.014, 0.02, 0.036),
            vec3(0.004, 0.007, 0.017),
            sqrt(up),
        ).toVar();
        const moon = vec3(0).toVar();
        const stars = float(0).toVar();

        If(u.night.greaterThan(0), () => {
            const moonCos = dot(direction, u.moonPosition).toVar();
            const moonDisc = smoothstep(0.99962, 0.99972, moonCos);
            // Craters: a little noise on the disc.
            const maria = gnoise(direction.xz.sub(u.moonPosition.xz).mul(900))
                .mul(0.25)
                .add(0.85);
            const glow = max(moonCos, 0);
            moon.assign(
                vec3(0.9, 0.92, 1).mul(
                    moonDisc
                        .mul(maria)
                        .mul(5)
                        .add(pow(glow, 900).mul(0.25))
                        .add(pow(glow, 40).mul(0.04)),
                ),
            );

            If(
                u.showStars.greaterThan(0.5).and(direction.y.greaterThan(0)),
                () => {
                    const sp = direction.mul(180).toVar();
                    const cell = floor(sp).toVar();
                    const h = hash13(cell).toVar();

                    If(h.greaterThan(0.93), () => {
                        const centre = cell.add(0.5).add(
                            vec3(
                                hash13(cell.add(1.7)),
                                hash13(cell.add(5.3)),
                                hash13(cell.add(9.1)),
                            )
                                .sub(0.5)
                                .mul(0.6),
                        );
                        const dist = length(sp.sub(centre));
                        const twinkle = sin(
                            u.time.mul(h.mul(6).add(2)).add(h.mul(40)),
                        )
                            .mul(0.3)
                            .add(0.7);
                        stars.assign(
                            smoothstep(0.2, 0, dist)
                                .mul(pow(h.sub(0.93).div(0.07), 3))
                                .mul(twinkle),
                        );
                    });

                    // Milky-way-ish band of haze.
                    const band = exp(
                        pow(
                            dot(
                                direction,
                                vec3(0.3, 0.4, 0.86).normalize(),
                            ).mul(3.2),
                            2,
                        ).negate(),
                    );
                    nightSky.addAssign(
                        vec3(0.006, 0.0065, 0.009)
                            .mul(band)
                            .mul(gnoise(direction.xz.mul(9)).mul(0.5).add(0.6)),
                    );
                    stars.mulAssign(smoothstep(0, 0.15, direction.y));
                },
            );
        });

        sky.addAssign(
            nightSky
                .add(moon)
                .add(vec3(1.1, 1.15, 1.3).mul(stars))
                .mul(u.night),
        );

        // Solar disc.
        const sundisc = clamp(
            cosTheta.sub(0.9999566769464484).mul(50000),
            0,
            1,
        ).mul(u.showSunDisc);
        const sunDiscColor = min(fex.mul(d.sunE), 80).mul(
            sundisc.mul(760 * 0.04),
        );

        // ---- overcast: desaturate and dim the clear-sky scattering
        const lum = dot(sky, LUMA);
        sky.assign(
            mix(
                sky,
                vec3(lum).mul(vec3(0.93, 0.97, 1.04)),
                u.overcast.mul(0.85),
            ).mul(float(1).sub(u.overcast.mul(0.25))),
        );

        // Sunlight and ambient reaching the cloud layer.
        const sunLight = d.sunFex.mul(d.sunE.mul(0.0088));
        const moonUp = smoothstep(-0.05, 0.2, u.moonPosition.y);
        const moonLight = vec3(0.03, 0.036, 0.05).mul(u.night.mul(moonUp));
        const skyLum = dot(clearSky, LUMA);
        // Scattered clouds are lit by the sky around them; a closed deck has a uniform (CPU) brightness.
        const ambient = mix(
            vec3(skyLum).mul(vec3(0.75 * 1.3, 0.85 * 1.3, 1.3)),
            u.deckColor,
            u.overcast,
        )
            .add(nightSky.mul(u.night.mul(2)))
            .toVar();

        const color = sky.add(sunDiscColor).toVar();

        if (q.clouds) {
            If(
                direction.y
                    .greaterThan(-0.02)
                    .and(u.cloudCoverage.greaterThan(0.001)),
                () => {
                    const dy = max(direction.y, 0).toVar();
                    // Curved cloud plane: features shrink towards the horizon without exploding.
                    const uv = direction.xz
                        .div(dy.add(0.09))
                        .mul(0.9)
                        .add(u.cloudOffset)
                        .toVar();
                    const n = cloudField(q.octaves)(uv, u.time).toVar();
                    // Large scale coverage variation: clear gaps next to dense banks (less so when overcast).
                    const cov = clamp(
                        u.cloudCoverage.add(
                            gnoise(uv.mul(0.16).add(2.3))
                                .mul(0.22)
                                .mul(float(1).sub(u.overcast)),
                        ),
                        0,
                        1,
                    ).toVar();
                    const threshold = float(1).sub(cov).toVar();
                    const mask = smoothstep(
                        threshold.sub(u.cloudSoftness.mul(0.2)),
                        threshold.add(u.cloudSoftness),
                        n,
                    ).toVar();
                    const thickness = max(0, n.sub(threshold)).toVar();

                    // Self shadowing: march a few steps towards the sun through the density field.
                    let shadow: Float;

                    if (q.steps > 0) {
                        const stepDir = sunDirection.xz
                            .mul(0.12)
                            .div(max(sunDirection.y, 0.05).add(0.4))
                            .toVar();
                        const field = cloudField(Math.min(3, q.octaves));
                        let sum: Float = float(0);

                        for (let i = 1; i <= q.steps; i++) {
                            sum = sum.add(
                                max(
                                    0,
                                    field(uv.add(stepDir.mul(i)), u.time).sub(
                                        threshold,
                                    ),
                                ),
                            );
                        }

                        shadow = sum.div(q.steps);
                    } else {
                        shadow = thickness.mul(0.8);
                    }

                    const density = u.cloudDensity
                        .mul(u.overcast.mul(1.6).add(0.6))
                        .toVar();
                    const beer = exp(
                        shadow.mul(6).mul(density).negate(),
                    ).toVar();
                    const powder = float(1).sub(exp(thickness.mul(-10)));
                    const silver = clamp(
                        float(0.51).div(
                            pow(float(1.49).sub(cosTheta.mul(1.4)), 1.5),
                        ),
                        0,
                        3,
                    );
                    const edge = mask.mul(float(1).sub(mask)).mul(4);
                    const sunVis = smoothstep(-0.06, 0.08, sunDirection.y);

                    // A closed deck lets little direct sun through.
                    const direct = sunLight
                        .mul(sunVis)
                        .mul(
                            beer
                                .mul(mix(0.55, 1, powder))
                                .mul(0.9)
                                .add(silver.mul(edge).mul(0.35).mul(beer)),
                        )
                        .mul(float(1).sub(u.overcast.mul(0.85)));
                    const amb = ambient
                        .mul(mix(1, 0.55, clamp(thickness.mul(2.5), 0, 1)))
                        .mul(dy.mul(0.2).add(0.8));
                    const cloudColor = direct
                        .add(amb)
                        .add(moonLight.mul(beer.add(0.4)))
                        .toVar();
                    // Storm clouds: thick, dark bases.
                    cloudColor.mulAssign(
                        float(1).sub(
                            u.cloudDarkness.mul(
                                mix(0.25, 0.6, clamp(thickness.mul(3), 0, 1)),
                            ),
                        ),
                    );

                    // Lightning lights the clouds from inside, strongest around the strike.
                    const flashLobe = pow(
                        max(dot(direction, u.flashDirection), 0),
                        6,
                    );
                    cloudColor.addAssign(
                        vec3(0.75, 0.8, 1)
                            .mul(u.flash)
                            .mul(flashLobe.mul(2.5).add(0.25))
                            .mul(thickness.mul(2).add(0.4)),
                    );

                    const alpha = clamp(
                        mask.mul(
                            float(1).sub(
                                exp(thickness.add(0.05).mul(density).mul(-14)),
                            ),
                        ),
                        0,
                        1,
                    )
                        .mul(smoothstep(-0.02, 0.06, direction.y))
                        .toVar();

                    // Aerial perspective: distant clouds dissolve into the haze.
                    const haze = exp(dy.mul(-9));
                    cloudColor.assign(
                        mix(
                            cloudColor,
                            mix(sky, u.horizonColor, u.overcast),
                            haze.mul(0.55),
                        ),
                    );

                    color.assign(mix(color, cloudColor, alpha));

                    if (q.cirrus) {
                        // Thin high cirrus streaks.
                        const cuv = direction.xz
                            .div(dy.add(0.25))
                            .mul(vec2(0.9, 3.5))
                            .add(u.cloudOffset.mul(0.6))
                            .toVar();
                        const c = gnoise(cuv.mul(1.4))
                            .mul(0.5)
                            .add(gnoise(cuv.mul(3.1).add(4)).mul(0.25));
                        const cirrus = smoothstep(0.1, 0.6, c)
                            .mul(float(1).sub(alpha))
                            .mul(smoothstep(0.02, 0.25, dy))
                            .mul(clamp(u.cloudCoverage.mul(2), 0, 1))
                            .mul(float(1).sub(u.overcast));
                        color.addAssign(
                            sunLight
                                .mul(sunVis.mul(0.25))
                                .add(ambient.mul(0.8))
                                .mul(cirrus.mul(0.5)),
                        );
                    }
                },
            );
        } else {
            // Overcast with clouds disabled: a flat grey deck.
            color.assign(
                mix(
                    color,
                    vec3(0.75, 0.8, 1).mul(u.flash.mul(0.4)).add(u.deckColor),
                    u.overcast.mul(smoothstep(-0.02, 0.1, direction.y)),
                ),
            );
        }

        // Lightning brightens the whole sky a little.
        color.addAssign(
            vec3(0.55, 0.6, 0.8).mul(u.flash.mul(0.12).mul(u.overcast.add(1))),
        );

        // Horizon band that matches the scene fog so distant terrain melts into the sky.
        const band = exp(
            abs(direction.y)
                .negate()
                .mul(mix(14, 3, u.horizonFog.mul(u.horizonFog))),
        );
        color.assign(
            mix(color, u.horizonColor, clamp(u.horizonFog.mul(band), 0, 1)),
        );
        // Below the horizon: fog colour (never the black lower hemisphere).
        color.assign(
            mix(color, u.horizonColor, smoothstep(0, -0.08, direction.y)),
        );

        return vec4(color, 1);
    })();
}
