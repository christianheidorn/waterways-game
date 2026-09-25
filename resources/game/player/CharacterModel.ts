import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

/**
 * Procedural explorer humanoid (~1.8 m, origin at the feet, facing local -Z) with a joint
 * hierarchy that is animated procedurally (idle, walk, run, airborne, swim).
 */

export type CharacterAnimState = {
    /** Horizontal speed in m/s. */
    speed: number;
    runSpeed: number;
    grounded: boolean;
    swimming: boolean;
    verticalVelocity: number;
};

const JOINTS = [
    'hips',
    'spine',
    'chest',
    'neck',
    'head',
    'clavL',
    'clavR',
    'armL',
    'armR',
    'foreL',
    'foreR',
    'handL',
    'handR',
    'thighL',
    'thighR',
    'shinL',
    'shinR',
    'footL',
    'footR',
] as const;

type JointName = (typeof JOINTS)[number];

const J: Record<JointName, number> = Object.fromEntries(
    JOINTS.map((n, i) => [n, i]),
) as Record<JointName, number>;

/** Euler XYZ per joint followed by a hips offset (y, z). */
const POSE_SIZE = JOINTS.length * 3 + 2;
const OFF_Y = JOINTS.length * 3;
const OFF_Z = OFF_Y + 1;
const HIPS_HEIGHT = 0.98;
const TAU = Math.PI * 2;

type Pose = Float32Array;

function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

function smoothstep(e0: number, e1: number, x: number): number {
    const t = clamp01((x - e0) / (e1 - e0));

    return t * t * (3 - 2 * t);
}

function rot(p: Pose, j: JointName, x: number, y = 0, z = 0): void {
    const i = J[j] * 3;
    p[i] = x;
    p[i + 1] = y;
    p[i + 2] = z;
}

/** Angle wrapped to (-π, π]. */
function wrapAngle(a: number): number {
    const w = ((a % TAU) + TAU) % TAU;

    return w > Math.PI ? w - TAU : w;
}

export class CharacterModel {
    readonly root: THREE.Group;

    private readonly joints: THREE.Group[] = [];
    private readonly geometries: THREE.BufferGeometry[] = [];
    private readonly materials: THREE.MeshStandardMaterial[] = [];
    private readonly jacket: THREE.MeshStandardMaterial;
    private readonly jacketTrim: THREE.MeshStandardMaterial;

    private readonly scratch: Pose = new Float32Array(POSE_SIZE);
    private readonly target: Pose = new Float32Array(POSE_SIZE);
    /** Smoothed state weights: idle, walk, run, air, swim. */
    private readonly weights = new Float32Array([1, 0, 0, 0, 0]);
    private phase = 0;
    private swimPhase = 0;
    private time = 0;
    private runBlend = 0;
    private swimMove = 0;

