<?php

namespace App\Mcp;

use App\Models\Map;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;

/**
 * Named performance profiles (profile_performance `save_as`) to compare later profiles with
 * (`compare_to`): before / after an optimisation, a placement or a settings change. Stored per map as
 * JSON under storage/app/private/performance/{map id}/{name}.json.
 */
class PerformanceBaselines
{
    /** Keys of the frame block that are compared (lower is better except fps). */
    private const FRAME_KEYS = ['fps', 'frame_interval_ms', 'cpu_ms', 'gpu_ms', 'frame_ms', 'draw_calls', 'triangles'];

    public static function normalizeName(string $name): string
    {
        $slug = Str::slug($name);

        if ($slug === '') {
            throw new ToolError('A baseline name needs letters or digits.');
        }

        return Str::limit($slug, 60, '');
    }

    /**
     * @param  array<string, mixed>  $profile
     */
    public function save(Map $map, string $name, array $profile): string
    {
        $name = self::normalizeName($name);
        Storage::disk('local')->put($this->path($map, $name), json_encode([
            'name' => $name,
            'saved_at' => now()->toIso8601String(),
            'profile' => $profile,
        ], JSON_UNESCAPED_SLASHES));

        return $name;
    }

    /**
     * @return array{name: string, saved_at: string, profile: array<string, mixed>}|null
     */
    public function find(Map $map, string $name): ?array
    {
        $path = $this->path($map, self::normalizeName($name));
        $data = Storage::disk('local')->exists($path) ? json_decode((string) Storage::disk('local')->get($path), true) : null;

        return is_array($data) && isset($data['profile']) ? $data : null;
    }

    /** @return list<string> */
    public function names(Map $map): array
    {
        return collect(Storage::disk('local')->files("performance/{$map->id}"))
            ->filter(fn (string $f) => str_ends_with($f, '.json'))
            ->map(fn (string $f) => basename($f, '.json'))
            ->sort()
            ->values()
            ->all();
    }

    public function delete(Map $map, string $name): bool
    {
        $path = $this->path($map, self::normalizeName($name));

        return Storage::disk('local')->exists($path) && Storage::disk('local')->delete($path);
    }

    /**
     * Before / after of two profiles: frame numbers, GPU time per pass, cost per system, with the
     * change and a verdict per line where it is larger than the measurement noise.
     *
     * @param  array<string, mixed>  $before
     * @param  array<string, mixed>  $after
     * @return array<string, mixed>
     */
    public static function compare(array $before, array $after, string $name, string $savedAt): array
    {
        $noise = max((float) ($before['noise_ms'] ?? 0), (float) ($after['noise_ms'] ?? 0), 0.2);
        $frame = [];

        foreach (self::FRAME_KEYS as $key) {
            $a = $before['frame'][$key] ?? null;
            $b = $after['frame'][$key] ?? null;
            if (is_numeric($a) || is_numeric($b)) {
                $frame[$key] = self::delta($a, $b, $key === 'fps', str_ends_with($key, '_ms') ? $noise : null);
            }
        }

        $passes = [];
        $beforePasses = collect($before['passes'] ?? [])->keyBy('name');
        $afterPasses = collect($after['passes'] ?? [])->keyBy('name');
        foreach ($beforePasses->keys()->merge($afterPasses->keys())->unique() as $pass) {
            $passes[] = ['name' => $pass, ...self::delta($beforePasses[$pass]['gpu_ms'] ?? null, $afterPasses[$pass]['gpu_ms'] ?? null, false, $noise)];
        }

        $costs = [];
        $beforeCosts = collect($before['costs'] ?? [])->keyBy('system');
        $afterCosts = collect($after['costs'] ?? [])->keyBy('system');
        foreach ($beforeCosts->keys()->merge($afterCosts->keys())->unique() as $system) {
            $costs[] = ['system' => $system, ...self::delta($beforeCosts[$system]['cost_ms'] ?? null, $afterCosts[$system]['cost_ms'] ?? null, false, $noise)];
        }

        $summary = [];
        $ms = isset($frame['gpu_ms']['change']) ? 'gpu_ms' : 'frame_ms';
        if (isset($frame[$ms]['change'])) {
            $summary[] = sprintf(
                '%s %s: %.1f → %.1f ms (%s%.1f ms, %s).',
                $ms === 'gpu_ms' ? 'GPU time' : 'Frame time',
                "vs \"{$name}\"",
                $frame[$ms]['before'],
                $frame[$ms]['after'],
                $frame[$ms]['change'] >= 0 ? '+' : '',
                $frame[$ms]['change'],
                $frame[$ms]['verdict'],
            );
        }
        if (isset($frame['fps']['change'])) {
            $summary[] = sprintf('fps %.0f → %.0f.', $frame['fps']['before'], $frame['fps']['after']);
        }
        foreach ([...$passes, ...$costs] as $row) {
            if (in_array($row['verdict'] ?? null, ['better', 'worse'], true) && abs((float) $row['change']) >= max(0.5, $noise * 2)) {
                $summary[] = sprintf('%s: %s%.1f ms (%s).', $row['name'] ?? $row['system'], $row['change'] >= 0 ? '+' : '', $row['change'], $row['verdict']);
            }
        }

        $settings = [];
        foreach (['backend', 'resolution'] as $key) {
            if (($before[$key] ?? null) !== ($after[$key] ?? null)) {
                $settings[] = $key;
            }
        }
        if ($settings !== []) {
            $summary[] = 'Not like for like: '.implode(' and ', $settings).' differ(s) from the baseline.';
        }

        return [
            'baseline' => $name,
            'baseline_saved_at' => $savedAt,
            'noise_ms' => $noise,
            'frame' => $frame,
            'passes' => $passes,
            'costs' => $costs,
            'summary' => $summary,
        ];
    }

    /**
     * @return array{before: float|int|null, after: float|int|null, change?: float, change_percent?: float|null, verdict?: string}
     */
    private static function delta(mixed $before, mixed $after, bool $higherIsBetter, ?float $noise): array
    {
        $row = ['before' => is_numeric($before) ? $before + 0 : null, 'after' => is_numeric($after) ? $after + 0 : null];
        if ($row['before'] === null || $row['after'] === null) {
            return $row;
        }

        $change = round($row['after'] - $row['before'], 2);
        $row['change'] = $change;
        $row['change_percent'] = $row['before'] != 0 ? round($change / $row['before'] * 100, 1) : null;
        $threshold = $noise ?? abs($row['before']) * 0.02;
        $row['verdict'] = abs($change) <= $threshold ? 'same' : (($change > 0) === $higherIsBetter ? 'better' : 'worse');

        return $row;
    }

    private function path(Map $map, string $name): string
    {
        return "performance/{$map->id}/{$name}.json";
    }
}
