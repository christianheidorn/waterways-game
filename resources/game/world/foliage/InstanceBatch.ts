import * as THREE from 'three/webgpu';
import { INSTANCE_ATTRIBUTES } from './FoliageMaterial';
import { INSTANCE_FLOATS } from './instances';

/**
 * Instance buffer of one CPU-culled foliage cell (WebGL 2 fallback path) plus one instanced geometry
 * view per LOD geometry: the views share the LOD's vertex data and this batch's per-instance rows
 * (see FoliageMaterial.attributeInstance), so switching LOD only swaps the mesh's geometry.
 */
export class InstanceBatch {
    readonly array: Float32Array;
    readonly buffer: THREE.InstancedInterleavedBuffer;
    /** Instance bounds (world space); shared by every view for frustum culling. */
    readonly box = new THREE.Box3();
    readonly sphere = new THREE.Sphere();
    private readonly attributes: THREE.InterleavedBufferAttribute[];
    private readonly views = new Map<
        THREE.BufferGeometry,
        THREE.InstancedBufferGeometry
    >();

    constructor(readonly capacity: number) {
        this.array = new Float32Array(capacity * INSTANCE_FLOATS);
        this.buffer = new THREE.InstancedInterleavedBuffer(
            this.array,
            INSTANCE_FLOATS,
        );
        this.buffer.setUsage(THREE.DynamicDrawUsage);
        this.attributes = INSTANCE_ATTRIBUTES.map(
            (_name, i) =>
                new THREE.InterleavedBufferAttribute(this.buffer, 4, i * 4),
        );
    }

    /** Instanced view of a LOD geometry drawing `count` instances of this batch. */
    view(base: THREE.BufferGeometry): THREE.InstancedBufferGeometry {
        let view = this.views.get(base);

        if (!view) {
            view = new THREE.InstancedBufferGeometry();
            view.setIndex(base.index);

            for (const [name, attribute] of Object.entries(base.attributes)) {
                view.setAttribute(name, attribute);
            }

            INSTANCE_ATTRIBUTES.forEach((name, i) =>
                view!.setAttribute(name, this.attributes[i]),
            );

            for (const group of base.groups) {
                view.addGroup(group.start, group.count, group.materialIndex);
            }

            view.setDrawRange(base.drawRange.start, base.drawRange.count);
            view.boundingBox = this.box;
            view.boundingSphere = this.sphere;
            this.views.set(base, view);
        }

        return view;
    }

    /** Uploads the first `count` instances. */
    upload(count: number): void {
        this.buffer.clearUpdateRanges();
        this.buffer.addUpdateRange(0, count * INSTANCE_FLOATS);
        this.buffer.needsUpdate = true;
    }

    setBounds(box: THREE.Box3): void {
        this.box.copy(box);
        box.getBoundingSphere(this.sphere);
    }

    /**
     * Frees the views. The renderer then also drops the LOD's shared vertex / index buffers; other
     * cells drawing that LOD simply upload them again on their next draw.
     */
    dispose(): void {
        for (const view of this.views.values()) {
            view.dispose();
        }

        this.views.clear();
    }
}
