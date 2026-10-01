import * as THREE from 'three/webgpu';
import {
    CharacterWetness,
    splashStrength,
    WADE_MIN_DEPTH,
} from '../../player/wading';
import { characterSoak } from '../SurfaceWetness';
import type { Water } from '../Water';
import { Splashes } from './Splashes';

/** What the interaction needs to know about the character each frame. */
export type WaderState = {
    position: THREE.Vector3;
    velocity: THREE.Vector3;
    height: number;
    swimming: boolean;
    yaw: number;
    /** The head is under water (diving). */
    headUnder?: boolean;
};

export type WaterSound = 'step' | 'splash' | 'stroke' | 'bubbles';

/** Snapshot for get_editor_state / control_player. */
export type WaterInteractionState = {
    wading: boolean;
    swimming: boolean;
    water_depth_m: number;
    wet: number;
    wet_line_m: number;
    /** The head is under water. */
    underwater: boolean;
};

/**
 * Everything that disturbs the water (docs/ROADMAP.md phase 12): the character wading (footsteps and legs
 * push ripples, spray at the shins, sounds), swimming (strokes and a wake), falling in (a splash sized by
 * the impact speed), drips from wet clothes, props dropped or dragged into water in the editor, and
 * splashes asked for by the MCP. Ripples go to Water.ripples, particles to Splashes; it also keeps the
 * character's wetness (CharacterWetness) and drives the wet-clothes uniforms (characterSoak).
 */
export class WaterInteraction {
    readonly splashes: Splashes;
    readonly wetness = new CharacterWetness();
    wading = false;
    depth = 0;
    underwater = false;
    /** Sounds (WeatherAudio.waterSound). */
    onSound: ((kind: WaterSound, volume: number) => void) | null = null;
    private swimming = false;
    private stride = 0;
    private foot = 1;
    private strokePhase = 0;
    private lastSubmerged = 0;
    private lastVy = 0;
    private dripCarry = 0;
    private bubbleCarry = 0;
    private wasCharacter = false;

    constructor(private readonly water: Water) {
        this.splashes = new Splashes(
            (x, z) => water.levelAt(x, z),
            (x, z) => water.terrain.sample(x, z),
        );
        // Drops landing make tiny rings.
        this.splashes.onDropLanded = (x, z, size) => {
            if (size > 0.03 || Math.random() < 0.25) {
                water.ripples.disturb({
                    x,
                    z,
                    radius: 0.12,
                    amount: -0.004 - size * 0.1,
                    foam: 0,
                });
            }
        };
    }

    /** Graphics water_splashes. */
    setSplashesEnabled(enabled: boolean): void {
        this.splashes.enabled = enabled;

        if (!enabled) {
            this.splashes.clear();
        }
    }

    /**
     * Something hits the water at (x, z) with `strength` (0-2, splashStrength) and footprint `size` (m):
     * particles, a foam ring and waves. Returns false where there is no water.
     */
    splash(
        x: number,
        z: number,
        strength: number,
        size = 0.5,
        vx = 0,
        vz = 0,
    ): boolean {
        const level = this.water.levelAt(x, z);

        if (level === null || level <= this.water.terrain.sample(x, z)) {
            return false;
        }

        const s = Math.max(0, Math.min(2, strength));
        this.splashes.splash(x, level, z, s, size, vx, vz);
        this.water.ripples.disturb({
            x,
            z,
            radius: Math.max(0.25, size * 0.6),
            amount: -(0.04 + 0.16 * s) * Math.min(1.5, size + 0.3),
            foam: Math.min(1, 0.5 + s * 0.4),
        });
        this.onSound?.('splash', Math.min(1, 0.25 + s * 0.5));

        return true;
    }

