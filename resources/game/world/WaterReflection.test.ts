import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import {
    PRESET_KEYS,
    PRESETS,
    SCALABILITY_GROUPS,
} from '../shared/graphicsPresets';
import {
    REFLECTION_OFF,
    REFLECTION_ON,
    waterCoverage,
} from './WaterReflection';

function camera(y: number, look: THREE.Vector3): THREE.PerspectiveCamera {
    const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
    cam.position.set(0, y, 0);
    cam.lookAt(look);
    cam.updateMatrixWorld();

    return cam;
}

describe('waterCoverage', () => {
    const lake = (x: number, z: number) =>
        Math.hypot(x, z - 40) < 30 ? 0 : null;

    it('is high looking down at a lake and zero looking at the sky', () => {
        const down = waterCoverage(
            camera(10, new THREE.Vector3(0, 0, 40)),
            0,
            lake,
        );
        const sky = waterCoverage(
            camera(10, new THREE.Vector3(0, 30, -40)),
            0,
            lake,
        );

        expect(down).toBeGreaterThan(0.3);
        expect(sky).toBe(0);
    });

    it('ignores water at another level and far-away water', () => {
        const other = waterCoverage(
            camera(10, new THREE.Vector3(0, 0, 40)),
            0,
            (x, z) => (Math.hypot(x, z - 40) < 30 ? 5 : null),
        );
        const far = (x: number, z: number) => (z > 3000 ? 0 : null);
        const horizon = waterCoverage(
            camera(2, new THREE.Vector3(0, 1.9, 100)),
            0,
            far,
        );

        expect(other).toBe(0);
        expect(horizon).toBe(0);
        expect(REFLECTION_OFF).toBeLessThan(REFLECTION_ON);
    });
});

describe('graphics presets', () => {
    it('set the Retina render scale, lower on cheaper presets', () => {
        expect(PRESET_KEYS).toContain('retina_render_scale');
        expect(PRESETS.low.retina_render_scale).toBeLessThan(
            PRESETS.high.retina_render_scale,
        );
        expect(PRESETS.high.retina_render_scale).toBeLessThan(
            PRESETS.epic.retina_render_scale,
        );
        expect(PRESETS.cinematic.retina_render_scale).toBe(1);
        const grouped = SCALABILITY_GROUPS.flatMap((g) => g.keys);
        expect(grouped.filter((k) => k === 'retina_render_scale')).toHaveLength(
            1,
        );
    });
});
