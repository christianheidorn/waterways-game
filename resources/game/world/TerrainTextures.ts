import * as THREE from 'three/webgpu';
import type { TerrainMaterialRef } from '../shared/types';

export const TERRAIN_SLOTS = 8;

type SlotState = { key: string | null; ready: boolean };

/**
 * GPU texture arrays holding the PBR maps of the (up to) 8 terrain layers:
 *
 * - `albedoRough`: RGB = albedo (sRGB), A = roughness
 * - `normalAoHeight`: RG = tangent normal XY (OpenGL convention, 0.5 = flat), B = AO, A = height
 *
 * Images are decoded off the main thread with createImageBitmap, resized to the array size and
 * packed on a 2D canvas. Missing maps get neutral defaults.
 */
export class TerrainTextures {
    readonly albedoRough: THREE.DataArrayTexture;
    readonly normalAoHeight: THREE.DataArrayTexture;
    readonly size: number;
    private readonly albedoData: Uint8Array;
    private readonly detailData: Uint8Array;
    private readonly slots: SlotState[] = Array.from(
        { length: TERRAIN_SLOTS },
        () => ({ key: null, ready: false }),
    );
    private canvas: HTMLCanvasElement | OffscreenCanvas;
    private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
    /** Called whenever a slot finished loading (e.g. to update shader uniforms). */
    onSlotReady: ((slot: number, ready: boolean) => void) | null = null;

    constructor(size: number) {
        this.size = size;
        const layerBytes = size * size * 4;
        this.albedoData = new Uint8Array(layerBytes * TERRAIN_SLOTS);
        this.detailData = new Uint8Array(layerBytes * TERRAIN_SLOTS);
        this.albedoRough = this.makeArray(
            this.albedoData,
            THREE.SRGBColorSpace,
        );
        this.normalAoHeight = this.makeArray(
            this.detailData,
            THREE.NoColorSpace,
        );

        this.canvas =
            typeof OffscreenCanvas !== 'undefined'
                ? new OffscreenCanvas(size, size)
                : Object.assign(document.createElement('canvas'), {
                      width: size,
                      height: size,
                  });
        const ctx = this.canvas.getContext('2d', { willReadFrequently: true });

        if (!ctx) {
            throw new Error(
                '2D canvas unavailable for terrain texture packing.',
            );
        }

        this.ctx = ctx as
            | CanvasRenderingContext2D
            | OffscreenCanvasRenderingContext2D;
    }

    isReady(slot: number): boolean {
        return this.slots[slot]?.ready ?? false;
    }

    /**
     * Load a material into a slot (no-op if the same material/version is already loaded).
     * `fallbackRoughness` is used when the material has no roughness map.
     */
    async load(
        slot: number,
        ref: TerrainMaterialRef | null,
        fallbackRoughness = 0.85,
    ): Promise<void> {
        const key = ref ? JSON.stringify(ref.maps) : null;
        const state = this.slots[slot];

        if (state.key === key) {
            return;
        }

        state.key = key;
        state.ready = false;
        this.onSlotReady?.(slot, false);

        if (!ref?.maps.albedo) {
            return;
        }

        try {
            const [albedo, normal, roughness, ao, height] = await Promise.all(
                (
                    ['albedo', 'normal', 'roughness', 'ao', 'height'] as const
                ).map((name) => this.decode(ref.maps[name])),
            );

            // A newer request replaced this one while loading.
            if (state.key !== key || !albedo) {
                return;
            }

            const n = this.size * this.size;
            const aData = this.albedoData.subarray(
                slot * n * 4,
                (slot + 1) * n * 4,
            );
            const dData = this.detailData.subarray(
                slot * n * 4,
                (slot + 1) * n * 4,
            );
            const defRough = Math.round(
                THREE.MathUtils.clamp(fallbackRoughness, 0, 1) * 255,
            );

            for (let i = 0; i < n; i++) {
                const p = i * 4;
                aData[p] = albedo[p];
                aData[p + 1] = albedo[p + 1];
                aData[p + 2] = albedo[p + 2];
                aData[p + 3] = roughness ? roughness[p] : defRough;
                dData[p] = normal ? normal[p] : 128;
                dData[p + 1] = normal ? normal[p + 1] : 128;
                dData[p + 2] = ao ? ao[p] : 255;
                dData[p + 3] = height ? height[p] : 128;
            }

            this.albedoRough.addLayerUpdate(slot);
            this.normalAoHeight.addLayerUpdate(slot);
            this.albedoRough.needsUpdate = true;
            this.normalAoHeight.needsUpdate = true;
            state.ready = true;
            this.onSlotReady?.(slot, true);
        } catch (error) {
            console.warn(
                `Terrain material for slot ${slot} failed to load`,
                error,
            );
        }
    }

    clear(slot: number): void {
        this.slots[slot] = { key: null, ready: false };
        this.onSlotReady?.(slot, false);
    }

    dispose(): void {
        this.albedoRough.dispose();
        this.normalAoHeight.dispose();
    }

    private async decode(
        url: string | null,
    ): Promise<Uint8ClampedArray | null> {
        if (!url) {
            return null;
        }

        const response = await fetch(url, { credentials: 'same-origin' });

        if (!response.ok) {
            return null;
        }

        const blob = await response.blob();
        const bitmap = await createImageBitmap(blob, {
            resizeWidth: this.size,
            resizeHeight: this.size,
            resizeQuality: 'high',
            colorSpaceConversion: 'none',
            premultiplyAlpha: 'none',
        });
        this.ctx.clearRect(0, 0, this.size, this.size);
        this.ctx.drawImage(bitmap, 0, 0, this.size, this.size);
        bitmap.close();

        return this.ctx.getImageData(0, 0, this.size, this.size).data;
    }

    private makeArray(
        data: Uint8Array,
        colorSpace: THREE.ColorSpace,
    ): THREE.DataArrayTexture {
        const texture = new THREE.DataArrayTexture(
            data,
            this.size,
            this.size,
            TERRAIN_SLOTS,
        );
        texture.format = THREE.RGBAFormat;
        texture.type = THREE.UnsignedByteType;
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = true;
        texture.anisotropy = 8;
        texture.colorSpace = colorSpace;
        texture.needsUpdate = true;

        return texture;
    }
}
