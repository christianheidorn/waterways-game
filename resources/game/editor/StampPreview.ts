import * as THREE from 'three/webgpu';
import type { Heightfield } from '../world/Heightfield';
import { Stamp, stampPreviewGrid } from './stamps';
import type { StampParams } from './stamps';

const N = 56;

/**
 * The Sculpt tool's stamp preview: a see-through grid over the footprint showing the terrain as it
 * will be after the stamp, following the cursor.
 */
export class StampPreview {
    private readonly mesh: THREE.LineSegments;
    private readonly positions: THREE.BufferAttribute;
    private lastKey = '';

    constructor(private readonly scene: THREE.Scene) {
        const geometry = new THREE.BufferGeometry();
        this.positions = new THREE.BufferAttribute(
            new Float32Array(N * N * 3),
            3,
        );
        this.positions.setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute('position', this.positions);
        const index: number[] = [];

        for (let j = 0; j < N; j++) {
            for (let i = 0; i < N; i++) {
                const k = j * N + i;

                if (i + 1 < N) {
                    index.push(k, k + 1);
                }

                if (j + 1 < N) {
                    index.push(k, k + N);
                }
            }
        }

        geometry.setIndex(index);
        this.mesh = new THREE.LineSegments(
            geometry,
            new THREE.LineBasicMaterial({
                color: 0xffd36b,
                transparent: true,
                opacity: 0.55,
                depthWrite: false,
            }),
        );
        this.mesh.frustumCulled = false;
        this.mesh.renderOrder = 9;
        this.mesh.visible = false;
        scene.add(this.mesh);
    }

    show(hf: Heightfield, params: StampParams | null): void {
        if (!params) {
            this.mesh.visible = false;

            return;
        }

        const key = JSON.stringify(params);

        if (key !== this.lastKey) {
            this.lastKey = key;
            const grid = stampPreviewGrid(hf, new Stamp(hf, params), N);
            (this.positions.array as Float32Array).set(grid);
            this.positions.needsUpdate = true;
        }

        this.mesh.visible = true;
    }

    /** The terrain changed under the preview: recompute next time. */
    invalidate(): void {
        this.lastKey = '';
    }

    dispose(): void {
        this.scene.remove(this.mesh);
        this.mesh.geometry.dispose();
        (this.mesh.material as THREE.Material).dispose();
    }
}
