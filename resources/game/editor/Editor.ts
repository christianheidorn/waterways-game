import * as THREE from 'three/webgpu';
import type { Input } from '../core/Input';
import type { EditorToolGroup } from '../shared/protocol';
import { NO_WATER } from '../shared/types';
import type {
    EditorSettings,
    PropsFile,
    FoliageType,
    TerrainLayer,
} from '../shared/types';
import type { Foliage } from '../world/Foliage';
import { Props } from '../world/Props';
import type { GridRect, Heightfield } from '../world/Heightfield';
import type { SplatMap } from '../world/SplatMap';
import type { Terrain } from '../world/Terrain';
import type { TerrainMaterial } from '../world/TerrainMaterial';
import type { Water } from '../world/Water';
import { brushWeight, DEFAULT_BRUSH } from './Brush';
import type { BrushSettings } from './Brush';
import { FlyCamera } from './FlyCamera';
import { History } from './History';
import {
    flatten,
    hydraulicErosion,
    noise,
    ramp,
    sculpt,
    smooth,
    terrace,
    thermalErosion,
} from './tools/terrainOps';
import type { FlattenMode } from './tools/terrainOps';

export type SculptTool =
    | 'sculpt'
    | 'smooth'
    | 'flatten'
    | 'ramp'
    | 'erosion'
    | 'hydro'
    | 'noise'
    | 'terrace';
export type FoliageTool = 'paint' | 'erase' | 'single';
export type WaterTool = 'lake' | 'river' | 'erase';
export type DirtyChannel =
    | 'heightmap'
    | 'splatmap'
    | 'water'
    | 'foliage'
    | 'props'
    | 'meta';

export type EditorWorld = {
    heights: Heightfield;
    terrain: Terrain;
    material: TerrainMaterial;
    splat: SplatMap;
    waterGrid: Heightfield;
    water: Water;
    foliage: Foliage;
    props: Props;
    layers: TerrainLayer[];
    foliageTypes: FoliageType[];
    spawn: { x: number; z: number; yaw: number } | null;
    landCoverAt?: (x: number, z: number) => number;
};

export type EditorCallbacks = {
    markDirty: (channel: DirtyChannel) => void;
    onHistory: (canUndo: boolean, canRedo: boolean) => void;
    onToolGroup: (group: EditorToolGroup) => void;
    onSpawnChanged: (spawn: { x: number; z: number; yaw: number }) => void;
    requestPlay: (fromCamera: boolean) => void;
    requestSave: () => void;
    /** Request tool: the outline being drawn changed. */
    onRequestOutline?: (points: { x: number; z: number }[]) => void;
    /** Next (+1) or previous (-1) view mode. */
    cycleViewMode: (step: number) => void;
    isPointerOverUi: () => boolean;
};

/** Everything the panel UI can read and change. */
export class EditorState {
    group: EditorToolGroup = 'sculpt';
    sculptTool: SculptTool = 'sculpt';
    foliageTool: FoliageTool = 'paint';
    waterTool: WaterTool = 'lake';
    brushes: Record<EditorToolGroup, BrushSettings> = {
        sculpt: { ...DEFAULT_BRUSH, radius: 40, strength: 0.35 },
        paint: { ...DEFAULT_BRUSH, radius: 18, strength: 0.6 },
        foliage: { ...DEFAULT_BRUSH, radius: 25, strength: 0.8, falloff: 0.3 },
        water: { ...DEFAULT_BRUSH, radius: 30, strength: 1, falloff: 0.25 },
        place: { ...DEFAULT_BRUSH, radius: 2, strength: 1, falloff: 0 },
        request: { ...DEFAULT_BRUSH, radius: 2, strength: 1, falloff: 0 },
        world: { ...DEFAULT_BRUSH, radius: 2, strength: 1, falloff: 0 },
    };
    flattenMode: FlattenMode = 'both';
    flattenTarget = 0;
    flattenPickOnStroke = true;
    noiseScale = 40;
    talusAngle = 32;
    hydroDroplets = 60;
    terraceStep = 6;
    terraceSharpness = 0.7;
    rampWidth = 12;
    paintLayer = 0;
    foliageSelection = new Set<number>();
    waterLevel = 0;
    waterPickOnStroke = true;
    waterDepth = 3;
    waterCarve = true;
    showGrid = false;
    /** Request tool: outline being drawn (world metres) and the draft note. */
    requestPoints: { x: number; z: number }[] = [];
    /** Place tool: the player start, or props from the library. */
    placeTool: 'spawn' | 'props' = 'spawn';
    propModel: number | null = null;
    /** Degrees; ignored with random rotation. */
    propYaw = 0;
    propRandomYaw = true;
    propScale = 1;
    /** Props: place new ones, or select placed ones to move / turn / resize. */
    propMode: 'place' | 'select' = 'place';
    selectedProp: string | null = null;
    requestNote = '';

    get brush(): BrushSettings {
        return this.brushes[this.group];
    }
}

/**
 * The in-game world editor (build mode): viewport camera, cursor ray, brush strokes and undo.
 */
export class Editor {
    readonly state = new EditorState();
    readonly fly: FlyCamera;
    readonly history: History;
    readonly cursor = new THREE.Vector3();
    cursorValid = false;
    private stroking = false;
    private strokeInvert = false;
    private rampStart: THREE.Vector3 | null = null;
    private rampMarker: THREE.Mesh;
    private spawnMarker: THREE.Group;
    private raycaster = new THREE.Raycaster();
    /** Props: see-through preview of the next placement, and the box around the selected prop. */
    private propGhost: THREE.Object3D | null = null;
    private propGhostModel: number | null = null;
    private propGhostLoading: number | null = null;
    /** Rotation (rad) of the next placement with random rotation, pre-rolled so the preview matches. */
    private nextPropYaw = Math.random() * Math.PI * 2;
    private selectionBox: THREE.LineSegments;
    private propDrag: {
        id: string;
        dx: number;
        dz: number;
        moved: boolean;
    } | null = null;
    private propEditTimer: number | null = null;
    private pendingHeightRect: GridRect | null = null;
    private pendingWaterRect: GridRect | null = null;
    private rebuildTimer = 0;
    private listeners = new Set<() => void>();
    private active = false;

