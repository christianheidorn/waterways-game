import * as THREE from 'three/webgpu';
import {
    abs,
    attribute,
    cameraPosition,
    cross,
    length,
    max,
    mix,
    normalize,
    uniform,
    vec3,
} from 'three/tsl';

const MAX_SEGMENTS = 700;
const MAX_PULSES = 6;

/**
 * Procedural lightning: branching bolts (camera-facing ribbons built by midpoint displacement into
 * preallocated buffers) plus a flash envelope made of a few return-stroke pulses. Weather decides
 * when and where strikes happen; this class only draws them and reports the flash level.
 */
export class Lightning {
    readonly group = new THREE.Group();
    /** Current flash brightness (0 = none). */
    level = 0;
    /** Bolt point in the sky, for the flash direction. */
    readonly origin = new THREE.Vector3();
    private geometry = new THREE.BufferGeometry();
    private starts: Float32Array;
    private ends: Float32Array;
    private widths: Float32Array;
    private core: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicNodeMaterial>;
    private glow: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicNodeMaterial>;
    /** Flash intensity shared by the core and glow ribbons. */
    private readonly intensity = uniform(0);
    private segments = 0;
    private age = 99;
    private pulses = new Float32Array(MAX_PULSES * 2);
    private pulseCount = 0;
    private boltVisible = false;
    // Scratch for generation.
    private readonly a = new THREE.Vector3();
    private readonly b = new THREE.Vector3();

    constructor() {
        this.group.name = 'Lightning';
        const verts = MAX_SEGMENTS * 4;
        this.starts = new Float32Array(verts * 3);
        this.ends = new Float32Array(verts * 3);
        this.widths = new Float32Array(verts);
        const corner = new Float32Array(verts * 2);
        const index = new Uint16Array(MAX_SEGMENTS * 6);

        for (let s = 0; s < MAX_SEGMENTS; s++) {
            const v = s * 4;
            // (side, along) per corner.
            corner.set([-1, 0, 1, 0, 1, 1, -1, 1], v * 2);
            index.set([v, v + 1, v + 2, v, v + 2, v + 3], s * 6);
        }

        const g = this.geometry;
        // `position` holds the corner (side, along); three needs a position attribute to draw.
        g.setAttribute(
            'position',
            new THREE.BufferAttribute(new Float32Array(verts * 3), 3),
        );
        g.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
        g.setAttribute('aStart', new THREE.BufferAttribute(this.starts, 3));
        g.setAttribute('aEnd', new THREE.BufferAttribute(this.ends, 3));
        g.setAttribute('aWidth', new THREE.BufferAttribute(this.widths, 1));
        g.setIndex(new THREE.BufferAttribute(index, 1));
        g.setDrawRange(0, 0);

        this.core = this.createMesh(1, 1, 7);
        this.glow = this.createMesh(7, 0.06, 6);
        this.group.add(this.glow, this.core);
        this.group.visible = false;
    }

    /**
     * Start a strike. `bolt` false = in-cloud flash only (sheet lightning).
     * `ground` is where the bolt lands, `top` the cloud point it starts from.
     */
    strike(
        top: THREE.Vector3,
        ground: THREE.Vector3,
        bolt: boolean,
        strength: number,
    ): void {
        this.origin.copy(top);
        this.age = 0;
        // 1-4 return strokes over ~0.4 s.
        this.pulseCount = 1 + Math.floor(Math.random() * 3.99);
        let t = 0;

        for (let i = 0; i < this.pulseCount; i++) {
            this.pulses[i * 2] = t;
            this.pulses[i * 2 + 1] =
                strength * (i === 0 ? 1 : 0.45 + Math.random() * 0.55);
            t += 0.05 + Math.random() * 0.12;
        }

        this.boltVisible = bolt;

        if (bolt) {
            this.segments = 0;
            this.build(top, ground, 0.9 + Math.random() * 0.6, 7, 0.22, 0);
            const count = this.segments * 4;

            for (const name of ['aStart', 'aEnd', 'aWidth']) {
                const attr = this.geometry.getAttribute(
                    name,
                ) as THREE.BufferAttribute;
                attr.clearUpdateRanges();
                attr.addUpdateRange(0, count * attr.itemSize);
                attr.needsUpdate = true;
            }

            this.geometry.setDrawRange(0, this.segments * 6);
            // Bounding sphere is irrelevant: culling is off.
        }
    }

    update(dt: number): void {
        this.age += dt;
        let level = 0;

        for (let i = 0; i < this.pulseCount; i++) {
            const dt0 = this.age - this.pulses[i * 2];

            if (dt0 >= 0) {
                // Fast rise, exponential decay.
                level +=
                    this.pulses[i * 2 + 1] *
                    Math.min(1, dt0 / 0.012) *
                    Math.exp(-dt0 / 0.07);
            }
        }

        // Faint afterglow flicker.
        this.level = level < 0.004 ? 0 : level;
        const showBolt = this.boltVisible && this.age < 0.55;
        this.group.visible = showBolt && level > 0.02;

        if (this.group.visible) {
            this.intensity.value = Math.min(1.5, level);
        }
    }

