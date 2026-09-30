import type { SplinePoint } from '../shared/types';
import type { Props } from '../world/Props';

/**
 * Prop placement helpers for the Props tool and place_props / update_props: grid snapping, snapping a
 * prop end-to-end onto a neighbour (fence panels, walls) and placing copies along a path (fence posts).
 */

export type Placement = { x: number; z: number; yaw: number };

export function snapToGrid(v: number, size: number): number {
    return size > 0 ? Math.round(v / size) * size : v;
}

/**
 * Puts a prop end-to-end with the nearest prop within reach: along the neighbour's long axis, just
 * touching one of its ends, turned the same way. Null when nothing is close enough.
 */
export function snapToEdges(
    props: Props,
    model: number,
    scale: number,
    x: number,
    z: number,
    exclude: string | null = null,
): Placement | null {
    const self = props.extents(model, scale);
    const selfLength = Math.max(self.maxX - self.minX, self.maxZ - self.minZ);
    let best: (Placement & { d: number }) | null = null;

    for (const q of props.list()) {
        if (q.id === exclude) {
            continue;
        }

        const e = props.extents(q.model, q.scale);
        const reach =
            Math.max(e.maxX - e.minX, e.maxZ - e.minZ) / 2 + selfLength;

        if (Math.hypot(q.x - x, q.z - z) > reach + 1) {
            continue;
        }

        // Long axis of the neighbour, in world space (local x → (cos, −sin), local z → (sin, cos)).
        const alongX = e.maxX - e.minX >= e.maxZ - e.minZ;
        const c = Math.cos(q.yaw);
        const s = Math.sin(q.yaw);
        const axis = alongX ? { x: c, z: -s } : { x: s, z: c };
        const [qMin, qMax] = alongX ? [e.minX, e.maxX] : [e.minZ, e.maxZ];
        const [sMin, sMax] = alongX
            ? [self.minX, self.maxX]
            : [self.minZ, self.maxZ];

        for (const offset of [qMax - sMin, qMin - sMax]) {
            const px = q.x + axis.x * offset;
            const pz = q.z + axis.z * offset;
            const d = Math.hypot(px - x, pz - z);

            if (d <= Math.max(1, selfLength * 0.6) && (!best || d < best.d)) {
                best = { x: px, z: pz, yaw: q.yaw, d };
            }
        }
    }

    return best ? { x: best.x, z: best.z, yaw: best.yaw } : null;
}

/**
 * Positions every `spacing` metres along a polyline (both ends included), each turned so the model's
 * long axis follows the line.
 */
export function placementsAlong(
    props: Props,
    model: number,
    scale: number,
    points: SplinePoint[],
    spacing: number | null,
): Placement[] {
    const e = props.extents(model, scale);
    const alongX = e.maxX - e.minX >= e.maxZ - e.minZ;
    const length = alongX ? e.maxX - e.minX : e.maxZ - e.minZ;
    const step = Math.max(0.2, spacing ?? length);
    const out: Placement[] = [];
    const yawFor = (dx: number, dz: number) =>
        alongX ? Math.atan2(-dz, dx) : Math.atan2(dx, dz);
    let carry = 0;

    for (let k = 0; k + 1 < points.length; k++) {
        const p = points[k];
        const q = points[k + 1];
        const dx = q.x - p.x;
        const dz = q.z - p.z;
        const len = Math.hypot(dx, dz);

        if (len < 1e-6) {
            continue;
        }

        const yaw = normalize(yawFor(dx, dz));

        for (let t = carry; t <= len + 1e-6; t += step) {
            out.push({ x: p.x + (dx * t) / len, z: p.z + (dz * t) / len, yaw });

            if (out.length >= 2000) {
                return out;
            }
        }

        // Keep the spacing even around corners.
        const used = Math.floor((len - carry) / step) * step + carry;
        carry = step - (len - used);
    }

    // The last point, unless a copy already stands there.
    const last = points[points.length - 1];
    const tail = out[out.length - 1];

    if (
        points.length > 1 &&
        (!tail || Math.hypot(tail.x - last.x, tail.z - last.z) > step * 0.5)
    ) {
        const prev = points[points.length - 2];
        out.push({
            x: last.x,
            z: last.z,
            yaw: normalize(yawFor(last.x - prev.x, last.z - prev.z)),
        });
    }

    return out;
}

function normalize(rad: number): number {
    const full = Math.PI * 2;

    return ((rad % full) + full) % full;
}
