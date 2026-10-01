import * as THREE from 'three/webgpu';
import { claimHeavySlot } from '../core/stagger';

/** Texels per side of the trail texture. */
const SIZE = 1024;
/** World metres the texture covers (5 cm texels). */
const WORLD = 51.2;
const TEXEL = WORLD / SIZE;
/** Distance between successive footprints (one step), m. */
const STRIDE = 0.68;
/** Footprint size (m): length along the step, width, and the sideways offset of each foot. */
const PRINT_LENGTH = 0.3;
const PRINT_WIDTH = 0.12;
const FOOT_OFFSET = 0.11;
/** Seconds between decay passes / texture uploads. */
const DECAY_INTERVAL = 0.25;

/** Something that walks: the player (play mode, the editor's walk mode). */
export type TrailWalker = {
    position: THREE.Vector3;
    velocity: THREE.Vector3;
    grounded: boolean;
    swimming: boolean;
};

/**
 * Footprints pressed into snow cover around the character: an R8 texture of print depth (0..1) on a
 * 51 m window that follows the walker. The texture wraps (toroidal addressing: texel = world position
 * mod the window), so following the walker only clears the rows / columns that scroll out of the
 * window; the terrain shader samples it with world UVs and masks it to the window. Prints fade over
 * `fadeTime` seconds without snowfall and fill much faster while snow falls.
 */
export class SnowTrail {
    readonly texture: THREE.DataTexture;
    /** x / z: window centre (m), y: window size (m), w: 1 while any print exists. */
    readonly info = new THREE.Vector4(0, 0, WORLD, 0);
    private readonly data = new Uint8Array(SIZE * SIZE);
    /** Grid coordinates (texels) of the window's lower corner. */
    private originX = 0;
    private originZ = 0;
    private placed = false;
    private distance = 0;
    private foot = 1;
    private readonly lastPos = new THREE.Vector3();
    private hasLast = false;
    private decayTimer = 0;
    private decayCarry = 0;
    private dirty = false;
    private uploadDue = false;
    private active = false;
    enabled = true;

    constructor() {
        this.texture = new THREE.DataTexture(
            this.data,
            SIZE,
            SIZE,
            THREE.RedFormat,
            THREE.UnsignedByteType,
        );
        this.texture.name = 'Snow trail';
        this.texture.wrapS = this.texture.wrapT = THREE.RepeatWrapping;
        this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter;
        this.texture.generateMipmaps = false;
        this.texture.needsUpdate = true;
    }

    /**
     * Per frame. `snow` = snow cover on the ground (0..1; no prints below a thin layer), `snowfall`
     * = snow currently falling (0..1), `fadeTime` = seconds prints take to fade without snowfall.
     */
    update(
        dt: number,
        walker: TrailWalker | null,
        snow: number,
        snowfall: number,
        fadeTime: number,
    ): void {
        if (!this.enabled) {
            return;
        }

        if (walker) {
            this.follow(walker.position.x, walker.position.z);
            this.walk(walker, snow);
        } else {
            this.hasLast = false;
        }

        this.decayTimer += dt;

        if (this.decayTimer >= DECAY_INTERVAL) {
            // Snowfall refills the prints within ~20 s at full intensity; snow melting away takes
            // them with it.
            const rate =
                1 / Math.max(1, fadeTime) +
                snowfall / 20 +
                (snow < 0.05 ? 0.5 : 0);
            this.decayCarry += rate * this.decayTimer * 255;
            this.decayTimer = 0;
            const step = Math.floor(this.decayCarry);

            if (step >= 1 && this.active) {
                this.decayCarry -= step;
                this.decay(step);
            } else if (!this.active) {
                this.decayCarry = 0;
            }

            this.uploadDue = true;
        }

        // 1 MB upload: on a frame no other low-rate upload takes (see core/stagger).
        if (this.uploadDue && this.dirty && claimHeavySlot()) {
            this.dirty = false;
            this.uploadDue = false;
            this.texture.needsUpdate = true;
        }

        this.info.w = this.active ? 1 : 0;
    }

    /** Clears every print (e.g. a new map). */
    clear(): void {
        this.data.fill(0);
        this.active = false;
        this.texture.needsUpdate = true;
    }

    dispose(): void {
        this.texture.dispose();
    }

    /** Moves the window to centre on (x, z), clearing the texels that scrolled in. */
    private follow(x: number, z: number): void {
        const ox = Math.floor(x / TEXEL) - SIZE / 2;
        const oz = Math.floor(z / TEXEL) - SIZE / 2;

        if (!this.placed) {
            this.placed = true;
            this.originX = ox;
            this.originZ = oz;
            this.clear();
        }

        // Re-centre in steps of 32 texels (1.6 m) so the clearing runs only now and then.
        if (
            Math.abs(ox - this.originX) >= 32 ||
            Math.abs(oz - this.originZ) >= 32
        ) {
            this.scroll(ox, oz);
        }

        this.info.x = (this.originX + SIZE / 2) * TEXEL;
        this.info.y = WORLD;
        this.info.z = (this.originZ + SIZE / 2) * TEXEL;
    }

