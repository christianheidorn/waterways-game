import * as THREE from 'three/webgpu';
import type { AgentRequestSummary } from '../shared/types';
import type { Heightfield } from '../world/Heightfield';

type Point = { x: number; z: number };

const DRAFT_COLOR = 0x4fd8ff;
const STATUS_COLORS: Record<AgentRequestSummary['status'], number> = {
    open: 0xff9f1c,
    in_progress: 0xffd23f,
    needs_input: 0xff4fd8,
    done: 0x5ee07a,
    dismissed: 0x888888,
};

/**
 * Outlines of build requests for agents, draped over the terrain: the one being drawn (Request tool)
 * and the map's existing requests, coloured by status.
 */
export class RequestOverlay {
    readonly group = new THREE.Group();
    private draft: THREE.Object3D | null = null;
    private saved: THREE.Object3D[] = [];

    constructor(private readonly heights: () => Heightfield) {
        this.group.name = 'RequestOverlay';
        this.group.renderOrder = 20;
    }

    setDraft(points: Point[]): void {
        this.dispose(this.draft);
        this.draft = points.length
            ? this.outline(points, DRAFT_COLOR, points.length >= 3, true)
            : null;

        if (this.draft) {
            this.group.add(this.draft);
        }
    }

    setRequests(requests: AgentRequestSummary[]): void {
        for (const o of this.saved) {
            this.dispose(o);
        }

        this.saved = requests
            .filter((r) => r.status !== 'dismissed' && r.area.length >= 3)
            .map((r) =>
                this.outline(r.area, STATUS_COLORS[r.status], true, false),
            );
        if (this.saved.length) {
            this.group.add(...this.saved);
        }
    }

    setVisible(visible: boolean): void {
        this.group.visible = visible;
    }

    private outline(
        points: Point[],
        color: number,
        closed: boolean,
        markers: boolean,
    ): THREE.Object3D {
        const hf = this.heights();
        const ground = (x: number, z: number) =>
            (hf.contains(x, z) ? hf.sample(x, z) : 0) + 1.2;
        const verts: number[] = [];
        const ring = closed ? [...points, points[0]] : points;

        // Follow the terrain between the corners (a sample every ~2 cells).
        for (let i = 0; i + 1 < ring.length; i++) {
            const a = ring[i];
            const b = ring[i + 1];
            const steps = Math.max(
                1,
                Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / (hf.cell * 2)),
            );

            for (let k = 0; k < steps; k++) {
                const x = a.x + ((b.x - a.x) * k) / steps;
                const z = a.z + ((b.z - a.z) * k) / steps;
                verts.push(x, ground(x, z), z);
            }
        }

        const last = ring[ring.length - 1];
        verts.push(last.x, ground(last.x, last.z), last.z);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
            'position',
            new THREE.Float32BufferAttribute(verts, 3),
        );
        const material = new THREE.LineBasicNodeMaterial({
            color,
            depthTest: false,
            transparent: true,
        });
        const line = new THREE.Line(geometry, material);
        line.renderOrder = 20;
        line.frustumCulled = false;

        if (!markers) {
            return line;
        }

        const group = new THREE.Group();
        group.add(line);
        const dot = new THREE.SphereGeometry(1, 10, 8);
        const dotMaterial = new THREE.MeshBasicNodeMaterial({
            color,
            depthTest: false,
            transparent: true,
        });

        for (const p of points) {
            const m = new THREE.Mesh(dot, dotMaterial);
            m.position.set(p.x, ground(p.x, p.z), p.z);
            m.scale.setScalar(Math.max(1, hf.cell * 0.4));
            m.renderOrder = 21;
            group.add(m);
        }

        return group;
    }

    private dispose(object: THREE.Object3D | null): void {
        if (!object) {
            return;
        }

        this.group.remove(object);
        const materials = new Set<THREE.Material>();
        const geometries = new Set<THREE.BufferGeometry>();

        object.traverse((o) => {
            const mesh = o as THREE.Mesh;

            if (mesh.geometry) {
                geometries.add(mesh.geometry);
            }

            if (mesh.material) {
                materials.add(mesh.material as THREE.Material);
            }
        });
        geometries.forEach((g) => g.dispose());
        materials.forEach((m) => m.dispose());
    }
}