    /** A prop was placed or moved (editor / MCP): splashes when it lands in water, ripples while dragged. */
    propMoved(
        x: number,
        z: number,
        radius: number,
        from: { x: number; z: number } | null,
    ): void {
        const level = this.water.levelAt(x, z);

        if (level === null || level <= this.water.terrain.sample(x, z)) {
            return;
        }

        const wasWet =
            from !== null &&
            (this.water.levelAt(from.x, from.z) ?? -Infinity) >
                this.water.terrain.sample(from.x, from.z);

        if (!wasWet) {
            // Dropped in: as if from about a metre.
            this.splash(x, z, splashStrength(5, radius), radius * 2);

            return;
        }

        const moved = Math.hypot(x - from.x, z - from.z);

        if (moved > 0.01) {
            this.water.ripples.disturb({
                x,
                z,
                radius: Math.max(0.3, radius),
                amount: Math.min(0.05, moved * 0.02),
                foam: 0,
            });
        }
    }

    /** Per frame: the character (null when not playing / walking) and the particles. */
    update(dt: number, character: WaderState | null): void {
        if (character) {
            this.updateCharacter(dt, character);
            this.wasCharacter = true;
        } else if (this.wasCharacter) {
            this.wasCharacter = false;
            this.wading = false;
            this.swimming = false;
            this.underwater = false;
            this.depth = 0;
            characterSoak.amount.value = 0;
        }

        this.splashes.update(dt);
    }

    state(): WaterInteractionState {
        return {
            wading: this.wading,
            swimming: this.swimming,
            water_depth_m: Math.round(this.depth * 100) / 100,
            wet: Math.round(this.wetness.amount * 100) / 100,
            wet_line_m: Math.round(this.wetness.line * 100) / 100,
            underwater: this.underwater,
        };
    }

    dispose(): void {
        this.splashes.dispose();
    }

    private updateCharacter(dt: number, c: WaderState): void {
        const p = c.position;
        const level = this.water.levelAt(p.x, p.z);
        const submerged = level === null ? 0 : level - p.y;
        const speed = Math.hypot(c.velocity.x, c.velocity.z);
        const moving = speed > 0.3;
        this.depth = Math.max(0, submerged);
        this.swimming = c.swimming;
        this.underwater = !!c.headUnder;
        this.wading = !c.swimming && submerged > WADE_MIN_DEPTH;

        // Falling in: crossing the surface downwards.
        const vy = Math.min(c.velocity.y, this.lastVy);

        if (
            level !== null &&
            this.lastSubmerged <= 0.05 &&
            submerged > 0.05 &&
            vy < -1.5
        ) {
            this.splash(
                p.x,
                p.z,
                splashStrength(-vy, c.height * 0.35),
                c.height * 0.3,
                c.velocity.x,
                c.velocity.z,
            );
        }

        this.lastSubmerged = submerged;
        this.lastVy = c.velocity.y;
        const dirX = speed > 1e-3 ? c.velocity.x / speed : -Math.sin(c.yaw);
        const dirZ = speed > 1e-3 ? c.velocity.z / speed : -Math.cos(c.yaw);

        if (this.wading && level !== null) {
            this.wade(dt, c, level, submerged, speed, dirX, dirZ);
        } else if (c.swimming && level !== null) {
            this.swim(dt, c, level, speed, dirX, dirZ);
        } else {
            this.stride = 0;
        }

        // Wet clothes.
        this.wetness.update(
            dt,
            Math.max(0, submerged),
            c.height,
            c.swimming,
            moving,
        );
        characterSoak.line.value = p.y + this.wetness.line;
        characterSoak.amount.value = this.wetness.amount;
        this.dripCarry += this.wetness.dripRate() * dt;

        while (this.dripCarry >= 1) {
            this.dripCarry -= 1;
            const a = Math.random() * Math.PI * 2;
            const r = 0.1 + Math.random() * 0.12;
            this.splashes.drip(
                p.x + Math.cos(a) * r,
                p.y +
                    Math.min(this.wetness.line, c.height * 0.6) *
                        (0.3 + Math.random() * 0.7),
                p.z + Math.sin(a) * r,
            );
        }
    }

