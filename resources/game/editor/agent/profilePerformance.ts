import * as THREE from 'three/webgpu';
import type { ProfileSection } from '../../core/GpuProfiler';
import type { Foliage } from '../../world/Foliage';
import type { Props } from '../../world/Props';
import type { FoliageTypeStat } from '../../shared/protocol';
import type { FoliageType, TerrainLayer } from '../../shared/types';

/** Systems the profile can switch off one at a time to measure what they cost. */
export type ProfileSystem =
    | 'props'
    | 'foliage'
    | 'ground_cover'
    | 'water'
    | 'shadows';

export const PROFILE_SYSTEMS: readonly ProfileSystem[] = [
    'props',
    'foliage',
    'ground_cover',
    'water',
    'shadows',
];

/** One rendered frame as the game measured it. */
export type FrameSample = {
    /** JavaScript + command submission time of the frame (ms). */
    cpuMs: number;
    /** Wall-clock time since the previous frame (ms). */
    intervalMs: number;
    /** GPU time of the most recently measured frame (ms), null without timestamp queries. */
    gpuMs: number | null;
    drawCalls: number;
    triangles: number;
};

/** What the profile needs from the game (built by Game). */
export type PerformanceHost = {
    backend: string;
    gpuTimers: boolean;
    scene: THREE.Object3D;
    camera: THREE.Camera;
    terrain: THREE.Object3D;
    water: THREE.Object3D;
    hasWater: () => boolean;
    foliage: Foliage;
    props: Props;
    layers: () => TerrainLayer[];
    foliageTypes: () => FoliageType[];
    shadows: () => Record<string, unknown>;
    resolution: () => Record<string, unknown>;
    /** Calls the listener after every rendered frame (null stops). */
    onFrame: (listener: ((frame: FrameSample) => void) | null) => void;
    /** Hides a system (true) or shows it again exactly as before (false). */
    setHidden: (system: ProfileSystem, hidden: boolean) => void;
    /** Per-pass GPU / CPU sections while measuring. */
    setDetailed: (detailed: boolean) => void;
    sections: () => ProfileSection[];
    /** Keeps dynamic resolution at its current scale (it would otherwise hide cost changes). */
    holdResolution: (hold: boolean) => void;
};

export type ProfileOptions = {
    /** Frames measured per state (baseline, each system off). */
    sampleFrames?: number;
    /** Frames skipped after each switch (GPU timings arrive a few frames late). */
    warmupFrames?: number;
    systems?: ProfileSystem[];
    /** Longest the whole measurement may take (ms). */
    budgetMs?: number;
};

type Summary = {
    frames: number;
    fps: number;
    frame_interval_ms: number;
    cpu_ms: number;
    gpu_ms: number | null;
    /** max(cpu, gpu): what limits the frame rate when nothing else caps it. */
    frame_ms: number;
    draw_calls: number;
    triangles: number;
};

const DEFAULT_FRAMES = 40;
const DEFAULT_WARMUP = 8;
const DEFAULT_BUDGET_MS = 18000;

/**
 * Measures the frame from the current view (see the MCP tool profile_performance): frame statistics,
 * GPU time per pass, a breakdown of what each system draws, and an A/B cost per system (switched off
 * for a few frames each, then restored exactly).
 */
