import * as THREE from 'three/webgpu';
import { Editor } from '../editor/Editor';
import type { DirtyChannel } from '../editor/Editor';
import { EditorPanel } from '../editor/ui/EditorPanel';
import { ViewModes } from '../editor/ViewModes';
import { AgentBridge } from './AgentBridge';
import { createAgentHost } from './AgentCommands';
import { runWorldEdit } from '../editor/agent/runWorldEdit';
import type { AgentContext } from './AgentCommands';
import { Player } from '../player/Player';
import { ThirdPersonCamera } from '../player/ThirdPersonCamera';
import type {
    GameMode,
    GameStats,
    ShellToGameMessage,
} from '../shared/protocol';
import { NO_WATER } from '../shared/types';
import type {
    EnvironmentSettings,
    FoliageType,
    GameManifest,
    GameSettings,
    GraphicsSettings,
    BiomeSummary,
    GroundCoverEntry,
    TerrainLayer,
} from '../shared/types';
import {
    applyPreset,
    normalizeGraphics,
    syncLegacy,
} from '../shared/graphicsPresets';
import {
    diffGraphics,
    GraphicsMenu,
    loadGraphicsOverrides,
    saveGraphicsOverrides,
} from '../ui/GraphicsMenu';
import { PhotoMode } from '../ui/PhotoMode';
import { Hud, LoadingScreen } from '../ui/Hud';
import { ViewModeMenu } from '../ui/ViewModeMenu';
import { Atmosphere } from '../world/Atmosphere';
import { Foliage, placementAllowed } from '../world/Foliage';
import { Heightfield } from '../world/Heightfield';
import type { GridRect } from '../world/Heightfield';
import { SplatMap } from '../world/SplatMap';
import { Terrain } from '../world/Terrain';
import { TerrainMaterial } from '../world/TerrainMaterial';
import { Water } from '../world/Water';
import { WaterReflection } from '../world/WaterReflection';
import { Weather } from '../world/Weather';
import { Wetness } from '../world/Wetness';
import { Api } from './Api';
import { Bridge } from './Bridge';
import type { BootConfig } from './config';
import { DynamicResolution } from './DynamicResolution';
import { GpuProfiler } from './GpuProfiler';
import { Input } from './Input';
import { PostFx } from './PostFx';
import type { GameRenderer } from './renderer';
import { installWebGpuCompat, isWebGpu } from './renderer';

type World = {
    heights: Heightfield;
    splat: SplatMap;
    waterGrid: Heightfield;
    material: TerrainMaterial;
    terrain: Terrain;
    water: Water;
    foliage: Foliage;
    wetness: Wetness;
    /** ESA WorldCover class lookup for real-world maps (0 = unknown). */
    landCoverAt?: (x: number, z: number) => number;
};

/**
 * Top-level game runtime: loads a map from the studio API, owns the renderer and switches between
 * build (editor) and play mode.
 */
export class Game {
    private readonly api: Api;
    private readonly bridge = new Bridge();
    private readonly container: HTMLElement;
    private renderer!: GameRenderer;
    private postFx!: PostFx;
    private profiler: GpuProfiler | null = null;
    private dynamicResolution = new DynamicResolution();
    /** Project graphics settings from the studio (before per-device overrides). */
    private graphicsDefaults!: GraphicsSettings;
    private graphicsMenu: GraphicsMenu | null = null;
    private photoMode: PhotoMode | null = null;
    /** Graphics in effect before photo mode switched to cinematic quality. */
    private graphicsBeforePhoto: GraphicsSettings | null = null;
    private anisotropyTimer = 0;
    private lastFrameAt = 0;
    private frameIntervalMs = 16.7;
    private backend: 'webgpu' | 'webgl' = 'webgl';
    private readonly skyLight = new THREE.Color();
    private readonly sunLight = new THREE.Color();
    private reflection = new WaterReflection();
    private reflectionLevelTimer = 0;
    private reflectionLevel: number | null = null;
    private scene = new THREE.Scene();
    private camera = new THREE.PerspectiveCamera(60, 1, 0.1, 20000);
    private input!: Input;
    private hud!: Hud;
    private loading: LoadingScreen;
    private manifest!: GameManifest;
    private world!: World;
    private atmosphere!: Atmosphere;
    private weather: Weather | null = null;
    private player!: Player;
    private playerCamera!: ThirdPersonCamera;
    private editor!: Editor;
    private panel!: EditorPanel;
    private viewModes!: ViewModes;
    private mode: GameMode;
    private timer = new THREE.Timer();
    private dirty = new Set<DirtyChannel>();
    private history = { canUndo: false, canRedo: false };
    private lastStats: Record<string, number | undefined> = {};
    private agentBridge: AgentBridge | null = null;
    /** An agent reloads the page on purpose (restored snapshot): no "leave page?" prompt. */
    private discarding = false;
    private saving = false;
    private statsTimer = 0;
    private frameTimes: number[] = [];
    private autosaveTimer = 0;
    private running = false;
    private pointerLocked = false;
    private escapeArmed = false;
    private resizeObserver: ResizeObserver | null = null;
    private editorCameraState: {
        position: THREE.Vector3;
        quaternion: THREE.Quaternion;
    } | null = null;

    constructor(private readonly config: BootConfig) {
        this.api = new Api(config);
        this.mode = config.mode;
        this.container = document.getElementById('game-root') ?? document.body;
        this.loading = new LoadingScreen(this.container, 'Waterways');
        this.bridge.on((message) => this.onShellMessage(message));
    }

    async start(): Promise<void> {
        try {
            this.progress(0.02, 'Fetching map');
            this.manifest = await this.api.manifest();

            if (
                this.manifest.map.terrain_status === 'ready' &&
                !this.manifest.assets.heightmap
            ) {
                throw new Error(
                    'This map has no terrain data. Regenerate the terrain from the map settings in the studio.',
                );
            }

            if (this.manifest.map.terrain_status !== 'ready') {
                await this.waitForTerrain();

                return;
            }

            await this.createRenderer();
            await this.loadWorld();
            this.createGameplay();
            this.weather = new Weather(this.scene, this.atmosphere, {
                heights: this.world.heights,
                material: this.world.material,
                water: this.world.water,
                setFoliageWind: (s, x, z) =>
                    this.world.foliage.setWind(s, x, z),
            });
            this.graphicsDefaults = normalizeGraphics(
                this.manifest.settings.graphics,
            );
            this.applyGraphics(this.layeredGraphics());
            this.applyEnvironment(this.manifest.environment);
            this.frameInitialView();
            this.setMode(this.mode, true);
            this.loading.hide();
            this.running = true;
            this.timer.connect(document);
            void this.renderer.setAnimationLoop(() => this.frame());
            this.bridge.send({
                type: 'ready',
                mapId: this.manifest.map.id,
                mode: this.mode,
            });
            this.bridge.send({ type: 'dirty', dirty: this.dirty.size > 0 });
            this.startAgentBridge();
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            console.error(error);
            this.loading.error(message);
            this.bridge.send({ type: 'error', message });
        }
    }

    // ---------------------------------------------------------------- agents

