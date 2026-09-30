import type {
    RiverSpline,
    RoadSpline,
    SplinePoint,
    SplinesFile,
} from '../shared/types';

/**
 * The map's editable splines: roads / paths and rivers (maps/{id}/splines.json). They only hold the
 * description and what each one did to the terrain (its footprint); the carving itself lives in
 * editor/splines/splineEdits.ts.
 */
export class Splines {
    /** Called whenever a spline was added, changed or removed (editor overlay, saving). */
    onChange: (() => void) | null = null;
    private roadMap = new Map<string, RoadSpline>();
    private riverMap = new Map<string, RiverSpline>();

    load(file: SplinesFile | null): void {
        this.roadMap = new Map(
            (file?.roads ?? []).map((r) => [r.id, clone(r)]),
        );
        this.riverMap = new Map(
            (file?.rivers ?? []).map((r) => [r.id, clone(r)]),
        );
        this.onChange?.();
    }

    serialize(): SplinesFile {
        return {
            version: 1,
            roads: [...this.roadMap.values()].map(clone),
            rivers: [...this.riverMap.values()].map(clone),
        };
    }

    get roads(): RoadSpline[] {
        return [...this.roadMap.values()];
    }

    get rivers(): RiverSpline[] {
        return [...this.riverMap.values()];
    }

    road(id: string): RoadSpline | null {
        return this.roadMap.get(id) ?? null;
    }

    river(id: string): RiverSpline | null {
        return this.riverMap.get(id) ?? null;
    }

    /** A road or river by id. */
    get(id: string): RoadSpline | RiverSpline | null {
        return this.roadMap.get(id) ?? this.riverMap.get(id) ?? null;
    }

    kindOf(id: string): 'road' | 'river' | null {
        return this.roadMap.has(id)
            ? 'road'
            : this.riverMap.has(id)
              ? 'river'
              : null;
    }

    putRoad(road: RoadSpline): void {
        this.roadMap.set(road.id, road);
        this.onChange?.();
    }

    putRiver(river: RiverSpline): void {
        this.riverMap.set(river.id, river);
        this.onChange?.();
    }

    remove(id: string): boolean {
        const removed = this.roadMap.delete(id) || this.riverMap.delete(id);

        if (removed) {
            this.onChange?.();
        }

        return removed;
    }

    /** A new id with a prefix ("r" roads, "w" rivers) not used yet. */
    newId(prefix: string): string {
        let id = '';

        do {
            id = `${prefix}${Math.random().toString(36).slice(2, 8)}`;
        } while (this.roadMap.has(id) || this.riverMap.has(id));

        return id;
    }

    /** "Road 3" etc.: the next free default name. */
    nextName(base: string): string {
        const names = new Set(
            [...this.roadMap.values(), ...this.riverMap.values()].map(
                (s) => s.name,
            ),
        );
        let n = 1;

        while (names.has(`${base} ${n}`)) {
            n++;
        }

        return `${base} ${n}`;
    }
}

/**
 * The course through a spline's control points: a centripetal Catmull-Rom curve sampled every
 * `step` metres (the control points themselves included).
 */
export function sampleSpline(points: SplinePoint[], step = 2): SplinePoint[] {
    if (points.length < 3) {
        // Two points: a straight line, subdivided so the grade can follow the ground.
        if (points.length < 2) {
            return points.map((p) => ({ ...p }));
        }

        const [a, b] = points;
        const n = Math.max(1, Math.ceil(dist(a, b) / step));

        return Array.from({ length: n + 1 }, (_, i) => ({
            x: a.x + ((b.x - a.x) * i) / n,
            z: a.z + ((b.z - a.z) * i) / n,
        }));
    }

    const out: SplinePoint[] = [{ ...points[0] }];

    for (let k = 0; k + 1 < points.length; k++) {
        const p0 = points[Math.max(0, k - 1)];
        const p1 = points[k];
        const p2 = points[k + 1];
        const p3 = points[Math.min(points.length - 1, k + 2)];
        const n = Math.max(1, Math.ceil(dist(p1, p2) / step));

        for (let i = 1; i <= n; i++) {
            out.push(catmullRom(p0, p1, p2, p3, i / n));
        }
    }

    return out;
}

/** Centripetal Catmull-Rom between p1 and p2 (no loops or cusps at uneven spacing). */
function catmullRom(
    p0: SplinePoint,
    p1: SplinePoint,
    p2: SplinePoint,
    p3: SplinePoint,
    t: number,
): SplinePoint {
    const knot = (a: SplinePoint, b: SplinePoint) =>
        Math.max(1e-4, Math.sqrt(dist(a, b)));
    const t0 = 0;
    const t1 = t0 + knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);
    const u = t1 + (t2 - t1) * t;
    const lerp = (a: SplinePoint, b: SplinePoint, ta: number, tb: number) => {
        const w = tb - ta < 1e-6 ? 0 : (u - ta) / (tb - ta);

        return { x: a.x + (b.x - a.x) * w, z: a.z + (b.z - a.z) * w };
    };
    const a1 = lerp(p0, p1, t0, t1);
    const a2 = lerp(p1, p2, t1, t2);
    const a3 = lerp(p2, p3, t2, t3);
    const b1 = lerp(a1, a2, t0, t2);
    const b2 = lerp(a2, a3, t1, t3);

    return lerp(b1, b2, t1, t2);
}

export function dist(a: SplinePoint, b: SplinePoint): number {
    return Math.hypot(b.x - a.x, b.z - a.z);
}

/** Total length (m) of a polyline. */
export function polylineLength(points: SplinePoint[]): number {
    let length = 0;

    for (let k = 0; k + 1 < points.length; k++) {
        length += dist(points[k], points[k + 1]);
    }

    return length;
}

function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}
