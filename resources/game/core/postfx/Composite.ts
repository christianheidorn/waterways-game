import * as THREE from 'three';
import type { FrameUniforms } from './common';
import { FRAME_UNIFORMS, fullscreenMaterial, setDefine } from './common';

/**
 * HDR lighting composite, one full-resolution pass for all screen-space lighting terms computed at
 * lower resolution: × ambient occlusion (GTAO), × contact shadows (depth-aware bilateral upsample so
 * shadows never bleed across silhouettes), screen-space reflections (premultiplied), + god rays (weighted
 * by the air in front of each surface, so close foreground is not washed out).
 */
const CompositeShader = /* glsl */ `
    ${FRAME_UNIFORMS}
    uniform sampler2D tColor;
    uniform sampler2D tAO;
    uniform float uAOIntensity;
    uniform sampler2D tContact;
    uniform vec2 uContactSize;
    uniform float uContactStrength;
    uniform sampler2D tSsr;
    uniform sampler2D tRays;
    uniform vec3 uRayColor;
    varying vec2 vUv;

    float contactShadow() {
        float z = linearDepth(vUv);
        vec2 p = vUv * uContactSize - 0.5;
        ivec2 i0 = ivec2(floor(p));
        vec2 f = fract(p);
        ivec2 maxI = ivec2(uContactSize) - 1;
        float sum = 0.0;
        float wsum = 0.0;

        for (int k = 0; k < 4; k++) {
            ivec2 o = ivec2(k & 1, k >> 1);
            vec2 s = texelFetch(tContact, clamp(i0 + o, ivec2(0), maxI), 0).rg;
            vec2 bw = mix(1.0 - f, f, vec2(o));
            float w = bw.x * bw.y * exp(-abs(s.y - z) / (0.03 * z + 0.05) * 3.0) + 1e-4;
            sum += s.x * w;
            wsum += w;
        }

        return sum / wsum;
    }

    void main() {
        vec3 c = texture2D(tColor, vUv).rgb;

        #if AO
            c *= mix(1.0, texture2D(tAO, vUv).r, uAOIntensity);
        #endif

        #if CONTACT
            c *= mix(1.0, contactShadow(), uContactStrength);
        #endif

        #if SSR
            vec4 r = texture2D(tSsr, vUv);
            c = c * (1.0 - r.a) + r.rgb;
        #endif

        #if RAYS
            // In-scattering builds up with the distance travelled through the air: close surfaces (a trunk
            // or foliage right in front of the camera) get little of it instead of being washed out.
            float airDepth = 1.0 - exp(-linearDepth(vUv) / 25.0);
            c += texture2D(tRays, vUv).rgb * uRayColor * airDepth;
        #endif

        gl_FragColor = vec4(c, 1.0);
    }
`;

export type CompositeTerms = {
    ao: THREE.Texture | null;
    contact: THREE.Texture | null;
    contactStrength: number;
    ssr: THREE.Texture | null;
    rays: THREE.Texture | null;
    rayColor: THREE.Vector3;
};

export class Composite {
    readonly material: THREE.ShaderMaterial;

    constructor(uniforms: FrameUniforms) {
        this.material = fullscreenMaterial({
            name: 'WaterwaysLightingComposite',
            uniforms: {
                ...uniforms,
                tColor: { value: null },
                tAO: { value: null },
                uAOIntensity: { value: 0.8 },
                tContact: { value: null },
                uContactSize: { value: new THREE.Vector2(1, 1) },
                uContactStrength: { value: 0 },
                tSsr: { value: null },
                tRays: { value: null },
                uRayColor: { value: new THREE.Vector3() },
            },
            defines: { AO: 0, CONTACT: 0, SSR: 0, RAYS: 0 },
            fragmentShader: CompositeShader,
        });
    }

    set(input: THREE.Texture, terms: CompositeTerms): void {
        const m = this.material;
        const u = m.uniforms;
        u.tColor.value = input;
        u.tAO.value = terms.ao;
        u.tContact.value = terms.contact;
        u.uContactStrength.value = terms.contactStrength;
        u.tSsr.value = terms.ssr;
        u.tRays.value = terms.rays;
        (u.uRayColor.value as THREE.Vector3).copy(terms.rayColor);

        if (terms.contact) {
            const img = terms.contact.image as {
                width: number;
                height: number;
            };
            (u.uContactSize.value as THREE.Vector2).set(img.width, img.height);
        }

        setDefine(m, 'AO', terms.ao ? 1 : 0);
        setDefine(m, 'CONTACT', terms.contact ? 1 : 0);
        setDefine(m, 'SSR', terms.ssr ? 1 : 0);
        setDefine(m, 'RAYS', terms.rays ? 1 : 0);
    }

    dispose(): void {
        this.material.dispose();
    }
}