    constructor(color: THREE.ColorRepresentation) {
        this.root = new THREE.Group();
        this.root.name = 'CharacterModel';

        const mat = (
            c: THREE.ColorRepresentation,
            roughness = 0.85,
            metalness = 0,
        ): THREE.MeshStandardMaterial => {
            const m = new THREE.MeshStandardMaterial({
                color: c,
                roughness,
                metalness,
            });
            this.materials.push(m);

            return m;
        };

        this.jacket = mat(color, 0.82);
        this.jacketTrim = mat(color, 0.9);
        const trousers = mat(0x3b3e36, 0.9);
        const boots = mat(0x4a3122, 0.7);
        const sole = mat(0x1d1916, 0.95);
        const skin = mat(0xdca685, 0.65);
        const hair = mat(0x3a2517, 0.8);
        const hat = mat(0x9a8360, 0.9);
        const band = mat(0x3a2c1f, 0.8);
        const pack = mat(0x6a5a3b, 0.88);
        const packDark = mat(0x4b3e29, 0.9);
        const roll = mat(0x5d6b4a, 0.95);
        const belt = mat(0x2a2018, 0.6);
        const buckle = mat(0xb0925a, 0.35, 0.8);
        const eye = mat(0x16130f, 0.3);
        this.setColor(color);

        const joint = (
            name: JointName,
            parent: THREE.Object3D,
            x: number,
            y: number,
            z = 0,
        ): THREE.Group => {
            const g = new THREE.Group();
            g.name = name;
            g.position.set(x, y, z);
            parent.add(g);
            this.joints[J[name]] = g;

            return g;
        };

        const add = (
            parent: THREE.Object3D,
            geo: THREE.BufferGeometry,
            m: THREE.Material,
            x = 0,
            y = 0,
            z = 0,
            sx = 1,
            sy = 1,
            sz = 1,
        ): THREE.Mesh => {
            this.geometries.push(geo);
            const mesh = new THREE.Mesh(geo, m);
            mesh.position.set(x, y, z);
            mesh.scale.set(sx, sy, sz);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            parent.add(mesh);

            return mesh;
        };

        const capsule = (r: number, len: number): THREE.CapsuleGeometry =>
            new THREE.CapsuleGeometry(r, len, 4, 12);
        const rbox = (
            w: number,
            h: number,
            d: number,
            r: number,
        ): RoundedBoxGeometry => new RoundedBoxGeometry(w, h, d, 2, r);

        // Torso.
        const hips = joint('hips', this.root, 0, HIPS_HEIGHT);
        add(hips, rbox(0.32, 0.2, 0.2, 0.07), trousers, 0, -0.03, 0);
        add(
            hips,
            new THREE.CylinderGeometry(0.168, 0.172, 0.045, 18),
            belt,
            0,
            0.06,
            0,
            1,
            1,
            0.72,
        );
        add(hips, rbox(0.05, 0.04, 0.02, 0.008), buckle, 0, 0.06, -0.125);

        const spine = joint('spine', hips, 0, 0.1);
        add(spine, capsule(0.135, 0.1), this.jacket, 0, 0.06, 0, 1.18, 1, 0.78);
        add(
            spine,
            new THREE.CylinderGeometry(0.17, 0.182, 0.09, 18),
            this.jacketTrim,
            0,
            -0.04,
            0,
            1,
            1,
            0.76,
        );

        const chest = joint('chest', spine, 0, 0.2);
        add(chest, capsule(0.15, 0.16), this.jacket, 0, 0.06, 0, 1.25, 1, 0.8);
        add(
            chest,
            new THREE.CylinderGeometry(0.07, 0.1, 0.07, 14),
            this.jacketTrim,
            0,
            0.21,
            0.005,
        );
        add(
            chest,
            rbox(0.06, 0.07, 0.02, 0.008),
            this.jacketTrim,
            -0.08,
            0.06,
            -0.118,
        );
        add(
            chest,
            rbox(0.06, 0.07, 0.02, 0.008),
            this.jacketTrim,
            0.08,
            0.06,
            -0.118,
        );

        // Backpack with straps and bedroll (back = +Z).
        add(chest, rbox(0.3, 0.38, 0.15, 0.045), pack, 0, 0.02, 0.19);
        add(chest, rbox(0.22, 0.16, 0.06, 0.025), packDark, 0, -0.06, 0.28);
        add(chest, rbox(0.24, 0.04, 0.02, 0.01), packDark, 0, 0.12, 0.27);
        const bed = add(
            chest,
            new THREE.CylinderGeometry(0.065, 0.065, 0.36, 14),
            roll,
            0,
            0.26,
            0.2,
        );
        bed.rotation.z = Math.PI / 2;
        for (const sx of [-1, 1]) {
            const strap = add(
                chest,
                rbox(0.045, 0.34, 0.02, 0.008),
                packDark,
                sx * 0.1,
                0.05,
                -0.118,
            );
            strap.rotation.z = sx * 0.08;
            const over = add(
                chest,
                rbox(0.045, 0.02, 0.24, 0.008),
                packDark,
                sx * 0.1,
                0.215,
                0.03,
            );
            over.rotation.x = -0.05;
        }

        // Neck and head.
        const neck = joint('neck', chest, 0, 0.2);
        add(
            neck,
            new THREE.CylinderGeometry(0.048, 0.055, 0.1, 12),
            skin,
            0,
            0.03,
            0,
        );
        const head = joint('head', neck, 0, 0.07);
        add(
            head,
            new THREE.SphereGeometry(0.105, 24, 18),
            skin,
            0,
            0.1,
            0,
            0.92,
            1.08,
            1,
        );
        add(
            head,
            new THREE.SphereGeometry(0.1, 16, 12),
            skin,
            0,
            0.045,
            -0.02,
            0.8,
            0.6,
            0.85,
        );
        const hairMesh = add(
            head,
            new THREE.SphereGeometry(0.111, 24, 14, 0, TAU, 0, Math.PI * 0.55),
            hair,
            0,
            0.105,
            0.008,
            0.93,
            1.08,
            1,
        );
        hairMesh.rotation.x = 0.45;
        add(
            head,
            new THREE.ConeGeometry(0.016, 0.04, 8),
            skin,
            0,
            0.09,
            -0.108,
        ).rotation.x = -Math.PI / 2;
        for (const sx of [-1, 1]) {
            add(
                head,
                new THREE.SphereGeometry(0.011, 8, 6),
                eye,
                sx * 0.036,
                0.115,
                -0.094,
            );
            add(
                head,
                new THREE.SphereGeometry(0.024, 10, 8),
                skin,
                sx * 0.097,
                0.1,
                0.005,
                0.45,
                1,
                0.8,
            );
        }
        add(
            head,
            new THREE.CylinderGeometry(0.2, 0.205, 0.014, 28),
            hat,
            0,
            0.175,
            0,
        );
        add(
            head,
            new THREE.CylinderGeometry(0.095, 0.115, 0.1, 22),
            hat,
            0,
            0.225,
            0,
            1,
            1,
            0.92,
        );
        add(
            head,
            new THREE.CylinderGeometry(0.117, 0.118, 0.025, 22),
            band,
            0,
            0.19,
            0,
            1,
            1,
            0.92,
        );

        // Arms. Character's right is +X (facing -Z).
        for (const side of [-1, 1] as const) {
            const s = side < 0 ? 'L' : 'R';
            const clav = joint(`clav${s}`, chest, side * 0.12, 0.17);
            const arm = joint(`arm${s}`, clav, side * 0.075, 0);
            add(
                arm,
                new THREE.SphereGeometry(0.068, 14, 10),
                this.jacket,
                0,
                -0.01,
                0,
            );
            add(arm, capsule(0.056, 0.19), this.jacket, 0, -0.14, 0);
            const fore = joint(`fore${s}`, arm, 0, -0.29);
            add(fore, capsule(0.049, 0.17), this.jacket, 0, -0.11, 0);
            add(
                fore,
                new THREE.CylinderGeometry(0.052, 0.052, 0.04, 12),
                this.jacketTrim,
                0,
                -0.22,
                0,
            );
            const hand = joint(`hand${s}`, fore, 0, -0.25);
            add(hand, rbox(0.055, 0.09, 0.08, 0.022), skin, 0, -0.045, -0.005);
            const thumb = add(
                hand,
                capsule(0.013, 0.03),
                skin,
                -side * 0.025,
                -0.035,
                -0.04,
            );
            thumb.rotation.x = 0.5;
        }

        // Legs.
        for (const side of [-1, 1] as const) {
            const s = side < 0 ? 'L' : 'R';
            const thigh = joint(`thigh${s}`, hips, side * 0.095, -0.06);
            add(thigh, capsule(0.078, 0.3), trousers, 0, -0.2, 0);
            add(
                thigh,
                rbox(0.04, 0.12, 0.09, 0.015),
                trousers,
                side * 0.075,
                -0.2,
                0,
            );
            const shin = joint(`shin${s}`, thigh, 0, -0.44);
            add(
                shin,
                new THREE.SphereGeometry(0.066, 12, 10),
                trousers,
                0,
                0,
                -0.005,
            );
            add(shin, capsule(0.062, 0.27), trousers, 0, -0.18, 0);
            add(
                shin,
                new THREE.CylinderGeometry(0.068, 0.072, 0.15, 14),
                boots,
                0,
                -0.33,
                0,
            );
            const foot = joint(`foot${s}`, shin, 0, -0.4);
            add(foot, rbox(0.1, 0.085, 0.24, 0.035), boots, 0, -0.03, -0.045);
            add(foot, rbox(0.108, 0.026, 0.255, 0.01), sole, 0, -0.068, -0.045);
        }

        this.applyPose(this.target);
    }