export async function profilePerformance(
    host: PerformanceHost,
    options: ProfileOptions = {},
): Promise<Record<string, unknown>> {
    const frames = clampInt(options.sampleFrames, 10, 240, DEFAULT_FRAMES);
    const warmup = clampInt(options.warmupFrames, 2, 60, DEFAULT_WARMUP);
    const systems = (options.systems ?? [...PROFILE_SYSTEMS]).filter((s) =>
        PROFILE_SYSTEMS.includes(s),
    );
    const budget = clampInt(options.budgetMs, 2000, 60000, DEFAULT_BUDGET_MS);
    // Baseline, per-pass sample, each system, baseline again.
    const states = systems.length + 3;
    const stateMs = Math.max(600, budget / states);
    const started = performance.now();
    const hidden = new Set<ProfileSystem>();
    // Taken before anything is switched off.
    const breakdown = describeSystems(host);

    host.holdResolution(true);

    try {
        const baseline = await measure(host, frames, warmup, stateMs);
        host.setDetailed(true);
        await measure(host, Math.min(frames, 30), warmup, stateMs);
        const passes = host
            .sections()
            .map((s) => ({
                name: s.name,
                gpu_ms: round2(s.gpuMs),
                cpu_ms: round2(s.cpuMs),
            }))
            .filter((s) => s.gpu_ms !== null || s.cpu_ms !== null);
        host.setDetailed(false);

        const costs: Record<string, unknown>[] = [];

        for (const system of systems) {
            if (!applies(host, system, breakdown)) {
                costs.push({ system, skipped: 'nothing to measure here' });
                continue;
            }

            hidden.add(system);
            host.setHidden(system, true);
            let off: Summary;

            try {
                off = await measure(host, frames, warmup, stateMs);
            } finally {
                host.setHidden(system, false);
                hidden.delete(system);
            }

            costs.push({ system, ...cost(baseline, off) });
        }

        const after = await measure(host, frames, warmup, stateMs);

        return {
            backend: host.backend,
            gpu_timers: host.gpuTimers,
            resolution: host.resolution(),
            frame: baseline,
            frame_after: after,
            // How much the baseline moved during the run: deltas smaller than this are noise.
            noise_ms: round2(Math.abs(after.frame_ms - baseline.frame_ms)),
            passes,
            costs,
            systems: breakdown,
            duration_ms: Math.round(performance.now() - started),
            sample_frames: frames,
        };
    } finally {
        for (const system of hidden) {
            host.setHidden(system, false);
        }

        host.setDetailed(false);
        host.holdResolution(false);
        host.onFrame(null);
    }
}

/** Collects `frames` frames after `warmup` skipped ones, or what arrived within `maxMs`. */
function measure(
    host: PerformanceHost,
    frames: number,
    warmup: number,
    maxMs: number,
): Promise<Summary> {
    return new Promise((resolve) => {
        const samples: FrameSample[] = [];
        const start = performance.now();
        let skipped = 0;
        let done = false;
        const finish = () => {
            if (done) {
                return;
            }

            done = true;
            window.clearTimeout(timer);
            host.onFrame(null);
            resolve(summarize(samples));
        };
        // Frames stop when the tab is hidden: answer with what arrived.
        const timer = window.setTimeout(finish, maxMs + 1500);

        host.onFrame((frame) => {
            if (skipped < warmup) {
                skipped++;

                return;
            }

            samples.push(frame);
            const elapsed = performance.now() - start;

            if (
                samples.length >= frames ||
                (elapsed > maxMs && samples.length >= 5)
            ) {
                finish();
            }
        });
    });
}

function summarize(samples: FrameSample[]): Summary {
    const cpu = median(samples.map((s) => s.cpuMs));
    const gpuValues = samples
        .map((s) => s.gpuMs)
        .filter((v): v is number => v !== null && v > 0);
    const gpu = gpuValues.length ? median(gpuValues) : null;
    const interval = median(samples.map((s) => s.intervalMs));

    return {
        frames: samples.length,
        fps: interval > 0 ? Math.round(1000 / interval) : 0,
        frame_interval_ms: round2(interval)!,
        cpu_ms: round2(cpu)!,
        gpu_ms: round2(gpu),
        frame_ms: round2(Math.max(cpu, gpu ?? 0))!,
        draw_calls: Math.round(median(samples.map((s) => s.drawCalls))),
        triangles: Math.round(median(samples.map((s) => s.triangles))),
    };
}