    dispose(): void {
        this.geometry.dispose();
        this.core.material.dispose();
        this.glow.material.dispose();
    }

    /** Midpoint-displaced channel from a to b with random branches. */
    private build(
        from: THREE.Vector3,
        to: THREE.Vector3,
        width: number,
        depth: number,
        branchChance: number,
        generation: number,
    ): void {
        const length = from.distanceTo(to);
        const n = 1 << depth;
        // Build the polyline in local scratch space: points along the line, displaced recursively.
        const pts = POINTS;
        pts[0] = from.x;
        pts[1] = from.y;
        pts[2] = from.z;
        pts[n * 3] = to.x;
        pts[n * 3 + 1] = to.y;
        pts[n * 3 + 2] = to.z;
        let offset = length * 0.18;

        for (let step = n; step > 1; step >>= 1) {
            for (let i = 0; i < n; i += step) {
                const m = i + step / 2;
                const i3 = i * 3;
                const j3 = (i + step) * 3;
                const m3 = m * 3;
                pts[m3] =
                    (pts[i3] + pts[j3]) / 2 + (Math.random() - 0.5) * offset;
                pts[m3 + 1] =
                    (pts[i3 + 1] + pts[j3 + 1]) / 2 +
                    (Math.random() - 0.5) * offset * 0.35;
                pts[m3 + 2] =
                    (pts[i3 + 2] + pts[j3 + 2]) / 2 +
                    (Math.random() - 0.5) * offset;
            }

            offset *= 0.52;
        }

        // Copy out before branching (branches reuse the scratch buffer).
        const local = new Float32Array(pts.subarray(0, (n + 1) * 3));

        for (let i = 0; i < n && this.segments < MAX_SEGMENTS; i++) {
            const t = i / n;
            // Channels thin out towards the tip.
            this.pushSegment(local, i, width * (1 - t * 0.55));
        }

        if (generation >= 2) {
            return;
        }

        for (let i = 2; i < n - 2; i++) {
            if (
                Math.random() > branchChance / (generation + 1) ||
                this.segments >= MAX_SEGMENTS - 32
            ) {
                continue;
            }

            this.a.fromArray(local, i * 3);
            const remaining = length * (1 - i / n);
            const branchLen = remaining * (0.25 + Math.random() * 0.4);
            this.b.set(
                this.a.x + (Math.random() - 0.5) * branchLen,
                this.a.y - branchLen * (0.5 + Math.random() * 0.5),
                this.a.z + (Math.random() - 0.5) * branchLen,
            );
            this.build(
                this.a.clone(),
                this.b.clone(),
                width * 0.45,
                Math.max(3, depth - 2),
                branchChance * 0.6,
                generation + 1,
            );
        }
    }

    private pushSegment(pts: Float32Array, i: number, width: number): void {
        const v = this.segments * 4;

        for (let k = 0; k < 4; k++) {
            this.starts.set(pts.subarray(i * 3, i * 3 + 3), (v + k) * 3);
            this.ends.set(pts.subarray(i * 3 + 3, i * 3 + 6), (v + k) * 3);
            this.widths[v + k] = width;
        }

        this.segments++;
    }

    /** Camera-facing ribbons along the segments: `widthScale` × channel width, additive glow. */
    private createMesh(widthScale: number, brightness: number, order: number) {
        const corner = attribute<'vec2'>('aCorner', 'vec2');
        const start = attribute<'vec3'>('aStart', 'vec3');
        const end = attribute<'vec3'>('aEnd', 'vec3');
        const p = mix(start, end, corner.y);
        const side = normalize(
            cross(normalize(end.sub(start)), normalize(cameraPosition.sub(p))),
        );
        // At least ~1.5 px wide at any distance.
        const dist = length(cameraPosition.sub(p));
        const width = max(
            attribute<'float'>('aWidth', 'float').mul(widthScale),
            dist.mul(0.0012 * widthScale),
        );
        const core = abs(corner.x).oneMinus();

        const material = new THREE.MeshBasicNodeMaterial({
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
            fog: false,
        });
        material.positionNode = p.add(side.mul(corner.x.mul(width)));
        material.colorNode = vec3(0.78, 0.84, 1).mul(
            this.intensity.mul(core.mul(core)).mul(12 * brightness),
        );
        const mesh = new THREE.Mesh(this.geometry, material);
        mesh.frustumCulled = false;
        mesh.renderOrder = order;

        return mesh;
    }
}

const POINTS = new Float32Array(((1 << 8) + 1) * 3);
