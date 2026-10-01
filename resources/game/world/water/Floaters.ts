import * as THREE from 'three/webgpu';
import type { PropBuoyancy } from '../../shared/types';
import type { Heightfield } from '../Heightfield';
import type { Props } from '../Props';
import type { Water, WaterSurfaceSample } from '../Water';
import {
    collideFloats,
    createFloatBody,
    pushFloat,
    stepFloat,
} from './floating';
import type { FloatBody, WaterProbe } from './floating';

/** Only bodies this close to the camera / player are simulated (farther ones keep their last pose). */
const SIM_RANGE = 160;

type Floater = {
    id: string;
    body: FloatBody;
    model: number;
    scale: number;
    buoyancy: PropBuoyancy;
    /** The saved placement the body was made from (an edit resets the body). */
    key: string;
};

/** The character, for pushing floating props around. */
export type FloatPusher = {
    position: THREE.Vector3;
    velocity: THREE.Vector3;
    radius: number;
    height: number;
};

export type FloaterState = {
    id: string;
    model: number;
    x: number;
    y: number;
    z: number;
    yaw_deg: number;
    pitch_deg: number;
    roll_deg: number;
    /** Distance from its saved spot (m). */
    drifted_m: number;
    grounded: boolean;
    drift: PropBuoyancy['drift'];
};

/**
 * Floating props (docs/ROADMAP.md phase 13): every placed prop whose model is buoyant and that stands in
 * water becomes a FloatBody (floating.ts). Each frame the bodies bob and tilt on the actual waves (five
 * samples of Water.sampleSurface over the footprint), drift with currents and wind while playing (when
 * their model allows it), bump into the shore and each other, are pushed by the character and push
 * ripples and wakes into the ripple field. Their poses go to Props.setPose: rendering and collision
 * follow, the saved placement (the anchor) does not change. Leaving play mode brings `return` drifters
 * back to their anchors; `stay` ones remain where they drifted until the map is reloaded.
 */
export class Floaters {
    private floaters = new Map<string, Floater>();
    private playing = false;
    private readonly sample: WaterSurfaceSample = {
        level: 0,
        height: 0,
        normal: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        depth: 0,
        body: null,
    };
    private readonly probe: WaterProbe;
    private readonly matrix = new THREE.Matrix4();
    private readonly quaternion = new THREE.Quaternion();
    private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
    private readonly position = new THREE.Vector3();
    private readonly scaleVec = new THREE.Vector3();

    constructor(
        private readonly props: Props,
        private readonly water: Water,
        private readonly heights: () => Heightfield,
    ) {
        this.probe = (x, z) => {
            const s = this.water.sampleSurface(x, z, this.sample);

            return s
                ? {
                      height: s.height,
                      vx: s.velocity.x,
                      vz: s.velocity.z,
                      depth: s.depth,
                  }
                : null;
        };
    }

    get count(): number {
        return this.floaters.size;
    }

    /** Play mode on / off: drifting starts; on leaving, `return` drifters go back to their anchors. */
    setPlaying(playing: boolean): void {
        if (playing === this.playing) {
            return;
        }

        this.playing = playing;

        if (!playing) {
            for (const f of this.floaters.values()) {
                if (f.buoyancy.drift === 'return') {
                    const b = f.body;
                    b.x = b.anchorX;
                    b.z = b.anchorZ;
                    b.yaw = b.anchorYaw;
                    b.vx = b.vz = b.yawRate = 0;
                }
            }
        }
    }

    /**
     * Per frame. `focus`: where the camera / player is (only nearby bodies are simulated); `pusher`:
     * the character while it walks or swims (null in the editor).
     */
    update(
        dt: number,
        focus: THREE.Vector3,
        pusher: FloatPusher | null,
    ): void {
        this.sync();

        if (!this.floaters.size || dt <= 0) {
            return;
        }

        const hf = this.heights();
        const wind = this.water.windVelocity();
        const active: Floater[] = [];

        for (const f of this.floaters.values()) {
            const b = f.body;

            if (
                Math.abs(b.x - focus.x) > SIM_RANGE ||
                Math.abs(b.z - focus.z) > SIM_RANGE
            ) {
                if (Number.isNaN(b.y)) {
                    stepFloat(b, 0.016, this.probe, {
                        drift: false,
                        windX: 0,
                        windZ: 0,
                        groundAt: (x, z) => hf.sample(x, z),
                    });
                    this.pose(f);
                }

                continue;
            }

            active.push(f);
            const vyBefore = b.vy;
            stepFloat(b, dt, this.probe, {
                drift: this.playing && f.buoyancy.drift !== 'none',
                windX: wind.x,
                windZ: wind.y,
                groundAt: (x, z) => (hf.contains(x, z) ? hf.sample(x, z) : 0),
            });

            if (pusher) {
                this.push(f, pusher);
            }

            this.ripple(f, vyBefore, dt);
        }

        for (let i = 0; i < active.length; i++) {
            for (let j = i + 1; j < active.length; j++) {
                collideFloats(active[i].body, active[j].body);
            }
        }

        for (const f of active) {
            this.pose(f);
        }
    }

