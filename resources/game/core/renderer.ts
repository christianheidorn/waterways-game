/// <reference types="@webgpu/types" />
import type { WebGPURenderer } from 'three/webgpu';

/**
 * The game renderer: three.js' WebGPURenderer, running on WebGPU where available (Metal on macOS,
 * D3D12 on Windows, Vulkan on Linux / Android) and on its WebGL 2 backend everywhere else.
 */
export type GameRenderer = WebGPURenderer;

export type RendererBackend = 'webgpu' | 'webgl';

/** True when the renderer runs on the WebGPU backend (compute, indirect draws, GPU-driven culling). */
export function isWebGpu(renderer: GameRenderer): boolean {
    return !!(renderer.backend as { isWebGPUBackend?: boolean })
        .isWebGPUBackend;
}

let compat: Promise<boolean> | null = null;

/**
 * Browser compatibility for three.js' WebGPU backend: it always sets `swizzle: 'rgba'` on texture views
 * (the final spec form). Chromium builds that shipped the experimental `texture-component-swizzle` with
 * the earlier dictionary form throw on that string, which breaks every texture. The identity swizzle is
 * the default, so it is dropped there.
 *
 * Resolves to whether a WebGPU device is available (the renderer falls back to WebGL 2 otherwise).
 */
export function installWebGpuCompat(): Promise<boolean> {
    compat ??= installCompat();

    return compat;
}

async function installCompat(): Promise<boolean> {
    if (typeof navigator === 'undefined' || !navigator.gpu) {
        return false;
    }

    try {
        const adapter = await navigator.gpu.requestAdapter();
        const device = await adapter?.requestDevice();

        if (!device) {
            return false;
        }

        const texture = device.createTexture({
            size: [1, 1],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING,
        });

        try {
            texture.createView({ swizzle: 'rgba' } as GPUTextureViewDescriptor);
        } catch {
            const proto = GPUTexture.prototype;
            // eslint-disable-next-line typescript/unbound-method -- re-bound with .call below
            const createView = proto.createView;
            proto.createView = function (
                this: GPUTexture,
                descriptor?: GPUTextureViewDescriptor,
            ): GPUTextureView {
                const d = descriptor as
                    | (GPUTextureViewDescriptor & { swizzle?: unknown })
                    | undefined;

                if (d && typeof d.swizzle === 'string') {
                    const { swizzle: _swizzle, ...rest } = d;

                    return createView.call(this, rest);
                }

                return createView.call(this, descriptor);
            };
        } finally {
            texture.destroy();
            device.destroy();
        }

        return true;
    } catch {
        // No adapter: the renderer falls back to WebGL 2.
        return false;
    }
}