/** What switching a system off saved (positive = the system costs this much). */
function cost(on: Summary, off: Summary): Record<string, unknown> {
    // Too slow to render a frame within the time slot (e.g. no GPU): no measurement, not "free".
    if (on.frames === 0 || off.frames === 0) {
        return { unmeasured: 'no frames rendered in time', frames: off.frames };
    }

    return {
        cost_ms: round2(on.frame_ms - off.frame_ms),
        gpu_ms:
            on.gpu_ms !== null && off.gpu_ms !== null
                ? round2(on.gpu_ms - off.gpu_ms)
                : null,
        cpu_ms: round2(on.cpu_ms - off.cpu_ms),
        draw_calls: on.draw_calls - off.draw_calls,
        triangles: on.triangles - off.triangles,
        fps_without: off.fps,
        frames: off.frames,
    };
}

/** Systems with nothing in them are not measured. */
function applies(
    host: PerformanceHost,
    system: ProfileSystem,
    breakdown: Record<string, unknown>,
): boolean {
    switch (system) {
        case 'props':
            return host.props.list().length > 0;
        case 'foliage':
            return (breakdown.foliage as { instances: number }).instances > 0;
        case 'ground_cover':
            return (
                (breakdown.ground_cover as { instances: number }).instances > 0
            );
        case 'water':
            return host.hasWater();
        case 'shadows':
            return (host.shadows().enabled as boolean) === true;
    }
}

// ---------------------------------------------------------------------------------------- breakdown

function describeSystems(host: PerformanceHost): Record<string, unknown> {
    const foliage = host.foliage.stats();
    const placed = foliage.types.filter((t) => !isCover(t));
    const cover = foliage.types.filter(isCover);
    const casters = shadowCasters(host);

    return {
        terrain: meshSummary(host.terrain),
        water: { has_water: host.hasWater(), ...meshSummary(host.water) },
        foliage: {
            instances: sum(placed, (t) => t.instances),
            drawn: sum(placed, (t) => t.drawn),
            draw_calls: sum(placed, (t) => t.drawCalls),
            triangles: sum(placed, (t) => t.triangles),
            types: placed.map(foliageType),
            // GPU path: hidden by Hi-Z occlusion, and drawn by the second phase of two-phase occlusion
            // (hidden in last frame's depth, visible in this frame's).
            occluded: foliage.occludedInstances,
            drawn_late: foliage.lateInstances,
            two_phase_occlusion: host.foliage.twoPhaseOcclusion,
        },
        ground_cover: {
            instances: sum(cover, (t) => t.instances),
            drawn: sum(cover, (t) => t.drawn),
            draw_calls: sum(cover, (t) => t.drawCalls),
            triangles: sum(cover, (t) => t.triangles),
            types: cover.map(foliageType),
            layers: coverLayers(host, cover),
        },
        props: describeProps(host),
        shadows: {
            ...host.shadows(),
            casters,
            foliage_shadow_casters: foliage.shadowCasters,
        },
    };
}

function isCover(t: FoliageTypeStat): boolean {
    return t.name.endsWith(' · ground cover');
}

function foliageType(t: FoliageTypeStat): Record<string, unknown> {
    return {
        name: t.name.replace(/ · ground cover$/, ''),
        kind: t.kind,
        source: t.source,
        instances: t.instances,
        drawn: t.drawn,
        draw_calls: t.drawCalls,
        triangles_drawn: t.triangles,
        lod_triangles: t.lodTriangles,
        lod_instances: t.lodInstances,
        cull_distance_m: t.cullDistance,
        shadow_casters: t.shadowCasters,
        ...(t.warnings.length ? { warnings: t.warnings } : {}),
    };
}

/** Ground cover per terrain layer: which types it grows and how many of each are grown now. */
function coverLayers(
    host: PerformanceHost,
    cover: FoliageTypeStat[],
): Record<string, unknown>[] {
    const types = new Map(host.foliageTypes().map((t) => [t.id, t]));
    const byName = new Map(
        cover.map((t) => [t.name.replace(/ · ground cover$/, ''), t]),
    );

    return host
        .layers()
        .filter((l) => (l.ground_cover ?? []).length > 0)
        .map((layer) => ({
            slot: layer.slot,
            name: layer.name,
            ground_cover: (layer.ground_cover ?? []).map((entry) => {
                const type = types.get(entry.foliage_type_id);
                const stat = type ? byName.get(type.name) : undefined;

                return {
                    type: type?.name ?? `#${entry.foliage_type_id}`,
                    kind: type?.kind ?? null,
                    density: entry.density,
                    type_density_per_100m2: type?.density ?? null,
                    // Shared by every layer growing the type.
                    instances_grown: stat?.instances ?? 0,
                    drawn: stat?.drawn ?? 0,
                    lod0_triangles: stat?.lodTriangles[0] ?? null,
                    cull_distance_m: stat?.cullDistance ?? type?.cull_distance,
                };
            }),
        }));
}

