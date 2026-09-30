<?php

namespace App\Mcp;

use App\Mcp\Assets\PropBudget;

/**
 * Turns an editor performance profile (profile_performance) into a short list of plain-language
 * findings: what the frame costs, which system costs most, and which assets are too heavy.
 */
class PerformanceFindings
{
    /** Triangles per frame above which the scene counts as heavy for most GPUs. */
    private const FRAME_TRIANGLES = 10000000;

    /** Draw calls per frame above which the CPU side usually suffers. */
    private const FRAME_DRAW_CALLS = 3000;

    /** Ground cover instances of one type grown around the camera that are worth a note. */
    private const COVER_INSTANCES = 400000;

    /**
     * @param  array<string, mixed>  $profile
     * @return list<string>
     */
    public static function analyse(array $profile): array
    {
        $findings = [];
        $frame = is_array($profile['frame'] ?? null) ? $profile['frame'] : [];
        $frameMs = (float) ($frame['frame_ms'] ?? 0);
        $cpu = (float) ($frame['cpu_ms'] ?? 0);
        $gpu = isset($frame['gpu_ms']) ? (float) $frame['gpu_ms'] : null;
        $noise = (float) ($profile['noise_ms'] ?? 0);

        if ($frame !== [] && (int) ($frame['frames'] ?? 1) === 0) {
            return [
                'No frame finished during the measurement: the editor renders too slowly here (for example a machine without a GPU, or a hidden / background tab), so nothing could be measured. The breakdown of what is in the scene (systems) still applies.',
                ...self::props($profile),
                ...self::foliage($profile),
            ];
        }

        if ($frame !== []) {
            $findings[] = sprintf(
                'The frame takes %s ms (%d fps; CPU %s ms, GPU %s)%s, %s draw calls, %s triangles.',
                self::ms($frameMs), (int) ($frame['fps'] ?? 0), self::ms($cpu),
                $gpu !== null ? self::ms($gpu).' ms' : 'not measurable here',
                $gpu !== null ? ($gpu > $cpu ? ': limited by the GPU' : ': limited by the CPU') : '',
                number_format((int) ($frame['draw_calls'] ?? 0)), self::count((int) ($frame['triangles'] ?? 0)),
            );
        }

        $findings = [...$findings, ...self::costs($profile, $frameMs, $noise)];
        $findings = [...$findings, ...self::props($profile)];
        $findings = [...$findings, ...self::foliage($profile)];

        if ((int) ($frame['triangles'] ?? 0) > self::FRAME_TRIANGLES) {
            $findings[] = 'Over '.self::count(self::FRAME_TRIANGLES).' triangles per frame (all passes): look for models without LODs drawn many times (props) and dense ground cover.';
        }
        if ((int) ($frame['draw_calls'] ?? 0) > self::FRAME_DRAW_CALLS) {
            $findings[] = number_format((int) $frame['draw_calls']).' draw calls per frame: many separate objects (props are drawn one mesh at a time, again for every shadow cascade and the water reflection).';
        }

        $passes = is_array($profile['passes'] ?? null) ? $profile['passes'] : [];
        $gpuPasses = array_filter($passes, fn ($p) => is_array($p) && isset($p['gpu_ms']));
        usort($gpuPasses, fn ($a, $b) => $b['gpu_ms'] <=> $a['gpu_ms']);
        if ($gpu !== null && $gpu > 0) {
            $top = array_slice(array_filter($gpuPasses, fn ($p) => $p['gpu_ms'] >= max(1.0, $gpu * 0.2)), 0, 3);
            if ($top !== []) {
                $findings[] = 'Most GPU time goes to: '.implode(', ', array_map(fn ($p) => $p['name'].' '.self::ms((float) $p['gpu_ms']).' ms', $top)).'.';
            }
        }

        $resolution = is_array($profile['resolution'] ?? null) ? $profile['resolution'] : [];
        if (($resolution['dynamic_resolution'] ?? false) && isset($resolution['render_scale'], $resolution['configured_render_scale'])
            && (float) $resolution['render_scale'] < (float) $resolution['configured_render_scale'] - 0.01) {
            $findings[] = sprintf(
                'Dynamic resolution has lowered the render scale to %s (of %s) to keep up: the scene is heavier than the frame time shows, and the picture is softer.',
                $resolution['render_scale'], $resolution['configured_render_scale'],
            );
        }

        $interval = (float) ($frame['frame_interval_ms'] ?? 0);
        if ($frameMs > 0 && $interval > $frameMs * 1.6 && $interval > 12) {
            $findings[] = sprintf('The frame rate is capped (display refresh or max fps): a frame takes %s ms of the %s ms between frames, so there is headroom.', self::ms($frameMs), self::ms($interval));
        }

        return $findings;
    }

    /**
     * The A/B costs, largest first.
     *
     * @param  array<string, mixed>  $profile
     * @return list<string>
     */
    private static function costs(array $profile, float $frameMs, float $noise): array
    {
        $labels = ['props' => 'Props', 'foliage' => 'Placed foliage', 'ground_cover' => 'Ground cover', 'water' => 'Water (with its reflection)', 'shadows' => 'Shadow maps'];
        $costs = array_values(array_filter(
            is_array($profile['costs'] ?? null) ? $profile['costs'] : [],
            fn ($c) => is_array($c) && isset($c['cost_ms']),
        ));
        usort($costs, fn ($a, $b) => $b['cost_ms'] <=> $a['cost_ms']);

        $threshold = max(0.3, $noise * 1.5);
        $parts = [];
        $small = [];
        foreach ($costs as $c) {
            $label = $labels[$c['system']] ?? (string) $c['system'];
            if ((float) $c['cost_ms'] >= $threshold) {
                $share = $frameMs > 0 ? round(100 * $c['cost_ms'] / $frameMs).'% of the frame, ' : '';
                $parts[] = sprintf(
                    '%s cost %s ms (%s%s draw calls, %s triangles)',
                    $label, self::ms((float) $c['cost_ms']), $share,
                    number_format((int) ($c['draw_calls'] ?? 0)), self::count((int) ($c['triangles'] ?? 0)),
                );
            } else {
                $small[] = mb_strtolower($label);
            }
        }

        $out = [];
        if ($parts !== []) {
            $out[] = 'Measured by switching each system off: '.implode('; ', $parts).'.';
        }
        if ($small !== []) {
            $out[] = 'Negligible here (within measurement noise of '.self::ms($threshold).' ms): '.implode(', ', $small).'.';
        }

        return $out;
    }

