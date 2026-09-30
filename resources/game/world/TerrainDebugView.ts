import * as THREE from 'three/webgpu';
import {
    abs,
    clamp,
    dot,
    float,
    floor,
    Fn,
    fract,
    fwidth,
    If,
    log,
    max,
    min,
    mix,
    mod,
    normalize,
    normalWorldGeometry,
    positionWorld,
    select,
    smoothstep,
    uniform,
    uniformArray,
    vec2,
    vec3,
    vec4,
} from 'three/tsl';

/**
 * Editor view modes of the terrain (like Unreal's viewport view modes). `lit` is the normal
 * rendering and `lighting` shades everything with a neutral grey albedo; the other modes replace the
 * terrain's lit colour with an unlit visualisation (readable at night, not fogged).
 */
export type TerrainViewMode =
    | 'lit'
    | 'lighting'
    | 'layers'
    | 'slope'
    | 'height'
    | 'density'
    | 'wireframe'
    | 'collision';

/** Shader value of each mode (the `uView` uniform); unlit visualisations are ≥ 2. */
const VIEW_INDEX: Record<TerrainViewMode, number> = {
    lit: 0,
    lighting: 1,
    layers: 2,
    slope: 3,
    height: 4,
    density: 5,
    wireframe: 6,
    // Lit terrain; the colliders are drawn on top (world/collision/CollisionDebug).
    collision: 0,
};

/** Albedo of the lighting-only view (linear; a mid grey like Unreal's). */
export const LIGHTING_ONLY_ALBEDO = 0.5;

/** Distinct colour per terrain layer slot (layers view). */
export const LAYER_VIEW_COLORS = [
    '#e6194b',
    '#3cb44b',
    '#ffe119',
    '#4363d8',
    '#f58231',
    '#911eb4',
    '#42d4f4',
    '#f032e6',
];

export type RampStop = { at: number; color: string };

/** Slope view: steepness in degrees. */
export const SLOPE_STOPS: RampStop[] = [
    { at: 0, color: '#2f9e44' },
    { at: 15, color: '#a9d344' },
    { at: 30, color: '#f5c542' },
    { at: 45, color: '#e8452c' },
    { at: 60, color: '#9c2f96' },
];

/** Height view: hypsometric tints over the normalised height range (evenly spaced, like the legend). */
export const HEIGHT_STOPS: RampStop[] = [
    { at: 0, color: '#1f6f8b' },
    { at: 0.2, color: '#3a9d5d' },
    { at: 0.4, color: '#c9d46a' },
    { at: 0.6, color: '#b9793c' },
    { at: 0.8, color: '#8a6a58' },
    { at: 1, color: '#f4f1ec' },
];

/** Foliage density view: instances per 100 m², on a log10 scale (the first stop is "none"). */
export const DENSITY_STOPS: RampStop[] = [
    { at: 0, color: '#1c2033' },
    { at: 1, color: '#2d5fd0' },
    { at: 10, color: '#18b5a4' },
    { at: 100, color: '#f2d23b' },
    { at: 1000, color: '#e8412c' },
];

/** Log10 position of a density stop (0 maps a decade below the first non-zero stop). */
function densityPosition(value: number): number {
    return Math.log10(Math.max(value, 0.1));
}

/** Largest grid of the density view (cells per side). */
const DENSITY_MAX_RES = 512;

/** Target size of a density cell (m). */
const DENSITY_CELL = 8;

type Float = THREE.Node<'float'>;
type Vec3 = THREE.Node<'vec3'>;

/** Constant colour from sRGB hex (linear in the shader, displayed as the hex after the output). */
function hexColor(hex: string): Vec3 {
    const c = new THREE.Color(hex);

    return vec3(c.r, c.g, c.b);
}

/** Piecewise-linear colour ramp over constant stops. */
function ramp(t: Float, stops: RampStop[], position = (v: number) => v): Vec3 {
    let c: Vec3 = hexColor(stops[0].color);

    for (let i = 1; i < stops.length; i++) {
        const a = position(stops[i - 1].at);
        const b = position(stops[i].at);
        c = mix(c, hexColor(stops[i].color), clamp(t.sub(a).div(b - a), 0, 1));
    }

    return c;
}

/**
 * Coarse foliage density grid over the whole map (instances per 100 m² per cell), shown by the
 * density view. The data is filled on demand by the caller (see Foliage.countInstances).
 */
