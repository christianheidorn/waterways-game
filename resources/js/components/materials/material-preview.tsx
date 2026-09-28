import type { TerrainMaterialRef } from '@game/shared/types';
import type {
    MaterialPreview as MaterialPreviewEngine,
    MaterialPreviewShape,
} from '@game/preview/MaterialPreview';
import { Box, Circle, MonitorX, Mountain, RotateCcw, Sun } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Spinner } from '@/components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { formatTimeOfDay } from '@/lib/format';
import { cn } from '@/lib/utils';

type Status = 'loading' | 'ready' | 'unsupported' | 'error';

export type MaterialPreviewOptions = {
    tileSize?: number;
    tint?: string;
    roughnessScale?: number;
    normalStrength?: number;
};

type Props = {
    material: TerrainMaterialRef;
    /** Overrides applied on top of the material (live, e.g. while editing). */
    options?: MaterialPreviewOptions;
    initialShape?: MaterialPreviewShape;
    /** Hide the shape toggle / light slider (compact inline previews). */
    controls?: boolean;
    className?: string;
};

const SHAPES: {
    value: MaterialPreviewShape;
    label: string;
    icon: typeof Circle;
}[] = [
    { value: 'sphere', label: 'Sphere', icon: Circle },
    { value: 'terrain', label: 'Terrain', icon: Mountain },
    { value: 'plane', label: 'Plane', icon: Box },
];

function webglAvailable(): boolean {
    try {
        const canvas = document.createElement('canvas');

        return !!(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
    } catch {
        return false;
    }
}

/**
 * Live PBR preview of a terrain material using the game's renderer. three.js and the
 * game code are loaded on demand. Mount at most one or two at a time: browsers cap the
 * number of WebGL / WebGPU contexts per page.
 */
export function MaterialPreview({
    material,
    options,
    initialShape = 'sphere',
    controls = true,
    className,
}: Props) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const engineRef = useRef<MaterialPreviewEngine | null>(null);
    const [status, setStatus] = useState<Status>('loading');
    const [shape, setShape] = useState<MaterialPreviewShape>(initialShape);
    const [hour, setHour] = useState(14);
    const latest = useRef({ material, options, shape, hour });

    latest.current = { material, options, shape, hour };

    const tileSize = options?.tileSize;
    const tint = options?.tint;
    const roughnessScale = options?.roughnessScale;
    const normalStrength = options?.normalStrength;
    const mapsKey = JSON.stringify(material.maps);

    useEffect(() => {
        engineRef.current?.setMaterial(latest.current.material, {
            tileSize,
            tint,
            roughnessScale,
            normalStrength,
        });
    }, [material.id, mapsKey, tileSize, tint, roughnessScale, normalStrength]);

    useEffect(() => {
        engineRef.current?.setShape(shape);
    }, [shape]);

    useEffect(() => {
        engineRef.current?.setLight(hour);
    }, [hour]);

    useEffect(() => {
        const canvas = canvasRef.current;
        let cancelled = false;
        let engine: MaterialPreviewEngine | null = null;

        if (!canvas) {
            return;
        }

        if (!webglAvailable()) {
            setStatus('unsupported');

            return;
        }

        import('@game/preview/MaterialPreview')
            .then(({ MaterialPreview: Engine }) => Engine.create(canvas))
            .then((created) => {
                if (cancelled) {
                    created.dispose();

                    return;
                }

                const current = latest.current;
                engine = created;
                engine.setShape(current.shape);
                engine.setLight(current.hour);
                engine.setMaterial(current.material, current.options);
                engineRef.current = engine;
                setStatus('ready');
            })
            .catch((error: unknown) => {
                console.error('Material preview failed to start', error);

                if (!cancelled) {
                    setStatus('error');
                }
            });

        return () => {
            cancelled = true;
            engine?.dispose();
            engineRef.current = null;
        };
    }, []);

    const failed = status === 'unsupported' || status === 'error';

    return (
        <div
            className={cn(
                'relative aspect-[16/10] overflow-hidden rounded-xl border bg-gradient-to-b from-sky-200 to-stone-200 dark:from-slate-800 dark:to-slate-950',
                className,
            )}
        >
            <canvas
                ref={canvasRef}
                className={cn(
                    'block size-full touch-none outline-none',
                    failed && 'hidden',
                )}
                aria-label={`3D preview of ${material.name}`}
            />

            {status === 'loading' && (
                <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Spinner />
                    Loading preview…
                </div>
            )}

            {failed && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
                    <MonitorX className="size-6" />
                    {status === 'unsupported'
                        ? 'Live preview needs WebGL, which is not available in this browser.'
                        : 'The live preview could not be started.'}
                </div>
            )}

            {status === 'ready' && controls && (
                <>
                    <div className="absolute inset-x-2 top-2 flex items-start justify-between gap-2">
                        <ToggleGroup
                            type="single"
                            variant="outline"
                            size="sm"
                            value={shape}
                            onValueChange={(v) =>
                                v && setShape(v as MaterialPreviewShape)
                            }
                            className="bg-background/85 backdrop-blur"
                            aria-label="Preview shape"
                        >
                            {SHAPES.map((s) => (
                                <ToggleGroupItem
                                    key={s.value}
                                    value={s.value}
                                    className="px-2.5"
                                    aria-label={s.label}
                                >
                                    <s.icon />
                                    <span className="hidden sm:inline">
                                        {s.label}
                                    </span>
                                </ToggleGroupItem>
                            ))}
                        </ToggleGroup>
                        <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            className="size-8 bg-background/85 backdrop-blur"
                            onClick={() => engineRef.current?.resetCamera()}
                            title="Reset camera"
                            aria-label="Reset camera"
                        >
                            <RotateCcw />
                        </Button>
                    </div>

                    <div className="absolute bottom-2 left-2 flex w-48 items-center gap-2 rounded-md border bg-background/85 px-2 py-1.5 backdrop-blur">
                        <Sun
                            className="size-4 shrink-0 text-muted-foreground"
                            aria-hidden
                        />
                        <Slider
                            value={[hour]}
                            min={5}
                            max={21}
                            step={0.25}
                            onValueChange={([v]) => setHour(v)}
                            aria-label="Time of day"
                        />
                        <span className="w-10 text-right text-xs text-muted-foreground tabular-nums">
                            {formatTimeOfDay(hour)}
                        </span>
                    </div>
                </>
            )}
        </div>
    );
}