    constructor(
        private readonly world: EditorWorld,
        private readonly camera: THREE.PerspectiveCamera,
        private readonly input: Input,
        private readonly scene: THREE.Scene,
        private readonly callbacks: EditorCallbacks,
        settings: EditorSettings,
    ) {
        this.fly = new FlyCamera(camera, settings.fly_speed);
        this.history = new History({
            maxSteps: settings.undo_steps,
            onChange: (u, r) => callbacks.onHistory(u, r),
        });

        this.history.registerGrid(
            'height',
            {
                resolution: world.heights.resolution,
                data: world.heights.data,
                channels: 1,
            },
            (rect) => {
                world.terrain.updateRect(rect);
                this.queueWaterRebuild(rect);
                this.snapFoliage(rect);
                callbacks.markDirty('heightmap');
            },
        );
        this.history.registerGrid(
            'splat',
            {
                resolution: world.splat.resolution,
                data: world.splat.data,
                channels: 8,
            },
            (rect) => {
                world.splat.syncRect(rect);
                callbacks.markDirty('splatmap');
            },
        );
        this.history.registerGrid(
            'water',
            {
                resolution: world.waterGrid.resolution,
                data: world.waterGrid.data,
                channels: 1,
            },
            (rect) => {
                this.queueWaterRebuild(rect);
                callbacks.markDirty('water');
            },
        );
        this.history.registerCustom('foliage', {
            capture: (id) => {
                const [typeId, key] = splitFoliageId(id);

                return world.foliage.captureCell(typeId, key);
            },
            restore: (id, state) => {
                const [typeId, key] = splitFoliageId(id);
                world.foliage.restoreCell(typeId, key, state as number[]);
                callbacks.markDirty('foliage');
            },
        });
        this.history.registerCustom('props', {
            capture: () => world.props.serialize(),
            restore: (_id, state) => {
                world.props.load(state as PropsFile);
                callbacks.markDirty('props');
            },
        });
        world.foliage.onBeforeModify = (typeId, key) => {
            if (this.history.recording) {
                this.history.touchCustom('foliage', `${typeId}|${key}`);
            }
        };

        this.rampMarker = new THREE.Mesh(
            new THREE.SphereGeometry(1, 16, 12),
            new THREE.MeshBasicMaterial({
                color: 0x4fc3ff,
                depthTest: false,
                transparent: true,
                opacity: 0.8,
            }),
        );
        this.rampMarker.visible = false;
        this.rampMarker.renderOrder = 10;
        scene.add(this.rampMarker);

        this.spawnMarker = createSpawnMarker();
        scene.add(this.spawnMarker);

        this.selectionBox = new THREE.LineSegments(
            new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
            new THREE.LineBasicMaterial({
                color: 0x3fd8ff,
                depthTest: false,
                transparent: true,
                opacity: 0.9,
            }),
        );
        this.selectionBox.matrixAutoUpdate = false;
        this.selectionBox.renderOrder = 11;
        this.selectionBox.visible = false;
        scene.add(this.selectionBox);
        this.updateSpawnMarker();

        for (const type of world.foliageTypes.slice(0, 1)) {
            this.state.foliageSelection.add(type.id);
        }

        const { min, max } = world.heights.minMax();
        this.state.flattenTarget = (min + max) / 2;
        this.state.waterLevel = min + (max - min) * 0.2;
    }

    /** Subscribe to state changes (for the panel UI). */
    subscribe(fn: () => void): () => void {
        this.listeners.add(fn);

        return () => this.listeners.delete(fn);
    }

    notify(): void {
        this.world.material.setGridVisible(this.active && this.state.showGrid);

        for (const fn of this.listeners) {
            fn();
        }
    }

    setActive(active: boolean): void {
        this.active = active;
        this.spawnMarker.visible = active;
        this.rampMarker.visible = active && this.rampStart !== null;
        this.world.material.setGridVisible(active && this.state.showGrid);

        if (!active) {
            this.endStroke();
            this.world.material.hideBrush();
            this.selectionBox.visible = false;

            if (this.propGhost) {
                this.propGhost.visible = false;
            }
        }
    }

    setGroup(group: EditorToolGroup): void {
        if (this.state.group === group) {
            return;
        }

        this.endStroke();
        this.state.group = group;
        this.rampStart = null;
        this.rampMarker.visible = false;
        this.callbacks.onToolGroup(group);
        this.notify();
    }

    setSculptTool(tool: SculptTool): void {
        this.state.sculptTool = tool;
        this.rampStart = null;
        this.rampMarker.visible = false;
        this.notify();
    }

    setLayers(layers: TerrainLayer[]): void {
        this.world.layers = layers;

        if (
            !layers.some((l) => l.slot === this.state.paintLayer) &&
            layers[0]
        ) {
            this.state.paintLayer = layers[0].slot;
        }

        this.notify();
    }

    setFoliageTypes(types: FoliageType[]): void {
        this.world.foliageTypes = types;

        for (const id of this.state.foliageSelection) {
            if (!types.some((t) => t.id === id)) {
                this.state.foliageSelection.delete(id);
            }
        }

        this.notify();
    }

    get layers(): TerrainLayer[] {
        return this.world.layers;
    }

    get foliageTypes(): FoliageType[] {
        return this.world.foliageTypes;
    }

