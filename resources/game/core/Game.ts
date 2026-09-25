import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
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
    GameManifest,
    GameSettings,
    GraphicsSettings,
} from '../shared/types';
import { Hud, LoadingScreen } from '../ui/Hud';
import { Atmosphere } from '../world/Atmosphere';
import { Foliage } from '../world/Foliage';
import { Heightfield } from '../world/Heightfield';
import { SplatMap } from '../world/SplatMap';
import { Terrain } from '../world/Terrain';
import { TerrainMaterial } from '../world/TerrainMaterial';
import { Water } from '../world/Water';
import { Api } from './Api';
import { Bridge } from './Bridge';
import type { BootConfig } from './config';
import { Input } from './Input';

type World = {
    heights: Heightfield;
    splat: SplatMap;
    waterGrid: Heightfield;
    material: TerrainMaterial;
    terrain: Terrain;
    water: Water;
    foliage: Foliage;
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
    private composer!: EffectComposer;
    private bloomPass: UnrealBloomPass | null = null;
    private aoPass: GTAOPass | null = null;
    private scene = new THREE.Scene();
    private camera = new THREE.PerspectiveCamera(60, 1, 0.1, 20000);
    private input!: Input;
    private hud!: Hud;
    private loading: LoadingScreen;
    private manifest!: GameManifest;
    private world!: World;
    private atmosphere!: Atmosphere;
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
                this.manifest.map.terrain_status !== 'ready' ||
                !this.manifest.assets.heightmap
            ) {
                await this.waitForTerrain();

                return;
            }

            this.createRenderer();
            await this.loadWorld();
            this.createGameplay();
            this.applyGraphics(this.manifest.settings.graphics);
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
        renderer.domElement.className = 'ww-canvas';
        renderer.domElement.tabIndex = 0;
        this.container.prepend(renderer.domElement);
        this.renderer = renderer;

        this.input = new Input(renderer.domElement);
        this.scene.background = null;
        this.atmosphere = new Atmosphere(renderer, this.scene);

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
        const material = new TerrainMaterial(splat, m.map.size, res);
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

        this.world = {
            heights,
            splat,
            waterGrid,
            material,
            terrain,
            water,
            foliage,
        };
        this.progress(0.97, 'Compiling shaders');
    }

    private createGameplay(): void {
        const settings = this.manifest.settings;
        this.player = new Player(settings.player);
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
            scatter: (ids) => {
                if (!ids.length) {
                    this.hud.flash('Select at least one foliage type');

                    return;
                }

                const count = this.editor.populateFoliage(ids);
                this.hud.flash(`Scattered ${count.toLocaleString()} instances`);
            },
            clearFoliage: (ids) => this.editor.clearFoliage(ids),
        });
        this.hud.panelSlot.append(this.panel.el);
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
        this.world.water.update(dt);
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

        this.composer.render(dt);
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
            foliageInstances: this.world.foliage.instanceCount,
        };
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

    private resize(): void {
        if (!this.renderer) {
            return;
        }

        const w = this.container.clientWidth || window.innerWidth;
        const h = this.container.clientHeight || window.innerHeight;
        const scale = this.manifest?.settings.graphics.render_scale ?? 1;
        this.renderer.setPixelRatio(
            Math.min(window.devicePixelRatio * scale, 3),
        );
        this.renderer.setSize(w, h, false);
        this.composer?.setPixelRatio(this.renderer.getPixelRatio());
        this.composer?.setSize(w, h);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
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
    }

    private applyGraphics(g: GraphicsSettings): void {
        this.manifest.settings.graphics = g;
        this.atmosphere.setShadowQuality(g.shadow_quality, g.shadow_distance);
        this.world.terrain.setShadows(
            g.shadow_quality === 'high' || g.shadow_quality === 'ultra',
        );
        this.world.terrain.lodBias = g.terrain_lod_bias;
        this.world.foliage.densityScale = g.foliage_density;
        this.world.foliage.distanceScale = g.foliage_distance;
        this.camera.far = g.draw_distance;
        this.camera.updateProjectionMatrix();
        this.buildComposer(g);
        this.resize();
    }

    private buildComposer(g: GraphicsSettings): void {
        const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
        const target = new THREE.WebGLRenderTarget(
            Math.max(1, size.x),
            Math.max(1, size.y),
            {
                type: THREE.HalfFloatType,
                samples: g.antialias ? 4 : 0,
            },
        );
        this.composer?.dispose();
        this.composer = new EffectComposer(this.renderer, target);
        this.composer.addPass(new RenderPass(this.scene, this.camera));
        this.aoPass = null;
        this.bloomPass = null;

        if (g.ambient_occlusion) {
            this.aoPass = new GTAOPass(this.scene, this.camera, size.x, size.y);
            this.aoPass.updateGtaoMaterial({
                radius: 2.5,
                distanceExponent: 1.5,
                thickness: 2,
                scale: 1,
            });
            this.aoPass.blendIntensity = 0.8;
            this.composer.addPass(this.aoPass);
        }

        if (g.bloom) {
            this.bloomPass = new UnrealBloomPass(
                new THREE.Vector2(size.x, size.y),
                0.12,
                0.45,
                3.5,
            );
            this.composer.addPass(this.bloomPass);
        }

        this.composer.addPass(new OutputPass());
    }

    private applySettings(settings: GameSettings): void {
        this.manifest.settings = settings;
        this.player.applySettings(settings.player);
        this.playerCamera.applySettings(settings.player);
        this.applyGraphics(settings.graphics);
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

    private captureThumbnail(): string {
        this.world.material.hideBrush();
        this.composer.render(0);
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
        }
    }
}
