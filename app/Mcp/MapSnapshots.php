<?php

namespace App\Mcp;

use App\Models\Map;
use App\Models\MapSnapshot;
use App\Models\TerrainLayer;
use App\Services\Terrain\TerrainStorage;
use App\Support\GameSettingsRepository;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Restore points of a map for agent work: the stored terrain assets (heights, paint, water, foliage)
 * are copied aside, the layers and map settings are kept as data. Agents take an automatic one before
 * changing a map (at most every few minutes), and can take, list and restore them explicitly.
 *
 * The editor also takes automatic ones of the user's own work after saves (afterEditorSave).
 *
 * Only what is saved is captured: unsaved editor changes live in the browser until saved.
 */
class MapSnapshots
{
    /** A new automatic snapshot is only taken when the last one is older than this. */
    public const AUTO_INTERVAL_MINUTES = 10;

    /** Automatic snapshots kept per map by default (the oldest are deleted; editor setting auto_snapshot_keep). */
    public const AUTO_KEEP = 15;

    /** Label prefix of the automatic snapshots taken while the user edits. */
    public const EDITING_LABEL = 'Editing session';

    /** Map attributes a snapshot restores. */
    private const MAP_ATTRIBUTES = ['name', 'description', 'environment', 'spawn_x', 'spawn_z', 'spawn_yaw', 'min_height', 'max_height'];

    /** Assets copied (land cover is source data and never edited). */
    private const ASSETS = ['heightmap', 'splatmap', 'water', 'foliage', 'props'];

    public function __construct(
        private readonly TerrainStorage $storage,
        private readonly GameSettingsRepository $settings,
    ) {}

    public function create(Map $map, string $label, bool $auto = false): MapSnapshot
    {
        $snapshot = MapSnapshot::query()->create([
            'map_id' => $map->id,
            'label' => mb_substr($label, 0, 200),
            'auto' => $auto,
            'data' => [
                'map' => $map->only(self::MAP_ATTRIBUTES),
                'layers' => $map->layers()->get()->map(fn (TerrainLayer $layer) => array_diff_key(
                    $layer->getAttributes(),
                    array_flip(['id', 'map_id', 'created_at', 'updated_at']),
                ))->values()->all(),
                'assets' => array_values(array_filter(self::ASSETS, fn (string $a) => $this->storage->exists($map, $a))),
            ],
        ]);

        $disk = $this->storage->disk();

        foreach ($snapshot->data['assets'] as $asset) {
            $disk->copy($this->storage->path($map, $asset), $snapshot->storageDirectory().'/'.$asset);
        }

        if ($auto) {
            $this->pruneAuto($map);
        }

        return $snapshot;
    }

    /** An automatic snapshot before an agent changes the map, unless a recent one exists. */
    public function autoBefore(Map $map, string $reason): ?MapSnapshot
    {
        $recent = MapSnapshot::query()
            ->where('map_id', $map->id)
            ->where('created_at', '>=', Carbon::now()->subMinutes(self::AUTO_INTERVAL_MINUTES))
            ->exists();

        return $recent ? null : $this->create($map, "Before: {$reason}", auto: true);
    }

    /**
     * An automatic snapshot of the user's own work after an editor save: always on the first save of
     * an editing session, then when the last automatic snapshot is older than the editor setting
     * auto_snapshot_minutes (0 turns them off).
     */
    public function afterEditorSave(Map $map, bool $firstSave): ?MapSnapshot
    {
        $minutes = (int) $this->settings->get('editor')['auto_snapshot_minutes'];

        if ($minutes <= 0) {
            return null;
        }

        $recent = MapSnapshot::query()
            ->where('map_id', $map->id)
            ->where('auto', true)
            ->where('created_at', '>=', Carbon::now()->subMinutes($minutes))
            ->exists();

        if ($recent && ! $firstSave) {
            return null;
        }

        return $this->create($map, self::EDITING_LABEL.($firstSave ? ' (first save)' : ''), auto: true);
    }

    /**
     * Snapshot settings, as get_settings / update_game_settings group "editor" hold them.
     *
     * @return array{auto_snapshot_minutes: int, auto_snapshot_keep: int, agent_interval_minutes: int}
     */
    public function settings(): array
    {
        $editor = $this->settings->get('editor');

        return [
            'auto_snapshot_minutes' => (int) $editor['auto_snapshot_minutes'],
            'auto_snapshot_keep' => (int) $editor['auto_snapshot_keep'],
            'agent_interval_minutes' => self::AUTO_INTERVAL_MINUTES,
        ];
    }

    /** Puts the map back as it was: assets, layers and settings (bumps the revision so clients reload). */
    public function restore(MapSnapshot $snapshot): void
    {
        $map = $snapshot->map;
        $disk = $this->storage->disk();
        $data = $snapshot->data;

        DB::transaction(function () use ($map, $data) {
            $map->layers()->delete();

            foreach ($data['layers'] as $layer) {
                $map->layers()->create($this->decodeJsonColumns($layer));
            }

            $map->update([...$data['map'], 'revision' => $map->revision + 1]);
        });

        foreach (self::ASSETS as $asset) {
            $copy = $snapshot->storageDirectory().'/'.$asset;

            if (in_array($asset, $data['assets'], true) && $disk->exists($copy)) {
                $disk->put($this->storage->path($map, $asset), $disk->get($copy));
            } elseif (! in_array($asset, $data['assets'], true)) {
                $this->storage->delete($map, $asset);
            }
        }
    }

    /**
     * @return array{id: int, label: string, auto: bool, editing: bool, created_at: string}
     */
    public static function summary(MapSnapshot $s): array
    {
        return [
            'id' => $s->id,
            'label' => $s->label,
            'auto' => $s->auto,
            // Taken automatically while the user edited (not before an agent change).
            'editing' => $s->auto && str_starts_with($s->label, self::EDITING_LABEL),
            'created_at' => $s->created_at->toIso8601String(),
        ];
    }

    public function delete(MapSnapshot $snapshot): void
    {
        $this->storage->disk()->deleteDirectory($snapshot->storageDirectory());
        $snapshot->delete();
    }

    private function pruneAuto(Map $map): void
    {
        MapSnapshot::query()
            ->where('map_id', $map->id)
            ->where('auto', true)
            ->latest('id')
            ->skip(max(1, (int) ($this->settings->get('editor')['auto_snapshot_keep'] ?? self::AUTO_KEEP)))
            ->take(PHP_INT_MAX)
            ->get()
            ->each(fn (MapSnapshot $s) => $this->delete($s));
    }

    /**
     * Raw attributes hold JSON columns as strings; creating through the model would encode them twice.
     *
     * @param  array<string, mixed>  $layer
     * @return array<string, mixed>
     */
    private function decodeJsonColumns(array $layer): array
    {
        if (isset($layer['ground_cover']) && is_string($layer['ground_cover'])) {
            $layer['ground_cover'] = json_decode($layer['ground_cover'], true);
        }

        return $layer;
    }
}