    setColor(color: THREE.ColorRepresentation): void {
        this.jacket.color.set(color);
        this.jacketTrim.color.set(color).multiplyScalar(0.62);
    }

    update(dt: number, state: CharacterAnimState): void {
        dt = Math.min(Math.max(dt, 0), 0.1);
        this.time += dt;
        const speed = Math.max(0, state.speed);
        const runSpeed = Math.max(0.5, state.runSpeed);

        // Target state weights.
        const swim = state.swimming ? 1 : 0;
        const air = !state.grounded && !state.swimming ? 1 : 0;
        const ground = 1 - swim - air;
        const move = smoothstep(0.15, 1.2, speed);
        const run = smoothstep(runSpeed * 0.45, runSpeed * 0.85, speed);
        const targets = [
            ground * (1 - move),
            ground * move * (1 - run),
            ground * move * run,
            air,
            swim,
        ];
        const k = 1 - Math.exp(-dt * 9);
        let sum = 0;

        for (let i = 0; i < 5; i++) {
            this.weights[i] += (targets[i] - this.weights[i]) * k;
            sum += this.weights[i];
        }

        this.runBlend += (run - this.runBlend) * k;
        this.swimMove +=
            (smoothstep(0.2, 1.4, speed) - this.swimMove) *
            (1 - Math.exp(-dt * 3));

        // Gait phase advances with distance travelled (one cycle = two steps).
        if (state.grounded) {
            const stride = lerp(1.5, 2.6, this.runBlend);
            this.phase = (this.phase + (speed * dt * TAU) / stride) % TAU;
        }

        this.swimPhase =
            (this.swimPhase + dt * TAU * (0.4 + 0.25 * clamp01(speed / 2))) %
            (TAU * 12);

        const target = this.target;
        target.fill(0);
        const w = this.weights;
        const inv = sum > 1e-4 ? 1 / sum : 0;

        if (w[0] > 1e-3) {
            this.idlePose(this.scratch);
            this.accumulate(w[0] * inv);
        }

        if (w[1] > 1e-3) {
            this.gaitPose(this.scratch, 0);
            this.accumulate(w[1] * inv);
        }

        if (w[2] > 1e-3) {
            this.gaitPose(this.scratch, 1);
            this.accumulate(w[2] * inv);
        }

        if (w[3] > 1e-3) {
            this.airPose(this.scratch, state.verticalVelocity);
            this.accumulate(w[3] * inv);
        }

        if (w[4] > 1e-3) {
            this.swimPose(this.scratch);
            this.accumulate(w[4] * inv);
        }

        this.applyPose(target);
    }