    undo(): void {
        this.endStroke();

        if (this.history.undo()) {
            this.flushRebuilds();
        }
    }

    redo(): void {
        this.endStroke();

        if (this.history.redo()) {
            this.flushRebuilds();
        }
    }

    /** Goes back or forward to a step of the history list (History panel); returns the steps moved. */
    jumpHistory(position: number): number {
        this.endStroke();
        const moved = this.history.jumpTo(position);

        if (moved) {
            this.flushRebuilds();
        }

        return moved;
    }

    /** Re-applies the automatic material rules to the whole map (undoable). */
    /**
     * Softens the whole terrain: an edge-aware blur that removes stair steps and hard creases while
     * keeping large landforms. Water beds are left alone (undoable).
     */
    softenMap(strength = 0.5): void {
        const hf = this.world.heights;
        const res = hf.resolution;
        const rect = { x0: 0, z0: 0, x1: res - 1, z1: res - 1 };
        const src = new Float32Array(hf.data);
        const water = this.world.waterGrid.data;
        const passes = Math.max(1, Math.round(strength * 4));
        this.history.beginStroke('Soften map');
        this.history.touch('height', rect);

        for (let pass = 0; pass < passes; pass++) {
            src.set(hf.data);

            for (let r = 1; r < res - 1; r++) {
                for (let c = 1; c < res - 1; c++) {
                    const i = r * res + c;

                    if (water[i] > NO_WATER + 1) {
                        continue;
                    }

                    const avg =
                        (src[i - 1] +
                            src[i + 1] +
                            src[i - res] +
                            src[i + res]) *
                            0.15 +
                        (src[i - res - 1] +
                            src[i - res + 1] +
                            src[i + res - 1] +
                            src[i + res + 1]) *
                            0.1;
                    // Blend less on steep ground so cliffs keep their character.
                    const slope =
                        Math.abs(src[i + 1] - src[i - 1]) +
                        Math.abs(src[i + res] - src[i - res]);
                    const keep = Math.min(1, slope / (hf.cell * 3));
                    const k = 0.85 * (1 - keep * 0.6);
                    hf.data[i] = src[i] + (avg - src[i]) * k;
                }
            }
        }

        this.history.endStroke();
        this.onHeightsChanged(rect);
        this.flushRebuilds();
    }

    autoPaint(): void {
        const res = this.world.splat.resolution;
        const rect = { x0: 0, z0: 0, x1: res - 1, z1: res - 1 };
        this.history.beginStroke('Auto paint');
        this.history.touch('splat', rect);
        this.world.splat.autoPaint(this.world.heights, this.world.layers);
        this.history.endStroke();
        this.callbacks.markDirty('splatmap');
    }

    /** Procedurally scatters the given foliage types over the whole map (undoable). */
    populateFoliage(typeIds: number[]): number {
        this.history.beginStroke('Scatter foliage');
        const count = this.world.foliage.populate(
            this.ctx(),
            typeIds,
            Math.floor(Math.random() * 1e6),
        );
        this.history.endStroke();
        this.callbacks.markDirty('foliage');

        return count;
    }

    /** Clears every foliage instance of the selected types (undoable). */
    clearFoliage(typeIds: number[]): void {
        this.history.beginStroke('Clear foliage');
        this.world.foliage.erase(
            typeIds,
            0,
            0,
            this.world.heights.size,
            1,
            () => 1,
        );
        this.history.endStroke();
        this.callbacks.markDirty('foliage');
    }

    update(dt: number): void {
        if (!this.active) {
            return;
        }

        const input = this.input;
        this.handleShortcuts();

        const overUi = this.callbacks.isPointerOverUi();
        this.updateCursor(overUi);
        this.fly.update(
            dt,
            input,
            this.world.heights,
            this.cursorValid ? this.cursor : null,
        );

        const rmb = input.buttons.has(2);
        const lmb = input.buttons.has(0) && !input.alt;
        const canPaint = lmb && !rmb && this.cursorValid && !overUi;

        if (canPaint && !this.stroking) {
            this.beginStroke();
        } else if (!input.buttons.has(0) && this.stroking) {
            this.endStroke();
        }

        if (this.stroking && this.cursorValid) {
            this.applyStroke(dt);
        }

        this.updateBrushOverlay(overUi || rmb);
        this.updatePropOverlays(overUi || rmb);

        this.rebuildTimer -= dt;

        if (
            this.rebuildTimer <= 0 &&
            (this.pendingWaterRect || this.pendingHeightRect)
        ) {
            this.flushRebuilds();
            this.rebuildTimer = 0.12;
        }
    }

    dispose(): void {
        this.scene.remove(this.rampMarker, this.spawnMarker, this.selectionBox);
        this.setPropGhost(null, null);
        this.rampMarker.geometry.dispose();
        (this.rampMarker.material as THREE.Material).dispose();
        this.listeners.clear();
    }

    /** World data for scripted edits (AI agents, see editor/agent). */
    get worldData(): EditorWorld {
        return this.world;
    }

    /** Placement rules context for foliage (terrain, water, land cover). */
    placementContext() {
        return this.ctx();
    }