    /**
     * Lets AI agents work in this editor through the MCP server (App\Mcp\EditorBridge): commands
     * they queue for this map are polled and run here, live, in front of the user.
     */
    private startAgentBridge(): void {
        const url = this.manifest.endpoints.agent;

        if (!url) {
            return;
        }

        const ctx: AgentContext = {
            camera: this.camera,
            heights: () => this.world.heights,
            spawn: () => this.manifest.map.spawn,
            mode: () => this.mode,
            setMode: (mode) => this.setMode(mode),
            syncFlyCamera: () => this.editor.fly.setFromCamera(),
            viewMode: () => this.viewModes.current,
            setViewMode: (mode) => this.viewModes.set(mode),
            settling: () => this.world.foliage.settling,
            capture: (maxWidth) => this.captureImage(maxWidth),
            unsaved: () => [...this.dirty],
            save: () => this.save(),
            history: () => this.history,
            undo: () => this.editor.undo(),
            redo: () => this.editor.redo(),
            autoPaint: () => this.editor.autoPaint(),
            worldEdit: (payload) => runWorldEdit(this.editor, payload),
            refresh: (parts) => this.refreshFromServer(parts),
            // Only after the agent checked that unsaved changes may go (see map_snapshots restore).
            reload: () => {
                this.discarding = true;
                window.location.reload();
            },
            editorState: () => ({
                tool_group: this.editor.state.group,
                paint_layer_slot: this.editor.state.paintLayer,
            }),
            stats: () => ({ ...this.lastStats }),
        };
        this.agentBridge = new AgentBridge(this.api, url, createAgentHost(ctx));
        this.agentBridge.start();
    }

    /** Re-reads parts of the manifest after an agent changed them on the server, and applies them. */
    private async refreshFromServer(parts: string[]): Promise<void> {
        const m = await this.api.manifest();

        if (parts.includes('layers')) {
            this.manifest.biomes = m.biomes;
            this.setLayers(m.layers);
        }

        if (parts.includes('foliage_types')) {
            this.onShellMessage({
                type: 'updateFoliageTypes',
                foliageTypes: m.foliage_types,
            });
        }

        if (parts.includes('environment')) {
            this.onShellMessage({
                type: 'updateEnvironment',
                environment: m.environment,
            });
        }

        if (parts.includes('settings')) {
            this.onShellMessage({
                type: 'updateSettings',
                settings: m.settings,
            });
        }

        if (parts.includes('map')) {
            this.manifest.map.spawn = m.map.spawn;
            this.editor.setSpawn(m.map.spawn);
        }
    }

    // ---------------------------------------------------------------- setup

    private progress(fraction: number, label: string, detail = ''): void {
        this.loading.set(fraction, label, detail);
        this.bridge.send({ type: 'loading', progress: fraction, label });
    }

