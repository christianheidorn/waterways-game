/**
 * Buoyancy of floating props (docs/ROADMAP.md phase 13), free of rendering so it can be tested. A
 * floating body samples the water at its centre and four points of its footprint every step: the mean
 * height sets how high it floats (its draft below), the differences tilt it (pitch / roll), the water's
 * velocity (wave orbits, river current) drags it along, and points over dry land or shallows push it
 * back off the shore. Springs are underdamped, so it bobs and rocks a little after every push.
 */

/** The water at a point: surface height (with waves), its velocity, and the depth to the bed (m). */
export type WaterProbe = (
    x: number,
    z: number,
) => { height: number; vx: number; vz: number; depth: number } | null;

type ProbeResult = ReturnType<WaterProbe>;

export type FloatBody = {
    x: number;
    z: number;
    /** Height of the model's base (its local y = 0). */
    y: number;
    vx: number;
    vz: number;
    vy: number;
    yaw: number;
    yawRate: number;
    /** Tilt about the body's local x axis (raises its +z end when negative) and z axis (raises +x). */
    pitch: number;
    roll: number;
    pitchRate: number;
    rollRate: number;
    /** Footprint half sizes along the local x / z axes and the height (m). */
    halfX: number;
    halfZ: number;
    height: number;
    /** Share of the height under water (PropBuoyancy.density). */
    density: number;
    /** The saved position (where an anchored body is held and a returning one goes back to). */
    anchorX: number;
    anchorZ: number;
    anchorYaw: number;
    /** Extra height (m) the author gave the prop (PropInstance.offset). */
    offset: number;
    /** Resting on the bed or the shore (too shallow to float) at the last step. */
    grounded: boolean;
};

export type FloatOptions = {
    /** Free drift (currents, wind, pushes) instead of being held at the anchor. */
    drift: boolean;
    /** Wind (m/s, the direction it blows towards) for the part above the water. */
    windX: number;
    windZ: number;
    /** Ground height where there is no water (the body rests there). */
    groundAt: (x: number, z: number) => number;
};

/** Largest tilt (radians) the waves give a body. */
export const MAX_TILT = 0.5;
/** Share of the wind speed a floating body drifts at (windage), for a body floating high. */
export const WINDAGE = 0.035;

export function createFloatBody(
    x: number,
    z: number,
    yaw: number,
    halfX: number,
    halfZ: number,
    height: number,
    density: number,
    offset = 0,
): FloatBody {
    return {
        x,
        z,
        y: Number.NaN,
        vx: 0,
        vz: 0,
        vy: 0,
        yaw,
        yawRate: 0,
        pitch: 0,
        roll: 0,
        pitchRate: 0,
        rollRate: 0,
        halfX: Math.max(0.05, halfX),
        halfZ: Math.max(0.05, halfZ),
        height: Math.max(0.02, height),
        density: Math.min(0.95, Math.max(0.05, density)),
        anchorX: x,
        anchorZ: z,
        anchorYaw: yaw,
        offset,
        grounded: false,
    };
}

/** How far below the surface the base floats (m). */
export function draft(b: FloatBody): number {
    return b.density * b.height;
}

/** Natural bobbing frequency (rad/s): small things bob fast, big ones slowly. */
export function bobFrequency(b: FloatBody): number {
    const size = Math.max(b.halfX, b.halfZ) * 2;

    return (Math.PI * 2 * 0.9) / Math.sqrt(Math.max(0.5, size));
}

/**
 * Advances a floating body by `dt` (s). Returns false when there is no water under it at all (it then
 * rests on the ground, upright).
 */