    /**
     * Runs a scripted edit (AI agents) as one undo step: the channels are recorded over `rect` (grid
     * samples) before `fn` changes the world data, then terrain, water, paint and foliage are rebuilt
     * and marked unsaved like after a brush stroke.
     */
    scriptedEdit<T>(
        label: string,
        rect: GridRect,
        channels: ('height' | 'splat' | 'water' | 'foliage' | 'props')[],
        fn: () => T,
    ): T {
        this.endStroke();
        this.history.beginStroke(label);

        for (const channel of channels) {
            if (channel === 'props') {
                this.history.touchCustom('props', 'all');
            } else if (channel !== 'foliage') {
                this.history.touch(channel, rect);
            }
        }

        let result: T;

        try {
            result = fn();
        } finally {
            this.history.endStroke();
        }

        if (channels.includes('height')) {
            this.onHeightsChanged(rect);
        }

        if (channels.includes('splat')) {
            this.world.splat.syncRect(rect);
            this.callbacks.markDirty('splatmap');
        }

        if (channels.includes('water')) {
            this.queueWaterRebuild(rect);
            this.callbacks.markDirty('water');
        }

        if (channels.includes('foliage')) {
            this.callbacks.markDirty('foliage');
        }

        if (channels.includes('props')) {
            this.callbacks.markDirty('props');
        }

        this.flushRebuilds();

        return result;
    }

    /** Request tool: replaces the outline being drawn (e.g. cleared after sending). */
    setRequestPoints(points: { x: number; z: number }[]): void {
        this.state.requestPoints = points;
        this.callbacks.onRequestOutline?.(points);
        this.notify();
    }

    /** Player start set from outside the editor (e.g. by an agent). */
    setSpawn(spawn: { x: number; z: number; yaw: number } | null): void {
        this.world.spawn = spawn;
        this.updateSpawnMarker();
    }

    updateSpawnMarker(): void {
        const spawn = this.world.spawn;
        const x = spawn?.x ?? 0;
        const z = spawn?.z ?? 0;
        this.spawnMarker.position.set(x, this.world.heights.sample(x, z), z);
        this.spawnMarker.rotation.y = spawn?.yaw ?? 0;
    }

    private handleShortcuts(): void {
        const input = this.input;
        const groups: EditorToolGroup[] = [
            'sculpt',
            'paint',
            'foliage',
            'water',
            'place',
            'request',
            'world',
        ];

        if (input.buttons.has(2)) {
            return;
        }

        for (let i = 0; i < groups.length; i++) {
            if (input.wasPressed(`Digit${i + 1}`) && !input.ctrl) {
                this.setGroup(groups[i]);
            }
        }

        // Request tool: Backspace removes the last outline point.
        if (
            this.state.group === 'request' &&
            input.wasPressed('Backspace') &&
            this.state.requestPoints.length
        ) {
            this.setRequestPoints(this.state.requestPoints.slice(0, -1));
        }

        const brush = this.state.brush;

        if (input.wasPressed('BracketLeft')) {
            brush.radius = Math.max(0.5, brush.radius / 1.15);
            this.notify();
        }

        if (input.wasPressed('BracketRight')) {
            brush.radius = Math.min(2000, brush.radius * 1.15);
            this.notify();
        }

        if (input.wasPressed('Minus')) {
            brush.strength = Math.max(0.01, brush.strength - 0.05);
            this.notify();
        }

        if (input.wasPressed('Equal')) {
            brush.strength = Math.min(1, brush.strength + 0.05);
            this.notify();
        }

        if (input.ctrl && input.wasPressed('KeyZ')) {
            if (input.shift) {
                this.redo();
            } else {
                this.undo();
            }
        }

        if (input.ctrl && input.wasPressed('KeyY')) {
            this.redo();
        }

        if (input.ctrl && input.wasPressed('KeyS')) {
            this.callbacks.requestSave();
        }

        if (input.wasPressed('KeyF') && this.cursorValid) {
            this.fly.focus(
                this.cursor,
                Math.max(40, this.state.brush.radius * 4),
            );
        }

        if (input.wasPressed('KeyG') && !input.ctrl) {
            this.state.showGrid = !this.state.showGrid;
            this.world.material.setGridVisible(this.state.showGrid);
            this.notify();
        }

        if (input.wasPressed('KeyV') && !input.ctrl) {
            this.callbacks.cycleViewMode(input.shift ? -1 : 1);
        }

        if (input.wasPressed('KeyP') && !input.ctrl) {
            this.callbacks.requestPlay(!input.alt);
        }

        if (this.state.group === 'place' && this.state.placeTool === 'props') {
            this.propShortcuts();
        }

        if (input.wasPressed('Escape')) {
            this.rampStart = null;
            this.rampMarker.visible = false;
        }
    }

    /** Props: R / Shift+R turn by 15°, Delete removes, Ctrl+D duplicates, Esc deselects. */
    private propShortcuts(): void {
        const input = this.input;
        const s = this.state;
        const step = input.shift ? -15 : 15;

        if (input.wasPressed('KeyR') && !input.ctrl) {
            if (s.propMode === 'select') {
                this.rotateSelectedProp(step);
            } else {
                if (s.propRandomYaw) {
                    s.propYaw = Math.round(
                        THREE.MathUtils.radToDeg(this.nextPropYaw),
                    );
                    s.propRandomYaw = false;
                }

                s.propYaw = (((s.propYaw + step) % 360) + 360) % 360;
                this.notify();
            }
        }

        if (s.propMode !== 'select' || !s.selectedProp) {
            return;
        }

        if (input.wasPressed('Delete') || input.wasPressed('Backspace')) {
            this.deleteSelectedProp();
        }

        if (input.ctrl && input.wasPressed('KeyD')) {
            this.duplicateSelectedProp();
        }

        if (input.wasPressed('Escape')) {
            this.selectProp(null);
        }
    }

    private updateCursor(overUi: boolean): void {
        if (!this.input.pointerOverCanvas || overUi) {
            this.cursorValid = false;

            return;
        }

        this.raycaster.setFromCamera(
            new THREE.Vector2(this.input.ndcX, this.input.ndcY),
            this.camera,
        );
        const hit = this.world.heights.raycast(
            this.raycaster.ray,
            this.camera.far,
            this.cursor,
        );
        this.cursorValid = hit !== null;
    }