export class DensityGrid {
    readonly res: number;
    /** World position of the grid's north-west corner. */
    readonly x0: number;
    readonly z0: number;
    /** Cell size (m). */
    readonly cell: number;
    /** Instance counts per cell (row-major, row = z). */
    readonly counts: Float32Array;
    readonly texture: THREE.DataTexture;
    private readonly half: Uint16Array;

    constructor(size: number) {
        this.res = Math.min(DENSITY_MAX_RES, Math.ceil(size / DENSITY_CELL));
        this.cell = size / this.res;
        this.x0 = this.z0 = -size / 2;
        this.counts = new Float32Array(this.res * this.res);
        this.half = new Uint16Array(this.res * this.res);
        this.texture = new THREE.DataTexture(
            this.half,
            this.res,
            this.res,
            THREE.RedFormat,
            THREE.HalfFloatType,
        );
        this.texture.magFilter = THREE.LinearFilter;
        this.texture.minFilter = THREE.LinearFilter;
        this.texture.needsUpdate = true;
    }

    /** Converts the counts to densities and uploads them. */
    upload(): void {
        const per100 = 100 / (this.cell * this.cell);

        for (let i = 0; i < this.counts.length; i++) {
            this.half[i] = THREE.DataUtils.toHalfFloat(
                Math.min(60000, this.counts[i] * per100),
            );
        }

        this.texture.needsUpdate = true;
    }

    dispose(): void {
        this.texture.dispose();
    }
}

/** Inputs the debug views share with the terrain material. */
export type TerrainDebugInputs = {
    splat0: THREE.Node<'vec4'>;
    splat1: THREE.Node<'vec4'>;
    /** Per-slot layer flags (x = slot enabled). */
    mat: THREE.UniformArrayNode<'vec4'>;
    mapHalf: Float;
    /** Height sample spacing (m). */
    cell: Float;
    /** The density grid's texture (see DensityGrid). */
    density: THREE.TextureNode;
};

/**
 * Uniforms and nodes of the terrain view modes. Switching modes only changes uniform values: every
 * view is compiled into the terrain shader once (behind a uniform branch, so the lit view pays
 * nothing for them).
 */
export class TerrainDebugView {
    readonly density: DensityGrid;
    /** Current mode (VIEW_INDEX). */
    private readonly view = uniform(0);
    /** Height view: x = min, y = max, z = band step (m). */
    private readonly heightRange = uniform(new THREE.Vector3(0, 100, 10));
    private readonly layerColors = uniformArray<'color'>(
        LAYER_VIEW_COLORS.map((c) => new THREE.Color(c)),
        'color',
    );
    /**
     * Vertex spacing of the drawn terrain node in height samples (its LOD), read per draw from the
     * mesh (Terrain sets `userData.lodStride`).
     */
    private readonly lodStride = uniform(1).onObjectUpdate(
        ({ object }) => (object?.userData.lodStride as number | undefined) ?? 1,
    );

    constructor(size: number) {
        this.density = new DensityGrid(size);
    }

    setMode(mode: TerrainViewMode): void {
        this.view.value = VIEW_INDEX[mode];
    }

    setHeightRange(min: number, max: number, step: number): void {
        this.heightRange.value.set(min, max, step);
    }

    /** Surface albedo with the lighting-only override applied. */
    albedo(surface: Vec3): Vec3 {
        return select(
            this.view.equal(VIEW_INDEX.lighting),
            vec3(LIGHTING_ONLY_ALBEDO),
            surface,
        );
    }

    /**
     * Final colour: the lit result, or the unlit visualisation of the current view plus the editor
     * overlays (brush, grid).
     */
    output(
        lit: THREE.Node<'vec4'>,
        overlay: Vec3,
        inputs: TerrainDebugInputs,
    ): THREE.Node<'vec4'> {
        return Fn(() => {
            const result = lit.toVar();

            If(this.view.greaterThanEqual(VIEW_INDEX.layers), () => {
                result.assign(vec4(this.visualisation(inputs).add(overlay), 1));
            });

            return result;
        })();
    }

    dispose(): void {
        this.density.dispose();
    }

