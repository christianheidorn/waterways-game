import * as THREE from 'three/webgpu';
import type { RiverSpline, RoadSpline, SplinePoint } from '../../shared/types';
import type { Heightfield } from '../../world/Heightfield';
import { dist, sampleSpline } from '../../world/Splines';
import type { Splines } from '../../world/Splines';

export type SplineKind = 'road' | 'river';

/** What the tool asks the editor to do (the editor runs it as one undo step). */
export type SplineToolActions = {
    create: (kind: SplineKind, points: SplinePoint[]) => string | null;
    setPoints: (id: string, points: SplinePoint[]) => void;
    remove: (id: string) => void;
    changed: () => void;
};

/**
 * Drawing and editing splines (roads in the Roads tool, rivers in the Water tool) in the viewport:
 * click to add points of a new course, Enter builds it; click a course to select it, drag its points,
 * Shift+click on it inserts a point, Ctrl+click a point removes it. Draws the courses, the selected
 * one's handles and the course being drawn.
 */
export class SplineTool {
    kind: SplineKind = 'road';
    /** Points of the course being drawn. */
    draft: SplinePoint[] = [];
    selected: string | null = null;
    private drag: {
        index: number;
        points: SplinePoint[];
        moved: boolean;
    } | null = null;
    private readonly group = new THREE.Group();
    private readonly lines: THREE.Line[] = [];
    private readonly handles: THREE.Mesh[] = [];
    private readonly handleGeometry = new THREE.SphereGeometry(1, 12, 8);
    private readonly handleMaterial = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        depthTest: false,
        transparent: true,
        opacity: 0.95,
    });
    private readonly activeHandleMaterial = new THREE.MeshBasicMaterial({
        color: 0xffc83d,
        depthTest: false,
        transparent: true,
        opacity: 0.95,
    });
    private stale = true;
    private visible = false;
    private hoverHandle = -1;

    constructor(
        scene: THREE.Scene,
        private readonly heights: () => Heightfield,
        private readonly store: Splines,
        private readonly camera: THREE.Camera,
        private readonly actions: SplineToolActions,
    ) {
        this.group.name = 'SplineTool';
        this.group.renderOrder = 12;
        scene.add(this.group);
        const previous = store.onChange;
        store.onChange = () => {
            previous?.();
            this.stale = true;

            if (this.selected && !store.get(this.selected)) {
                this.selected = null;
                this.actions.changed();
            }
        };
    }

    /** Shows the tool for a kind of spline (or hides it). */
    setActive(kind: SplineKind | null): void {
        const visible = kind !== null;

        if (kind && kind !== this.kind) {
            this.kind = kind;
            this.draft = [];
            this.selected = null;
            this.stale = true;
        }

        if (visible !== this.visible) {
            this.visible = visible;
            this.group.visible = visible;
            this.stale = true;
        }

        if (!visible) {
            this.drag = null;
        }
    }

    select(id: string | null): void {
        this.selected = id;
        this.draft = [];
        this.stale = true;
        this.actions.changed();
    }

    /** Builds the course drawn so far (Enter / the panel's button). */
    finish(): boolean {
        if (this.draft.length < 2) {
            return false;
        }

        const points = this.draft;
        this.draft = [];
        this.stale = true;
        const id = this.actions.create(this.kind, points);

        if (id) {
            this.selected = id;
        }

        this.actions.changed();

        return id !== null;
    }

    cancel(): void {
        if (this.draft.length) {
            this.draft = [];
        } else {
            this.selected = null;
        }

        this.stale = true;
        this.actions.changed();
    }

    undoPoint(): void {
        if (this.draft.length) {
            this.draft = this.draft.slice(0, -1);
            this.stale = true;
            this.actions.changed();
        }
    }

    /** Mouse down on the terrain at `cursor`. */
    pointerDown(cursor: THREE.Vector3, shift: boolean, ctrl: boolean): void {
        const spline = this.current();
        const handle = spline ? this.handleAt(cursor, spline.points) : -1;

        if (spline && handle >= 0) {
            if (ctrl) {
                if (spline.points.length > 2) {
                    this.actions.setPoints(
                        spline.id,
                        spline.points.filter((_p, i) => i !== handle),
                    );
                }

                return;
            }

            this.drag = {
                index: handle,
                points: spline.points.map((p) => ({ ...p })),
                moved: false,
            };

            return;
        }

        if (spline && shift) {
            const at = this.insertIndex(spline.points, cursor);

            if (at !== null) {
                const points = spline.points.slice();
                points.splice(at, 0, { x: cursor.x, z: cursor.z });
                this.actions.setPoints(spline.id, points);

                return;
            }
        }

        if (!this.draft.length) {
            const hit = this.pick(cursor);

            if (hit) {
                this.select(hit);

                return;
            }

            if (this.selected) {
                // Clicking away from the selection deselects before a new course starts.
                this.select(null);

                return;
            }
        }

        this.draft = [...this.draft, { x: cursor.x, z: cursor.z }];
        this.stale = true;
        this.actions.changed();
    }

    pointerMove(cursor: THREE.Vector3): void {
        const drag = this.drag;

        if (!drag) {
            return;
        }

        const p = drag.points[drag.index];

        if (Math.abs(p.x - cursor.x) + Math.abs(p.z - cursor.z) > 0.05) {
            drag.points[drag.index] = { x: cursor.x, z: cursor.z };
            drag.moved = true;
            this.stale = true;
        }
    }

    pointerUp(): void {
        const drag = this.drag;
        this.drag = null;

        if (drag?.moved && this.selected) {
            this.actions.setPoints(this.selected, drag.points);
        }

        this.stale = true;
    }

    get dragging(): boolean {
        return this.drag !== null;
    }

    /** Redraws the overlay when something changed; highlights the handle under the cursor. */
    update(cursor: THREE.Vector3 | null): void {
        if (!this.visible) {
            return;
        }

        const spline = this.current();
        const hover =
            cursor && spline && !this.drag
                ? this.handleAt(cursor, spline.points)
                : (this.drag?.index ?? -1);

        if (hover !== this.hoverHandle) {
            this.hoverHandle = hover;
            this.stale = true;
        }

        if (this.stale) {
            this.stale = false;
            this.rebuild();
        }

        // Handles keep a constant size on screen.
        const cam = this.camera.position;

        for (const handle of this.handles) {
            handle.scale.setScalar(
                Math.max(0.35, handle.position.distanceTo(cam) * 0.008),
            );
        }
    }

    dispose(): void {
        this.clear();
        this.group.removeFromParent();
        this.handleGeometry.dispose();
        this.handleMaterial.dispose();
        this.activeHandleMaterial.dispose();
    }

    /** The selected spline of the tool's kind. */
    current(): RoadSpline | RiverSpline | null {
        if (!this.selected) {
            return null;
        }

        return this.kind === 'road'
            ? this.store.road(this.selected)
            : this.store.river(this.selected);
    }

    private all(): (RoadSpline | RiverSpline)[] {
        return this.kind === 'road' ? this.store.roads : this.store.rivers;
    }

    /** The spline whose course passes near a point (within its width plus a margin). */
    private pick(cursor: THREE.Vector3): string | null {
        let best: { id: string; d: number } | null = null;

        for (const s of this.all()) {
            const line = sampleSpline(s.points, 3);
            const margin = s.width / 2 + Math.max(2, this.pickRadius(cursor));

            for (let k = 0; k + 1 < line.length; k++) {
                const d = segmentDistance(cursor, line[k], line[k + 1]);

                if (d <= margin && (!best || d < best.d)) {
                    best = { id: s.id, d };
                }
            }
        }

        return best?.id ?? null;
    }

    private pickRadius(cursor: THREE.Vector3): number {
        return Math.max(1.5, cursor.distanceTo(this.camera.position) * 0.02);
    }

    private handleAt(cursor: THREE.Vector3, points: SplinePoint[]): number {
        const r = this.pickRadius(cursor);
        let best = -1;
        let bestD = r;

        points.forEach((p, i) => {
            const d = dist(p, cursor);

            if (d <= bestD) {
                best = i;
                bestD = d;
            }
        });

        return best;
    }

    /** Where a point on the course would be inserted among the control points (null: not near it). */
    private insertIndex(
        points: SplinePoint[],
        cursor: THREE.Vector3,
    ): number | null {
        let best: { k: number; d: number } | null = null;
        const segment = sampleSpline(points, 3);

        for (let k = 0; k + 1 < points.length; k++) {
            // Distance to the curved course between control points k and k + 1.
            const from = nearestIndex(segment, points[k]);
            const to = nearestIndex(segment, points[k + 1]);

            for (let j = from; j < to; j++) {
                const d = segmentDistance(cursor, segment[j], segment[j + 1]);

                if (!best || d < best.d) {
                    best = { k, d };
                }
            }
        }

        const spline = this.current();
        const margin = (spline?.width ?? 4) / 2 + this.pickRadius(cursor);

        return best && best.d <= margin ? best.k + 1 : null;
    }

    private rebuild(): void {
        this.clear();
        const hf = this.heights();
        const y = (p: SplinePoint) =>
            (hf.contains(p.x, p.z) ? hf.sample(p.x, p.z) : 0) + 0.5;

        for (const s of this.all()) {
            const selected = s.id === this.selected;
            const points = selected && this.drag ? this.drag.points : s.points;
            const color =
                this.kind === 'river'
                    ? selected
                        ? 0x7fe8ff
                        : 0x2f9fd8
                    : selected
                      ? 0xffc83d
                      : 0xd89a3f;
            this.addLine(sampleSpline(points, 2), y, color, selected ? 1 : 0.7);

            if (selected) {
                points.forEach((p, i) =>
                    this.addHandle(p, y(p), i === this.hoverHandle),
                );
            }
        }

        if (this.draft.length) {
            this.addLine(sampleSpline(this.draft, 2), y, 0xffffff, 1);
            this.draft.forEach((p) => this.addHandle(p, y(p), false));
        }
    }

    private addLine(
        line: SplinePoint[],
        y: (p: SplinePoint) => number,
        color: number,
        opacity: number,
    ): void {
        if (line.length < 2) {
            return;
        }

        const positions = new Float32Array(line.length * 3);
        line.forEach((p, k) => {
            positions[k * 3] = p.x;
            positions[k * 3 + 1] = y(p);
            positions[k * 3 + 2] = p.z;
        });
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
            'position',
            new THREE.BufferAttribute(positions, 3),
        );
        const object = new THREE.Line(
            geometry,
            new THREE.LineBasicMaterial({
                color,
                depthTest: false,
                transparent: true,
                opacity,
            }),
        );
        object.renderOrder = 12;
        object.frustumCulled = false;
        this.group.add(object);
        this.lines.push(object);
    }

    private addHandle(p: SplinePoint, y: number, active: boolean): void {
        const mesh = new THREE.Mesh(
            this.handleGeometry,
            active ? this.activeHandleMaterial : this.handleMaterial,
        );
        mesh.position.set(p.x, y, p.z);
        mesh.renderOrder = 13;
        this.group.add(mesh);
        this.handles.push(mesh);
    }

    private clear(): void {
        for (const line of this.lines) {
            line.geometry.dispose();
            (line.material as THREE.Material).dispose();
            this.group.remove(line);
        }

        for (const handle of this.handles) {
            this.group.remove(handle);
        }

        this.lines.length = 0;
        this.handles.length = 0;
    }
}

function segmentDistance(
    c: { x: number; z: number },
    p: SplinePoint,
    q: SplinePoint,
): number {
    const dx = q.x - p.x;
    const dz = q.z - p.z;
    const len2 = dx * dx + dz * dz;
    const t =
        len2 > 0
            ? Math.min(
                  1,
                  Math.max(0, ((c.x - p.x) * dx + (c.z - p.z) * dz) / len2),
              )
            : 0;

    return Math.hypot(c.x - (p.x + dx * t), c.z - (p.z + dz * t));
}

function nearestIndex(line: SplinePoint[], p: SplinePoint): number {
    let best = 0;
    let bestD = Infinity;

    line.forEach((q, i) => {
        const d = dist(p, q);

        if (d < bestD) {
            best = i;
            bestD = d;
        }
    });

    return best;
}
