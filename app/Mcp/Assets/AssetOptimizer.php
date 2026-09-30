<?php

namespace App\Mcp\Assets;

use App\Models\FoliageAsset;
use App\Models\PropModel;
use Illuminate\Support\Facades\Process;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;

/**
 * Compressed copies of library GLBs (foliage assets and prop models) for the game: meshes with
 * EXT_meshopt_compression (lossless) and textures as KTX2 / Basis Universal (KHR_texture_basisu),
 * encoded by `resources/node/optimize-glb.mjs` (glTF Transform, meshoptimizer, the Basis encoder).
 *
 * The copy is stored next to the original as `<name>.opt.glb` and is used by the game only while it
 * is at least as new as the original (a re-bake or re-import makes it stale until it is optimised
 * again); the game falls back to the original if the copy fails to load.
 */
class AssetOptimizer
{
    /** Seconds one asset may take (texture encoding is the slow part: ~1 min per 1K texture set). */
    public const TIMEOUT = 900;

    /** Path of the compressed copy of a GLB on the public disk. */
    public static function optimizedPath(string $path): string
    {
        $path = Str::before($path, '?');

        return preg_replace('/\.glb$/i', '', $path).'.opt.glb';
    }

    /**
     * Public URL of the up-to-date compressed copy of `$path`, or null (none, or older than the
     * original).
     */
    public static function optimizedUrl(?string $path, string $version): ?string
    {
        if ($path === null || $path === '' || str_ends_with($path, '.opt.glb')) {
            return null;
        }

        $disk = Storage::disk('public');
        $optimized = self::optimizedPath($path);

        if (! $disk->exists($optimized) || ! $disk->exists($path)) {
            return null;
        }

        if ($disk->lastModified($optimized) < $disk->lastModified($path)) {
            return null;
        }

        return '/storage/'.$optimized.'?v='.$version;
    }

    /**
     * Compresses one GLB of the public disk into its `.opt.glb` copy.
     *
     * @return array<string, mixed> sizes before / after (file, textures in the file, estimated GPU
     *                              texture memory) or `error`
     */
    public function optimize(string $path, bool $textures = true, bool $meshes = true): array
    {
        $disk = Storage::disk('public');

        if (! $disk->exists($path)) {
            return ['ok' => false, 'error' => "Model file {$path} is missing."];
        }

        $out = self::optimizedPath($path);
        $command = [
            (string) config('services.node.binary', 'node'),
            base_path('resources/node/optimize-glb.mjs'),
            $disk->path($path),
            $disk->path($out),
        ];

        if (! $textures) {
            $command[] = '--no-textures';
        }

        if (! $meshes) {
            $command[] = '--no-meshes';
        }

        $result = Process::path(base_path())->timeout(self::TIMEOUT)->run($command);
        $line = collect(explode("\n", $result->output()))
            ->last(fn (string $l) => str_starts_with($l, '@@RESULT '));
        $data = $line ? json_decode(substr($line, 9), true) : null;

        if (! is_array($data)) {
            return [
                'ok' => false,
                'error' => trim($result->errorOutput()) !== '' ? Str::limit(trim($result->errorOutput()), 400) : 'The optimiser gave no result (is Node.js installed?).',
            ];
        }

        if (! ($data['ok'] ?? false)) {
            $disk->delete($out);
        }

        return ['path' => $out, ...$data];
    }

