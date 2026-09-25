import type { EditorToolGroup, GameMode } from '@game/shared/protocol';
import type { EnvironmentSettings, GameSettings } from '@game/shared/types';
import { Head, Link, router } from '@inertiajs/react';
import {
    Droplets,
    ExternalLink,
    Flag,
    Gamepad2,
    Hammer,
    Loader2,
    Mountain,
    Paintbrush,
    Redo2,
    RotateCw,
    Save,
    Settings2,
    Sun,
    TreePine,
    TriangleAlert,
    Undo2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import AppLogoIcon from '@/components/app-logo-icon';
import { LiveSettings } from '@/components/studio/live-settings';
import { useGameBridge } from '@/components/studio/use-game-bridge';
import { Button } from '@/components/ui/button';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
} from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import maps from '@/routes/maps';
import environmentRoutes from '@/routes/maps/environment';
import gameSettings from '@/routes/game-settings';
import type { MapSummary, SettingGroup, SettingValues } from '@/types';

type Props = {
    map: MapSummary;
    maps: { id: number; name: string; slug: string }[];
    mode: GameMode;
    gameUrl: string;
    environment: EnvironmentSettings;
    environmentGroup: SettingGroup;
    settings: GameSettings;
    settingsGroups: SettingGroup[];
};

const TOOL_GROUPS: {
    value: EditorToolGroup;
    label: string;
    icon: LucideIcon;
}[] = [
    { value: 'sculpt', label: 'Sculpt', icon: Mountain },
    { value: 'paint', label: 'Paint', icon: Paintbrush },
    { value: 'foliage', label: 'Foliage', icon: TreePine },
    { value: 'water', label: 'Water', icon: Droplets },
    { value: 'place', label: 'Place', icon: Flag },
];

const formatHour = (v: number) => {
    const h = Math.floor(v) % 24;
    const m = Math.round((v - Math.floor(v)) * 60);

    return `${String(h).padStart(2, '0')}:${String(m === 60 ? 0 : m).padStart(2, '0')}`;
};

