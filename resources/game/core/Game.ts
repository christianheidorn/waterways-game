import * as THREE from 'three';
import { Editor } from '../editor/Editor';
import type { DirtyChannel } from '../editor/Editor';
import { EditorPanel } from '../editor/ui/EditorPanel';
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
} from '../shared/types';
import { normalizeGraphics, syncLegacy } from '../shared/graphicsPresets';
import {
    diffGraphics,
    GraphicsMenu,
    loadGraphicsOverrides,
    saveGraphicsOverrides,
} from '../ui/GraphicsMenu';
import { Hud, LoadingScreen } from '../ui/Hud';
import { Atmosphere } from '../world/Atmosphere';
import { Foliage } from '../world/Foliage';
import { Heightfield } from '../world/Heightfield';
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
import { DynamicResolution, GpuTimer } from './DynamicResolution';
import { Input } from './Input';
import { PostFx } from './PostFx';

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
    private renderer!: THREE.WebGLRenderer;
    private postFx!: PostFx;
    private gpuTimer: GpuTimer | null = null;
    private dynamicResolution = new DynamicResolution();
    /** Project graphics settings from the studio (before per-device overrides). */
    private graphicsDefaults!: GraphicsSettings;
    private graphicsMenu: GraphicsMenu | null = null;
    private anisotropyTimer = 0;
    private lastFrameAt = 0;
    private frameIntervalMs = 16.7;
    private waterTarget: THREE.WebGLRenderTarget | null = null;
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
    private mode: GameMode;
    private timer = new THREE.Timer();
    private dirty = new Set<DirtyChannel>();
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

            this.createRenderer();
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
            this.renderer.setAnimationLoop(() => this.frame());
            this.bridge.send({
                type: 'ready',
                mapId: this.manifest.map.id,
                mode: this.mode,
            });
            this.bridge.send({ type: 'dirty', dirty: this.dirty.size > 0 });
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            console.error(error);
            this.loading.error(message);
            this.bridge.send({ type: 'error', message });
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

    private createRenderer(): void {
        const renderer = new THREE.WebGLRenderer({
            antialias: false,
            powerPreference: 'high-performance',
            stencil: false,
        });
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFShadowMap;
        renderer.info.autoReset = false;
        // Shadows are refreshed once per frame manually, because the water prepass renders the scene twice.
        renderer.shadowMap.autoUpdate = false;
        renderer.domElement.className = 'ww-canvas';
        renderer.domElement.tabIndex = 0;
        this.container.prepend(renderer.domElement);
        this.renderer = renderer;

        this.input = new Input(renderer.domElement);
        this.scene.background = null;
        this.atmosphere = new Atmosphere(renderer, this.scene);
        this.postFx = new PostFx(renderer, this.scene, this.camera);
        this.gpuTimer = new GpuTimer(renderer.getContext());

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
            if (this.dirty.size && !this.config.embedded) {
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
        const foliage = new Foliage();
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
        water.onRebuild = () => wetness.invalidate();

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

        this.hud = new Hud(this.container, this.config.embedded, {
            setMode: (mode) => this.setMode(mode),
            save: () => void this.save(),
            undo: () => this.editor.undo(),
            redo: () => this.editor.redo(),
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
                markDirty: (channel) => this.markDirty(channel),
                onHistory: (canUndo, canRedo) => {
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
            this.camera.near = 0.1;

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

        if (this.mode === 'play') {
            this.updatePlay(dt);
        } else {
            this.editor.update(dt);
        }

        const focus =
            this.mode === 'play'
                ? this.player.position
                : this.editor.cursorValid
                  ? this.editor.cursor
                  : this.cameraGroundPoint();
        this.atmosphere.update(dt, focus);
        this.world.terrain.updateLod(this.camera);
        this.world.water.update(dt, this.camera);
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

        this.gpuTimer?.poll();
        this.gpuTimer?.begin();
        this.renderFrame(dt);
        this.gpuTimer?.end();
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
            drawCalls: info.calls,
            triangles: info.triangles,
            position: { x: pos.x, y: pos.y, z: pos.z },
            ...foliageStats(this.world.foliage),
            renderScale: this.manifest.settings.graphics.dynamic_resolution
                ? this.effectiveRenderScale()
                : undefined,
            gpuMs: this.gpuTimer?.lastMs ?? undefined,
        };
        this.graphicsMenu?.setStats(stats, {
            renderScale: this.effectiveRenderScale(),
            passes: this.postFx.passNames,
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
     * Renders the frame: first the opaque scene without water into a colour + depth target (used by the
     * water shader for refraction, absorption and soft shores), then the full scene through the composer.
     */
    private renderFrame(dt: number): void {
        const renderer = this.renderer;
        renderer.shadowMap.needsUpdate = true;
        const water = this.world.water;

        if (this.waterTarget && water.hasWater()) {
            water.group.visible = false;
            renderer.setRenderTarget(this.waterTarget);
            renderer.clear();
            renderer.render(this.scene, this.camera);
            renderer.setRenderTarget(null);
            water.group.visible = true;
            // Water maps gl_FragCoord of the composer render (dynamic resolution aware) to scene UVs.
            const size = this.postFx.renderSize;
            water.setSceneTextures(
                {
                    color: this.waterTarget.texture,
                    depth: this.waterTarget.depthTexture!,
                },
                size.x,
                size.y,
            );
            // The composer render must not redraw the shadow map a second time.
            renderer.shadowMap.needsUpdate = false;
            // Reflection after the prepass: the shadow map exists (and is current) by now.
            this.renderReflection(dt);
        } else {
            water.setSceneTextures(null);
        }

        this.postFx.render(dt);
    }

    /** Planar reflection of the water level closest to what the viewer is looking at. */
    private renderReflection(dt: number): void {
        const water = this.world.water;

        if (!this.reflection.enabled || !water.hasWater()) {
            water.setReflection(null);

            return;
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
            water.setReflection(null);

            return;
        }

        const small = new Set(
            this.manifest.foliage_types
                .filter(
                    (t) =>
                        t.kind === 'grass' ||
                        t.kind === 'flower' ||
                        t.kind === 'reed',
                )
                .map((t) => `Foliage_${t.name}_`),
        );
        const hidden: THREE.Object3D[] = [];
        this.reflection.level = this.reflectionLevel;
        this.reflection.render(
            this.renderer,
            this.scene,
            this.camera,
            () => {
                water.group.visible = false;

                for (const child of this.world.foliage.group.children) {
                    if (
                        child.visible &&
                        [...small].some((prefix) =>
                            child.name.startsWith(prefix),
                        )
                    ) {
                        child.visible = false;
                        hidden.push(child);
                    }
                }
            },
            () => {
                water.group.visible = true;

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
        const scale =
            quality === 'high' ? 1 : quality === 'medium' ? 0.6 : 0.35;
        // Follows the composer resolution (which dynamic resolution may lower below the canvas size).
        const size = this.postFx.renderSize;
        this.reflection.setSize(
            size.x,
            size.y,
            quality === 'high' ? 0.6 : quality === 'medium' ? 0.4 : 0,
        );
        const w = Math.max(1, Math.round(size.x * scale));
        const h = Math.max(1, Math.round(size.y * scale));

        if (!this.waterTarget) {
            this.waterTarget = new THREE.WebGLRenderTarget(w, h, {
                type: THREE.HalfFloatType,
                depthTexture: new THREE.DepthTexture(w, h),
            });
            this.waterTarget.texture.minFilter = THREE.LinearFilter;
            this.waterTarget.texture.generateMipmaps = false;
        } else {
            this.waterTarget.setSize(w, h);
        }
    }

    /** Canvas pixel ratio: device pixel ratio × render_scale (the upper bound for dynamic resolution). */
    private basePixelRatio(): number {
        const scale = this.manifest?.settings.graphics.render_scale ?? 1;

        return Math.min(window.devicePixelRatio * scale, 3);
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

        // The composer renders at the effective (possibly dynamic) scale; its last pass upscales to the canvas.
        const effective = Math.min(
            base,
            window.devicePixelRatio * this.effectiveRenderScale(),
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
                this.gpuTimer?.lastMs ?? null,
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
        const max = this.renderer.capabilities.getMaxAnisotropy();
        const value = Math.max(1, Math.min(max, Math.round(requested || 1)));
        const seen = new Set<THREE.Texture>();

        this.scene.traverse((object) => {
            const material = (object as THREE.Mesh).material as
                | THREE.Material
                | THREE.Material[]
                | undefined;

            if (!material) {
                return;
            }

            for (const m of Array.isArray(material) ? material : [material]) {
                const uniforms = (
                    m as { uniforms?: Record<string, THREE.IUniform> }
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

    /** Renders the current view without editor overlays and posts it to the studio (AI review). */
    private sendScreenshot(requestId: string): void {
        this.world.material.hideBrush();
        this.renderFrame(0);
        const src = this.renderer.domElement;
        const scale = Math.min(1, 1280 / src.width);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(src.width * scale);
        canvas.height = Math.round(src.height * scale);
        canvas
            .getContext('2d')!
            .drawImage(src, 0, 0, canvas.width, canvas.height);
        const euler = new THREE.Euler().setFromQuaternion(
            this.camera.quaternion,
            'YXZ',
        );
        const p = this.camera.position;
        this.bridge.send({
            type: 'screenshot',
            requestId,
            dataUrl: canvas.toDataURL('image/jpeg', 0.85),
            mode: this.mode,
            camera: { x: p.x, y: p.y, z: p.z, yaw: euler.y, pitch: euler.x },
        });
    }

    private captureThumbnail(): string {
        this.world.material.hideBrush();
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
                this.applySettings({
                    player: { ...s.player, ...next.player },
                    graphics: { ...s.graphics, ...next.graphics },
                    editor: { ...s.editor, ...next.editor },
                });
                break;
            }
            case 'updateLayers':
                this.manifest.layers = message.layers;
                this.world.material.setLayers(message.layers);
                this.editor.setLayers(message.layers);
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
    };
}
