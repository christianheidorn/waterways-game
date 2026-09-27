import type { CharacterRef } from '@game/shared/types';
import type { ClipKey } from '@game/player/GltfCharacter';
import { useEffect, useRef, useState } from 'react';
import { Spinner } from '@/components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';

const CLIPS: { key: ClipKey; label: string }[] = [
    { key: 'idle', label: 'Idle' },
    { key: 'walk', label: 'Walk' },
    { key: 'run', label: 'Run' },
    { key: 'jump', label: 'Jump' },
    { key: 'swim', label: 'Swim' },
];

/**
 * Live Three.js preview of a character using the game's own GltfCharacter (same clips, scale
 * and facing as in-game). Three.js is loaded on demand.
 */
export function CharacterPreview({
    character,
    className,
}: {
    character: CharacterRef;
    className?: string;
}) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const clipRef = useRef<ClipKey>('idle');
    const [clip, setClip] = useState<ClipKey>('idle');
    const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
        'loading',
    );

    useEffect(() => {
        clipRef.current = clip;
    }, [clip]);

    useEffect(() => {
        const canvas = canvasRef.current;

        if (!canvas) {
            return;
        }

        let disposed = false;
        let cleanup = () => {};

        void (async () => {
            try {
                const THREE = await import('three');
                const { OrbitControls } =
                    await import('three/addons/controls/OrbitControls.js');
                const { GltfCharacter } =
                    await import('@game/player/GltfCharacter');

                if (disposed) {
                    return;
                }

                const renderer = new THREE.WebGLRenderer({
                    canvas,
                    antialias: true,
                    alpha: true,
                });
                renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
                renderer.toneMapping = THREE.ACESFilmicToneMapping;
                renderer.shadowMap.enabled = true;
                const scene = new THREE.Scene();
                const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 100);
                const h = character.height;
                camera.position.set(h * 1.1, h * 0.75, h * 2.4);
                const controls = new OrbitControls(camera, canvas);
                controls.target.set(0, h * 0.55, 0);
                controls.enableDamping = true;
                scene.add(new THREE.HemisphereLight(0xdde8ff, 0x3a3025, 1.4));
                const sun = new THREE.DirectionalLight(0xffffff, 2.6);
                sun.position.set(2, 4, 3);
                sun.castShadow = true;
                sun.shadow.mapSize.setScalar(1024);
                scene.add(sun);
                const ground = new THREE.Mesh(
                    new THREE.CircleGeometry(h * 1.2, 48),
                    new THREE.MeshStandardMaterial({
                        color: 0x55604a,
                        roughness: 1,
                    }),
                );
                ground.rotation.x = -Math.PI / 2;
                ground.receiveShadow = true;
                scene.add(ground);

                const model = await GltfCharacter.load(
                    character.model_url,
                    h,
                    character.animations,
                );

                if (disposed) {
                    model.dispose();
                    renderer.dispose();

                    return;
                }

                model.root.rotation.y = Math.PI; // Face the camera.
                scene.add(model.root);
                setStatus('ready');

                const resize = () => {
                    const { clientWidth: w, clientHeight: hh } = canvas;
                    renderer.setSize(w, hh, false);
                    camera.aspect = w / Math.max(1, hh);
                    camera.updateProjectionMatrix();
                };
                resize();
                const observer = new ResizeObserver(resize);
                observer.observe(canvas);

                const clock = new THREE.Clock();
                let frame = 0;
                const tick = () => {
                    frame = requestAnimationFrame(tick);
                    const key = clipRef.current;
                    model.update(clock.getDelta(), {
                        speed: key === 'run' ? 7.5 : key === 'walk' ? 3.2 : 0,
                        runSpeed: 7.5,
                        grounded: key !== 'jump',
                        swimming: key === 'swim',
                        verticalVelocity: 0,
                    });
                    controls.update();
                    renderer.render(scene, camera);
                };
                tick();

                cleanup = () => {
                    cancelAnimationFrame(frame);
                    observer.disconnect();
                    controls.dispose();
                    model.dispose();
                    renderer.dispose();
                    renderer.forceContextLoss();
                };
            } catch (error) {
                console.error(error);

                if (!disposed) {
                    setStatus('error');
                }
            }
        })();

        return () => {
            disposed = true;
            cleanup();
        };
    }, [character]);

    return (
        <div className={cn('grid gap-2', className)}>
            <div className="relative aspect-[4/3] overflow-hidden rounded-xl border bg-gradient-to-b from-sky-100 to-sky-50 dark:from-slate-800 dark:to-slate-900">
                <canvas
                    ref={canvasRef}
                    className="size-full"
                    aria-label={`3D preview of ${character.name}`}
                />
                {status !== 'ready' && (
                    <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                        {status === 'loading' ? (
                            <Spinner />
                        ) : (
                            'Could not load the model.'
                        )}
                    </div>
                )}
            </div>
            <ToggleGroup
                type="single"
                variant="outline"
                value={clip}
                onValueChange={(v) => v && setClip(v as ClipKey)}
                className="w-full"
                aria-label="Animation"
            >
                {CLIPS.map((c) => (
                    <ToggleGroupItem
                        key={c.key}
                        value={c.key}
                        className="flex-1"
                    >
                        {c.label}
                    </ToggleGroupItem>
                ))}
            </ToggleGroup>
        </div>
    );
}