    /**
     * Optimises (or with `$dryRun` only lists) foliage assets and prop models.
     *
     * @param  'all'|'foliage'|'props'  $kind
     * @param  list<int>|null  $ids  only these ids (of the chosen kind)
     * @return list<array<string, mixed>>
     */
    public function run(string $kind = 'all', ?array $ids = null, bool $textures = true, bool $meshes = true, bool $force = false, bool $dryRun = false, ?callable $progress = null): array
    {
        $rows = [];

        foreach ($this->targets($kind, $ids) as [$type, $model]) {
            $path = (string) $model->model_path;
            $current = self::optimizedUrl($path, '0') !== null;
            $row = [
                'kind' => $type,
                'id' => $model->id,
                'name' => $model->name,
                'model_path' => $path,
                'bytes' => Storage::disk('public')->exists($path) ? Storage::disk('public')->size($path) : null,
            ];

            if ($type === 'foliage' && $model instanceof FoliageAsset) {
                $row['impostor'] = self::impostorKind($model);
            }

            if ($current && ! $force) {
                $optimized = self::optimizedPath($path);
                $rows[] = [...$row, 'status' => 'up_to_date', 'optimized_bytes' => Storage::disk('public')->size($optimized)];

                continue;
            }

            if ($dryRun) {
                $rows[] = [...$row, 'status' => $current ? 'up_to_date' : 'pending'];

                continue;
            }

            $progress && $progress("{$type} #{$model->id} {$model->name}…");
            $result = $this->optimize($path, $textures, $meshes);
            $rows[] = [...$row, 'status' => ($result['ok'] ?? false) ? 'optimized' : 'failed', 'result' => $result];
        }

        return $rows;
    }

    /**
     * Totals of a run: bytes before / after (optimised and up-to-date rows), texture memory.
     *
     * @param  list<array<string, mixed>>  $rows
     * @return array<string, int|float>
     */
    public static function summary(array $rows): array
    {
        $sum = fn (string $key) => array_sum(array_map(fn ($r) => (int) ($r['result'][$key] ?? 0), $rows));
        $before = $sum('bytes_before');
        $after = $sum('bytes_after');
        $memBefore = $sum('texture_memory_before');
        $memAfter = $sum('texture_memory_after');

        return [
            'optimized' => count(array_filter($rows, fn ($r) => $r['status'] === 'optimized')),
            'up_to_date' => count(array_filter($rows, fn ($r) => $r['status'] === 'up_to_date')),
            'failed' => count(array_filter($rows, fn ($r) => $r['status'] === 'failed')),
            'pending' => count(array_filter($rows, fn ($r) => $r['status'] === 'pending')),
            'bytes_before' => $before,
            'bytes_after' => $after,
            'file_saving_percent' => $before > 0 ? round((1 - $after / $before) * 100, 1) : 0,
            'texture_memory_before' => $memBefore,
            'texture_memory_after' => $memAfter,
            'texture_memory_saving_percent' => $memBefore > 0 ? round((1 - $memAfter / $memBefore) * 100, 1) : 0,
        ];
    }

    /**
     * Impostor of a baked foliage asset: `octahedral` (current bakes), `billboard` (older bakes: one
     * camera-facing card, re-bake with bake_foliage_asset to upgrade) or null (not baked).
     */
    public static function impostorKind(FoliageAsset $asset): ?string
    {
        if (! $asset->isReady()) {
            return null;
        }

        return ($asset->meta['impostor'] ?? null) === 'octahedral' ? 'octahedral' : 'billboard';
    }

    /**
     * @return list<array{0: string, 1: FoliageAsset|PropModel}>
     */
    private function targets(string $kind, ?array $ids): array
    {
        $targets = [];

        if ($kind === 'all' || $kind === 'foliage') {
            $query = FoliageAsset::query()->where('status', 'ready')->whereNotNull('model_path')->orderBy('id');
            if ($ids !== null && $kind === 'foliage') {
                $query->whereIn('id', $ids);
            }
            foreach ($query->get() as $asset) {
                $targets[] = ['foliage', $asset];
            }
        }

        if ($kind === 'all' || $kind === 'props') {
            $query = PropModel::query()->where('status', 'ready')->whereNotNull('model_path')->orderBy('id');
            if ($ids !== null && $kind === 'props') {
                $query->whereIn('id', $ids);
            }
            foreach ($query->get() as $model) {
                $targets[] = ['props', $model];
            }
        }

        return $targets;
    }
}
