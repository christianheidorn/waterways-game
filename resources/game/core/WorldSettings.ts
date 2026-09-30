import type { Editor } from '../editor/Editor';
import type { WorldHost } from '../editor/ui/WorldPanel';
import type {
    EnvironmentSettings,
    GameManifest,
    MapTemplateSummary,
    MaterialSummary,
    SettingGroupDef,
    SnapshotSummary,
    TerrainLayer,
} from '../shared/types';
import type { Api } from './Api';

/** What the World tab's saving needs from the game. */
export type WorldSettingsDeps = {
    api: Api;
    manifest: () => GameManifest;
    editor: Editor;
    /** New layers everywhere they are used (terrain shading, ground cover, editor). */
    setLayers: (layers: TerrainLayer[]) => void;
    applyEnvironment: (env: EnvironmentSettings) => void;
    flash: (message: string) => void;
    layerSaved: (layer: TerrainLayer) => void;
    heightRange: () => { min: number; max: number };
    unsaved: () => string[];
    save: () => Promise<void>;
    /** Reloads the page without the unsaved-changes prompt. */
    reload: () => void;
};

/** Pause after the last change before it is sent (sliders send many). */
const SAVE_DELAY_MS = 500;

/**
 * The World tab's side in the game: applies layer and environment changes live and saves them to the
 * studio API after a short pause; snapshots, templates and new maps; automatic snapshots after saves.
 */
export class WorldSettings {
    private readonly layerPatches = new Map<number, Partial<TerrainLayer>>();
    private layerTimer = 0;
    private envPatch: Partial<EnvironmentSettings> = {};
    private envTimer = 0;
    private materials: Promise<MaterialSummary[]> | null = null;
    private savedOnce = false;

    constructor(private readonly deps: WorldSettingsDeps) {}

    host(): Omit<WorldHost, 'groundCover'> {
        const d = this.deps;

        return {
            updateLayer: (id, patch) => this.updateLayer(id, patch),
            materials: () => this.loadMaterials(),
            autoPaint: () => d.editor.autoPaint(),
            heightRange: () => d.heightRange(),
            environment: () => d.manifest().environment,
            environmentGroup: () => this.environmentGroup(),
            updateEnvironment: (patch) => this.updateEnvironment(patch),
            history: () => d.editor.history.list(),
            jumpHistory: (position) => {
                d.editor.jumpHistory(position);
                d.editor.notify();
            },
            snapshots: () => this.snapshots(),
            takeSnapshot: (label) => this.takeSnapshot(label),
            restoreSnapshot: (snapshot) => this.restoreSnapshot(snapshot),
            templates: () => this.templates(),
            createMap: (data) => this.createMap(data),
        };
    }

    /** After a successful save: an automatic snapshot of the user's work (the server throttles). */
    async afterSave(): Promise<void> {
        const url = this.deps.manifest().endpoints.snapshots;
        const first = !this.savedOnce;
        this.savedOnce = true;

        if (!url || new URLSearchParams(location.search).get('agent') === '1') {
            return;
        }

        try {
            const res = await this.deps.api.postJson<{
                snapshot: SnapshotSummary | null;
            }>(`${url}/auto`, { first });

            if (res.snapshot) {
                this.deps.flash('Snapshot taken');
            }
        } catch {
            // A missing snapshot never blocks editing.
        }
    }

    // ------------------------------------------------------------------ layers

    private updateLayer(id: number, patch: Partial<TerrainLayer>): void {
        const d = this.deps;
        const layers = d
            .manifest()
            .layers.map((l) => (l.id === id ? { ...l, ...patch } : l));
        d.setLayers(layers);
        this.layerPatches.set(id, { ...this.layerPatches.get(id), ...patch });
        window.clearTimeout(this.layerTimer);
        // A new material needs the server's material data (maps, tile size) before it can show.
        const delay = 'material_id' in patch ? 0 : SAVE_DELAY_MS;
        this.layerTimer = window.setTimeout(
            () => void this.flushLayers(),
            delay,
        );
    }