    /** Snapshot for get_editor_state / control_player. */
    describe(): FloaterState[] {
        const deg = (r: number) => Math.round(THREE.MathUtils.radToDeg(r) * 10) / 10;
        const r2 = (v: number) => Math.round(v * 100) / 100;

        return [...this.floaters.entries()].map(([id, f]) => {
            const b = f.body;

            return {
                id,
                model: f.model,
                x: r2(b.x),
                y: r2(Number.isNaN(b.y) ? 0 : b.y),
                z: r2(b.z),
                yaw_deg: deg(b.yaw),
                pitch_deg: deg(b.pitch),
                roll_deg: deg(b.roll),
                drifted_m: r2(Math.hypot(b.x - b.anchorX, b.z - b.anchorZ)),
                grounded: b.grounded,
                drift: f.buoyancy.drift,
            };
        });
    }

    /** Drops every body (map reload); the props go back to their saved placements. */
    clear(): void {
        for (const id of this.floaters.keys()) {
            this.props.setPose(id, null);
        }

        this.floaters.clear();
    }

    /** Creates / updates / removes bodies to match the placed buoyant props standing in water. */
    private sync(): void {
        const seen = new Set<string>();

        for (const p of this.props.list()) {
            const ref = this.props.modelRef(p.model);
            const buoyancy = ref?.buoyancy;
            const box = buoyancy?.mode === 'float' ? this.props.modelBounds(p.model) : null;

            if (!buoyancy || !box) {
                continue;
            }

            const key = `${p.x},${p.z},${p.yaw},${p.scale},${p.offset},${buoyancy.density}`;
            let f = this.floaters.get(p.id);

            if (f && f.key === key) {
                f.buoyancy = buoyancy;
                seen.add(p.id);
                continue;
            }

            // New, edited in the editor or re-tuned: a fresh body at the saved placement — if there is
            // water there (props on land stay as placed).
            if (this.water.levelAt(p.x, p.z) === null) {
                if (f) {
                    this.floaters.delete(p.id);
                    this.props.setPose(p.id, null);
                }

                continue;
            }

            // Models are normalised with their base centred on the origin: the body's (x, z) is it.
            const size = box.getSize(new THREE.Vector3());
            f = {
                id: p.id,
                body: createFloatBody(
                    p.x,
                    p.z,
                    p.yaw,
                    (size.x / 2) * p.scale,
                    (size.z / 2) * p.scale,
                    size.y * p.scale,
                    buoyancy.density,
                    p.offset,
                ),
                model: p.model,
                scale: p.scale,
                buoyancy,
                key,
            };
            this.floaters.set(p.id, f);
            seen.add(p.id);
        }

        for (const id of [...this.floaters.keys()]) {
            if (!seen.has(id)) {
                this.floaters.delete(id);
                this.props.setPose(id, null);
            }
        }
    }

    /** The character walking or swimming into a body shoves it (and the collision pushes back). */
    private push(f: Floater, c: FloatPusher): void {
        const b = f.body;
        const reach = Math.max(b.halfX, b.halfZ) * 0.9 + c.radius;
        const dx = b.x - c.position.x;
        const dz = b.z - c.position.z;
        const dist = Math.hypot(dx, dz);
        const top = b.y + b.height;

        if (
            dist >= reach ||
            dist < 1e-4 ||
            c.position.y > top ||
            c.position.y + c.height < b.y
        ) {
            return;
        }

        const nx = dx / dist;
        const nz = dz / dist;
        const into = c.velocity.x * nx + c.velocity.z * nz;
        const overlap = (reach - dist) / reach;
        const dv = Math.max(0, into) * 0.25 + overlap * 0.6;
        pushFloat(b, nx * dv, nz * dv);
    }

    /** Bobbing and moving bodies disturb the water: rings from the heave, a bow wave and wake. */
    private ripple(f: Floater, vyBefore: number, dt: number): void {
        const b = f.body;

        if (b.grounded || Number.isNaN(b.y)) {
            return;
        }

        const size = Math.max(b.halfX, b.halfZ);
        const heave = b.vy - vyBefore;
        const speed = Math.hypot(b.vx, b.vz);

        if (Math.abs(b.vy) > 0.05 || Math.abs(heave) > 0.01) {
            this.water.ripples.disturb({
                x: b.x,
                z: b.z,
                radius: Math.min(2, size * 0.8),
                amount: -b.vy * dt * 0.4 * Math.min(2, size),
                foam: 0,
            });
        }

        if (speed > 0.15) {
            const ux = b.vx / speed;
            const uz = b.vz / speed;
            const push = Math.min(2, speed) * dt * 0.05 * Math.min(2, size);
            this.water.ripples.disturb({
                x: b.x + ux * size * 0.8,
                z: b.z + uz * size * 0.8,
                radius: Math.min(1.5, size * 0.5),
                amount: push,
                foam: 0,
            });
            this.water.ripples.disturb({
                x: b.x - ux * size * 0.8,
                z: b.z - uz * size * 0.8,
                radius: Math.min(1.5, size * 0.5),
                amount: -push * 0.8,
                foam: 0,
            });
        }
    }

    private pose(f: Floater): void {
        const b = f.body;

        if (Number.isNaN(b.y)) {
            return;
        }

        this.euler.set(b.pitch, b.yaw, b.roll, 'YXZ');
        this.quaternion.setFromEuler(this.euler);
        this.position.set(b.x, b.y, b.z);
        this.scaleVec.setScalar(f.scale);
        this.matrix.compose(this.position, this.quaternion, this.scaleVec);
        this.props.setPose(f.id, {
            matrix: this.matrix,
            x: b.x,
            z: b.z,
            yaw: b.yaw,
        });
    }
}