export function stepFloat(
    b: FloatBody,
    dt: number,
    probe: WaterProbe,
    o: FloatOptions,
): boolean {
    dt = Math.min(dt, 0.05);
    const cos = Math.cos(b.yaw);
    const sin = Math.sin(b.yaw);
    // Local +x → (cos, −sin), local +z → (sin, cos) (three.js rotation about +Y).
    const ax = b.halfX * 0.8;
    const az = b.halfZ * 0.8;
    const centre = probe(b.x, b.z);
    const px = probe(b.x + cos * ax, b.z - sin * ax);
    const nx = probe(b.x - cos * ax, b.z + sin * ax);
    const pz = probe(b.x + sin * az, b.z + cos * az);
    const nz = probe(b.x - sin * az, b.z - cos * az);

    if (!centre) {
        // On land: rest on the ground, upright, sliding to a stop.
        b.y = o.groundAt(b.x, b.z) + b.offset;
        b.vy = 0;
        b.vx *= Math.exp(-dt * 6);
        b.vz *= Math.exp(-dt * 6);
        b.pitch *= Math.exp(-dt * 6);
        b.roll *= Math.exp(-dt * 6);
        b.grounded = true;
        b.x += b.vx * dt;
        b.z += b.vz * dt;

        return false;
    }

    const h = (p: ProbeResult) => (p ? p.height : centre.height - 0.05);
    const surface = (centre.height * 2 + h(px) + h(nx) + h(pz) + h(nz)) / 6;
    const d = draft(b);
    const bed = centre.height - centre.depth;
    // Too shallow to float: it sits on the bed (and tilts with it less).
    const floatY = surface - d + b.offset;
    const targetY = Math.max(floatY, bed + b.offset);
    b.grounded = floatY < bed + b.offset;

    if (Number.isNaN(b.y)) {
        b.y = targetY;
    }

    const w = bobFrequency(b);
    // Underdamped spring: bobs after a disturbance (damping ratio ~0.35).
    b.vy += ((targetY - b.y) * w * w - b.vy * 2 * 0.35 * w) * dt;
    b.y += b.vy * dt;

    // Tilt with the waves (slope across the footprint).
    const targetRoll = clamp(
        Math.atan2(h(px) - h(nx), 2 * ax),
        -MAX_TILT,
        MAX_TILT,
    );
    const targetPitch = clamp(
        -Math.atan2(h(pz) - h(nz), 2 * az),
        -MAX_TILT,
        MAX_TILT,
    );
    const wt = w * 1.2;
    const groundedK = b.grounded ? 0.3 : 1;
    b.rollRate +=
        ((targetRoll * groundedK - b.roll) * wt * wt -
            b.rollRate * 2 * 0.3 * wt) *
        dt;
    b.pitchRate +=
        ((targetPitch * groundedK - b.pitch) * wt * wt -
            b.pitchRate * 2 * 0.3 * wt) *
        dt;
    b.roll += b.rollRate * dt;
    b.pitch += b.pitchRate * dt;

    // Horizontal: dragged towards the water's velocity (plus windage), or held at the anchor.
    const flowX = (centre.vx * 2 + vx(px) + vx(nx) + vx(pz) + vx(nz)) / 6;
    const flowZ = (centre.vz * 2 + vz(px) + vz(nx) + vz(pz) + vz(nz)) / 6;
    const above = 1 - b.density;
    let fx: number;
    let fz: number;

    if (o.drift) {
        const drag = 0.9;
        fx = (flowX + o.windX * WINDAGE * above * 2 - b.vx) * drag;
        fz = (flowZ + o.windZ * WINDAGE * above * 2 - b.vz) * drag;
    } else {
        // Moored: a spring to the anchor; the waves still sway it a little.
        fx = (b.anchorX - b.x) * 3 - b.vx * 2.5 + (flowX - b.vx) * 0.3;
        fz = (b.anchorZ - b.z) * 3 - b.vz * 2.5 + (flowZ - b.vz) * 0.3;
    }

    // Shore: footprint points over land or shallower than the draft push the body away from them.
    const push = (p: ProbeResult, dx: number, dz: number) => {
        const shallow = p ? Math.max(0, d - p.depth) / Math.max(d, 0.05) : 1;

        if (shallow > 0) {
            fx -= dx * shallow * 6;
            fz -= dz * shallow * 6;
        }
    };
    push(px, cos, -sin);
    push(nx, -cos, sin);
    push(pz, sin, cos);
    push(nz, -sin, -cos);

    if (b.grounded) {
        // Friction on the bed.
        fx -= b.vx * 4;
        fz -= b.vz * 4;
    }

    b.vx += fx * dt;
    b.vz += fz * dt;
    b.x += b.vx * dt;
    b.z += b.vz * dt;

    // Turning: shear in the flow across the footprint, or back to the anchor's heading when moored.
    const shear = (vz(px) - vz(nx)) / (2 * ax) - (vx(pz) - vx(nz)) / (2 * az);
    const yawTarget = o.drift ? 0 : wrapAngle(b.anchorYaw - b.yaw) * 2;
    b.yawRate += (shear * 0.25 + yawTarget - b.yawRate * 1.2) * dt;
    b.yaw += b.yawRate * dt;

    return true;
}

/** Pushes `b` with a horizontal velocity change (m/s), e.g. the player walking or swimming into it. */
export function pushFloat(b: FloatBody, dvx: number, dvz: number): void {
    // Heavier (bigger, lower floating) bodies give way less.
    const mass = Math.max(0.3, b.halfX * b.halfZ * 4 * b.height * b.density);
    const k = 1 / (1 + mass * 0.5);
    b.vx += dvx * k;
    b.vz += dvz * k;
    // A push off-centre also rocks it a little.
    b.rollRate += (Math.random() - 0.5) * k * 0.6;
}

/**
 * Separates two floating bodies whose footprint circles overlap (simple: circles of the larger half
 * size), exchanging some velocity along the contact.
 */
export function collideFloats(a: FloatBody, b: FloatBody): boolean {
    const ra = Math.max(a.halfX, a.halfZ) * 0.85;
    const rb = Math.max(b.halfX, b.halfZ) * 0.85;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const dist = Math.hypot(dx, dz);
    const overlap = ra + rb - dist;

    if (overlap <= 0) {
        return false;
    }

    const nx = dist > 1e-4 ? dx / dist : 1;
    const nz = dist > 1e-4 ? dz / dist : 0;
    a.x -= nx * overlap * 0.5;
    a.z -= nz * overlap * 0.5;
    b.x += nx * overlap * 0.5;
    b.z += nz * overlap * 0.5;
    const rel = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;

    if (rel < 0) {
        const j = rel * 0.6;
        a.vx += nx * j;
        a.vz += nz * j;
        b.vx -= nx * j;
        b.vz -= nz * j;
    }

    return true;
}

function vx(p: { vx: number } | null): number {
    return p ? p.vx : 0;
}

function vz(p: { vz: number } | null): number {
    return p ? p.vz : 0;
}

function clamp(v: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, v));
}

function wrapAngle(a: number): number {
    return Math.atan2(Math.sin(a), Math.cos(a));
}
