<?php

namespace App\Support;

use App\Models\AgentRequest;
use App\Models\Biome;
use App\Models\FoliageType;
use App\Models\Map;
use App\Models\TerrainLayer;
use App\Services\Terrain\HeightGrid;

/**
 * Curated starting points for new maps, as data: procedural terrain parameters (plus a relief
 * multiplier, an optional coast sloping into the sea and terracing), starter biomes per layer slot,
 * layer overrides, environment values and the foliage kinds scattered on first load.
 *
 * A template is applied in steps: its terrain values are defaults for the create form, the shaping
 * runs during generation, the environment is set on creation and the layers once the terrain exists
 * (their auto-paint rules depend on the height range).
 */
final class MapTemplates
{
    /**
     * @var array<string, array{
     *     name: string,
     *     summary: string,
     *     terrain: array<string, mixed>,
     *     shape: array{relief?: float, coast?: string, terrace?: float},
     *     environment: array<string, mixed>,
     *     biomes: array<int, string>,
     *     layers: array<int, array<string, mixed>>,
     *     foliage: list<string>,
     * }>
     */
    public const TEMPLATES = [
        'coastal_village' => [
            'name' => 'Coastal village',
            'summary' => 'Gentle green hills running down to a sandy coast and the open sea in the south, in warm late-afternoon light. Room for a village above the beach.',
            'terrain' => ['size' => 2048, 'resolution' => 513, 'smoothing' => 0.6, 'lake_depth' => 4, 'river_depth' => 1.5],
            'shape' => ['relief' => 0.55, 'coast' => 'south'],
            'environment' => [
                'ocean_enabled' => true, 'sea_level' => 0, 'time_of_day' => 17.5, 'weather' => 'clear', 'cloud_coverage' => 0.3,
                'wind_strength' => 0.7, 'color_grade' => 'golden_hour', 'wave_height' => 0.4, 'water_shallow_color' => '#3fb3a8',
            ],
            'biomes' => [0 => 'meadow', 2 => 'temperate_forest', 3 => 'rocky_slope', 4 => 'beach'],
            'layers' => [4 => ['auto_min_height' => -100, 'auto_max_height' => 3, 'auto_min_slope' => 0, 'auto_max_slope' => 18, 'auto_priority' => 4]],
            'foliage' => ['grass', 'flower', 'bush', 'broadleaf', 'palm'],
        ],
        'alpine_lake' => [
            'name' => 'Alpine lake',
            'summary' => 'High, rugged mountains with snow caps around a deep, clear lake; conifer forests and alpine pastures on the lower slopes; cool morning light.',
            'terrain' => ['size' => 4096, 'resolution' => 1025, 'smoothing' => 0.4, 'lake_depth' => 18, 'river_depth' => 2.5, 'shore_angle' => 22],
            'shape' => ['relief' => 2.4],
            'environment' => [
                'time_of_day' => 9.5, 'weather' => 'cloudy', 'cloud_coverage' => 0.45, 'turbidity' => 2, 'height_fog_height' => 120,
                'height_fog_density' => 0.01, 'color_grade' => 'lush', 'water_clarity' => 14, 'water_shallow_color' => '#4fb6c2', 'water_deep_color' => '#0b2f45',
            ],
            'biomes' => [0 => 'alpine', 2 => 'conifer_forest', 3 => 'rocky_slope', 5 => 'wetland'],
            'layers' => [],
            'foliage' => ['grass', 'flower', 'conifer', 'rock', 'reed'],
        ],
        'river_valley' => [
            'name' => 'River valley',
            'summary' => 'A broad green valley with a meandering river, reed beds along the banks, meadows and mixed woodland on the hillsides.',
            'terrain' => ['size' => 2048, 'resolution' => 513, 'smoothing' => 0.7, 'river_depth' => 3.5, 'bank_angle' => 25, 'lake_depth' => 5],
            'shape' => ['relief' => 0.9],
            'environment' => [
                'time_of_day' => 14, 'weather' => 'clear', 'cloud_coverage' => 0.35, 'wind_strength' => 0.5, 'color_grade' => 'filmic',
                'flow_speed' => 1.4, 'height_fog_height' => 40, 'height_fog_density' => 0.006,
            ],
            'biomes' => [0 => 'meadow', 2 => 'temperate_forest', 3 => 'rocky_slope', 5 => 'wetland'],
            'layers' => [],
            'foliage' => ['grass', 'flower', 'bush', 'broadleaf', 'reed'],
        ],
        'desert_canyon' => [
            'name' => 'Desert canyon',
            'summary' => 'Dry, terraced sandstone plateaus cut by deep canyons, sparse rocks and shrubs, a harsh midday sun and a desert colour grade.',
            'terrain' => ['size' => 2048, 'resolution' => 513, 'smoothing' => 0.3, 'river_depth' => 6, 'bank_angle' => 60, 'lake_depth' => 3],
            'shape' => ['relief' => 1.5, 'terrace' => 14],
            'environment' => [
                'time_of_day' => 12.5, 'weather' => 'clear', 'cloud_coverage' => 0.05, 'turbidity' => 4, 'wind_strength' => 0.9,
                'color_grade' => 'desert', 'wetness' => 0, 'fog_density' => 0.0001,
            ],
            'biomes' => [3 => 'rocky_slope'],
            'layers' => [
                0 => ['name' => 'Desert sand', 'color' => '#c9a26b', 'color_secondary' => '#b98a52', 'material_id' => null, 'ground_cover' => []],
                1 => ['name' => 'Dry ground', 'color' => '#a67c4f', 'color_secondary' => '#8f6a42', 'material_id' => null, 'ground_cover' => []],
                3 => ['auto_min_slope' => 24, 'auto_max_slope' => 90, 'auto_priority' => 5],
            ],
            'foliage' => ['rock', 'bush'],
        ],
    ];

