import * as THREE from 'three';

const VelocityVertex = /* glsl */ `
    #include <common>
    #include <skinning_pars_vertex>
    uniform mat4 uPrevModel;
    uniform mat4 uPrevViewProj;
    uniform mat4 uViewProj;
    varying vec4 vCurrent;
    varying vec4 vPrevious;

    void main() {
        #include <skinbase_vertex>
        #include <begin_vertex>
        #include <skinning_vertex>
        vec4 world = modelMatrix * vec4(transformed, 1.0);
        gl_Position = projectionMatrix * viewMatrix * world;
        vCurrent = uViewProj * world;
        vPrevious = uPrevViewProj * uPrevModel * vec4(transformed, 1.0);
    }
`;

const VelocityFragment = /* glsl */ `
    uniform sampler2D tDepth;
    varying vec4 vCurrent;
    varying vec4 vPrevious;

    void main() {
        // Only where this object is the visible surface of the main render.
        float scene = texelFetch(tDepth, ivec2(gl_FragCoord.xy), 0).x;

        if (gl_FragCoord.z > scene + 5e-5) {
            discard;
        }

        vec2 current = vCurrent.xy / vCurrent.w * 0.5 + 0.5;
        vec2 previous = vPrevious.xy / vPrevious.w * 0.5 + 0.5;
        gl_FragColor = vec4(current - previous, 0.0, 1.0);
    }
`;

/**
 * Screen-space velocity of dynamic objects (e.g. the player), which camera reprojection alone gets
 * wrong: rendered with a swap-in material into a full resolution target (rg = uv motion since the last
 * frame, a = 1 where written). Skinned meshes are handled (current pose, rigid previous transform).
 */
export class VelocityBuffer {
    readonly target: THREE.WebGLRenderTarget;
    private readonly material: THREE.ShaderMaterial;
    private objects: THREE.Object3D[] = [];
    private readonly previous = new WeakMap<THREE.Object3D, THREE.Matrix4>();
    private readonly swapped: [
        THREE.Mesh,
        THREE.Material | THREE.Material[],
    ][] = [];
    private readonly clearColor = new THREE.Color();

    constructor(
        width: number,
        height: number,
        depth: THREE.IUniform<THREE.Texture | null>,
        private readonly prevViewProj: THREE.Matrix4,
        private readonly viewProj: THREE.Matrix4,
    ) {
        this.target = new THREE.WebGLRenderTarget(width, height, {
            type: THREE.HalfFloatType,
            minFilter: THREE.NearestFilter,
            magFilter: THREE.NearestFilter,
            depthBuffer: true,
        });
        const prevModel = { value: new THREE.Matrix4() };
        this.material = new THREE.ShaderMaterial({
            name: 'WaterwaysVelocity',
            uniforms: {
                tDepth: depth,
                uPrevModel: prevModel,
                uPrevViewProj: { value: prevViewProj },
                uViewProj: { value: viewProj },
            },
            vertexShader: VelocityVertex,
            fragmentShader: VelocityFragment,
            toneMapped: false,
        });
        this.material.onBeforeRender = (_r, _s, _c, _g, object) => {
            prevModel.value.copy(
                this.previous.get(object) ?? object.matrixWorld,
            );
            this.material.uniformsNeedUpdate = true;
        };
    }

    setObjects(objects: THREE.Object3D[]): void {
        this.objects = objects;
    }

    get active(): boolean {
        return this.objects.some((o) => o.visible && o.parent !== null);
    }

    setSize(width: number, height: number): void {
        this.target.setSize(width, height);
    }

    render(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
        renderer.getClearColor(this.clearColor);
        const alpha = renderer.getClearAlpha();
        renderer.setRenderTarget(this.target);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, true, false);

        for (const root of this.objects) {
            if (!root.visible || !root.parent) {
                continue;
            }

            root.traverse(this.swapIn);
            renderer.render(root, camera);

            for (const [mesh, material] of this.swapped) {
                mesh.material = material;
            }

            this.swapped.length = 0;
        }

        renderer.setClearColor(this.clearColor, alpha);
    }

    /** Remembers this frame's transforms as the next frame's previous ones. */
    commit(): void {
        for (const root of this.objects) {
            root.traverse(this.remember);
        }
    }

    private readonly swapIn = (o: THREE.Object3D): void => {
        const mesh = o as THREE.Mesh;

        if (mesh.isMesh) {
            this.swapped.push([mesh, mesh.material]);
            mesh.material = this.material;
        }
    };

    private readonly remember = (o: THREE.Object3D): void => {
        const m = this.previous.get(o);

        if (m) {
            m.copy(o.matrixWorld);
        } else {
            this.previous.set(o, o.matrixWorld.clone());
        }
    };

    dispose(): void {
        this.target.dispose();
        this.material.dispose();
    }
}
