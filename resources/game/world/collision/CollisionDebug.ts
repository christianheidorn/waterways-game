import * as THREE from 'three/webgpu';
import type { Collider, CollisionWorld } from './Collision';

/** Colliders within this distance (m) of the camera are drawn. */
const RADIUS = 40;
/** Redraw after the camera moved this far (m), or at least this often (s). */
const MOVE = 2;
const INTERVAL = 0.5;
/** Mesh colliders draw at most this many triangle edges in total. */
const MESH_EDGE_BUDGET = 60_000;

/** Line colours per collider kind (also the view mode's legend). */
export const COLLISION_COLORS = {
    foliage: '#4ade80',
    ground_cover: '#facc15',
    prop: '#fb923c',
    mesh: '#38bdf8',
} as const;

/**
 * The Collision view mode: outlines of the colliders around the camera (trunk cylinders, rock and
 * prop boxes, mesh triangles), drawn through everything.
 */
export class CollisionDebug {
    readonly object: THREE.LineSegments;
    private readonly lastAt = new THREE.Vector3(Infinity, 0, 0);
    private timer = 0;
    private count = 0;

    constructor(private readonly world: CollisionWorld) {
        this.object = new THREE.LineSegments(
            new THREE.BufferGeometry(),
            new THREE.LineBasicMaterial({
                vertexColors: true,
                depthTest: false,
                transparent: true,
                opacity: 0.85,
            }),
        );
        this.object.name = 'Collision debug';
        this.object.frustumCulled = false;
        this.object.renderOrder = 12;
        this.object.visible = false;
    }

    /** Colliders drawn in the last update. */
    get drawn(): number {
        return this.count;
    }

    setVisible(visible: boolean): void {
        this.object.visible = visible;
        this.lastAt.set(Infinity, 0, 0);
    }

    update(dt: number, camera: THREE.Camera): void {
        if (!this.object.visible) {
            return;
        }

        const eye = camera.getWorldPosition(_eye);
        this.timer -= dt;

        if (this.timer > 0 && eye.distanceTo(this.lastAt) < MOVE) {
            return;
        }

        this.timer = INTERVAL;
        this.lastAt.copy(eye);
        const colliders = this.world.gather(
            eye.x - RADIUS,
            eye.z - RADIUS,
            eye.x + RADIUS,
            eye.z + RADIUS,
        );
        const positions: number[] = [];
        const colors: number[] = [];
        let meshEdges = 0;
        this.count = 0;

        for (const c of colliders) {
            if (Math.hypot(c.x - eye.x, c.z - eye.z) > RADIUS + c.radius) {
                continue;
            }

            this.count++;
            const color = _color.set(
                c.shape.kind === 'mesh'
                    ? COLLISION_COLORS.mesh
                    : COLLISION_COLORS[c.info.source],
            );
            const start = positions.length;

            if (c.shape.kind === 'mesh') {
                const edges = c.shape.mesh.edges();

                if (meshEdges + edges.length / 6 > MESH_EDGE_BUDGET) {
                    continue;
                }

                meshEdges += edges.length / 6;

                for (let i = 0; i < edges.length; i += 3) {
                    pushPoint(
                        positions,
                        c,
                        edges[i],
                        edges[i + 1],
                        edges[i + 2],
                    );
                }
            } else if (c.shape.kind === 'cylinder') {
                cylinder(positions, c, c.shape);
            } else {
                const b = c.shape.boxes;

                for (let i = 0; i < b.length; i += 6) {
                    box(positions, c, b, i);
                }
            }

            for (let i = start; i < positions.length; i += 3) {
                colors.push(color.r, color.g, color.b);
            }
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
            'position',
            new THREE.Float32BufferAttribute(positions, 3),
        );
        geometry.setAttribute(
            'color',
            new THREE.Float32BufferAttribute(colors, 3),
        );
        this.object.geometry.dispose();
        this.object.geometry = geometry;
    }

    dispose(): void {
        this.object.geometry.dispose();
        (this.object.material as THREE.Material).dispose();
    }
}

function pushPoint(
    out: number[],
    c: Collider,
    x: number,
    y: number,
    z: number,
): void {
    const s = c.scale;
    out.push(
        c.x + (x * c.cos + z * c.sin) * s,
        c.y + y * s,
        c.z + (-x * c.sin + z * c.cos) * s,
    );
}

function cylinder(
    out: number[],
    c: Collider,
    shape: { radius: number; height: number; cx: number; cz: number },
): void {
    const { radius: r, height: h, cx, cz } = shape;
    const n = 16;

    for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2;
        const a1 = ((i + 1) / n) * Math.PI * 2;

        for (const y of [0, Math.min(h, 3 / c.scale), h]) {
            pushPoint(out, c, cx + Math.cos(a0) * r, y, cz + Math.sin(a0) * r);
            pushPoint(out, c, cx + Math.cos(a1) * r, y, cz + Math.sin(a1) * r);
        }

        if (i % 4 === 0) {
            pushPoint(out, c, cx + Math.cos(a0) * r, 0, cz + Math.sin(a0) * r);
            pushPoint(out, c, cx + Math.cos(a0) * r, h, cz + Math.sin(a0) * r);
        }
    }
}

function box(out: number[], c: Collider, b: Float32Array, i: number): void {
    const x = [b[i], b[i + 3]];
    const y = [b[i + 1], b[i + 4]];
    const z = [b[i + 2], b[i + 5]];

    for (const yy of y) {
        pushPoint(out, c, x[0], yy, z[0]);
        pushPoint(out, c, x[1], yy, z[0]);
        pushPoint(out, c, x[1], yy, z[0]);
        pushPoint(out, c, x[1], yy, z[1]);
        pushPoint(out, c, x[1], yy, z[1]);
        pushPoint(out, c, x[0], yy, z[1]);
        pushPoint(out, c, x[0], yy, z[1]);
        pushPoint(out, c, x[0], yy, z[0]);
    }

    for (const xx of x) {
        for (const zz of z) {
            pushPoint(out, c, xx, y[0], zz);
            pushPoint(out, c, xx, y[1], zz);
        }
    }
}

const _eye = new THREE.Vector3();
const _color = new THREE.Color();