    private updateBrushOverlay(hidden: boolean): void {
        const s = this.state;
        const b = s.brush;

        if (
            hidden ||
            !this.cursorValid ||
            s.group === 'place' ||
            s.group === 'request' ||
            s.group === 'world'
        ) {
            this.world.material.hideBrush();

            return;
        }

        const color = new THREE.Color();
        const invert = this.input.shift;

        switch (s.group) {
            case 'sculpt':
                color.set(invert ? '#ff9a3c' : '#43b6ff');
                break;
            case 'paint': {
                const layer = this.world.layers.find(
                    (l) => l.slot === s.paintLayer,
                );
                color
                    .set(invert ? '#ff5a5a' : (layer?.color ?? '#ffffff'))
                    .lerp(new THREE.Color('#ffffff'), 0.35);
                break;
            }
            case 'foliage':
                color.set(
                    invert || s.foliageTool === 'erase' ? '#ff5a5a' : '#6fe36b',
                );
                break;
            case 'water':
                color.set(
                    invert || s.waterTool === 'erase' ? '#ff5a5a' : '#3fd8ff',
                );
                break;
        }

        const radius =
            s.group === 'sculpt' && s.sculptTool === 'ramp'
                ? s.rampWidth / 2
                : b.radius;
        this.world.material.setBrush({
            x: this.cursor.x,
            z: this.cursor.z,
            radius,
            falloff: b.falloff,
            visible: true,
            color: color.multiplyScalar(0.55),
        });
    }

    private beginStroke(): void {
        const s = this.state;
        this.strokeInvert = this.input.shift;

        // One-shot / click tools.
        if (s.group === 'sculpt' && s.sculptTool === 'ramp') {
            this.handleRampClick();

            return;
        }

        if (s.group === 'place' && s.placeTool === 'props') {
            if (s.propMode === 'select') {
                this.grabProp();
            } else {
                this.placeProp(this.input.shift);
                // One prop per click: wait for the button to be released.
                this.history.beginStroke('noop');
            }

            this.stroking = true;

            return;
        }

        if (s.group === 'place') {
            this.placeSpawn();

            return;
        }

        // World settings: no tool acts on the terrain.
        if (s.group === 'world') {
            return;
        }

        if (s.group === 'request') {
            s.requestPoints = [
                ...s.requestPoints,
                { x: this.cursor.x, z: this.cursor.z },
            ];
            this.callbacks.onRequestOutline?.(s.requestPoints);
            this.notify();
            // One point per click: wait for the button to be released.
            this.stroking = true;
            this.history.beginStroke('noop');

            return;
        }

        if (
            this.input.ctrl &&
            ((s.group === 'sculpt' && s.sculptTool === 'flatten') ||
                s.group === 'water')
        ) {
            // Ctrl+click samples the target height.
            if (s.group === 'water') {
                const existing = this.world.water.levelAt(
                    this.cursor.x,
                    this.cursor.z,
                );
                s.waterLevel = existing ?? this.cursor.y;
                s.waterPickOnStroke = false;
            } else {
                s.flattenTarget = this.cursor.y;
                s.flattenPickOnStroke = false;
            }

            this.notify();
            // Wait for the button to be released before stroking.
            this.stroking = true;
            this.history.beginStroke('Pick');

            return;
        }

        if (
            s.group === 'sculpt' &&
            s.sculptTool === 'flatten' &&
            s.flattenPickOnStroke
        ) {
            s.flattenTarget = this.cursor.y;
            this.notify();
        }

        if (
            s.group === 'water' &&
            s.waterTool === 'lake' &&
            s.waterPickOnStroke
        ) {
            // Level at the terrain (or existing water) under the cursor so ponds don't float.
            s.waterLevel =
                this.world.water.levelAt(this.cursor.x, this.cursor.z) ??
                this.cursor.y - 0.3;
            this.notify();
        }

        if (s.group === 'foliage' && s.foliageTool === 'single') {
            const id = [...s.foliageSelection][0];

            if (id !== undefined) {
                this.history.beginStroke('Place foliage');

                if (
                    this.world.foliage.placeSingle(
                        this.ctx(),
                        id,
                        this.cursor.x,
                        this.cursor.z,
                    )
                ) {
                    this.callbacks.markDirty('foliage');
                }

                this.history.endStroke();
            }

            this.stroking = true;
            this.history.beginStroke('noop');

            return;
        }

        this.stroking = true;
        this.history.beginStroke(`${s.group}`);
    }

    private endStroke(): void {
        if (!this.stroking) {
            return;
        }

        this.stroking = false;
        this.history.endStroke();
        this.flushRebuilds();

        if (this.propDrag?.moved) {
            this.callbacks.markDirty('props');
        }

        this.propDrag = null;
    }