/**
 * Props per model: placed count, and from the loaded objects triangles / meshes / materials per
 * instance. Reads Props only through its public API and its group, so it works whether props are
 * cloned objects or instanced meshes.
 */
function describeProps(host: PerformanceHost): Record<string, unknown> {
    const props = host.props;
    const list = props.list();
    const library = new Map(props.library.map((m) => [m.id, m]));
    const counts = new Map<number, number>();
    const modelOf = new Map<string, number>();

    for (const p of list) {
        counts.set(p.model, (counts.get(p.model) ?? 0) + 1);
        modelOf.set(p.id, p.model);
    }

    // First loaded object of each model (clones carry userData.propId).
    const samples = new Map<number, THREE.Object3D>();
    const visible = new Map<number, number>();
    const frustum = cameraFrustum(host.camera);
    const sphere = new THREE.Sphere();

    for (const child of props.group.children) {
        const id = child.userData.propId as string | undefined;
        const model = id !== undefined ? modelOf.get(id) : undefined;

        if (model === undefined) {
            continue;
        }

        if (!samples.has(model)) {
            samples.set(model, child);
        }

        const radius = Math.max(
            1,
            ((child.userData.radius as number | undefined) ?? 2) * 2,
        );
        sphere.center.copy(child.position);
        sphere.radius = radius;

        if (frustum.intersectsSphere(sphere)) {
            visible.set(model, (visible.get(model) ?? 0) + 1);
        }
    }

    // Instanced props (Props.stats): triangles per LOD and how many copies each LOD drew last frame.
    const stats = new Map(props.stats().map((st) => [st.model, st]));
    const models = [...counts.entries()]
        .map(([id, count]) => {
            const ref = library.get(id);
            const st = stats.get(id);
            const sample = samples.get(id);
            const measured = sample ? objectStats(sample) : null;
            const triangles =
                st?.triangles[0] ??
                measured?.triangles ??
                ref?.triangles ??
                null;
            const drawn = st?.visible.reduce((a, b) => a + b, 0) ?? null;
            const drawnTriangles = st
                ? st.visible.reduce(
                      (sum, n, lod) => sum + n * (st.triangles[lod] ?? 0),
                      0,
                  )
                : null;

            return {
                model_id: id,
                name: ref?.name ?? `model ${id}`,
                instances: count,
                in_view:
                    drawn ?? (samples.size ? (visible.get(id) ?? 0) : null),
                triangles_per_instance: triangles,
                lod_triangles: st?.triangles ?? null,
                drawn_per_lod: st?.visible ?? null,
                meshes_per_instance:
                    st?.parts ?? measured?.meshes ?? ref?.meshes ?? null,
                materials_per_instance:
                    measured?.materials ?? ref?.materials ?? null,
                casts_shadow: measured?.castShadow ?? null,
                triangles_total: triangles !== null ? triangles * count : null,
                // With LODs and distance culling: what one pass actually draws.
                triangles_drawn: drawnTriangles,
                // Instanced: one draw per material per LOD in use, whatever the number of copies.
                draw_calls_per_pass: st
                    ? st.parts * st.visible.filter((n) => n > 0).length
                    : measured?.instanced
                      ? null
                      : measured
                        ? measured.meshes * count
                        : null,
            };
        })
        .sort(
            (a, b) =>
                (b.triangles_drawn ?? b.triangles_total ?? b.instances) -
                (a.triangles_drawn ?? a.triangles_total ?? a.instances),
        );
    const group = objectStats(props.group);

    return {
        instances: list.length,
        models,
        group: {
            objects: props.group.children.length,
            meshes: group.meshes,
            instanced_meshes: group.instancedMeshes,
            triangles: group.triangles,
            shadow_casting_meshes: group.shadowMeshes,
        },
    };
}