    private async flushLayers(): Promise<void> {
        const base = this.deps.manifest().endpoints.update_layers;
        const patches = [...this.layerPatches];
        this.layerPatches.clear();

        if (!base) {
            return;
        }

        for (const [id, patch] of patches) {
            try {
                const saved = await this.deps.api.patchJson<TerrainLayer>(
                    `${base}/${id}`,
                    patch,
                );
                // Keep changes made while this request was on its way.
                const pending = this.layerPatches.get(id) ?? {};
                this.deps.setLayers(
                    this.deps
                        .manifest()
                        .layers.map((l) =>
                            l.id === id ? { ...l, ...saved, ...pending } : l,
                        ),
                );
                this.deps.layerSaved(saved);
            } catch (error) {
                this.deps.flash(`Could not save the layer: ${message(error)}`);
            }
        }
    }

    private loadMaterials(): Promise<MaterialSummary[]> {
        const url = this.deps.manifest().endpoints.materials;

        this.materials ??= url
            ? this.deps.api.json<MaterialSummary[]>(url).catch(() => [])
            : Promise.resolve([]);

        return this.materials;
    }

    // ------------------------------------------------------------- environment

    private async environmentGroup(): Promise<SettingGroupDef | null> {
        const url = this.deps.manifest().endpoints.environment;

        if (!url) {
            return null;
        }

        const res = await this.deps.api.json<{
            group: SettingGroupDef;
            values: EnvironmentSettings;
        }>(url);

        return res.group;
    }

    private updateEnvironment(patch: Partial<EnvironmentSettings>): void {
        const d = this.deps;
        d.applyEnvironment({ ...d.manifest().environment, ...patch });
        this.envPatch = { ...this.envPatch, ...patch };
        window.clearTimeout(this.envTimer);
        this.envTimer = window.setTimeout(
            () => void this.flushEnvironment(),
            SAVE_DELAY_MS,
        );
    }

    private async flushEnvironment(): Promise<void> {
        const url = this.deps.manifest().endpoints.environment;
        const patch = this.envPatch;
        this.envPatch = {};

        if (!url || !Object.keys(patch).length) {
            return;
        }

        try {
            await this.deps.api.patchJson(url, patch);
        } catch (error) {
            this.deps.flash(
                `Could not save the environment: ${message(error)}`,
            );
        }
    }

    // --------------------------------------------------------------- snapshots

    private async snapshots(): ReturnType<WorldHost['snapshots']> {
        const url = this.deps.manifest().endpoints.snapshots;

        return url ? this.deps.api.json(url) : null;
    }

    private async takeSnapshot(label: string): Promise<void> {
        const url = this.deps.manifest().endpoints.snapshots;

        if (!url) {
            return;
        }

        if (this.deps.unsaved().length) {
            await this.deps.save();
        }

        await this.deps.api.postJson(url, { label });
        this.deps.flash('Snapshot taken');
    }

    private async restoreSnapshot(snapshot: SnapshotSummary): Promise<void> {
        const url = this.deps.manifest().endpoints.snapshots;

        if (!url) {
            return;
        }

        const unsaved = this.deps.unsaved();

        if (
            !window.confirm(
                `Restore “${snapshot.label}”? The map goes back to that state; the current saved state is kept as a snapshot too.` +
                    (unsaved.length
                        ? `\n\nUnsaved changes (${unsaved.join(', ')}) will be lost.`
                        : ''),
            )
        ) {
            return;
        }

        try {
            // Settings changes still on their way would land after the restore.
            window.clearTimeout(this.layerTimer);
            window.clearTimeout(this.envTimer);
            this.layerPatches.clear();
            this.envPatch = {};
            await this.deps.api.postJson(`${url}/${snapshot.id}/restore`, {});
            this.deps.flash('Snapshot restored, reloading…');
            this.deps.reload();
        } catch (error) {
            this.deps.flash(`Could not restore: ${message(error)}`);
        }
    }

    // -------------------------------------------------------------------- maps

    private async templates(): Promise<MapTemplateSummary[]> {
        const url = this.deps.manifest().endpoints.map_templates;

        return url ? this.deps.api.json(url) : [];
    }

    private async createMap(data: {
        name: string;
        template: string | null;
        brief: string | null;
    }): Promise<boolean> {
        const url = this.deps.manifest().endpoints.create_map;

        if (!url) {
            return false;
        }

        try {
            const map = await this.deps.api.postJson<{ url: string }>(
                url,
                data,
            );
            this.deps.flash('Map created, opening it…');
            // The studio page shows the generation; leave the editor frame when embedded.
            (window.top ?? window).location.href = map.url;

            return true;
        } catch (error) {
            this.deps.flash(`Could not create the map: ${message(error)}`);

            return false;
        }
    }
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