    private applyStroke(dt: number): void {
        const s = this.state;

        if (s.group === 'place') {
            this.dragProp();

            return;
        }

        const b = s.brush;
        const { x, z } = this.cursor;
        const hf = this.world.heights;
        const invert = this.strokeInvert;

        if (
            this.input.ctrl &&
            (s.group === 'water' ||
                (s.group === 'sculpt' && s.sculptTool === 'flatten'))
        ) {
            return;
        }

        switch (s.group) {
            case 'sculpt': {
                this.history.touch(
                    'height',
                    hf.rectForCircle(x, z, b.radius, 4),
                );
                let rect: GridRect | null = null;

                switch (s.sculptTool) {
                    case 'sculpt':
                        rect = sculpt(hf, x, z, b, dt, invert);
                        break;
                    case 'smooth':
                        rect = smooth(hf, x, z, b, dt);
                        break;
                    case 'flatten':
                        rect = flatten(hf, x, z, b, dt, {
                            target: s.flattenTarget,
                            mode: s.flattenMode,
                        });
                        break;
                    case 'erosion':
                        rect = thermalErosion(hf, x, z, b, dt, {
                            talusAngle: s.talusAngle,
                            iterations: 4,
                        });
                        break;
                    case 'hydro':
                        rect = hydraulicErosion(hf, x, z, b, dt, {
                            droplets: s.hydroDroplets,
                        });
                        break;
                    case 'noise':
                        rect = noise(
                            hf,
                            x,
                            z,
                            b,
                            dt,
                            { scale: s.noiseScale, seed: 1234 },
                            invert,
                        );
                        break;
                    case 'terrace':
                        rect = terrace(hf, x, z, b, dt, {
                            step: s.terraceStep,
                            sharpness: s.terraceSharpness,
                        });
                        break;
                    default:
                        break;
                }

                if (rect) {
                    this.onHeightsChanged(rect);
                }

                break;
            }
            case 'paint':
                this.paintSplat(x, z, b, dt, invert);
                break;
            case 'foliage': {
                const ids = [...s.foliageSelection];

                if (!ids.length || s.foliageTool === 'single') {
                    break;
                }

                const weight = (d: number) => brushWeight(d, b);

                if (s.foliageTool === 'erase' || invert) {
                    this.world.foliage.erase(
                        ids,
                        x,
                        z,
                        b.radius,
                        b.strength * dt * 8,
                        weight,
                    );
                } else {
                    this.world.foliage.paint(
                        this.ctx(),
                        ids,
                        x,
                        z,
                        b.radius,
                        b.strength,
                        dt,
                        weight,
                    );
                }

                this.callbacks.markDirty('foliage');
                break;
            }
            case 'water':
                this.paintWater(x, z, b, invert || s.waterTool === 'erase');
                break;
            default:
                break;
        }
    }

    private paintSplat(
        x: number,
        z: number,
        b: BrushSettings,
        dt: number,
        invert: boolean,
    ): void {
        const splat = this.world.splat;
        const hf = this.world.heights;
        const rect = hf.rectForCircle(x, z, b.radius);
        this.history.touch('splat', rect);
        const rate = b.strength * dt * 4;

        for (let row = rect.z0; row <= rect.z1; row++) {
            for (let col = rect.x0; col <= rect.x1; col++) {
                const d = Math.hypot(hf.colToX(col) - x, hf.rowToZ(row) - z);
                const w = brushWeight(d, b);

                if (w <= 0) {
                    continue;
                }

                splat.paint(
                    col,
                    row,
                    this.state.paintLayer,
                    (invert ? -1 : 1) * w * rate,
                );
            }
        }

        splat.syncRect(rect);
        this.callbacks.markDirty('splatmap');
    }

    private paintWater(
        x: number,
        z: number,
        b: BrushSettings,
        erase: boolean,
    ): void {
        const s = this.state;
        const hf = this.world.heights;
        const wg = this.world.waterGrid;
        const rect = hf.rectForCircle(x, z, b.radius);
        this.history.touch('water', rect);

        if (!erase && s.waterCarve) {
            this.history.touch('height', rect);
        }

        let heightsChanged = false;

        for (let row = rect.z0; row <= rect.z1; row++) {
            for (let col = rect.x0; col <= rect.x1; col++) {
                const d = Math.hypot(hf.colToX(col) - x, hf.rowToZ(row) - z);
                const w = brushWeight(d, b);

                if (w < 0.5) {
                    continue;
                }

                const i = row * hf.resolution + col;

                if (erase) {
                    wg.data[i] = NO_WATER;
                    continue;
                }

                const ground = hf.data[i];
                let surface: number;

                if (s.waterTool === 'river') {
                    // Keep existing river levels so repeated passes don't dig deeper.
                    surface =
                        wg.data[i] > NO_WATER + 1 ? wg.data[i] : ground - 0.15;
                } else {
                    surface = s.waterLevel;

                    if (ground >= surface && !s.waterCarve) {
                        continue;
                    }
                }

                wg.data[i] = surface;

                if (s.waterCarve) {
                    const bed = surface - s.waterDepth * Math.min(1, w * 1.2);

                    if (ground > bed) {
                        hf.data[i] = bed;
                        heightsChanged = true;
                    }
                }
            }
        }

        if (heightsChanged) {
            this.onHeightsChanged(rect);
        }

        this.queueWaterRebuild(rect);
        this.callbacks.markDirty('water');
    }

    private handleRampClick(): void {
        const hf = this.world.heights;

        if (!this.rampStart) {
            this.rampStart = this.cursor.clone();
            this.rampMarker.position.copy(this.rampStart);
            this.rampMarker.scale.setScalar(
                Math.max(0.6, this.state.rampWidth * 0.08),
            );
            this.rampMarker.visible = true;

            return;
        }

        const start = this.rampStart;
        const end = this.cursor.clone();
        const pad = this.state.rampWidth;
        const rect = {
            x0: Math.max(
                0,
                Math.floor(hf.toGrid(Math.min(start.x, end.x) - pad, 0).gx),
            ),
            x1: Math.min(
                hf.resolution - 1,
                Math.ceil(hf.toGrid(Math.max(start.x, end.x) + pad, 0).gx),
            ),
            z0: Math.max(
                0,
                Math.floor(hf.toGrid(0, Math.min(start.z, end.z) - pad).gz),
            ),
            z1: Math.min(
                hf.resolution - 1,
                Math.ceil(hf.toGrid(0, Math.max(start.z, end.z) + pad).gz),
            ),
        };
        this.history.beginStroke('Ramp');
        this.history.touch('height', rect);
        const changed = ramp(
            hf,
            start,
            end,
            this.state.rampWidth,
            this.state.brush.falloff,
        );
        this.history.endStroke();

        if (changed) {
            this.onHeightsChanged(changed);
        }

        this.rampStart = null;
        this.rampMarker.visible = false;
    }