    private wade(
        dt: number,
        c: WaderState,
        level: number,
        submerged: number,
        speed: number,
        dirX: number,
        dirZ: number,
    ): void {
        const p = c.position;
        const deep = Math.min(1, submerged / (c.height * 0.5));

        // The legs push a bow wave ahead and leave a trough behind: a V-shaped wake as they move on.
        if (speed > 0.2) {
            const push = Math.min(3, speed) * dt;
            this.water.ripples.disturb({
                x: p.x + dirX * 0.25,
                z: p.z + dirZ * 0.25,
                radius: 0.22 + deep * 0.12,
                amount: push * 0.05 * (0.4 + deep),
                foam: 0,
            });
            this.water.ripples.disturb({
                x: p.x - dirX * 0.2,
                z: p.z - dirZ * 0.2,
                radius: 0.25 + deep * 0.1,
                amount: -push * 0.04 * (0.4 + deep),
                foam: 0,
            });
        }

        // Footsteps: one per half stride.
        this.stride += speed * dt;
        const step = Math.max(0.35, c.height * 0.4);

        if (this.stride < step) {
            return;
        }

        this.stride -= step;
        this.foot = -this.foot;
        const sideX = -dirZ * 0.12 * this.foot;
        const sideZ = dirX * 0.12 * this.foot;
        const fx = p.x + sideX + dirX * 0.15;
        const fz = p.z + sideZ + dirZ * 0.15;
        const shallow = 1 - deep * 0.5;
        this.water.ripples.disturb({
            x: fx,
            z: fz,
            radius: 0.18,
            amount: -(0.012 + speed * 0.008) * shallow,
            foam: speed > 3.5 ? 0.25 : 0,
        });
        // Spray at the shins, more when running through shallow water.
        const kick = Math.round(
            (2 + speed * 2.2) * (submerged < 0.5 ? 1 : 0.5),
        );
        this.splashes.kick(fx, level, fz, speed, dirX, dirZ, kick);
        this.onSound?.('step', Math.min(1, 0.2 + speed * 0.12));
    }

    private swim(
        dt: number,
        c: WaderState,
        level: number,
        speed: number,
        dirX: number,
        dirZ: number,
    ): void {
        const p = c.position;

        // Under water: no rings on the surface (unless just below it), bubbles from the breath and
        // the strokes instead.
        if (c.headUnder) {
            const head = p.y + c.height * 0.85;
            this.bubbleCarry += dt * (1.5 + speed * 2);

            while (this.bubbleCarry >= 1) {
                this.bubbleCarry -= 1;
                this.splashes.bubbles(
                    p.x - dirX * 0.1,
                    head,
                    p.z - dirZ * 0.1,
                    1 + Math.floor(Math.random() * 3),
                    0.015,
                );
            }

            this.strokePhase += dt * (0.8 + speed * 0.5);

            if (this.strokePhase >= 1) {
                this.strokePhase = 0;

                if (speed > 0.3) {
                    this.splashes.bubbles(
                        p.x + dirX * 0.4,
                        p.y + c.height * 0.5,
                        p.z + dirZ * 0.4,
                        5,
                        0.01,
                    );
                    this.onSound?.('bubbles', 0.3);
                }
            }

            // A diver close below the surface still pushes a faint bulge.
            if (head > level - 1 && speed > 0.2) {
                this.water.ripples.disturb({
                    x: p.x,
                    z: p.z,
                    radius: 0.4,
                    amount: Math.min(2, speed) * dt * 0.02,
                    foam: 0,
                });
            }

            return;
        }

        // Wake behind the body.
        if (speed > 0.2) {
            this.water.ripples.disturb({
                x: p.x + dirX * 0.4,
                z: p.z + dirZ * 0.4,
                radius: 0.3,
                amount: Math.min(2, speed) * dt * 0.06,
                foam: 0,
            });
        }

        // Strokes: an arm enters the water ahead, alternating sides.
        this.strokePhase += dt * (0.8 + speed * 0.5);

        if (this.strokePhase >= 1 && speed > 0.3) {
            this.strokePhase = 0;
            this.foot = -this.foot;
            const x = p.x + dirX * 0.6 - dirZ * 0.25 * this.foot;
            const z = p.z + dirZ * 0.6 + dirX * 0.25 * this.foot;
            this.water.ripples.disturb({
                x,
                z,
                radius: 0.2,
                amount: -0.03,
                foam: 0.25,
            });
            this.onSound?.('stroke', 0.35);
        } else if (this.strokePhase >= 1) {
            this.strokePhase = 0;
        }
    }
}