    private async waitForTerrain(): Promise<void> {
        for (;;) {
            const status = await this.api.status();

            if (status.status === 'failed') {
                this.loading.error(
                    status.message ??
                        'Terrain generation failed. Regenerate it from the map settings.',
                );

                return;
            }

            if (status.status === 'ready') {
                window.location.reload();

                return;
            }

            this.progress(
                status.progress / 100,
                'Generating terrain',
                status.message ?? 'The queue worker is building this map…',
            );
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
    }

    /**
     * WebGPU where the browser supports it (Chrome / Edge, Safari 26+, Firefox 141+ on Windows), the
     * WebGL 2 backend of the same renderer otherwise, or when `renderer_backend` forces it.
     */
    private async createRenderer(): Promise<void> {
        const requested =
            loadGraphicsOverrides().renderer_backend ??
            this.manifest.settings.graphics.renderer_backend ??
            'auto';
        const webGpu = requested !== 'webgl' && (await installWebGpuCompat());

        const renderer = new THREE.WebGPURenderer({
            antialias: false,
            powerPreference: 'high-performance',
            stencil: false,
            forceWebGL: requested === 'webgl',
            // Reversed float depth (see depth.ts) on WebGPU. The WebGL 2 backend could reverse depth
            // with EXT_clip_control, but three.js r186's shared getViewPosition() still maps depth to
            // clip z as 2·depth − 1 there, which breaks the view-space reconstruction of GTAO, SSR, the
            // AO denoiser and the TAA / TAAU disocclusion test; it keeps the standard 24-bit buffer.
            reversedDepthBuffer: webGpu,
            trackTimestamp: true,
        });
        await renderer.init();
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFShadowMap;
        renderer.info.autoReset = false;
        this.backend = isWebGpu(renderer) ? 'webgpu' : 'webgl';
        console.info(
            `Waterways renderer: ${this.backend === 'webgpu' ? 'WebGPU' : 'WebGL 2'} backend`,
        );
        renderer.domElement.className = 'ww-canvas';
        renderer.domElement.tabIndex = 0;
        this.container.prepend(renderer.domElement);
        this.renderer = renderer;

        this.input = new Input(renderer.domElement);
        this.scene.background = null;
        // The scene root never moves; auto-updating it would force every object's world matrix to be
        // recomputed on each render (static terrain / foliage meshes included).
        this.scene.matrixAutoUpdate = false;
        this.atmosphere = new Atmosphere(renderer, this.scene);
        this.postFx = new PostFx(renderer, this.scene, this.camera);
        this.postFx.setLightSource(this.atmosphere);
        this.profiler = new GpuProfiler(renderer);

        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(this.container);

        document.addEventListener('pointerlockchange', () => {
            this.pointerLocked =
                document.pointerLockElement === renderer.domElement;
            this.hud?.setMode(this.mode, this.pointerLocked);

            if (!this.pointerLocked && this.mode === 'play') {
                this.escapeArmed = true;
            }
        });
        renderer.domElement.addEventListener('click', () => {
            if (this.mode === 'play' && !this.pointerLocked) {
                void renderer.domElement.requestPointerLock();
                this.escapeArmed = false;
            }
        });
        window.addEventListener('beforeunload', (e) => {
            if (this.dirty.size && !this.config.embedded && !this.discarding) {
                e.preventDefault();
            }
        });
    }

    private async loadWorld(): Promise<void> {
        const m = this.manifest;
        const res = m.map.resolution;
        const assets = m.assets;

        this.progress(0.1, 'Loading terrain', `${res}×${res} heightmap`);
        const heightBuf = await this.api.binary(assets.heightmap, (f) =>
            this.progress(0.1 + f * 0.35, 'Loading terrain'),
        );
        const heights = new Heightfield(
            res,
            m.map.size,
            new Float32Array(heightBuf),
        );

        this.progress(0.5, 'Loading materials');
        let splat: SplatMap;

        if (assets.splatmap) {
            splat = new SplatMap(
                res,
                new Uint8Array(await this.api.binary(assets.splatmap)),
            );
        } else {
            splat = new SplatMap(res);
            splat.autoPaint(heights, m.layers);
            this.dirty.add('splatmap');
        }

        this.progress(0.62, 'Loading water');
        const waterGrid = assets.water
            ? new Heightfield(
                  res,
                  m.map.size,
                  new Float32Array(await this.api.binary(assets.water)),
              )
            : new Heightfield(
                  res,
                  m.map.size,
                  new Float32Array(res * res).fill(NO_WATER),
              );

        this.progress(0.72, 'Building terrain mesh');
        const material = new TerrainMaterial(
            splat,
            m.map.size,
            res,
            Number(m.settings.graphics.terrain_texture_resolution ?? 1024),
        );
        material.setLayers(m.layers);
        const terrain = new Terrain(heights, material);
        this.scene.add(terrain.group);

        this.progress(0.82, 'Filling rivers and lakes');
        const water = new Water(waterGrid, heights);
        this.scene.add(water.group);

        this.progress(0.9, 'Growing foliage');
        // Grass etc. blend into the terrain colour at their roots.
        const foliage = new Foliage((xz) => material.groundColor(xz));
        // WebGPU: GPU-driven culling + indirect draws (culled in renderFrame).
        foliage.setRenderer(this.renderer);
        foliage.setTypes(m.foliage_types);
        foliage.load(
            assets.foliage ? await this.api.foliage(assets.foliage) : null,
        );
        this.scene.add(foliage.group);

        let landCoverAt: ((x: number, z: number) => number) | undefined;

        if (assets.landcover) {
            const classes = new Uint8Array(
                await this.api.binary(assets.landcover),
            );

            if (classes.length === res * res) {
                landCoverAt = (x, z) => {
                    const { gx, gz } = heights.toGrid(x, z);
                    const c = Math.min(res - 1, Math.max(0, Math.round(gx)));
                    const r = Math.min(res - 1, Math.max(0, Math.round(gz)));

                    return classes[r * res + c];
                };
            }
        }

        const wetness = new Wetness(heights, waterGrid);
        wetness.compute();
        material.setWetness(wetness.texture);
        // Ground cover: grass etc. grown by the terrain layers wherever they are painted.
        const coverAt = (rect?: GridRect) =>
            rect
                ? foliage.invalidateGroundCover(
                      heights.colToX(rect.x0 - 1),
                      heights.rowToZ(rect.z0 - 1),
                      heights.colToX(rect.x1 + 1),
                      heights.rowToZ(rect.z1 + 1),
                  )
                : foliage.invalidateGroundCover(
                      -Infinity,
                      -Infinity,
                      Infinity,
                      Infinity,
                  );
        const waterLevelAt = (x: number, z: number) => water.levelAt(x, z);
        foliage.setGroundCover(m.layers, {
            heights,
            splat,
            waterLevelAt,
            water: waterGrid,
            allowed: (type, x, z) =>
                placementAllowed({ heights, waterLevelAt }, type, x, z),
        });
        splat.onChange = coverAt;
        water.onRebuild = (rect) => {
            wetness.invalidate();
            coverAt(rect);
        };

        this.world = {
            heights,
            splat,
            waterGrid,
            material,
            terrain,
            water,
            foliage,
            wetness,
            landCoverAt,
        };
        this.progress(0.97, 'Compiling shaders');
    }

    private createGameplay(): void {
        const settings = this.manifest.settings;
        this.player = new Player(
            settings.player,
            this.manifest.character ?? null,
        );
        this.scene.add(this.player.object);
        this.playerCamera = new ThirdPersonCamera(this.camera, settings.player);
        // The character moves on its own: only the live near shadow cascade draws it. Edited
        // casters refresh the cached far cascade.
        this.atmosphere.sunShadows.addLiveCaster(this.player.object);
        this.world.foliage.onShadowCastersChanged = () =>
            this.atmosphere.invalidateShadows();

        this.hud = new Hud(this.container, this.config.embedded, {
            setMode: (mode) => this.setMode(mode),
            save: () => void this.save(),
            undo: () => this.editor.undo(),
            redo: () => this.editor.redo(),
        });

        this.viewModes = new ViewModes({
            material: this.world.material,
            foliage: this.world.foliage,
            postFx: this.postFx,
            heights: this.world.heights,
            layers: () => this.manifest.layers,
        });

        this.editor = new Editor(
            {
                ...this.world,
                layers: this.manifest.layers,
                foliageTypes: this.manifest.foliage_types,
                spawn: this.manifest.map.spawn,
            },
            this.camera,
            this.input,
            this.scene,
            {
                markDirty: (channel) => {
                    this.markDirty(channel);

                    if (channel === 'heightmap') {
                        this.atmosphere.invalidateShadows();
                    }
                },
                onHistory: (canUndo, canRedo) => {
                    this.history = { canUndo, canRedo };
                    this.hud.setHistory(canUndo, canRedo);
                    this.bridge.send({ type: 'history', canUndo, canRedo });
                },
                onToolGroup: (group) =>
                    this.bridge.send({ type: 'toolGroupChanged', group }),
                onSpawnChanged: (spawn) => {
                    this.manifest.map.spawn = spawn;
                    this.hud.flash('Player start moved');
                },
                requestPlay: (fromCamera) =>
                    this.setMode('play', false, fromCamera),
                requestSave: () => void this.save(),
                cycleViewMode: (step) => this.viewModes.cycle(step),
                isPointerOverUi: () => this.isPointerOverUi(),
            },
            settings.editor,
        );
        this.panel = new EditorPanel(this.editor, {
            autoPaint: () => this.editor.autoPaint(),
            softenMap: () => {
                this.editor.softenMap(0.5);
                this.hud.flash('Terrain softened');
            },
            scatter: (ids) => {
                if (!ids.length) {
                    this.hud.flash('Select at least one foliage type');

                    return;
                }

                const count = this.editor.populateFoliage(ids);
                this.hud.flash(`Scattered ${count.toLocaleString()} instances`);
            },
            clearFoliage: (ids) => this.editor.clearFoliage(ids),
            updateFoliageType: (id, patch) => this.updateFoliageType(id, patch),
            updateGroundCover: (id, entries) =>
                this.updateGroundCover(id, entries),
            biomes: () => this.manifest.biomes ?? [],
            applyBiome: (layerId, biomeId) => this.applyBiome(layerId, biomeId),
            saveBiome: (layerId, name) => this.saveBiome(layerId, name),
        });
        this.hud.panelSlot.append(this.panel.el);
        this.graphicsMenu = new GraphicsMenu(
            this.hud.el,
            {
                current: () => this.manifest.settings.graphics,
                defaults: () => this.graphicsDefaults,
                apply: (g) => this.applyGraphicsOverride(g),
                onOpen: () => {
                    if (document.pointerLockElement) {
                        document.exitPointerLock();
                    }
                },
            },
            this.config.embedded,
        );
        const viewModeMenu = new ViewModeMenu(
            this.hud.el,
            this.viewModes,
            this.config.embedded,
        );
        this.viewModes.onChange = () => viewModeMenu.sync();
        this.photoMode = new PhotoMode(this.hud.el, {
            environment: () => this.manifest.environment,
            previewEnvironment: (patch) =>
                this.applyEnvironment({
                    ...this.manifest.environment,
                    ...patch,
                }),
            restoreEnvironment: (snapshot) => this.applyEnvironment(snapshot),
            setCinematic: (on) => this.setPhotoCinematic(on),
            focusAt: (x, y) => this.focusAt(x, y),
            capture: (scale) => this.capturePhoto(scale),
            setUiHidden: (hidden) =>
                this.hud.el.classList.toggle('is-photo', hidden),
            fov: () => this.camera.fov,
            setFov: (fov) => {
                this.camera.fov = fov;
                this.camera.updateProjectionMatrix();
            },
            canvas: this.renderer.domElement,
            mapName: () => this.manifest.map.name,
            onOpen: () => {
                if (document.pointerLockElement) {
                    document.exitPointerLock();
                }
            },
        });
        this.hud.setStatus(this.panel.hintElement);
        this.hud.setHistory(false, false);
        this.hud.setSaveState(this.dirty.size ? 'dirty' : 'idle');

        // A freshly generated map has no foliage yet: grow an initial ecosystem (saved on the next save).
        if (
            !this.manifest.assets.foliage &&
            this.manifest.foliage_types.length
        ) {
            const count = this.world.foliage.populate(
                {
                    heights: this.world.heights,
                    waterLevelAt: (x, z) => this.world.water.levelAt(x, z),
                    landCoverAt: this.world.landCoverAt,
                },
                this.manifest.foliage_types.map((t) => t.id),
                this.manifest.map.id,
            );
            this.markDirty('foliage');
            window.setTimeout(
                () =>
                    this.hud.flash(
                        `Generated materials and ${count.toLocaleString()} foliage instances — save to keep them`,
                    ),
                800,
            );
        }
    }

    private frameInitialView(): void {
        const hf = this.world.heights;
        const spawn = this.manifest.map.spawn;
        const target = new THREE.Vector3(spawn?.x ?? 0, 0, spawn?.z ?? 0);
        target.y = hf.sample(target.x, target.z);
        const distance = Math.min(hf.size * 0.35, 600);
        this.camera.position.set(
            target.x + distance * 0.55,
            target.y + distance * 0.45,
            target.z + distance * 0.75,
        );
        this.editor.fly.lookAt(target);
        this.resize();
    }

    // ---------------------------------------------------------------- modes

    private setMode(mode: GameMode, initial = false, fromCamera = false): void {
        if (!initial && mode === this.mode) {
            return;
        }

        const previous = this.mode;
        this.mode = mode;

        if (mode === 'play') {
            if (previous === 'edit' || initial) {
                this.editorCameraState = {
                    position: this.camera.position.clone(),
                    quaternion: this.camera.quaternion.clone(),
                };
            }

            const spawn = this.manifest.map.spawn;
            const env = this.playerEnv();

            if (fromCamera && !initial) {
                const dir = new THREE.Vector3();
                this.camera.getWorldDirection(dir);
                const hit = this.editor.cursorValid
                    ? this.editor.cursor
                    : this.camera.position;
                const yaw = Math.atan2(-dir.x, -dir.z);
                this.player.spawn(hit.x, hit.z, yaw, env);
            } else {
                this.player.spawn(
                    spawn?.x ?? 0,
                    spawn?.z ?? 0,
                    spawn?.yaw ?? 0,
                    env,
                );
            }

            this.playerCamera.reset(this.player.yaw);
            this.player.object.visible = true;
            this.editor.setActive(false);
            // The third-person camera keeps ≥ 0.4 m from the ground; 0.2 m halves the far depth
            // steps of WebGL's 24-bit buffer compared to 0.1 m.
            this.camera.near = 0.2;

            if (!initial) {
                void this.renderer.domElement
                    .requestPointerLock?.()
                    ?.catch?.(() => undefined);
            }
        } else {
            if (document.pointerLockElement) {
                document.exitPointerLock();
            }

            this.player.object.visible = false;

            if (this.editorCameraState) {
                this.camera.position.copy(this.editorCameraState.position);
                this.camera.quaternion.copy(this.editorCameraState.quaternion);
                this.editor.fly.setFromCamera();
            }

            this.editor.setActive(true);
            this.camera.near = 0.5;
        }

        this.viewModes.setSuspended(mode === 'play');
        this.camera.updateProjectionMatrix();
        this.escapeArmed = false;
        this.hud.setMode(mode, this.pointerLocked);
        this.bridge.send({ type: 'modeChanged', mode });
    }

    private playerEnv() {
        return {
            heights: this.world.heights,
            waterLevelAt: (x: number, z: number) =>
                this.world.water.levelAt(x, z),
        };
    }

    // ---------------------------------------------------------------- loop

    private frame(): void {
        if (!this.running) {
            return;
        }

        // Frame limiter (max_fps): skip animation frames until the interval is reached. The timer is not
        // updated on skipped frames, so the simulation delta still covers the whole interval.
        const now = performance.now();
        const maxFps = this.manifest.settings.graphics.max_fps ?? 0;
        const elapsed = now - this.lastFrameAt;

        if (maxFps > 0) {
            const interval = 1000 / maxFps;

            // 1 ms tolerance so a 60 fps cap on a 60 Hz display does not drop every other frame.
            if (elapsed < interval - 1) {
                return;
            }
        }

        this.frameIntervalMs = Math.min(elapsed, 1000);
        this.lastFrameAt = now;
        this.timer.update();
        const dt = Math.min(this.timer.getDelta(), 0.1);
        this.renderer.info.reset();
        const start = performance.now();
        // Per-pass timings only while the F10 menu shows them.
        const profiler = this.profiler;

        if (profiler) {
            profiler.detailed = !!this.graphicsMenu?.isOpen;
            profiler.begin('Update (CPU)');
        }

        if (this.mode === 'play') {
            this.updatePlay(dt);
        } else {
            this.editor.update(dt);
            this.viewModes.update(dt);
        }

        const focus =
            this.mode === 'play'
                ? this.player.position
                : this.editor.cursorValid
                  ? this.editor.cursor
                  : this.cameraGroundPoint();
        this.atmosphere.update(dt, focus);
        this.atmosphere.skyAndSunLight(this.skyLight, this.sunLight);
        this.world.foliage.setLighting(
            this.skyLight,
            this.sunLight,
            this.atmosphere.lightDirection(),
        );
        this.world.terrain.updateLod(this.camera);
        this.world.water.update(dt);
        this.world.wetness.update(dt);
        this.world.foliage.update(dt, this.camera);

        const waterLevel = this.world.water.levelAt(
            this.camera.position.x,
            this.camera.position.z,
        );
        const env = this.atmosphere.environment;
        this.atmosphere.setUnderwater(
            waterLevel !== null && this.camera.position.y < waterLevel - 0.05,
            env?.water_shallow_color,
        );
        this.weather?.update(dt, this.camera);

        this.renderFrame(dt);
        this.updateDynamicResolution(dt);
        this.input.endFrame();
        this.trackStats(dt, performance.now() - start);
        this.tickAutosave(dt);
    }

    private updatePlay(dt: number): void {
        const input = this.input;

        if (
            input.wasPressed('Escape') &&
            !this.pointerLocked &&
            this.escapeArmed
        ) {
            this.setMode('edit');

            return;
        }

        this.player.update(dt, input, this.playerCamera.yaw, this.playerEnv());
        this.playerCamera.update(
            dt,
            input,
            this.player.headPosition(),
            this.world.heights,
            this.pointerLocked,
        );
    }

    private cameraGroundPoint(): THREE.Vector3 {
        const dir = new THREE.Vector3();
        this.camera.getWorldDirection(dir);
        const hit = this.world.heights.raycast(
            new THREE.Ray(this.camera.position.clone(), dir),
            5000,
        );

        return hit ?? this.camera.position;
    }

    private trackStats(dt: number, cpuMs: number): void {
        this.frameTimes.push(dt);

        if (this.frameTimes.length > 60) {
            this.frameTimes.shift();
        }

        this.statsTimer -= dt;

        if (this.statsTimer > 0) {
            return;
        }

        this.statsTimer = 0.5;
        this.anisotropyTimer -= 0.5;

        if (this.anisotropyTimer <= 0) {
            // Picks up textures created since the last pass (foliage types, streamed materials).
            this.anisotropyTimer = 3;
            this.applyAnisotropy(this.manifest.settings.graphics.anisotropy);
        }
        const avg =
            this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
        const info = this.renderer.info.render;
        const pos =
            this.mode === 'play' ? this.player.position : this.camera.position;
        const stats: GameStats = {
            fps: 1 / Math.max(1e-4, avg),
            frameMs: cpuMs,
            drawCalls: info.drawCalls,
            triangles: info.triangles,
            position: { x: pos.x, y: pos.y, z: pos.z },
            ...foliageStats(this.world.foliage),
            renderScale: this.manifest.settings.graphics.dynamic_resolution
                ? this.effectiveRenderScale()
                : undefined,
            gpuMs: this.profiler?.lastMs ?? undefined,
        };
        this.lastStats = {
            fps: Math.round(stats.fps),
            frame_ms: Math.round(stats.frameMs * 10) / 10,
            gpu_ms: stats.gpuMs,
            draw_calls: stats.drawCalls,
            triangles: stats.triangles,
            foliage_instances: stats.foliageInstances,
            foliage_drawn: stats.foliageDrawn,
        };
        this.graphicsMenu?.setStats(stats, {
            renderScale: this.effectiveRenderScale(),
            passes: this.postFx.passNames,
            renderSize: this.postFx.renderSize,
            outputSize: this.postFx.outputSize,
            backend: this.backend,
            profile: this.profiler?.sections(),
            gpuTimers: this.profiler?.supported,
        });
        this.hud.setStats(
            this.manifest.settings.editor.show_stats ? stats : null,
        );
        this.bridge.send({ type: 'stats', stats });
    }

    private tickAutosave(dt: number): void {
        const minutes = this.manifest.settings.editor.autosave_minutes;

        if (!minutes || !this.dirty.size || this.saving) {
            this.autosaveTimer = 0;

            return;
        }

        this.autosaveTimer += dt;

        if (this.autosaveTimer > minutes * 60) {
            this.autosaveTimer = 0;
            void this.save();
        }
    }

    /**
     * Renders the frame: the water's planar reflection (when there is water), then the scene through the
     * post-processing pipeline. Water refraction reads the opaque scene from the same pass (viewport
     * textures), so there is no separate refraction pre-pass.
     */
    private renderFrame(dt: number): void {
        const water = this.world.water;
        const profiler = this.profiler;
        const reflection = water.hasWater() ? this.prepareReflection(dt) : null;
        // GPU foliage culling reads last frame's scene depth (Hi-Z), before any pass draws foliage;
        // it culls for the reflection camera too when the reflection renders this frame.
        this.world.foliage.cull(
            this.renderer,
            this.camera,
            this.postFx.depthTexture,
            profiler,
            reflection,
        );

        if (water.hasWater()) {
            profiler?.mark('Water reflection');
            this.renderReflection();
        }

        this.postFx.render(dt, profiler);
        profiler?.end();
    }

    /**
     * Depth of field: focus on the surface under a screen point (NDC -1..1, +y up), e.g. a click in
     * photo mode; the focus follows that point with a smooth pull. `null` returns to the map's focus
     * setting (manual distance or centre auto-focus).
     */
    focusAt(ndcX: number | null, ndcY = 0): void {
        if (ndcX === null) {
            this.postFx.clearFocusPoint();
        } else {
            this.postFx.focusAtScreen(ndcX, ndcY);
        }
    }

    /** Current depth of field focus distance in metres (async GPU read-back); null when DoF is off. */
    focusDistance(): Promise<number | null> {
        return this.postFx.readFocusDistance();
    }

    // Small foliage (grass, flowers, reeds) is left out of the water reflection; cached per type list.
    private smallFoliageTypes: FoliageType[] | null = null;
    private smallFoliagePrefixes: string[] = [];
    private readonly reflectionHidden: THREE.Object3D[] = [];

    /**
     * Picks the water level to reflect (closest to what the viewer is looking at) and positions the
     * reflection camera; returns it when the reflection renders this frame.
     */
    private prepareReflection(dt: number): THREE.Camera | null {
        const water = this.world.water;

        if (!this.reflection.enabled) {
            return null;
        }

        this.reflectionLevelTimer -= dt;

        if (this.reflectionLevelTimer <= 0) {
            this.reflectionLevelTimer = 0.3;
            const focus =
                this.mode === 'play'
                    ? this.player.position
                    : this.editor.cursorValid
                      ? this.editor.cursor
                      : this.cameraGroundPoint();
            const level = water.dominantLevel(focus, this.camera);
            // Keep the previous plane when nothing is found so the reflection doesn't flicker.
            this.reflectionLevel = level ?? this.reflectionLevel;
        }

        if (this.reflectionLevel === null) {
            return null;
        }

        this.reflection.level = this.reflectionLevel;
        // Mirrored from this frame's view (the camera moved during the update).
        this.camera.updateMatrixWorld();

        return this.reflection.prepare(
            this.camera,
            this.renderer.coordinateSystem,
            this.renderer.reversedDepthBuffer,
        );
    }

    /** Planar reflection of the water level picked by prepareReflection(). */
    private renderReflection(): void {
        const water = this.world.water;

        if (!this.reflection.enabled || this.reflectionLevel === null) {
            water.setReflection(null);

            return;
        }

        if (this.smallFoliageTypes !== this.manifest.foliage_types) {
            this.smallFoliageTypes = this.manifest.foliage_types;
            this.smallFoliagePrefixes = this.manifest.foliage_types
                .filter(
                    (t) =>
                        t.kind === 'grass' ||
                        t.kind === 'flower' ||
                        t.kind === 'reed',
                )
                .map((t) => `Foliage_${t.name}_`);
        }

        const small = this.smallFoliagePrefixes;
        const hidden = this.reflectionHidden;
        hidden.length = 0;
        const precipitation = this.weather?.precipitation.group;
        const foliage = this.world.foliage;
        this.reflection.render(
            this.renderer,
            this.scene,
            () => {
                water.group.visible = false;
                foliage.beginReflection();

                // Rain / snow streaks are invisible in a rippled reflection but cost a full particle draw.
                if (precipitation?.visible) {
                    precipitation.visible = false;
                    hidden.push(precipitation);
                }

                for (const child of foliage.group.children) {
                    if (
                        child.visible &&
                        small.some((prefix) => child.name.startsWith(prefix))
                    ) {
                        child.visible = false;
                        hidden.push(child);
                    }
                }
            },
            () => {
                water.group.visible = true;
                foliage.endReflection();

                for (const child of hidden) {
                    child.visible = true;
                }
            },
        );
        water.setReflection(
            this.reflection.active
                ? {
                      texture: this.reflection.target.texture,
                      matrix: this.reflection.textureMatrix,
                      level: this.reflection.level,
                  }
                : null,
        );
    }

    private resizeWaterTarget(): void {
        const quality =
            this.manifest?.settings.graphics.water_quality ?? 'medium';
        // Follows the composer resolution (which dynamic resolution may lower below the canvas size).
        const size = this.postFx.renderSize;
        this.reflection.setSize(
            size.x,
            size.y,
            quality === 'high' ? 0.6 : quality === 'medium' ? 0.4 : 0,
        );
        // Medium redraws the reflection every other frame; the water projects it through the matrix
        // of the frame it was drawn in, so it stays in place while the camera moves.
        this.reflection.interval = quality === 'medium' ? 2 : 1;
    }

    /**
     * Device pixel ratio capped by `max_pixel_ratio`: a 2× Retina screen at 1.5 outputs 56 % of the native
     * pixels (like UE's screen percentage on high-DPI displays); the browser upsamples the canvas.
     */
    private displayPixelRatio(): number {
        const cap = this.manifest?.settings.graphics.max_pixel_ratio ?? 1.5;

        return Math.min(window.devicePixelRatio || 1, Math.max(1, cap));
    }

    /**
     * Canvas (output) pixel ratio: the capped device pixel ratio, supersampled when render_scale > 1. Below
     * 1× the canvas stays at the display resolution and the scene is upscaled to it (TAAU / FSR 1).
     */
    private basePixelRatio(): number {
        const scale = this.manifest?.settings.graphics.render_scale ?? 1;

        return Math.min(this.displayPixelRatio() * Math.max(1, scale), 3);
    }

    /** Render scale (× device pixel ratio) the scene is currently rendered at. */
    private effectiveRenderScale(): number {
        const g = this.manifest.settings.graphics;

        return g.dynamic_resolution
            ? Math.min(this.dynamicResolution.scale, g.render_scale)
            : g.render_scale;
    }

    private resize(): void {
        if (!this.renderer) {
            return;
        }

        const w = this.container.clientWidth || window.innerWidth;
        const h = this.container.clientHeight || window.innerHeight;
        const base = this.basePixelRatio();
        const size = this.renderer.getSize(new THREE.Vector2());

        // Resizing the canvas clears it and reallocates the back buffer: only when something changed.
        if (
            size.x !== w ||
            size.y !== h ||
            this.renderer.getPixelRatio() !== base
        ) {
            this.renderer.setPixelRatio(base);
            this.renderer.setSize(w, h, false);
        }

        // The scene renders at the effective (possibly dynamic) scale; TAAU / FSR 1 upscale it to the canvas.
        const effective = Math.min(
            base,
            this.displayPixelRatio() * this.effectiveRenderScale(),
        );
        this.postFx.setSize(w, h, effective);
        this.resizeWaterTarget();
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
    }

    private updateDynamicResolution(dt: number): void {
        const g = this.manifest.settings.graphics;

        if (!g.dynamic_resolution) {
            return;
        }

        const target = Math.min(
            g.target_fps || 60,
            g.max_fps > 0 ? g.max_fps : Infinity,
        );

        if (
            this.dynamicResolution.update(
                dt,
                this.frameIntervalMs,
                this.profiler?.lastMs ?? null,
                target,
            )
        ) {
            this.resize();
        }
    }

    private isPointerOverUi(): boolean {
        const el = document.elementFromPoint(
            this.input.mouseX,
            this.input.mouseY,
        );

        return (
            !!el && el !== this.renderer.domElement && !!el.closest('.ww-panel')
        );
    }

    // ---------------------------------------------------------------- settings

    private applyEnvironment(env: EnvironmentSettings): void {
        this.manifest.environment = env;
        this.atmosphere.apply(env);
        this.postFx.setLook(env);
        this.world.water.applyEnvironment(env);
        this.world.foliage.setWind(env.wind_strength);
        this.weather?.apply(env);
    }

    private readonly foliagePatches = new Map<number, Partial<FoliageType>>();
    private foliageSaveTimer = 0;

    /**
     * In-editor foliage type tweaks (density, scale, rules, …): applied live and saved to the
     * studio library after a short pause, so the editor never has to be left.
     */
    private updateFoliageType(id: number, patch: Partial<FoliageType>): void {
        const types = this.manifest.foliage_types.map((t) =>
            t.id === id ? { ...t, ...patch } : t,
        );
        this.manifest.foliage_types = types;
        this.world.foliage.setTypes(types);
        this.editor.setFoliageTypes(types);
        this.foliagePatches.set(id, {
            ...this.foliagePatches.get(id),
            ...patch,
        });

        window.clearTimeout(this.foliageSaveTimer);
        this.foliageSaveTimer = window.setTimeout(
            () => void this.flushFoliagePatches(),
            700,
        );
    }

    private readonly coverPatches = new Map<number, GroundCoverEntry[]>();
    private coverSaveTimer = 0;

    /** In-editor ground cover edits of a terrain layer: regrown live, saved after a short pause. */
    private updateGroundCover(
        layerId: number,
        entries: GroundCoverEntry[],
    ): void {
        const layers = this.manifest.layers.map((l) =>
            l.id === layerId ? { ...l, ground_cover: entries } : l,
        );
        this.manifest.layers = layers;
        this.world.foliage.setGroundCover(layers);
        this.editor.setLayers(layers);
        this.coverPatches.set(layerId, entries);

        window.clearTimeout(this.coverSaveTimer);
        this.coverSaveTimer = window.setTimeout(
            () => void this.flushCoverPatches(),
            700,
        );
    }

    /** Applies a library biome to a terrain layer (look + ground cover), live. */
    private async applyBiome(layerId: number, biomeId: number): Promise<void> {
        const base = this.manifest.endpoints.update_layers;

        if (!base) {
            return;
        }

        try {
            // Pending ground cover edits of this layer would overwrite the biome's.
            window.clearTimeout(this.coverSaveTimer);
            await this.flushCoverPatches();
            const saved = await this.api.postJson<TerrainLayer>(
                `${base}/${layerId}/biome`,
                { biome_id: biomeId },
            );
            this.setLayers(
                this.manifest.layers.map((l) => (l.id === layerId ? saved : l)),
            );
            this.bridge.send({ type: 'terrainLayerSaved', layer: saved });
            this.hud.flash(`Layer ${saved.slot + 1} is now ${saved.name}`);
        } catch (error) {
            this.hud.flash(
                `Could not apply the biome: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    /** Saves a terrain layer's look and ground cover as a new library biome. */
    private async saveBiome(layerId: number, name: string): Promise<boolean> {
        const url = this.manifest.endpoints.biomes;

        if (!url) {
            return false;
        }

        try {
            window.clearTimeout(this.coverSaveTimer);
            await this.flushCoverPatches();
            const biome = await this.api.postJson<BiomeSummary>(url, {
                layer_id: layerId,
                name,
            });
            this.manifest.biomes = [
                ...(this.manifest.biomes ?? []),
                biome,
            ].sort((a, b) => a.name.localeCompare(b.name));
            this.hud.flash(`Saved ${biome.name} to the biome library`);

            return true;
        } catch (error) {
            this.hud.flash(
                `Could not save the biome: ${error instanceof Error ? error.message : String(error)}`,
            );

            return false;
        }
    }

    /** New terrain layers everywhere they are used (terrain shading, ground cover, editor). */
    private setLayers(layers: TerrainLayer[]): void {
        this.manifest.layers = layers;
        this.world.material.setLayers(layers);
        this.world.foliage.setGroundCover(layers);
        this.editor.setLayers(layers);
    }

    private async flushCoverPatches(): Promise<void> {
        const base = this.manifest.endpoints.update_layers;

        if (!base) {
            return;
        }

        const patches = [...this.coverPatches];
        this.coverPatches.clear();

        for (const [id, entries] of patches) {
            try {
                const saved = await this.api.patchJson<TerrainLayer>(
                    `${base}/${id}/ground-cover`,
                    { ground_cover: entries },
                );
                this.bridge.send({ type: 'terrainLayerSaved', layer: saved });
            } catch (error) {
                this.hud.flash(
                    `Could not save ground cover: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
    }

    private async flushFoliagePatches(): Promise<void> {
        const base = this.manifest.endpoints.update_foliage_type;

        if (!base) {
            return;
        }

        const patches = [...this.foliagePatches];
        this.foliagePatches.clear();

        for (const [id, patch] of patches) {
            try {
                const saved = await this.api.patchJson<FoliageType>(
                    `${base}/${id}`,
                    patch,
                );
                this.bridge.send({
                    type: 'foliageTypeSaved',
                    foliageType: saved,
                });
            } catch (error) {
                this.hud.flash(
                    `Could not save foliage settings: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
    }

    /** Project defaults with this device's overrides (in-game graphics menu) on top. */
    private layeredGraphics(): GraphicsSettings {
        return normalizeGraphics({
            ...this.graphicsDefaults,
            ...loadGraphicsOverrides(),
        });
    }

    /** From the in-game graphics menu: store what differs from the project defaults, then apply. */
    private applyGraphicsOverride(g: GraphicsSettings): void {
        const next = syncLegacy(g);
        saveGraphicsOverrides(diffGraphics(next, this.graphicsDefaults));
        this.applyGraphics(next);
    }

    private applyGraphics(input: GraphicsSettings): void {
        const g = normalizeGraphics(input);
        this.manifest.settings.graphics = g;
        this.atmosphere.setShadowQuality(g.shadow_quality, g.shadow_distance);
        this.world.foliage.setShadowCascade(this.atmosphere.sunShadows.cascade);
        this.weather?.setQuality(g);
        this.world.terrain.setShadows(
            g.shadow_quality === 'high' || g.shadow_quality === 'ultra',
        );
        this.world.terrain.lodBias = g.terrain_lod_bias;
        this.world.foliage.densityScale = g.foliage_density;
        this.world.material.setTextureSize(
            Number(g.terrain_texture_resolution ?? 1024),
        );
        this.world.foliage.distanceScale = g.foliage_distance;
        this.world.foliage.setShadowDistance(g.foliage_shadow_distance);
        this.world.foliage.setLodBias(g.foliage_lod_bias);
        this.camera.far = g.draw_distance;
        this.camera.updateProjectionMatrix();

        if (
            !g.dynamic_resolution ||
            this.dynamicResolution.max !==
                Math.max(this.dynamicResolution.min, g.render_scale)
        ) {
            this.dynamicResolution.reset(g.render_scale);
        }

        this.postFx.configure(g);
        this.applyAnisotropy(g.anisotropy);
        this.resize();
        this.graphicsMenu?.sync();
    }

    /**
     * Anisotropic filtering on every mipmapped texture in the scene (terrain texture arrays via the
     * material's uniforms, foliage, water …), clamped to the GPU limit. Textures that already have data
     * are re-uploaded, since three.js applies sampler parameters at upload time. Called again after
     * foliage types change so new textures pick it up.
     */
    private applyAnisotropy(requested: number): void {
        const max = this.renderer.getMaxAnisotropy();
        const value = Math.max(1, Math.min(max, Math.round(requested || 1)));
        const seen = new Set<THREE.Texture>();
        // Thousands of foliage meshes share a few materials: scan each material once.
        const materials = new Set<THREE.Material>();

        this.scene.traverse((object) => {
            const material = (object as THREE.Mesh).material as
                | THREE.Material
                | THREE.Material[]
                | undefined;

            if (!material) {
                return;
            }

            for (const m of Array.isArray(material) ? material : [material]) {
                if (materials.has(m)) {
                    continue;
                }

                materials.add(m);
                const uniforms = (
                    m as { uniforms?: Record<string, { value: unknown }> }
                ).uniforms;
                const values = [
                    ...Object.values(m),
                    ...Object.values(uniforms ?? {}).map((u) => u?.value),
                ];

                for (const v of values) {
                    if (v instanceof THREE.Texture) {
                        seen.add(v);
                    }
                }
            }
        });

        for (const texture of seen) {
            if (
                (texture as THREE.Texture & { isRenderTargetTexture?: boolean })
                    .isRenderTargetTexture ||
                texture.minFilter === THREE.NearestFilter ||
                texture.minFilter === THREE.LinearFilter ||
                texture.anisotropy === value
            ) {
                continue;
            }

            texture.anisotropy = value;

            if (texture.image && texture.version > 0) {
                texture.needsUpdate = true;
            }
        }
    }

    private applySettings(settings: GameSettings): void {
        this.manifest.settings = settings;
        this.player.applySettings(settings.player);
        this.playerCamera.applySettings(settings.player);
        // The studio sends project defaults; this device's overrides stay on top.
        this.graphicsDefaults = normalizeGraphics(settings.graphics);
        this.applyGraphics(this.layeredGraphics());
        this.editor.fly.speed = settings.editor.fly_speed;
    }

    // ---------------------------------------------------------------- persistence

    private markDirty(channel: DirtyChannel): void {
        const wasClean = this.dirty.size === 0;
        this.dirty.add(channel);

        if (channel === 'heightmap') {
            this.viewModes.invalidateHeights();
        }

        if (wasClean) {
            this.hud.setSaveState('dirty');
            this.bridge.send({ type: 'dirty', dirty: true });
        }
    }

    async save(): Promise<void> {
        if (this.saving || !this.world) {
            return;
        }

        const channels = new Set(this.dirty);

        if (!channels.size) {
            this.hud.flash('Nothing to save');
            this.bridge.send({ type: 'saveState', state: 'saved' });

            return;
        }

        this.saving = true;
        this.dirty.clear();
        this.hud.setSaveState('saving');
        this.bridge.send({ type: 'saveState', state: 'saving' });
        const endpoints = this.manifest.endpoints;

        try {
            if (channels.has('heightmap')) {
                const { min, max } = this.world.heights.minMax();
                await this.api.putBinary(
                    endpoints.save_heightmap,
                    this.world.heights.data,
                    {
                        'X-Min-Height': String(min),
                        'X-Max-Height': String(max),
                    },
                );
            }

            if (channels.has('splatmap')) {
                await this.api.putBinary(
                    endpoints.save_splatmap,
                    this.world.splat.data,
                );
            }

            if (channels.has('water')) {
                await this.api.putBinary(
                    endpoints.save_water,
                    this.world.waterGrid.data,
                );
            }

            if (channels.has('foliage')) {
                await this.api.putBinary(
                    endpoints.save_foliage,
                    JSON.stringify(this.world.foliage.serialize()),
                );
            }

            if (channels.has('meta')) {
                await this.api.saveSpawn(
                    endpoints.save_meta,
                    this.manifest.map.spawn,
                );
            }

            await this.api
                .postJson(endpoints.save_thumbnail, {
                    image: this.captureThumbnail(),
                })
                .catch(() => undefined);
            this.hud.setSaveState(this.dirty.size ? 'dirty' : 'saved');
            this.hud.flash('World saved');
            this.bridge.send({ type: 'saveState', state: 'saved' });
            this.bridge.send({ type: 'dirty', dirty: this.dirty.size > 0 });
        } catch (error) {
            for (const channel of channels) {
                this.dirty.add(channel);
            }

            const message =
                error instanceof Error ? error.message : String(error);
            this.hud.setSaveState('error', message);
            this.bridge.send({ type: 'saveState', state: 'error', message });
        } finally {
            this.saving = false;
        }
    }

    /** Photo mode: cinematic quality while it is open (not saved), the previous graphics afterwards. */
    private setPhotoCinematic(on: boolean): void {
        if (on && !this.graphicsBeforePhoto) {
            this.graphicsBeforePhoto = this.manifest.settings.graphics;
            this.applyGraphics({
                ...applyPreset('cinematic', this.graphicsBeforePhoto),
                dynamic_resolution: false,
                max_fps: 0,
            });
        } else if (!on && this.graphicsBeforePhoto) {
            const previous = this.graphicsBeforePhoto;
            this.graphicsBeforePhoto = null;
            this.applyGraphics(previous);
        }
    }

    /**
     * Photo mode capture: renders a few still frames (so TAA converges) at `scale` × the current
     * resolution, without editor overlays, and returns a PNG.
     */
    private async capturePhoto(scale: number): Promise<Blob> {
        this.world.material.hideBrush();
        const renderer = this.renderer;
        const base = renderer.getPixelRatio();
        const w = this.container.clientWidth || window.innerWidth;
        const h = this.container.clientHeight || window.innerHeight;
        const canvas = document.createElement('canvas');

        try {
            if (scale !== 1) {
                renderer.setPixelRatio(base * scale);
                renderer.setSize(w, h, false);
                this.postFx.setSize(w, h, base * scale);
            }

            // 16 converging frames (TAA accumulates the jittered samples, eye adaptation and focus settle).
            for (let i = 0; i < 16; i++) {
                this.postFx.beginStill();
                this.renderFrame(0);
            }

            const src = renderer.domElement;
            canvas.width = src.width;
            canvas.height = src.height;
            // Copy right after rendering: the WebGL back buffer is not preserved.
            canvas.getContext('2d')!.drawImage(src, 0, 0);
        } finally {
            if (scale !== 1) {
                renderer.setPixelRatio(base);
                this.resize();
            }
        }

        return new Promise((resolve, reject) =>
            canvas.toBlob(
                (blob) =>
                    blob ? resolve(blob) : reject(new Error('Empty image')),
                'image/png',
            ),
        );
    }

    /** Renders the current view without editor overlays and posts it to the studio (AI review). */
    /** Renders a still frame (no brush) and copies it, scaled to at most maxWidth, as a JPEG. */
    private captureImage(maxWidth: number): {
        dataUrl: string;
        width: number;
        height: number;
    } {
        this.world.material.hideBrush();
        this.postFx.beginStill();
        this.renderFrame(0);
        const src = this.renderer.domElement;
        const scale = Math.min(1, maxWidth / src.width);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(src.width * scale);
        canvas.height = Math.round(src.height * scale);
        canvas
            .getContext('2d')!
            .drawImage(src, 0, 0, canvas.width, canvas.height);

        return {
            dataUrl: canvas.toDataURL('image/jpeg', 0.85),
            width: canvas.width,
            height: canvas.height,
        };
    }

    private sendScreenshot(requestId: string): void {
        const image = this.captureImage(1280);
        const euler = new THREE.Euler().setFromQuaternion(
            this.camera.quaternion,
            'YXZ',
        );
        const p = this.camera.position;
        this.bridge.send({
            type: 'screenshot',
            requestId,
            dataUrl: image.dataUrl,
            mode: this.mode,
            camera: { x: p.x, y: p.y, z: p.z, yaw: euler.y, pitch: euler.x },
        });
    }

    private captureThumbnail(): string {
        this.world.material.hideBrush();
        this.postFx.beginStill();
        this.renderFrame(0);
        const src = this.renderer.domElement;
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 360;
        const ctx = canvas.getContext('2d')!;
        const aspect = src.width / src.height;
        const target = 640 / 360;
        let sw = src.width;
        let sh = src.height;

        if (aspect > target) {
            sw = sh * target;
        } else {
            sh = sw / target;
        }

        ctx.drawImage(
            src,
            (src.width - sw) / 2,
            (src.height - sh) / 2,
            sw,
            sh,
            0,
            0,
            640,
            360,
        );

        return canvas.toDataURL('image/jpeg', 0.82);
    }

    // ---------------------------------------------------------------- shell bridge

    private onShellMessage(message: ShellToGameMessage): void {
        if (!this.world) {
            if (message.type === 'reload') {
                window.location.reload();
            }

            return;
        }

        switch (message.type) {
            case 'setMode':
                this.setMode(message.mode, false, message.fromCamera ?? false);
                break;
            case 'save':
                void this.save();
                break;
            case 'reload':
                window.location.reload();
                break;
            case 'undo':
                this.editor.undo();
                break;
            case 'redo':
                this.editor.redo();
                break;
            case 'setToolGroup':
                this.editor.setGroup(message.group);
                break;
            case 'updateEnvironment':
                this.applyEnvironment({
                    ...this.manifest.environment,
                    ...message.environment,
                });
                break;
            case 'updateSettings': {
                const s = this.manifest.settings;
                const next = message.settings;

                if (next.graphics) {
                    // What the studio just changed wins over this device's F10 overrides for those keys.
                    const overrides = loadGraphicsOverrides();
                    const incoming = next.graphics as Record<string, unknown>;
                    const defaults = this.graphicsDefaults as unknown as Record<
                        string,
                        unknown
                    >;
                    let touched = false;

                    for (const key of Object.keys(incoming)) {
                        if (
                            key in overrides &&
                            incoming[key] !== defaults[key]
                        ) {
                            delete (overrides as Record<string, unknown>)[key];
                            touched = true;
                        }
                    }

                    if (touched) {
                        saveGraphicsOverrides(overrides);
                    }
                }

                this.applySettings({
                    player: { ...s.player, ...next.player },
                    graphics: { ...this.graphicsDefaults, ...next.graphics },
                    editor: { ...s.editor, ...next.editor },
                });
                break;
            }
            case 'updateLayers':
                this.setLayers(message.layers);
                break;
            case 'updateFoliageTypes':
                this.manifest.foliage_types = message.foliageTypes;
                this.world.foliage.setTypes(message.foliageTypes);
                this.editor.setFoliageTypes(message.foliageTypes);
                break;
            case 'focusGame':
                this.renderer.domElement.focus();
                break;
            case 'captureScreenshot':
                this.sendScreenshot(message.requestId);
                break;
        }
    }
}

function foliageStats(foliage: Foliage): Partial<GameStats> & {
    foliageInstances: number;
} {
    const f = foliage.stats();

    return {
        foliageInstances: f.instances,
        foliageDrawn: f.drawnInstances,
        foliageDrawCalls: f.drawCalls,
        foliageTriangles: f.triangles,
        foliageTypes: f.types,
    };
}