    /** Place tool (props): adds the selected model at the cursor, or (remove) deletes the nearest prop. */
    private placeProp(remove: boolean): void {
        const s = this.state;
        const props = this.world.props;
        this.history.beginStroke(remove ? 'Remove prop' : 'Place prop');
        this.history.touchCustom('props', 'all');

        if (remove) {
            const hit = props.nearest(this.cursor.x, this.cursor.z, 8);

            if (hit) {
                props.remove([hit.id]);
            }
        } else if (s.propModel !== null) {
            props.add({
                model: s.propModel,
                x: this.cursor.x,
                z: this.cursor.z,
                yaw: s.propRandomYaw
                    ? this.nextPropYaw
                    : THREE.MathUtils.degToRad(s.propYaw),
                scale: s.propScale,
                offset: 0,
            });
        }

        this.history.endStroke();
        this.callbacks.markDirty('props');
        this.nextPropYaw = Math.random() * Math.PI * 2;
    }

    // ---------------------------------------------------------------- props: select and edit

    /** Selects the prop under the cursor (or clears the selection) and starts dragging it. */
    private grabProp(): void {
        const s = this.state;
        this.history.beginStroke('Move prop');
        const hit = this.world.props.pick(this.raycaster.ray);
        s.selectedProp = hit?.id ?? null;
        this.propDrag = hit
            ? {
                  id: hit.id,
                  dx: hit.x - this.cursor.x,
                  dz: hit.z - this.cursor.z,
                  moved: false,
              }
            : null;
        this.notify();
    }

    private dragProp(): void {
        const drag = this.propDrag;

        if (!drag) {
            return;
        }

        const p = this.world.props.get(drag.id);
        const x = this.cursor.x + drag.dx;
        const z = this.cursor.z + drag.dz;

        if (!p || (Math.abs(p.x - x) < 0.01 && Math.abs(p.z - z) < 0.01)) {
            return;
        }

        if (!drag.moved) {
            // Recorded on the first real move, so a plain click leaves no undo step.
            this.history.touchCustom('props', 'all');
            drag.moved = true;
        }

        this.world.props.update(drag.id, { x, z });
    }

    /** The selected placed prop, if it still exists (undo can remove it). */
    get selectedProp() {
        const id = this.state.selectedProp;

        return id ? this.world.props.get(id) : null;
    }

    selectProp(id: string | null): void {
        this.state.selectedProp = id;
        this.notify();
    }

    /**
     * Changes the selected prop. Consecutive changes (dragging a slider) merge into one undo step
     * unless `step` asks for a step of its own (keyboard shortcuts).
     */
    editSelectedProp(
        patch: { yaw?: number; scale?: number; offset?: number },
        step = false,
    ): void {
        const p = this.selectedProp;

        if (!p) {
            return;
        }

        if (step || this.propEditTimer === null || !this.history.recording) {
            this.history.beginStroke('Edit prop');
            this.history.touchCustom('props', 'all');
        }

        if (this.propEditTimer !== null) {
            window.clearTimeout(this.propEditTimer);
        }

        this.world.props.update(p.id, patch);
        this.callbacks.markDirty('props');

        if (step) {
            this.history.endStroke();
            this.propEditTimer = null;
        } else {
            this.propEditTimer = window.setTimeout(() => {
                this.propEditTimer = null;
                this.history.endStroke();
            }, 500);
        }
    }

    rotateSelectedProp(degrees: number): void {
        const p = this.selectedProp;

        if (p) {
            this.editSelectedProp(
                {
                    yaw: normalizeAngle(
                        p.yaw + THREE.MathUtils.degToRad(degrees),
                    ),
                },
                true,
            );
            this.notify();
        }
    }

    deleteSelectedProp(): void {
        const p = this.selectedProp;

        if (!p) {
            return;
        }

        this.history.beginStroke('Remove prop');
        this.history.touchCustom('props', 'all');
        this.world.props.remove([p.id]);
        this.history.endStroke();
        this.callbacks.markDirty('props');
        this.selectProp(null);
    }

    /** Copies the selected prop next to it and selects the copy. */
    duplicateSelectedProp(): void {
        const p = this.selectedProp;

        if (!p) {
            return;
        }

        const step = Math.max(
            2,
            this.world.props.modelRadius(p.model, p.scale) * 1.2,
        );
        this.history.beginStroke('Duplicate prop');
        this.history.touchCustom('props', 'all');
        const copy = this.world.props.add({
            model: p.model,
            x: p.x + step,
            z: p.z,
            yaw: p.yaw,
            scale: p.scale,
            offset: p.offset,
        });
        this.history.endStroke();
        this.callbacks.markDirty('props');
        this.selectProp(copy.id);
    }

    /** Placement preview (Place mode) and the selection box (Select mode). */
    private updatePropOverlays(hidden: boolean): void {
        const s = this.state;
        const propsTool =
            this.active && s.group === 'place' && s.placeTool === 'props';
        const placing =
            propsTool && s.propMode === 'place' && s.propModel !== null;

        if (s.selectedProp && !this.world.props.get(s.selectedProp)) {
            this.selectProp(null);
        }

        const bounds =
            propsTool && s.propMode === 'select' && s.selectedProp
                ? this.world.props.boundsMatrix(s.selectedProp)
                : null;
        this.selectionBox.visible = bounds !== null;

        if (bounds) {
            this.selectionBox.matrix.copy(bounds);
            this.selectionBox.matrixWorld.copy(bounds);
        }

        if (!placing) {
            if (this.propGhost) {
                this.propGhost.visible = false;
            }

            return;
        }

        if (
            this.propGhostModel !== s.propModel &&
            this.propGhostLoading !== s.propModel
        ) {
            const model = s.propModel!;
            this.propGhostLoading = model;
            void this.world.props.preview(model).then((object) => {
                if (this.propGhostLoading !== model) {
                    Props.disposePreview(object);

                    return;
                }

                this.propGhostLoading = null;
                this.setPropGhost(object, model);
            });
        }

        const ghost = this.propGhost;

        if (!ghost) {
            return;
        }

        ghost.visible = !hidden && this.cursorValid && !this.input.shift;

        if (ghost.visible) {
            const radius =
                ((ghost.userData.radius as number) ?? 1) * s.propScale;
            ghost.position.set(
                this.cursor.x,
                this.world.props.groundAt(this.cursor.x, this.cursor.z, radius),
                this.cursor.z,
            );
            ghost.rotation.y = s.propRandomYaw
                ? this.nextPropYaw
                : THREE.MathUtils.degToRad(s.propYaw);
            ghost.scale.setScalar(s.propScale);
        }
    }

