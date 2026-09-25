import * as THREE from 'three';
import { SPLAT_CHANNELS } from '../shared/types';
import type { TerrainLayer } from '../shared/types';
import type { GridRect, Heightfield } from './Heightfield';

/**
 * Eight material weights per heightmap sample, stored interleaved (8 bytes per texel) and mirrored
 * into two RGBA8 textures for the terrain shader.
 */
export class SplatMap {
    readonly resolution: number;
    readonly channels = SPLAT_CHANNELS;
    readonly data: Uint8Array;
    readonly textures: [THREE.DataTexture, THREE.DataTexture];
    private readonly texData: [Uint8Array, Uint8Array];

    constructor(resolution: number, data?: Uint8Array) {
        this.resolution = resolution;
        const count = resolution * resolution;
        this.data = data ?? new Uint8Array(count * SPLAT_CHANNELS);

        if (this.data.length !== count * SPLAT_CHANNELS) {
            throw new Error('Splat map size mismatch.');
        }

        this.texData = [new Uint8Array(count * 4), new Uint8Array(count * 4)];
        this.textures = [
            this.makeTexture(this.texData[0]),
            this.makeTexture(this.texData[1]),
        ];
        this.syncRect({ x0: 0, z0: 0, x1: resolution - 1, z1: resolution - 1 });
    }

    /** Copies a region of the interleaved data into the GPU textures. */
    syncRect(rect: GridRect): void {
        const res = this.resolution;
        const [a, b] = this.texData;

        for (let row = rect.z0; row <= rect.z1; row++) {
            for (let col = rect.x0; col <= rect.x1; col++) {
                const i = row * res + col;
                const s = i * 8;
                const t = i * 4;
                a[t] = this.data[s];
                a[t + 1] = this.data[s + 1];
                a[t + 2] = this.data[s + 2];
                a[t + 3] = this.data[s + 3];
                b[t] = this.data[s + 4];
                b[t + 1] = this.data[s + 5];
                b[t + 2] = this.data[s + 6];
                b[t + 3] = this.data[s + 7];
            }
        }

        for (const texture of this.textures) {
            texture.needsUpdate = true;
        }
    }

    /**
     * Adds weight to one channel, renormalising the others so the texel still sums to 255.
     * `amount` is 0..1 of full weight.
     */
    paint(col: number, row: number, channel: number, amount: number): void {
        const base = (row * this.resolution + col) * 8;
        const d = this.data;
        const current = d[base + channel] / 255;
        const target = Math.min(1, Math.max(0, current + amount));

        if (target === current) {
            return;
        }

        const othersBefore = 1 - current;
        const othersAfter = 1 - target;
        let sum = 0;

        for (let c = 0; c < 8; c++) {
            if (c === channel) {
                continue;
            }

            const v =
                othersBefore > 1e-6
                    ? (d[base + c] / 255) * (othersAfter / othersBefore)
                    : 0;
            d[base + c] = Math.round(v * 255);
            sum += d[base + c];
        }

        // If we're erasing and nothing else has weight, spill into channel 0 (or 1 if erasing 0).
        let own = Math.max(0, 255 - sum);

        if (othersBefore <= 1e-6 && target < current) {
            const spill = channel === 0 ? 1 : 0;
            d[base + spill] = Math.round((current - target) * 255);
            own = 255 - d[base + spill];
        }

        d[base + channel] = own;
    }

    fill(channel: number): void {
        this.data.fill(0);

        for (let i = 0; i < this.resolution * this.resolution; i++) {
            this.data[i * 8 + channel] = 255;
        }

        this.syncRect({
            x0: 0,
            z0: 0,
            x1: this.resolution - 1,
            z1: this.resolution - 1,
        });
    }

    /**
     * Procedural auto-painting from each layer's height/slope rules. Layers without rules act as the base.
     */
    autoPaint(
        heights: Heightfield,
        layers: TerrainLayer[],
        rect?: GridRect,
    ): void {
        const res = this.resolution;
        const r = rect ?? { x0: 0, z0: 0, x1: res - 1, z1: res - 1 };
        const ruled = layers
            .filter(
                (l) =>
                    l.auto_min_height !== null ||
                    l.auto_max_height !== null ||
                    l.auto_min_slope !== null ||
                    l.auto_max_slope !== null,
            )
            .sort((a, b) => a.auto_priority - b.auto_priority);
        const base = layers.find((l) => !ruled.includes(l)) ?? layers[0];

        if (!base) {
            return;
        }

        const weights = new Float32Array(8);
        const normal: number[] = [0, 1, 0];
        const range = heights.minMax();
        const blendH = Math.max(1, (range.max - range.min) * 0.01);
        const blendS = 4;

        for (let row = r.z0; row <= r.z1; row++) {
            for (let col = r.x0; col <= r.x1; col++) {
                heights.normalAtSample(col, row, normal, 0);
                const slope =
                    (Math.acos(Math.min(1, normal[1])) * 180) / Math.PI;
                const h = heights.data[row * res + col];
                weights.fill(0);
                weights[base.slot] = 1;

                for (const layer of ruled) {
                    let w = 1;
                    w *= ramp(
                        h,
                        layer.auto_min_height,
                        layer.auto_max_height,
                        blendH,
                    );
                    w *= ramp(
                        slope,
                        layer.auto_min_slope,
                        layer.auto_max_slope,
                        blendS,
                    );

                    if (w <= 0) {
                        continue;
                    }

                    for (let c = 0; c < 8; c++) {
                        weights[c] *= 1 - w;
                    }

                    weights[layer.slot] += w;
                }

                const idx = (row * res + col) * 8;
                let total = 0;

                for (let c = 0; c < 8; c++) {
                    total += weights[c];
                }

                let sum = 0;

                for (let c = 1; c < 8; c++) {
                    const v = Math.round((weights[c] / total) * 255);
                    this.data[idx + c] = v;
                    sum += v;
                }

                this.data[idx] = Math.max(0, 255 - sum);
            }
        }

        this.syncRect(r);
    }

    dispose(): void {
        for (const texture of this.textures) {
            texture.dispose();
        }
    }

    private makeTexture(data: Uint8Array): THREE.DataTexture {
        const texture = new THREE.DataTexture(
            data,
            this.resolution,
            this.resolution,
            THREE.RGBAFormat,
            THREE.UnsignedByteType,
        );
        texture.magFilter = THREE.LinearFilter;
        texture.minFilter = THREE.LinearFilter;
        texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.generateMipmaps = false;
        texture.needsUpdate = true;

        return texture;
    }
}

/** Soft 0..1 membership of `v` within [min, max] with a blend band on each side. */
function ramp(
    v: number,
    min: number | null,
    max: number | null,
    band: number,
): number {
    let w = 1;

    if (min !== null) {
        w *= smoothstep(min - band, min + band, v);
    }

    if (max !== null) {
        w *= 1 - smoothstep(max - band, max + band, v);
    }

    return w;
}

function smoothstep(a: number, b: number, v: number): number {
    const t = Math.min(1, Math.max(0, (v - a) / (b - a)));

    return t * t * (3 - 2 * t);
}