    dispose(): void {
        for (const g of this.geometries) {
            g.dispose();
        }

        for (const m of this.materials) {
            m.dispose();
        }

        this.geometries.length = 0;
        this.materials.length = 0;
        this.root.removeFromParent();
        this.root.clear();
    }

    private accumulate(weight: number): void {
        for (let i = 0; i < POSE_SIZE; i++) {
            this.target[i] += this.scratch[i] * weight;
        }
    }

    private applyPose(p: Pose): void {
        for (let j = 0; j < JOINTS.length; j++) {
            this.joints[j].rotation.set(p[j * 3], p[j * 3 + 1], p[j * 3 + 2]);
        }

        this.joints[J.hips].position.set(0, HIPS_HEIGHT + p[OFF_Y], p[OFF_Z]);
    }

    /** Relaxed stance with breathing, weight shift and slow head movement. */
    private idlePose(p: Pose): void {
        p.fill(0);
        const t = this.time;
        const breath = Math.sin((t * TAU) / 4);
        const sway = Math.sin(t * 0.6);
        p[OFF_Y] = breath * 0.004 - 0.005;
        rot(p, 'hips', 0, sway * 0.03, sway * 0.025);
        rot(p, 'spine', 0.01 + breath * 0.01, 0, -sway * 0.015);
        rot(p, 'chest', -0.02 + breath * 0.025, -sway * 0.02, -sway * 0.01);
        rot(p, 'neck', 0.02);
        rot(
            p,
            'head',
            Math.sin(t * 0.23) * 0.05,
            Math.sin(t * 0.37) * 0.25 * Math.sin(t * 0.11),
            0,
        );
        rot(p, 'clavL', 0, 0, -breath * 0.02);
        rot(p, 'clavR', 0, 0, breath * 0.02);
        rot(p, 'armL', 0.04, 0, -0.1 - breath * 0.01);
        rot(p, 'armR', 0.04, 0, 0.1 + breath * 0.01);
        rot(p, 'foreL', 0.15);
        rot(p, 'foreR', 0.15);
        rot(p, 'thighL', 0.03, 0, -0.035 - sway * 0.02);
        rot(p, 'thighR', 0.02, 0, 0.035 - sway * 0.02);
        rot(p, 'shinL', -0.06);
        rot(p, 'shinR', -0.04);
        rot(p, 'footL', 0.03, 0, sway * 0.02);
        rot(p, 'footR', 0.02, 0, sway * 0.02);
    }

