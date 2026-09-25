import type { FoliageType } from '@game/shared/types';
import type {
    FoliagePreview as FoliagePreviewEngine,
    FoliagePreviewStats,
    PreviewMode,
} from '@game/preview/FoliagePreview';
import {
    Focus,
    LandPlot,
    MonitorX,
    RotateCcw,
    ShieldCheck,
    Wind,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Spinner } from '@/components/ui/spinner';
import { Toggle } from '@/components/ui/toggle';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

type Status = 'loading' | 'ready' | 'unsupported' | 'error';

type Props = {
    /** The (possibly unsaved) foliage type to preview; every change is reflected live. */
    type: FoliageType;
    className?: string;
};

function webglAvailable(): boolean {
    try {
        const canvas = document.createElement('canvas');

        return !!(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
    } catch {
        return false;
    }
}

/**
 * Live Three.js preview of a foliage type using the game's own foliage renderer.
 * The engine (three.js + game code) is loaded on demand so the page itself stays light.
 */
export function FoliagePreview({ type, className }: Props) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const engineRef = useRef<FoliagePreviewEngine | null>(null);
    const typeRef = useRef(type);
    const [status, setStatus] = useState<Status>('loading');
    const [mode, setMode] = useState<PreviewMode>('specimen');
    const [wind, setWind] = useState(0.6);
    const [showRules, setShowRules] = useState(false);
    const [stats, setStats] = useState<FoliagePreviewStats | null>(null);
    const settingsRef = useRef({ mode, wind, showRules });

    useEffect(() => {
        typeRef.current = type;
        engineRef.current?.setType(type);
    }, [type]);

    useEffect(() => {
        settingsRef.current = { mode, wind, showRules };
        const engine = engineRef.current;

        if (engine) {
            engine.setMode(mode);
            engine.setWind(wind);
            engine.setShowRules(showRules);
        }
    }, [mode, wind, showRules]);

    useEffect(() => {
        const canvas = canvasRef.current;
        let cancelled = false;
        let engine: FoliagePreviewEngine | null = null;

        if (!canvas) {
            return;
        }

        if (!webglAvailable()) {
            setStatus('unsupported');

            return;
        }

        import('@game/preview/FoliagePreview')
            .then(({ FoliagePreview: Engine }) => {
                if (cancelled) {
                    return;
                }

                engine = new Engine(canvas);
                engine.onStats = setStats;
                const settings = settingsRef.current;
                engine.setWind(settings.wind);
                engine.setShowRules(settings.showRules);
                engine.setMode(settings.mode);
                engine.setType(typeRef.current);
                engineRef.current = engine;
                setStatus('ready');
            })
            .catch((error: unknown) => {
                console.error('Foliage preview failed to start', error);

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
        <div className={cn('grid gap-2', className)}>
            <div className="relative aspect-[16/10] overflow-hidden rounded-xl border bg-gradient-to-b from-sky-200 to-emerald-100 dark:from-slate-800 dark:to-slate-900">
                <canvas
                    ref={canvasRef}
                    className={cn(
                        'block size-full touch-none outline-none',
                        failed && 'hidden',
                    )}
                    aria-label={`3D preview of ${type.name || 'this foliage type'}`}
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

                {status === 'ready' && (
                    <>
                        <div className="absolute inset-x-2 top-2 flex items-start justify-between gap-2">
                            <ToggleGroup
                                type="single"
                                variant="outline"
                                size="sm"
                                value={mode}
                                onValueChange={(v) =>
                                    v && setMode(v as PreviewMode)
                                }
                                className="bg-background/85 backdrop-blur"
                                aria-label="Preview mode"
                            >
                                <ToggleGroupItem
                                    value="specimen"
                                    className="px-2.5"
                                    title="Three instances at min, mid and max scale"
                                >
                                    <Focus />
                                    Specimen
                                </ToggleGroupItem>
                                <ToggleGroupItem
                                    value="scatter"
                                    className="px-2.5"
                                    title="Scattered over a test terrain with a hill and a pond"
                                >
                                    <LandPlot />
                                    Scatter
                                </ToggleGroupItem>
                            </ToggleGroup>

                            <div className="flex gap-1.5">
                                {mode === 'scatter' && (
                                    <Toggle
                                        variant="outline"
                                        size="sm"
                                        pressed={showRules}
                                        onPressedChange={setShowRules}
                                        className="bg-background/85 px-2.5 backdrop-blur data-[state=on]:bg-emerald-600 data-[state=on]:text-white"
                                        title="Tint ground where the slope / height / water rules allow placement"
                                    >
                                        <ShieldCheck />
                                        <span className="hidden sm:inline">
                                            Placement rules
                                        </span>
                                    </Toggle>
                                )}
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="icon"
                                    className="size-8 bg-background/85 backdrop-blur"
                                    onClick={() =>
                                        engineRef.current?.resetCamera()
                                    }
                                    title="Reset camera"
                                    aria-label="Reset camera"
                                >
                                    <RotateCcw />
                                </Button>
                            </div>
                        </div>

                        <div className="absolute bottom-2 left-2 flex w-44 items-center gap-2 rounded-md border bg-background/85 px-2 py-1.5 backdrop-blur">
                            <Wind
                                className="size-4 shrink-0 text-muted-foreground"
                                aria-hidden
                            />
                            <Slider
                                value={[wind]}
                                min={0}
                                max={2}
                                step={0.05}
                                onValueChange={([v]) => setWind(v)}
                                aria-label="Wind strength"
                            />
                            <span className="w-7 text-right text-xs text-muted-foreground tabular-nums">
                                {wind.toFixed(1)}
                            </span>
                        </div>

                        {showRules && mode === 'scatter' && (
                            <div className="absolute right-2 bottom-2 flex gap-2 rounded-md border bg-background/85 px-2 py-1 text-xs backdrop-blur">
                                <span className="flex items-center gap-1">
                                    <span className="size-2.5 rounded-sm bg-[#3fdc6a]" />
                                    Allowed
                                </span>
                                <span className="flex items-center gap-1">
                                    <span className="size-2.5 rounded-sm bg-[#e5484d]" />
                                    Blocked
                                </span>
                            </div>
                        )}
                    </>
                )}
            </div>

            {stats && status === 'ready' && (
                <PreviewStats stats={stats} configuredDensity={type.density} />
            )}
        </div>
    );
}

function PreviewStats({
    stats,
    configuredDensity,
}: {
    stats: FoliagePreviewStats;
    configuredDensity: number;
}) {
    const items: string[] = [
        `${formatNumber(stats.instances, 0)} ${stats.instances === 1 ? 'instance' : 'instances'}`,
        stats.lodCount > 1
            ? `LOD0 ${formatNumber(stats.trianglesLod0, 0)} / LOD1 ${formatNumber(stats.trianglesLod1, 0)} tris`
            : `${formatNumber(stats.trianglesLod0, 0)} tris${stats.usingModel ? ' (GLB)' : ''}`,
        `${formatNumber(stats.drawCalls, 0)} draw calls`,
    ];

    if (stats.mode === 'scatter') {
        const share = stats.patchArea
            ? Math.round((stats.allowedArea / stats.patchArea) * 100)
            : 0;
        items.push(
            `${formatNumber(stats.densityPer100, 2)} / ${formatNumber(configuredDensity, 2)} per 100 m² on allowed ground (${share}% of plot)`,
        );
        items.push(
            stats.cullRingVisible
                ? `cull ${formatNumber(stats.cullDistance, 0)} m (ring)`
                : `cull ${formatNumber(stats.cullDistance, 0)} m (beyond plot)`,
        );
    }

    return (
        <p className="text-xs text-muted-foreground tabular-nums">
            {items.join(' · ')}
        </p>
    );
}
