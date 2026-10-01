import type * as THREE from 'three/webgpu';
import {
    abs,
    cos,
    dot,
    exp,
    float,
    floor,
    fract,
    length,
    max,
    mod,
    pow,
    sin,
    vec2,
    vec3,
} from 'three/tsl';

type Float = THREE.Node<'float'>;
type Vec2 = THREE.Node<'vec2'>;

/** Per-drop hash (Dave Hoskins' hash22). */
export const rippleHash = (p: Vec2): Vec2 => {
    const q = fract(
        vec3(p.x, p.y, p.x).mul(vec3(0.1031, 0.103, 0.0973)),
    ).toVar();
    q.addAssign(dot(q, q.yzx.add(33.33)));

    return fract(vec2(q.x, q.x).add(q.yz).mul(q.zy));
};

/**
 * Expanding rings from rain drops: one drop per cell and layer; returns the slope (d height / d xz).
 * Used by the water surface and by puddles on the terrain.
 */
export const rainRipples = (p: Vec2, t: Float): Vec2 => {
    let slope: Vec2 = vec2(0);

    for (let layer = 0; layer < 3; layer++) {
        const q = p.mul(2.3 + layer * 0.7).add(layer * 17.31);
        const cell = floor(q);
        const f = fract(q);
        const h = rippleHash(cell.add(layer * 3.7));
        const phase = fract(t.mul(1.1 + layer * 0.2).add(h.x.mul(7)));
        const d = f.sub(h.mul(0.4).add(0.3));
        const dist = length(d);
        const x = dist.sub(phase.mul(0.42));
        const fade = phase.oneMinus();
        const ring = sin(x.mul(45))
            .mul(exp(x.mul(x).mul(-500)))
            .mul(fade.mul(fade));
        slope = slope.add(d.div(max(dist, 1e-3)).mul(ring));
    }

    return slope;
};

/**
 * Animated caustic network (0..1, thin bright filaments), tiling every 1 unit of `p`: the classic
 * iterated-warp water caustic (after joltz0r's "Tileable Water Caustic"), four iterations.
 */
export const causticPattern = (p: Vec2, t: Float): Float => {
    const tau = Math.PI * 2;
    const q = mod(p.mul(tau), tau).sub(250).toVar();
    let i: Vec2 = q;
    let c: Float = float(1);
    const inten = 0.005;
    const iterations = 4;

    for (let n = 0; n < iterations; n++) {
        const tt = t.mul(1 - 3.5 / (n + 1));
        i = q
            .add(
                vec2(
                    cos(tt.sub(i.x)).add(sin(tt.add(i.y))),
                    sin(tt.sub(i.y)).add(cos(tt.add(i.x))),
                ),
            )
            .toVar();
        c = c.add(
            float(1).div(
                length(
                    vec2(
                        q.x.div(sin(i.x.add(tt)).div(inten)),
                        q.y.div(cos(i.y.add(tt)).div(inten)),
                    ),
                ),
            ),
        );
    }

    const v = float(1.17).sub(pow(c.div(iterations), 1.4));

    return pow(abs(v), 8).clamp(0, 1);
};