    /** Walk (k = 0) or run (k = 1) cycle driven by the distance-based phase. */
    private gaitPose(p: Pose, k: number): void {
        p.fill(0);
        const s = Math.sin(this.phase);
        const c = Math.cos(this.phase);
        const thighAmp = lerp(0.45, 0.8, k);
        const kneeBase = lerp(0.1, 0.3, k);
        const kneeLift = lerp(0.8, 1.6, k);
        const lean = lerp(0.04, 0.2, k);
        const twist = lerp(0.12, 0.16, k);

        p[OFF_Y] =
            -lerp(0.025, 0.06, k) * (0.5 - 0.5 * Math.cos(2 * this.phase)) -
            k * 0.04;
        rot(p, 'hips', 0, s * twist, c * 0.04);
        rot(p, 'spine', -lean, 0, 0);
        rot(
            p,
            'chest',
            -lean * 0.5 + Math.abs(c) * 0.02,
            -s * twist * 1.6,
            -c * 0.02,
        );
        rot(p, 'neck', lean * 0.9);
        rot(p, 'head', lean * 0.2, s * twist * 0.5, 0);

        const thighL = s * thighAmp + k * 0.12;
        const thighR = -s * thighAmp + k * 0.12;
        const shinL = -(kneeBase + kneeLift * Math.max(0, c));
        const shinR = -(kneeBase + kneeLift * Math.max(0, -c));
        rot(p, 'thighL', thighL);
        rot(p, 'thighR', thighR);
        rot(p, 'shinL', shinL);
        rot(p, 'shinR', shinR);
        rot(p, 'footL', -(thighL + shinL) * 0.55);
        rot(p, 'footR', -(thighR + shinR) * 0.55);

        const armAmp = lerp(0.42, 0.95, k);
        const elbow = lerp(0.25, 1.45, k);
        const armOut = lerp(0.08, 0.14, k);
        rot(p, 'armL', -s * armAmp, 0, -armOut);
        rot(p, 'armR', s * armAmp, 0, armOut);
        rot(p, 'foreL', elbow + Math.max(0, -s) * 0.25, 0, 0);
        rot(p, 'foreR', elbow + Math.max(0, s) * 0.25, 0, 0);
        rot(p, 'handL', 0, 0, 0.1);
        rot(p, 'handR', 0, 0, -0.1);
    }

