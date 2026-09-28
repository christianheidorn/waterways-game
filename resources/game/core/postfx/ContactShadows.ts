import * as THREE from 'three';
import type { Blitter, FrameUniforms } from './common';
import {
    colorTarget,
    FRAME_UNIFORMS,
    fullscreenMaterial,
    scaledSize,
} from './common';

/**
 * Screen-space contact shadows (half resolution): a short ray march from each surface towards the
 * light through the depth buffer catches the small-scale occlusion shadow maps miss (feet, rocks and
 * grass bases, crevices). The ray length scales with distance so the effect stays a few pixels long.
 * Output: r = light visibility (1 = unshadowed), g = linear depth (for the bilateral upsample).
 */
const ContactShadowShader = /* glsl */ `
    ${FRAME_UNIFORMS}
    uniform vec3 uLightDirView;
    varying vec2 vUv;

    #define STEPS 16

    void main() {
        float d = rawDepth(vUv);
        float z = linearizeDepth(d);

        if (isSky(d)) {
            gl_FragColor = vec4(1.0, z, 0.0, 1.0);
            return;
        }

        vec3 p = viewPosition(vUv, d);
        vec3 n = viewNormal(vUv, p);
        float ndl = dot(n, uLightDirView);

        // Faces turned away from the light are already dark (and self-shadow in the shadow map).
        if (ndl <= 0.02 || z > 400.0) {
            gl_FragColor = vec4(1.0, z, 0.0, 1.0);
            return;
        }

        float rayLength = clamp(z * 0.012, 0.12, 1.6);
        float thickness = clamp(z * 0.01, 0.08, 1.2);
        // Start slightly off the surface (along the normal) to avoid self-intersection.
        vec3 origin = p + n * (0.03 + z * 0.004);
        vec3 stepVec = uLightDirView * rayLength / float(STEPS);
        float jitter = ign(gl_FragCoord.xy);
        float occlusion = 0.0;

        for (int i = 0; i < STEPS; i++) {
            vec3 q = origin + stepVec * (float(i) + jitter);
            vec2 uv = viewToUv(q);

            if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) {
                break;
            }

            float sceneZ = linearDepth(uv);
            float delta = -q.z - sceneZ;

            if (delta > 0.02 + z * 0.003 && delta < thickness) {
                // Fade with distance along the ray so the shadow tapers off.
                occlusion = 1.0 - (float(i) + jitter) / float(STEPS);
                break;
            }
        }

        // Grazing light: fade to avoid acne on surfaces almost parallel to the light.
        occlusion *= smoothstep(0.02, 0.2, ndl) * (1.0 - smoothstep(200.0, 400.0, z));
        gl_FragColor = vec4(1.0 - occlusion, z, 0.0, 1.0);
    }
`;

export class ContactShadows {
    private readonly target: THREE.WebGLRenderTarget;
    private readonly material: THREE.ShaderMaterial;
    readonly lightDirView = new THREE.Vector3();

    constructor(
        uniforms: FrameUniforms,
        private readonly blitter: Blitter,
        width: number,
        height: number,
    ) {
        this.target = colorTarget(
            scaledSize(width, 0.5),
            scaledSize(height, 0.5),
            {
                minFilter: THREE.NearestFilter,
                magFilter: THREE.NearestFilter,
            },
        );
        this.material = fullscreenMaterial({
            name: 'WaterwaysContactShadows',
            uniforms: {
                ...uniforms,
                uLightDirView: { value: this.lightDirView },
            },
            fragmentShader: ContactShadowShader,
        });
    }

    get texture(): THREE.Texture {
        return this.target.texture;
    }

    setSize(width: number, height: number): void {
        this.target.setSize(scaledSize(width, 0.5), scaledSize(height, 0.5));
    }

    render(lightDir: THREE.Vector3, camera: THREE.Camera): void {
        this.lightDirView
            .copy(lightDir)
            .transformDirection(camera.matrixWorldInverse);
        this.blitter.draw(this.material, this.target);
    }

    dispose(): void {
        this.target.dispose();
        this.material.dispose();
    }
}