type ObjectStats = {
    meshes: number;
    instancedMeshes: number;
    materials: number;
    triangles: number;
    shadowMeshes: number;
    castShadow: boolean;
    instanced: boolean;
};

/** Meshes, distinct materials and triangles (× instances for instanced meshes) under an object. */
function objectStats(root: THREE.Object3D): ObjectStats {
    const materials = new Set<THREE.Material>();
    const stats: ObjectStats = {
        meshes: 0,
        instancedMeshes: 0,
        materials: 0,
        triangles: 0,
        shadowMeshes: 0,
        castShadow: false,
        instanced: false,
    };

    root.traverse((o) => {
        const mesh = o as THREE.Mesh;

        if (!mesh.isMesh) {
            return;
        }

        const instances = (o as THREE.InstancedMesh).isInstancedMesh
            ? (o as THREE.InstancedMesh).count
            : 1;
        stats.meshes++;
        stats.instancedMeshes += instances !== 1 ? 1 : 0;
        stats.instanced ||= (o as THREE.InstancedMesh).isInstancedMesh === true;
        stats.triangles += triangleCount(mesh.geometry) * instances;
        stats.shadowMeshes += mesh.castShadow ? 1 : 0;
        stats.castShadow ||= mesh.castShadow;

        for (const m of Array.isArray(mesh.material)
            ? mesh.material
            : [mesh.material]) {
            materials.add(m);
        }
    });
    stats.materials = materials.size;

    return stats;
}

/** Meshes of a system, how many are shown, and their triangles. */
function meshSummary(root: THREE.Object3D): Record<string, unknown> {
    let meshes = 0;
    let shown = 0;
    let triangles = 0;

    root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
            meshes++;
        }
    });
    root.traverseVisible((o) => {
        const mesh = o as THREE.Mesh;

        if (mesh.isMesh) {
            shown++;
            triangles += triangleCount(mesh.geometry);
        }
    });

    return { meshes, shown_meshes: shown, triangles_shown: triangles };
}

/** Shadow casting meshes that are shown, by top-level scene object. */
function shadowCasters(host: PerformanceHost): Record<string, number> {
    const out: Record<string, number> = {};

    for (const child of host.scene.children) {
        let n = 0;

        child.traverseVisible((o) => {
            if ((o as THREE.Mesh).isMesh && o.castShadow) {
                n++;
            }
        });

        if (n > 0) {
            const name = child.name || child.type;
            out[name] = (out[name] ?? 0) + n;
        }
    }

    return out;
}

function triangleCount(geometry: THREE.BufferGeometry): number {
    const count = geometry.index
        ? geometry.index.count
        : (geometry.getAttribute('position')?.count ?? 0);
    const range = geometry.drawRange.count;

    return Math.floor(
        (Number.isFinite(range) ? Math.min(range, count) : count) / 3,
    );
}

function cameraFrustum(camera: THREE.Camera): THREE.Frustum {
    camera.updateMatrixWorld();

    return new THREE.Frustum().setFromProjectionMatrix(
        new THREE.Matrix4().multiplyMatrices(
            camera.projectionMatrix,
            camera.matrixWorldInverse,
        ),
        camera.coordinateSystem,
    );
}

function sum<T>(items: T[], f: (item: T) => number): number {
    return items.reduce((total, item) => total + f(item), 0);
}

function median(values: number[]): number {
    if (!values.length) {
        return 0;
    }

    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;

    return sorted.length % 2
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round2(v: number | null | undefined): number | null {
    return v === null || v === undefined ? null : Math.round(v * 100) / 100;
}

function clampInt(
    value: number | undefined,
    min: number,
    max: number,
    fallback: number,
): number {
    const n = Number(value);

    return Number.isFinite(n) && n > 0
        ? Math.round(Math.min(max, Math.max(min, n)))
        : fallback;
}