    private scroll(ox: number, oz: number): void {
        const clearCols = (from: number, to: number) => {
            for (let gx = from; gx < to; gx++) {
                const c = mod(gx, SIZE);

                for (let r = 0; r < SIZE; r++) {
                    this.data[r * SIZE + c] = 0;
                }
            }
        };
        const clearRows = (from: number, to: number) => {
            for (let gz = from; gz < to; gz++) {
                const r = mod(gz, SIZE);
                this.data.fill(0, r * SIZE, r * SIZE + SIZE);
            }
        };

        if (
            Math.abs(ox - this.originX) >= SIZE ||
            Math.abs(oz - this.originZ) >= SIZE
        ) {
            this.data.fill(0);
        } else {
            // Columns that left on one side re-enter on the other: clear the new ones.
            if (ox > this.originX) {
                clearCols(this.originX + SIZE, ox + SIZE);
            } else if (ox < this.originX) {
                clearCols(ox, this.originX);
            }

            if (oz > this.originZ) {
                clearRows(this.originZ + SIZE, oz + SIZE);
            } else if (oz < this.originZ) {
                clearRows(oz, this.originZ);
            }
        }

        this.originX = ox;
        this.originZ = oz;
        this.dirty = true;
    }

    /** Stamps a footprint every half stride while the walker moves on snow. */
    private walk(walker: TrailWalker, snow: number): void {
        const p = walker.position;

        if (!this.hasLast) {
            this.lastPos.copy(p);
            this.hasLast = true;

            return;
        }

        const dx = p.x - this.lastPos.x;
        const dz = p.z - this.lastPos.z;
        const moved = Math.hypot(dx, dz);
        this.lastPos.copy(p);

        // Teleports (respawn, editor jumps) don't leave a line of prints.
        if (moved > 3 || !walker.grounded || walker.swimming || snow < 0.08) {
            this.distance = 0;

            return;
        }

        this.distance += moved;

        if (this.distance < STRIDE / 2 || moved < 1e-5) {
            return;
        }

        this.distance = 0;
        const v = walker.velocity;
        const speed = Math.hypot(v.x, v.z);
        const dirX = speed > 0.05 ? v.x / speed : dx / moved;
        const dirZ = speed > 0.05 ? v.z / speed : dz / moved;
        this.foot = -this.foot;
        // Right foot: 90° clockwise from the heading (x, z) → (-z, x) points left in a y-up frame.
        const sideX = -dirZ * this.foot * FOOT_OFFSET;
        const sideZ = dirX * this.foot * FOOT_OFFSET;
        this.stamp(p.x + sideX, p.z + sideZ, dirX, dirZ);
    }

    /** One oval print (heel and toe slightly deeper), max-blended into the texture. */
    private stamp(x: number, z: number, dirX: number, dirZ: number): void {
        const halfL = PRINT_LENGTH / 2;
        const halfW = PRINT_WIDTH / 2;
        const reach = Math.ceil((halfL + TEXEL * 2) / TEXEL);
        const cx = x / TEXEL;
        const cz = z / TEXEL;

        for (let j = -reach; j <= reach; j++) {
            for (let i = -reach; i <= reach; i++) {
                const gx = Math.floor(cx) + i;
                const gz = Math.floor(cz) + j;
                // Texel centre relative to the print, in metres, in the print's frame.
                const wx = (gx + 0.5) * TEXEL - x;
                const wz = (gz + 0.5) * TEXEL - z;
                const along = wx * dirX + wz * dirZ;
                const across = -wx * dirZ + wz * dirX;
                // Narrower at the heel than at the ball of the foot.
                const width = halfW * (along < 0 ? 0.82 : 1);
                const e = (along / halfL) ** 2 + (across / width) ** 2;

                if (e >= 1) {
                    continue;
                }

                const edge = Math.min(1, (1 - e) * 3.5);
                const value = Math.round(edge * 255);
                const k = mod(gz, SIZE) * SIZE + mod(gx, SIZE);

                if (value > this.data[k]) {
                    this.data[k] = value;
                }
            }
        }

        this.active = true;
        this.dirty = true;
    }

    private decay(step: number): void {
        const d = this.data;
        let any = false;

        for (let k = 0; k < d.length; k++) {
            const v = d[k];

            if (v !== 0) {
                const next = v > step ? v - step : 0;
                d[k] = next;
                any ||= next !== 0;
            }
        }

        this.active = any;
        this.dirty = true;
    }
}

function mod(a: number, n: number): number {
    return ((a % n) + n) % n;
}