    /** Tucked when rising, arms flaring and legs extending when falling. */
    private airPose(p: Pose, verticalVelocity: number): void {
        p.fill(0);
        const f = clamp01(0.45 - verticalVelocity * 0.1);
        const flail = Math.sin(this.time * 9) * 0.08 * f;
        rot(p, 'spine', lerp(-0.12, 0.04, f));
        rot(p, 'chest', lerp(-0.05, 0.02, f));
        rot(p, 'neck', lerp(0.05, -0.05, f));
        rot(p, 'head', lerp(0.05, -0.12, f));
        rot(p, 'armL', lerp(0.55, 0.25, f), 0, lerp(-0.35, -1.05, f) + flail);
        rot(p, 'armR', lerp(0.3, 0.2, f), 0, lerp(0.4, 1.05, f) - flail);
        rot(p, 'foreL', lerp(0.7, 0.35, f));
        rot(p, 'foreR', lerp(0.6, 0.35, f));
        rot(p, 'thighL', lerp(0.85, 0.35, f));
        rot(p, 'thighR', lerp(0.2, -0.12, f));
        rot(p, 'shinL', lerp(-1.25, -0.45, f));
        rot(p, 'shinR', lerp(-0.55, -0.25, f));
        rot(p, 'footL', lerp(0.25, -0.1, f));
        rot(p, 'footR', lerp(0.2, -0.15, f));
    }

    /** Treading water when slow, front crawl with flutter kick when moving. */
    private swimPose(p: Pose): void {
        p.fill(0);
        const m = this.swimMove;
        const t = this.time;
        const sp = this.swimPhase;
        const tr = Math.sin(t * 3);
        const tr2 = Math.cos(t * 3);

        // Crawl arm angles: rotation about X, negative sweeps back → over → ahead → under.
        const aL = wrapAngle(-sp);
        const aR = wrapAngle(-sp - Math.PI);
        const pullL = Math.max(0, -Math.sin(sp));
        const pullR = Math.max(0, Math.sin(sp));
        const kick = Math.sin(sp * 3);
        const roll = Math.sin(sp) * 0.35;

        p[OFF_Y] = lerp(-0.05, 0.1, m) + tr * 0.02 * (1 - m);
        p[OFF_Z] = m * -0.02;
        rot(p, 'hips', lerp(-0.25, -1.4, m), roll * m, 0);
        rot(p, 'spine', lerp(-0.05, 0.05, m));
        rot(p, 'chest', lerp(-0.05, 0.08, m), -roll * 0.3 * m);
        rot(p, 'neck', lerp(0.05, 0.5, m));
        rot(p, 'head', lerp(0.05, 0.45, m), -roll * 0.6 * m);

        rot(
            p,
            'armL',
            lerp(0.9 + tr * 0.2, aL, m),
            0,
            lerp(-0.55 + tr2 * 0.3, -0.15, m),
        );
        rot(
            p,
            'armR',
            lerp(0.9 - tr * 0.2, aR, m),
            0,
            lerp(0.55 - tr2 * 0.3, 0.15, m),
        );
        rot(p, 'foreL', lerp(0.55, 0.15 + pullL * 0.6, m));
        rot(p, 'foreR', lerp(0.55, 0.15 + pullR * 0.6, m));
        rot(p, 'handL', 0, 0, lerp(tr2 * 0.4, 0, m));
        rot(p, 'handR', 0, 0, lerp(-tr2 * 0.4, 0, m));

        rot(p, 'thighL', lerp(0.45 + tr * 0.35, kick * 0.3, m), 0, -0.06);
        rot(p, 'thighR', lerp(0.45 - tr * 0.35, -kick * 0.3, m), 0, 0.06);
        rot(
            p,
            'shinL',
            lerp(
                -0.9 - tr2 * 0.3,
                -0.2 - 0.25 * Math.max(0, Math.cos(sp * 3)),
                m,
            ),
        );
        rot(
            p,
            'shinR',
            lerp(
                -0.9 + tr2 * 0.3,
                -0.2 - 0.25 * Math.max(0, -Math.cos(sp * 3)),
                m,
            ),
        );
        rot(p, 'footL', lerp(-0.3, -1.1, m));
        rot(p, 'footR', lerp(-0.3, -1.1, m));
    }
}
