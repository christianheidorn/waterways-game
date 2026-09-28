import * as THREE from 'three/webgpu';
import { FOLIAGE_STRIDE } from '../../shared/types';

/**
 * GPU layout of one foliage instance: 16 floats = the rows of its affine 3×4 transform (xyz = rotation ×
 * scale, w = translation) followed by a data vec4 (rank within its cell, scale, 1 = live slot, unused).
 * Shared by the per-cell vertex attributes (CPU culling) and the storage buffers (GPU culling).
 */
export const INSTANCE_FLOATS = 16;

/**
 * Writes instance `i` of a flat foliage list (x, y, z, yaw, scale, tiltX, tiltZ) at `out[offset]`.
 * Returns the instance's scale.
 */
export function writeInstance(
    data: ArrayLike<number>,
    i: number,
    out: Float32Array,
    offset: number,
    rank: number,
): number {
    const o = i * FOLIAGE_STRIDE;
    const scale = data[o + 4];
    _p.set(data[o], data[o + 1], data[o + 2]);
    // Yaw first (Y), then tilt to the terrain normal (Z, X).
    _e.set(data[o + 5], data[o + 3], data[o + 6], 'XZY');
    _q.setFromEuler(_e);
    _s.setScalar(scale);
    _m.compose(_p, _q, _s);
    const e = _m.elements;

    for (let r = 0; r < 3; r++) {
        out[offset + r * 4] = e[r];
        out[offset + r * 4 + 1] = e[r + 4];
        out[offset + r * 4 + 2] = e[r + 8];
        out[offset + r * 4 + 3] = e[r + 12];
    }

    out[offset + 12] = rank;
    out[offset + 13] = scale;
    out[offset + 14] = 1;
    out[offset + 15] = 0;

    return scale;
}

const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();