    /**
     * For lists (studio, editor, MCP list_map_templates).
     *
     * @return list<array<string, mixed>>
     */
    public static function all(): array
    {
        return array_values(array_map(fn (string $key) => self::describe($key), array_keys(self::TEMPLATES)));
    }

    /** @return array<string, mixed> */
    public static function describe(string $key): array
    {
        $t = self::TEMPLATES[$key];

        return [
            'key' => $key,
            'name' => $t['name'],
            'summary' => $t['summary'],
            'terrain' => [...$t['terrain'], ...$t['shape']],
            'environment' => $t['environment'],
            'biomes' => array_map(fn (string $b) => StarterBiomes::BIOMES[$b]['name'], $t['biomes']),
            'foliage_kinds' => $t['foliage'],
        ];
    }

    public static function exists(?string $key): bool
    {
        return $key !== null && isset(self::TEMPLATES[$key]);
    }

    /**
     * Create-form input with the template's terrain values as defaults (the input wins).
     *
     * @param  array<string, mixed>  $input
     * @return array<string, mixed>
     */
    public static function withDefaults(array $input): array
    {
        $key = $input['template'] ?? null;

        if (! self::exists($key)) {
            return $input;
        }

        return [
            ...self::TEMPLATES[$key]['terrain'],
            'source' => 'procedural',
            ...array_filter($input, fn ($v) => $v !== null),
        ];
    }

    /**
     * Environment of a new map from this template.
     *
     * @param  array<string, mixed>  $environment
     * @return array<string, mixed>
     */
    public static function environment(?string $key, array $environment): array
    {
        return self::exists($key) ? EnvironmentDefaults::merge([...$environment, ...self::TEMPLATES[$key]['environment']]) : $environment;
    }

    /**
     * Template landforms on freshly generated procedural terrain, before rivers and lakes are carved.
     */
    public static function shape(?string $key, HeightGrid $grid): void
    {
        if (! self::exists($key)) {
            return;
        }

        $shape = self::TEMPLATES[$key]['shape'];
        $relief = (float) ($shape['relief'] ?? 1.0);
        $terrace = (float) ($shape['terrace'] ?? 0.0);
        $coast = $shape['coast'] ?? null;
        $n = $grid->resolution;
        $min = $grid->min();

        for ($row = 0; $row < $n; $row++) {
            $v = $row / ($n - 1);
            // Coast: the last third of the map slopes smoothly down to 25 m below sea level.
            $t = $coast === 'south' ? self::smoothstep(0.55, 0.92, $v) : 0.0;

            for ($col = 0; $col < $n; $col++) {
                $i = $row * $n + $col;
                $h = $min + ($grid->data[$i] - $min) * $relief;

                if ($terrace > 0) {
                    // Soft steps: flat benches with steep risers, like layered sandstone.
                    $k = $h / $terrace;
                    $f = $k - floor($k);
                    $h = (floor($k) + self::smoothstep(0.6, 1.0, $f)) * $terrace * 0.75 + $h * 0.25;
                }

                if ($t > 0) {
                    $h = $h * (1 - $t) + (-25.0) * $t;
                }

                $grid->data[$i] = $h;
            }
        }
    }

    /**
     * The template's layers once the default layers exist: starter biomes on slots (installing a
     * missing starter biome first), then the layer overrides.
     */
    public static function applyLayers(Map $map): void
    {
        if (! self::exists($map->template)) {
            return;
        }

        $template = self::TEMPLATES[$map->template];

        if ($template['biomes'] !== [] && Biome::query()->whereIn('starter_key', array_values($template['biomes']))->count() < count(array_unique($template['biomes']))) {
            StarterBiomes::install();
        }

        foreach ($template['biomes'] as $slot => $key) {
            $layer = $map->layers()->where('slot', $slot)->first();
            $biome = Biome::query()->where('starter_key', $key)->first();

            if ($layer instanceof TerrainLayer && $biome instanceof Biome) {
                // Biomes keep the layer's auto-paint rules.
                $biome->applyTo($layer);
            }
        }

        foreach ($template['layers'] as $slot => $values) {
            $map->layers()->where('slot', $slot)->first()?->update($values);
        }
    }

    /**
     * Foliage types scattered over a template map on its first load (null: every type, as usual).
     *
     * @return list<int>|null
     */
    public static function initialFoliage(Map $map): ?array
    {
        if (! self::exists($map->template)) {
            return null;
        }

        return FoliageType::query()->whereIn('kind', self::TEMPLATES[$map->template]['foliage'])->orderBy('id')->pluck('id')->all();
    }

    /**
     * "From a description": the user's description becomes an open build request over the whole
     * map, so an agent picks it up (list_requests) and builds it with the world-building tools.
     */
    public static function storeBrief(Map $map, string $brief): AgentRequest
    {
        $half = $map->size / 2;

        return AgentRequest::query()->create([
            'map_id' => $map->id,
            'status' => 'open',
            'note' => "Build this map from the description:\n\n".trim($brief),
            'area' => [
                ['x' => -$half, 'z' => -$half], ['x' => $half, 'z' => -$half],
                ['x' => $half, 'z' => $half], ['x' => -$half, 'z' => $half],
            ],
        ]);
    }

    private static function smoothstep(float $a, float $b, float $x): float
    {
        $t = max(0.0, min(1.0, ($x - $a) / ($b - $a)));

        return $t * $t * (3 - 2 * $t);
    }
}