    private setPropGhost(
        object: THREE.Object3D | null,
        model: number | null,
    ): void {
        if (this.propGhost) {
            this.scene.remove(this.propGhost);
            Props.disposePreview(this.propGhost);
        }

        this.propGhost = object;
        this.propGhostModel = model;

        if (object) {
            object.visible = false;
            this.scene.add(object);
        }
    }

    private placeSpawn(): void {
        const dir = new THREE.Vector3();
        this.camera.getWorldDirection(dir);
        const yaw = Math.atan2(-dir.x, -dir.z);
        this.world.spawn = { x: this.cursor.x, z: this.cursor.z, yaw };
        this.updateSpawnMarker();
        this.callbacks.onSpawnChanged(this.world.spawn);
        this.callbacks.markDirty('meta');
    }

    private onHeightsChanged(rect: GridRect): void {
        this.world.terrain.updateRect(rect);
        this.pendingHeightRect = union(this.pendingHeightRect, rect);
        this.callbacks.markDirty('heightmap');
    }

    private queueWaterRebuild(rect: GridRect): void {
        this.pendingWaterRect = union(this.pendingWaterRect, rect);
    }

    private flushRebuilds(): void {
        if (this.pendingHeightRect) {
            const rect = this.pendingHeightRect;
            this.pendingHeightRect = null;
            this.snapFoliage(rect);
            this.pendingWaterRect = union(this.pendingWaterRect, rect);

            if (rect && this.spawnInRect(rect)) {
                this.updateSpawnMarker();
            }
        }

        if (this.pendingWaterRect) {
            this.world.water.rebuildRect(this.pendingWaterRect);
            this.pendingWaterRect = null;
        }
    }

    private snapFoliage(rect: GridRect): void {
        const hf = this.world.heights;
        this.world.props.snap(
            hf.colToX(rect.x0),
            hf.rowToZ(rect.z0),
            hf.colToX(rect.x1),
            hf.rowToZ(rect.z1),
        );
        this.world.foliage.snapToTerrain(
            hf,
            hf.colToX(rect.x0),
            hf.rowToZ(rect.z0),
            hf.colToX(rect.x1),
            hf.rowToZ(rect.z1),
        );
    }

    private spawnInRect(rect: GridRect): boolean {
        const hf = this.world.heights;
        const spawn = this.world.spawn ?? { x: 0, z: 0 };
        const { gx, gz } = hf.toGrid(spawn.x, spawn.z);

        return (
            gx >= rect.x0 - 1 &&
            gx <= rect.x1 + 1 &&
            gz >= rect.z0 - 1 &&
            gz <= rect.z1 + 1
        );
    }

    private ctx() {
        return {
            heights: this.world.heights,
            waterLevelAt: (x: number, z: number) =>
                this.world.water.levelAt(x, z),
            landCoverAt: this.world.landCoverAt,
        };
    }
}

function union(a: GridRect | null, b: GridRect): GridRect {
    if (!a) {
        return { ...b };
    }

    return {
        x0: Math.min(a.x0, b.x0),
        z0: Math.min(a.z0, b.z0),
        x1: Math.max(a.x1, b.x1),
        z1: Math.max(a.z1, b.z1),
    };
}

function splitFoliageId(id: string): [number, string] {
    const [typeId, key] = id.split('|');

    return [Number(typeId), key];
}

function createSpawnMarker(): THREE.Group {
    const group = new THREE.Group();
    group.name = 'PlayerStart';
    const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.06, 0.08, 3.2, 8),
        new THREE.MeshStandardMaterial({
            color: 0xdddddd,
            metalness: 0.6,
            roughness: 0.3,
        }),
    );
    pole.position.y = 1.6;
    const flag = new THREE.Mesh(
        new THREE.PlaneGeometry(1.3, 0.8),
        new THREE.MeshStandardMaterial({
            color: 0x1ea1ff,
            emissive: 0x0a4a88,
            side: THREE.DoubleSide,
        }),
    );
    flag.position.set(0.65, 2.75, 0);
    const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.9, 1.1, 40),
        new THREE.MeshBasicMaterial({
            color: 0x1ea1ff,
            transparent: true,
            opacity: 0.8,
            side: THREE.DoubleSide,
            depthWrite: false,
        }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.08;
    const arrow = new THREE.Mesh(
        new THREE.ConeGeometry(0.35, 0.9, 12),
        new THREE.MeshBasicMaterial({
            color: 0x1ea1ff,
            transparent: true,
            opacity: 0.9,
        }),
    );
    arrow.rotation.x = -Math.PI / 2;
    arrow.position.set(0, 0.15, -1.6);
    group.add(pole, flag, ring, arrow);

    return group;
}

function normalizeAngle(rad: number): number {
    const full = Math.PI * 2;

    return ((rad % full) + full) % full;
}