    private visualisation(inputs: TerrainDebugInputs): Vec3 {
        const view = this.view;
        const wp = positionWorld.xz.toVar();
        const N = normalize(normalWorldGeometry).toVar();
        // Fixed-light hillshade keeps the relief readable in the flat colours.
        const shade = max(dot(N, normalize(vec3(-0.45, 0.8, -0.35))), 0)
            .mul(0.4)
            .add(0.6)
            .toVar();
        const color = vec3(0).toVar();

        If(view.equal(VIEW_INDEX.layers), () => {
            color.assign(this.layers(inputs));
        })
            .ElseIf(view.equal(VIEW_INDEX.slope), () => {
                const deg = N.y
                    .clamp(-1, 1)
                    .acos()
                    .mul(180 / Math.PI);
                color.assign(ramp(deg, SLOPE_STOPS));
            })
            .ElseIf(view.equal(VIEW_INDEX.height), () => {
                color.assign(this.height());
            })
            .ElseIf(view.equal(VIEW_INDEX.density), () => {
                const d = this.density;
                const uv = wp
                    .sub(vec2(d.x0, d.z0))
                    .div(d.res * d.cell)
                    .toVar();
                const perArea = inputs.density.sample(uv).x;
                const pos = log(max(perArea, 0.1)).div(Math.LN10);
                color.assign(ramp(pos, DENSITY_STOPS, densityPosition));
            })
            .Else(() => {
                color.assign(this.wireframe(inputs, wp));
            });

        return color.mul(shade);
    }

    /** Each layer in its own colour, blended by paint weight (enabled layers only). */
    private layers(inputs: TerrainDebugInputs): Vec3 {
        const s0 = inputs.splat0;
        const s1 = inputs.splat1;
        const weights = [s0.x, s0.y, s0.z, s0.w, s1.x, s1.y, s1.z, s1.w];
        let sum: Vec3 = vec3(0);
        let total: Float = float(0);

        weights.forEach((w, i) => {
            const k = w.mul(inputs.mat.element(i).x);
            sum = sum.add(this.layerColors.element(i).mul(k));
            total = total.add(k);
        });

        // Unpainted ground: dark grey.
        return select(
            total.greaterThan(1e-3),
            sum.div(max(total, 1e-3)),
            vec3(0.08),
        );
    }

    /** Hypsometric bands with contour lines at every step (every fifth one stronger). */
    private height(): Vec3 {
        const r = this.heightRange;
        const h = positionWorld.y.toVar();
        const bands = h.div(r.z).toVar();
        const band = floor(bands);
        const t = band
            .add(0.5)
            .mul(r.z)
            .sub(r.x)
            .div(max(r.y.sub(r.x), 1e-3));
        const f = fract(bands);
        const edge = min(f, float(1).sub(f)).div(max(fwidth(bands), 1e-5));
        const major = mod(floor(bands.add(0.5)), 5).equal(0);
        const width = select(major, float(1.4), float(0.7));
        const line = float(1).sub(smoothstep(width.mul(0.5), width, edge));

        return ramp(t, HEIGHT_STOPS).mul(
            float(1).sub(line.mul(select(major, float(0.7), float(0.45)))),
        );
    }

    /**
     * The drawn triangles: grid lines at the node's vertex spacing plus each quad's diagonal, which
     * alternates in a checkerboard like the terrain's index buffers (see Terrain.buildIndices).
     */
    private wireframe(
        inputs: TerrainDebugInputs,
        wp: THREE.Node<'vec2'>,
    ): Vec3 {
        const g = wp
            .add(inputs.mapHalf)
            .div(inputs.cell.mul(this.lodStride))
            .toVar();
        const f = fract(g).toVar();
        const edge = min(f, vec2(1).sub(f)).div(max(fwidth(g), vec2(1e-5)));
        const grid = float(1).sub(smoothstep(0.4, 1.1, min(edge.x, edge.y)));
        const parity = mod(floor(g.x).add(floor(g.y)), 2);
        const d = select(
            parity.lessThan(0.5),
            f.x.add(f.y).sub(1),
            f.x.sub(f.y),
        ).toVar();
        const diag = float(1).sub(
            smoothstep(0.4, 1.1, abs(d).div(max(fwidth(d), 1e-5))),
        );
        const line = max(grid, diag.mul(0.8));

        return mix(vec3(0.16, 0.18, 0.2), vec3(0.45, 0.9, 1), line);
    }
}