export default function MapEditor({
    map,
    maps: allMaps,
    mode: initialMode,
    gameUrl,
    environment,
    environmentGroup,
    settings,
    settingsGroups,
}: Props) {
    const { iframeRef, state, send, onFrameLoad } = useGameBridge(initialMode);
    const [panel, setPanel] = useState<'environment' | 'settings' | null>(null);
    const [frameKey, setFrameKey] = useState(0);
    const src = useMemo(
        () => `${gameUrl}?embedded=1&mode=${initialMode}`,
        [gameUrl, initialMode],
    );

    // Ctrl+S / Ctrl+Z when the shell (not the iframe) has focus.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (!(e.ctrlKey || e.metaKey)) {
                return;
            }

            if (e.key === 's') {
                e.preventDefault();
                send({ type: 'save' });
            } else if (e.key === 'z' && !isTyping(e)) {
                e.preventDefault();
                send({ type: e.shiftKey ? 'redo' : 'undo' });
            }
        };
        window.addEventListener('keydown', onKey);

        return () => window.removeEventListener('keydown', onKey);
    }, [send]);

    // Warn before leaving with unsaved world changes.
    useEffect(() => {
        const offBefore = router.on('before', (event) => {
            if (
                state.dirty &&
                event.detail.visit.method === 'get' &&
                !window.confirm('The world has unsaved changes. Leave anyway?')
            ) {
                event.preventDefault();
            }
        });
        const onUnload = (e: BeforeUnloadEvent) => {
            if (state.dirty) {
                e.preventDefault();
            }
        };
        window.addEventListener('beforeunload', onUnload);

        return () => {
            offBefore();
            window.removeEventListener('beforeunload', onUnload);
        };
    }, [state.dirty]);

    const setMode = (mode: GameMode) => {
        send({ type: 'setMode', mode });
        iframeRef.current?.focus();
    };

    const reload = () => {
        if (
            state.dirty &&
            !window.confirm(
                'Reloading discards unsaved world changes. Continue?',
            )
        ) {
            return;
        }

        setFrameKey((k) => k + 1);
    };

    const saveLabel = (() => {
        switch (state.saveState) {
            case 'saving':
                return 'Saving…';
            case 'error':
                return 'Save failed';
            default:
                return state.dirty ? 'Unsaved changes' : 'All changes saved';
        }
    })();

    return (
        <>
            <Head title={`${map.name} · Studio`} />
            <div className="dark flex h-dvh flex-col bg-neutral-950 text-neutral-100">
                <header className="flex h-12 shrink-0 items-center gap-1.5 border-b border-white/10 bg-neutral-900 px-2">
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Link
                                href={maps.show(map.slug).url}
                                className="flex size-8 items-center justify-center rounded-md text-sky-400 hover:bg-white/10"
                            >
                                <AppLogoIcon className="size-5" />
                            </Link>
                        </TooltipTrigger>
                        <TooltipContent>Back to map settings</TooltipContent>
                    </Tooltip>

                    <Select
                        value={map.slug}
                        onValueChange={(slug) =>
                            router.visit(maps.editor(slug).url)
                        }
                    >
                        <SelectTrigger
                            size="sm"
                            className="w-44 border-white/10 bg-transparent text-sm"
                        >
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {allMaps.map((m) => (
                                <SelectItem key={m.id} value={m.slug}>
                                    {m.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>

                    <Separator
                        orientation="vertical"
                        className="mx-1 h-6! bg-white/10"
                    />

                    <div className="flex rounded-lg bg-white/5 p-0.5">
                        <ModeButton
                            active={state.mode === 'edit'}
                            icon={Hammer}
                            label="Build"
                            onClick={() => setMode('edit')}
                        />
                        <ModeButton
                            active={state.mode === 'play'}
                            icon={Gamepad2}
                            label="Play"
                            onClick={() => setMode('play')}
                        />
                    </div>

                    {state.mode === 'edit' && (
                        <div className="ml-1 hidden items-center gap-0.5 md:flex">
                            {TOOL_GROUPS.map((g) => (
                                <IconButton
                                    key={g.value}
                                    icon={g.icon}
                                    label={g.label}
                                    active={state.toolGroup === g.value}
                                    onClick={() => {
                                        send({
                                            type: 'setToolGroup',
                                            group: g.value,
                                        });
                                        iframeRef.current?.focus();
                                    }}
                                />
                            ))}
                            <Separator
                                orientation="vertical"
                                className="mx-1 h-6! bg-white/10"
                            />
                            <IconButton
                                icon={Undo2}
                                label="Undo (Ctrl+Z)"
                                disabled={!state.canUndo}
                                onClick={() => send({ type: 'undo' })}
                            />
                            <IconButton
                                icon={Redo2}
                                label="Redo (Ctrl+Shift+Z)"
                                disabled={!state.canRedo}
                                onClick={() => send({ type: 'redo' })}
                            />
                        </div>
                    )}

                    <div className="flex-1" />

                    {state.stats && (
                        <span className="hidden font-mono text-xs text-neutral-400 tabular-nums lg:block">
                            {Math.round(state.stats.fps)} fps ·{' '}
                            {(state.stats.triangles / 1e6).toFixed(1)}M tris
                        </span>
                    )}

                    <span
                        className={cn(
                            'hidden rounded-md px-2 py-1 text-xs sm:block',
                            state.saveState === 'error'
                                ? 'bg-red-500/15 text-red-300'
                                : state.dirty
                                  ? 'bg-amber-500/15 text-amber-200'
                                  : 'text-neutral-400',
                        )}
                        title={state.saveMessage ?? undefined}
                    >
                        {saveLabel}
                    </span>

                    <IconButton
                        icon={Sun}
                        label="Environment"
                        active={panel === 'environment'}
                        onClick={() => setPanel('environment')}
                    />
                    <IconButton
                        icon={Settings2}
                        label="Game settings"
                        active={panel === 'settings'}
                        onClick={() => setPanel('settings')}
                    />
                    <IconButton
                        icon={RotateCw}
                        label="Reload game"
                        onClick={reload}
                    />
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                asChild
                                variant="ghost"
                                size="icon"
                                className="size-8 text-neutral-300 hover:bg-white/10 hover:text-white"
                            >
                                <a
                                    href={`${gameUrl}?mode=play`}
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    <ExternalLink />
                                </a>
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Play in a new tab</TooltipContent>
                    </Tooltip>

                    <Button
                        size="sm"
                        className="ml-1 bg-sky-600 text-white hover:bg-sky-500"
                        disabled={!state.ready || state.saveState === 'saving'}
                        onClick={() => send({ type: 'save' })}
                    >
                        {state.saveState === 'saving' ? (
                            <Loader2 className="animate-spin" />
                        ) : (
                            <Save />
                        )}
                        Save
                    </Button>
                </header>

                <main className="relative min-h-0 flex-1">
                    <iframe
                        key={frameKey}
                        ref={iframeRef}
                        src={src}
                        title={`${map.name} game view`}
                        onLoad={onFrameLoad}
                        className="absolute inset-0 size-full border-0"
                        allow="fullscreen; pointer-lock; gamepad"
                    />
                    {state.error && (
                        <div className="absolute inset-x-0 top-4 mx-auto flex w-fit items-center gap-2 rounded-lg border border-red-500/30 bg-red-950/80 px-4 py-2 text-sm text-red-200">
                            <TriangleAlert className="size-4" /> {state.error}
                        </div>
                    )}
                </main>
            </div>

            <Sheet
                open={panel !== null}
                onOpenChange={(open) => !open && setPanel(null)}
            >
                <SheetContent className="dark w-full overflow-y-auto border-white/10 bg-neutral-900 text-neutral-100 sm:max-w-md">
                    {panel === 'environment' && (
                        <>
                            <SheetHeader>
                                <SheetTitle>Environment</SheetTitle>
                                <SheetDescription>
                                    Changes preview live in the game. Save to
                                    keep them for {map.name}.
                                </SheetDescription>
                            </SheetHeader>
                            <div className="px-4">
                                <LiveSettings
                                    group={environmentGroup}
                                    initial={
                                        environment as unknown as SettingValues
                                    }
                                    onPreview={(values) =>
                                        send({
                                            type: 'updateEnvironment',
                                            environment:
                                                values as unknown as EnvironmentSettings,
                                        })
                                    }
                                    action={environmentRoutes.update(map.slug)}
                                    formatters={{ time_of_day: formatHour }}
                                />
                            </div>
                        </>
                    )}
                    {panel === 'settings' && (
                        <>
                            <SheetHeader>
                                <SheetTitle>Game settings</SheetTitle>
                                <SheetDescription>
                                    Global settings for every map. Changes
                                    preview live; save to persist.
                                </SheetDescription>
                            </SheetHeader>
                            <Tabs defaultValue="player" className="px-4">
                                <TabsList className="w-full">
                                    {settingsGroups.map((g) => (
                                        <TabsTrigger key={g.key} value={g.key}>
                                            {g.title}
                                        </TabsTrigger>
                                    ))}
                                </TabsList>
                                {settingsGroups.map((g) => (
                                    <TabsContent
                                        key={g.key}
                                        value={g.key}
                                        className="pt-4"
                                    >
                                        <LiveSettings
                                            group={g}
                                            initial={
                                                settings[
                                                    g.key as keyof GameSettings
                                                ] as unknown as SettingValues
                                            }
                                            onPreview={(values) =>
                                                send({
                                                    type: 'updateSettings',
                                                    settings: {
                                                        [g.key]: values,
                                                    },
                                                })
                                            }
                                            action={gameSettings.update(g.key)}
                                        />
                                    </TabsContent>
                                ))}
                            </Tabs>
                        </>
                    )}
                </SheetContent>
            </Sheet>
        </>
    );
}

function ModeButton({
    active,
    icon: Icon,
    label,
    onClick,
}: {
    active: boolean;
    icon: LucideIcon;
    label: string;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                'flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors',
                active
                    ? 'bg-white/15 text-white shadow-sm'
                    : 'text-neutral-400 hover:text-white',
            )}
        >
            <Icon className="size-3.5" />
            {label}
        </button>
    );
}

function IconButton({
    icon: Icon,
    label,
    onClick,
    active,
    disabled,
}: {
    icon: LucideIcon;
    label: string;
    onClick: () => void;
    active?: boolean;
    disabled?: boolean;
}) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon"
                    disabled={disabled}
                    onClick={onClick}
                    aria-label={label}
                    className={cn(
                        'size-8 text-neutral-300 hover:bg-white/10 hover:text-white',
                        active && 'bg-white/15 text-white',
                    )}
                >
                    <Icon />
                </Button>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
        </Tooltip>
    );
}

function isTyping(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement | null;

    return (
        !!t &&
        (t.tagName === 'INPUT' ||
            t.tagName === 'TEXTAREA' ||
            t.isContentEditable)
    );
}