    /**
     * @param  array<string, mixed>  $profile
     * @return list<string>
     */
    private static function props(array $profile): array
    {
        $out = [];
        $props = $profile['systems']['props'] ?? null;
        if (! is_array($props)) {
            return $out;
        }

        foreach (is_array($props['models'] ?? null) ? $props['models'] : [] as $m) {
            $tris = $m['triangles_per_instance'] ?? null;
            $count = (int) ($m['instances'] ?? 0);
            if (! is_numeric($tris)) {
                continue;
            }
            // Instanced props with LODs report what one pass really draws.
            $lods = is_numeric($m['triangles_drawn'] ?? null);
            $total = $lods ? (int) $m['triangles_drawn'] : (int) $tris * $count;
            $vegetation = preg_match('/\b(tree|pine|fir|spruce|oak|birch|palm|conifer|bush|shrub|plant|grass|flower)s?\b/i', (string) ($m['name'] ?? '')) === 1;
            if (($lods ? $total > PropBudget::PLACED_TRIANGLES : ($tris > PropBudget::TRIANGLES || $total > PropBudget::PLACED_TRIANGLES))) {
                $out[] = sprintf(
                    $lods
                        ? 'Prop model "%s" has %s triangles; its %s copies draw %s triangles per pass even with LODs (the view, the near shadow cascade and the water reflection). %s'
                        : 'Prop model "%s" has %s triangles × %s placed = %s triangles per pass (no LODs: the view, each shadow cascade and the water reflection draw them all). %s',
                    $m['name'] ?? '?', self::count((int) $tris), number_format($count), self::count($total),
                    $vegetation
                        ? 'Vegetation belongs in foliage: import it as a foliage asset (import_model kind "foliage", create_type) and scatter it with edit_foliage or a ground cover biome; foliage gets LODs, impostors and GPU culling.'
                        : 'Import a lighter model (decimate in Blender) or place fewer copies.',
                );
            } elseif ($vegetation && $count > 50) {
                $out[] = sprintf('%s copies of prop "%s" look like vegetation: as a foliage type they would get LODs, impostors and GPU culling.', number_format($count), $m['name'] ?? '?');
            }
            if (is_numeric($m['materials_per_instance'] ?? null) && $m['materials_per_instance'] > PropBudget::MATERIALS) {
                $out[] = sprintf('Prop model "%s" uses %d materials per copy: merge them (texture atlas) in Blender.', $m['name'] ?? '?', $m['materials_per_instance']);
            }
            if (is_numeric($m['draw_calls_per_pass'] ?? null) && $m['draw_calls_per_pass'] > 1000) {
                $out[] = sprintf('Prop model "%s" alone needs %s draw calls per pass (%s meshes × %s copies).', $m['name'] ?? '?', number_format((int) $m['draw_calls_per_pass']), $m['meshes_per_instance'] ?? '?', number_format($count));
            }
        }

        return $out;
    }

    /**
     * @param  array<string, mixed>  $profile
     * @return list<string>
     */
    private static function foliage(array $profile): array
    {
        $out = [];
        $systems = is_array($profile['systems'] ?? null) ? $profile['systems'] : [];

        foreach (['foliage' => 'Foliage type', 'ground_cover' => 'Ground cover'] as $key => $label) {
            foreach (is_array($systems[$key]['types'] ?? null) ? $systems[$key]['types'] : [] as $t) {
                if (! is_array($t)) {
                    continue;
                }
                foreach (is_array($t['warnings'] ?? null) ? $t['warnings'] : [] as $warning) {
                    $out[] = "{$label} \"{$t['name']}\": {$warning}";
                }
                if ($key === 'ground_cover' && (int) ($t['instances'] ?? 0) > self::COVER_INSTANCES) {
                    $out[] = sprintf(
                        'Ground cover "%s" has %s instances grown around the camera (%s drawn): lower its density on the layer (update_terrain_layer ground_cover) or its cull distance (save_foliage_type).',
                        $t['name'], number_format((int) $t['instances']), number_format((int) ($t['drawn'] ?? 0)),
                    );
                }
                $lod0 = (int) ($t['lod_triangles'][0] ?? 0);
                $nearCount = (int) ($t['lod_instances'][0] ?? 0);
                if ($lod0 * $nearCount > 5000000) {
                    $out[] = sprintf(
                        '%s "%s" draws %s instances at full detail (%s triangles each): rebake the asset (bake_foliage_asset) or use a lighter model.',
                        $label, $t['name'], number_format($nearCount), self::count($lod0),
                    );
                }
            }
        }

        return $out;
    }

    private static function ms(float $ms): string
    {
        return number_format($ms, $ms < 10 ? 1 : 0);
    }

    private static function count(int $n): string
    {
        return match (true) {
            $n >= 1000000 => round($n / 1000000, 1).'M',
            $n >= 10000 => round($n / 1000).'k',
            default => number_format($n),
        };
    }
}
