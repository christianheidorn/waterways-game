<?php

namespace App\Services\Ai;

use App\Jobs\GenerateMaterial;
use App\Models\Map;
use App\Models\Material;
use App\Models\TerrainLayer;
use App\Services\Materials\MaterialLibrary;
use App\Services\Terrain\TerrainStorage;
use App\Support\AiSettings;
use App\Support\DefaultTerrainLayers;
use App\Support\EnvironmentDefaults;
use App\Support\SettingField;
use Illuminate\Support\Str;
use Throwable;

/**
 * Claude-assisted terrain art direction: material suggestions per layer and screenshot reviews.
 *
 * Everything the model returns is treated as untrusted: unknown keys are dropped, numbers are
 * clamped to the schema ranges and only existing material ids / layer slots are kept.
 */
class MapAiAssistant
{
    /** ESA WorldCover classes. */
    public const LANDCOVER_CLASSES = [
        10 => 'tree cover', 20 => 'shrubland', 30 => 'grassland', 40 => 'cropland', 50 => 'built-up',
        60 => 'bare / sparse vegetation', 70 => 'snow and ice', 80 => 'permanent water', 90 => 'herbaceous wetland',
        95 => 'mangroves', 100 => 'moss and lichen',
    ];

    private const COLOR = '/^#[0-9a-fA-F]{6}$/';

    public function __construct(
        private readonly OpenRouterClient $client,
        private readonly AiSettings $settings,
        private readonly TerrainStorage $terrain,
        private readonly MaterialLibrary $library,
    ) {}

    // ---------------------------------------------------------------------------------------
    // Material suggestions
    // ---------------------------------------------------------------------------------------

    /**
     * @return array{summary: string, layers: list<array<string, mixed>>}
     */
    public function suggestMaterials(Map $map): array
    {
        $system = <<<'TXT'
You are a senior environment artist setting up the terrain materials of a realistic open-world game map.
You get facts about the map (location, size, height range, water, land cover) plus its current terrain layers and the
material library. Choose up to 8 terrain layers (slots 0-7) that make this landscape look believable:
- slot 0 is the base layer that covers everything no rule claims; other layers paint automatically by height (metres,
  absolute, same datum as the map height range) and slope (degrees 0-90); where rules overlap, higher auto_priority (0-10) wins.
- Prefer materials from the library (material_id). Only when nothing suitable exists, set material_id to null and give a
  short generate_prompt (max 40 words) describing the ground surface for an AI texture generator.
- tint is a hex colour multiplied onto the material (#ffffff = unchanged); use subtle tints to harmonise with the biome.
- Keep slot names short (e.g. "Grass", "Forest floor", "Rock").
Answer with a single JSON object only, no prose:
{"summary": string, "layers": [{"slot": int, "name": string, "material_id": int|null, "generate_prompt": string|null,
"category": string, "tint": "#rrggbb", "auto_min_height": number|null, "auto_max_height": number|null,
"auto_min_slope": number|null, "auto_max_slope": number|null, "auto_priority": int, "reason": string}]}
TXT;

        $user = "Map facts:\n".json_encode($this->mapFacts($map), JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
            ."\n\nMaterial library:\n".json_encode($this->libraryList(), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
            ."\n\nMaterial categories: ".implode(', ', array_keys(Material::CATEGORIES));

        $raw = $this->client->chatJson($this->settings->textModel(), $system, $user, 4000);

        return $this->sanitizeSuggestion($raw, $map);
    }

    /**
     * @param  array<string, mixed>  $raw
     * @return array{summary: string, layers: list<array<string, mixed>>}
     */
    public function sanitizeSuggestion(array $raw, Map $map): array
    {
        $materialIds = Material::query()->where('status', '!=', 'failed')->pluck('id')->all();
        $minH = $map->min_height - 1000;
        $maxH = $map->max_height + 1000;
        $defaults = $this->defaultDefinitions($map);

        $layers = [];
        foreach (array_slice(is_array($raw['layers'] ?? null) ? array_values($raw['layers']) : [], 0, 16) as $entry) {
            if (! is_array($entry) || ! isset($entry['slot']) || ! is_numeric($entry['slot'])) {
                continue;
            }

            $slot = (int) $entry['slot'];
            if ($slot < 0 || $slot >= TerrainLayer::MAX_LAYERS || isset($layers[$slot])) {
                continue;
            }

            $name = $this->string($entry['name'] ?? null, 60) ?? ($defaults[$slot]['name'] ?? 'Layer '.($slot + 1));
            $materialId = isset($entry['material_id']) && is_numeric($entry['material_id']) && in_array((int) $entry['material_id'], $materialIds, true)
                ? (int) $entry['material_id']
                : null;
            $prompt = $materialId === null ? $this->string($entry['generate_prompt'] ?? null, 500) : null;

            [$minHeight, $maxHeight] = $this->orderedPair(
                $this->clampOrNull($entry['auto_min_height'] ?? null, $minH, $maxH),
                $this->clampOrNull($entry['auto_max_height'] ?? null, $minH, $maxH),
            );
            [$minSlope, $maxSlope] = $this->orderedPair(
                $this->clampOrNull($entry['auto_min_slope'] ?? null, 0, 90),
                $this->clampOrNull($entry['auto_max_slope'] ?? null, 0, 90),
            );

            $category = is_string($entry['category'] ?? null) && isset(Material::CATEGORIES[$entry['category']])
                ? $entry['category']
                : MaterialLibrary::guessCategory([$name, (string) $prompt]);

            $layers[$slot] = [
                'slot' => $slot,
                'name' => $name,
                'material_id' => $materialId,
                'generate_prompt' => $prompt,
                'category' => $category,
                'tint' => is_string($entry['tint'] ?? null) && preg_match(self::COLOR, $entry['tint']) === 1 ? strtolower($entry['tint']) : '#ffffff',
                'auto_min_height' => $minHeight,
                'auto_max_height' => $maxHeight,
                'auto_min_slope' => $minSlope,
                'auto_max_slope' => $maxSlope,
                'auto_priority' => (int) ($this->clampOrNull($entry['auto_priority'] ?? null, 0, 10) ?? 0),
                'reason' => $this->string($entry['reason'] ?? null, 300) ?? '',
            ];
        }

        ksort($layers);

        return [
            'summary' => $this->string($raw['summary'] ?? null, 1500) ?? '',
            'layers' => array_values($layers),
        ];
    }

    /**
     * Upsert the suggested layers. Entries with a generate_prompt and no material get a new AI
     * material (queued) linked right away; the game ignores it until it is ready.
     *
     * @param  list<array<string, mixed>>  $layers  already sanitized
     * @return array{layers: int, generating: int, skipped_generation: int}
     */
    public function applySuggestion(Map $map, array $layers): array
    {
        $defaults = $this->defaultDefinitions($map);
        $aiConfigured = $this->settings->configured();
        $result = ['layers' => 0, 'generating' => 0, 'skipped_generation' => 0];

        foreach ($layers as $entry) {
            $slot = $entry['slot'];
            /** @var TerrainLayer|null $layer */
            $layer = $map->layers()->where('slot', $slot)->first();
            $materialId = $entry['material_id'];
            $job = null;

            if ($materialId === null && $entry['generate_prompt'] !== null) {
                if ($aiConfigured) {
                    $material = $this->library->create([
                        'name' => MaterialPrompts::summary($entry['generate_prompt']),
                        'category' => $entry['category'],
                        'source' => 'ai',
                        'license' => 'AI generated',
                        'status' => 'processing',
                        'status_message' => 'Queued…',
                        'ai_prompt' => $entry['generate_prompt'],
                        'ai_model' => $this->settings->imageModel(),
                    ]);
                    $materialId = $material->id;
                    $job = new GenerateMaterial($material, ['prompt' => $entry['generate_prompt'], 'category' => $entry['category']]);
                    $result['generating']++;
                } else {
                    $result['skipped_generation']++;
                }
            }

            $attributes = [
                'name' => $entry['name'],
                'tint' => $entry['tint'],
                'auto_min_height' => $entry['auto_min_height'],
                'auto_max_height' => $entry['auto_max_height'],
                'auto_min_slope' => $entry['auto_min_slope'],
                'auto_max_slope' => $entry['auto_max_slope'],
                'auto_priority' => $entry['auto_priority'],
            ];

            // Keep the current material when the model suggested nothing new for this slot.
            if ($materialId !== null || $entry['generate_prompt'] === null) {
                $attributes['material_id'] = $materialId;
            }

            if (($attributes['material_id'] ?? null) !== null && $attributes['material_id'] !== $layer?->material_id) {
                $attributes['texture_scale'] = (float) (Material::query()->whereKey($attributes['material_id'])->value('tile_size') ?? 2);
            }

            if ($layer) {
                $layer->update($attributes);
            } else {
                $base = $defaults[$slot] ?? $defaults[0];
                $map->layers()->create([...$base, ...$attributes, 'slot' => $slot]);
            }
            $result['layers']++;

            if ($job !== null) {
                try {
                    dispatch($job);
                } catch (Throwable $e) {
                    report($e);
                }
            }
        }

        return $result;
    }

    // ---------------------------------------------------------------------------------------
    // Screenshot review
    // ---------------------------------------------------------------------------------------

    /**
     * @param  array<string, mixed>|null  $camera
     * @return array{summary: string, score: int, suggestions: list<array{title: string, detail: string, changes: array<string, mixed>}>}
     */
    public function review(Map $map, string $imageDataUrl, string $mode, ?array $camera): array
    {
        $system = <<<'TXT'
You are an experienced environment artist and art director reviewing a screenshot from a realistic open-world game.
Judge realism critically and concretely: terrain materials (fit to the landscape, scale, colour), texture tiling and
visible repetition, colour harmony between layers, lighting / exposure / haze, water appearance (colour, clarity,
reflections, foam), and foliage density and placement. Then propose a few high-impact changes that can be applied
with the parameters listed below (only those keys; stay within the given ranges; layer changes reference existing slots
and, for material_id, only ids from the library).
Answer with a single JSON object only, no prose:
{"summary": string, "score": int 1-10, "suggestions": [{"title": string, "detail": string,
"changes": {"environment"?: {key: value}, "layers"?: [{"slot": int, "tint"?: "#rrggbb", "roughness_scale"?: number 0-3,
"normal_strength"?: number 0-3, "texture_scale"?: number 0.1-200 (metres per repeat), "material_id"?: int}]}}]}
TXT;

        $facts = [
            'map' => $this->mapFacts($map),
            'view' => ['mode' => $mode, 'camera' => $camera],
            'environment_parameters' => $this->environmentSchema($map),
            'layers' => $map->layers->map(fn (TerrainLayer $l) => [
                'slot' => $l->slot,
                'name' => $l->name,
                'material' => $l->material ? ['id' => $l->material->id, 'name' => $l->material->name, 'tile_size_m' => $l->material->tile_size] : null,
                'tint' => $l->tint,
                'roughness_scale' => $l->roughness_scale,
                'normal_strength' => $l->normal_strength,
                'texture_scale' => $l->texture_scale,
            ])->values()->all(),
            'material_library' => $this->libraryList(),
        ];

        $raw = $this->client->chatJson($this->settings->textModel(), $system, [
            ['type' => 'text', 'text' => "Scene facts:\n".json_encode($facts, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)],
            ['type' => 'image_url', 'image_url' => ['url' => $imageDataUrl]],
        ], 3000);

        return $this->sanitizeReview($raw, $map);
    }

    /**
     * @param  array<string, mixed>  $raw
     * @return array{summary: string, score: int, suggestions: list<array{title: string, detail: string, changes: array<string, mixed>}>}
     */
    public function sanitizeReview(array $raw, Map $map): array
    {
        $suggestions = [];

        foreach (is_array($raw['suggestions'] ?? null) ? array_values($raw['suggestions']) : [] as $entry) {
            if (! is_array($entry) || count($suggestions) >= 8) {
                continue;
            }

            $title = $this->string($entry['title'] ?? null, 120);
            if ($title === null) {
                continue;
            }

            $suggestions[] = [
                'title' => $title,
                'detail' => $this->string($entry['detail'] ?? null, 1500) ?? '',
                'changes' => $this->sanitizeChanges(is_array($entry['changes'] ?? null) ? $entry['changes'] : [], $map),
            ];
        }

        return [
            'summary' => $this->string($raw['summary'] ?? null, 2000) ?? '',
            'score' => (int) round($this->clampOrNull($raw['score'] ?? null, 1, 10) ?? 5),
            'suggestions' => $suggestions,
        ];
    }

    /**
     * Keep only valid environment keys (clamped / checked against EnvironmentDefaults) and layer
     * changes for existing slots.
     *
     * @param  array<string, mixed>  $changes
     * @return array{environment?: array<string, mixed>, layers?: list<array<string, mixed>>}
     */
    public function sanitizeChanges(array $changes, Map $map): array
    {
        $out = [];

        if (is_array($changes['environment'] ?? null)) {
            $environment = [];
            foreach (EnvironmentDefaults::group()->fields as $field) {
                if (array_key_exists($field->key, $changes['environment'])) {
                    $value = $this->fieldValue($field, $changes['environment'][$field->key]);
                    if ($value !== null) {
                        $environment[$field->key] = $value;
                    }
                }
            }
            if ($environment !== []) {
                $out['environment'] = $environment;
            }
        }

        if (is_array($changes['layers'] ?? null)) {
            $slots = $map->layers()->pluck('slot')->all();
            $layers = [];

            foreach ($changes['layers'] as $entry) {
                if (! is_array($entry) || ! isset($entry['slot']) || ! is_numeric($entry['slot']) || ! in_array((int) $entry['slot'], $slots, true)) {
                    continue;
                }

                $slot = (int) $entry['slot'];
                $layer = [];

                if (is_string($entry['tint'] ?? null) && preg_match(self::COLOR, $entry['tint']) === 1) {
                    $layer['tint'] = strtolower($entry['tint']);
                }
                foreach (['roughness_scale' => [0, 3], 'normal_strength' => [0, 3], 'texture_scale' => [0.1, 200]] as $key => [$min, $max]) {
                    $value = $this->clampOrNull($entry[$key] ?? null, $min, $max);
                    if ($value !== null) {
                        $layer[$key] = round($value, 3);
                    }
                }
                if (array_key_exists('material_id', $entry) && $entry['material_id'] === null) {
                    // Explicit null: back to procedural colours.
                    $layer['material_id'] = null;
                } elseif (isset($entry['material_id']) && is_numeric($entry['material_id'])
                    && Material::query()->whereKey((int) $entry['material_id'])->where('status', '!=', 'failed')->exists()) {
                    $layer['material_id'] = (int) $entry['material_id'];
                }

                if ($layer !== []) {
                    $layers[$slot] = ['slot' => $slot, ...($layers[$slot] ?? []), ...$layer];
                }
            }

            if ($layers !== []) {
                $out['layers'] = array_values($layers);
            }
        }

        return $out;
    }

    /**
     * Apply (sanitized) changes and return the game-shaped environment and layers.
     *
     * @param  array<string, mixed>  $changes
     * @return array{environment: array<string, mixed>, layers: list<array<string, mixed>>, applied: array<string, mixed>}
     */
    public function applyChanges(Map $map, array $changes): array
    {
        $clean = $this->sanitizeChanges($changes, $map);

        if (isset($clean['environment'])) {
            $map->update(['environment' => EnvironmentDefaults::merge([...$map->resolvedEnvironment(), ...$clean['environment']])]);
        }

        foreach ($clean['layers'] ?? [] as $entry) {
            /** @var TerrainLayer|null $layer */
            $layer = $map->layers()->where('slot', $entry['slot'])->first();
            if ($layer === null) {
                continue;
            }

            $attributes = collect($entry)->except('slot')->all();
            if (isset($attributes['material_id']) && $attributes['material_id'] !== $layer->material_id && ! isset($attributes['texture_scale'])) {
                $attributes['texture_scale'] = (float) Material::query()->whereKey($attributes['material_id'])->value('tile_size');
            }
            $layer->update($attributes);
        }

        $map->refresh();

        return [
            'environment' => $map->resolvedEnvironment(),
            'layers' => $map->layers()->get()->map->toGameArray()->values()->all(),
            'applied' => $clean,
        ];
    }

    // ---------------------------------------------------------------------------------------
    // Facts
    // ---------------------------------------------------------------------------------------

    /**
     * @return array<string, mixed>
     */
    public function mapFacts(Map $map): array
    {
        $environment = $map->resolvedEnvironment();

        return array_filter([
            'name' => $map->name,
            'description' => $map->description,
            'source' => $map->source->value,
            'location' => $map->center_lat !== null && $map->center_lng !== null ? [
                'lat' => round($map->center_lat, 4),
                'lng' => round($map->center_lng, 4),
                'place_hint' => 'Real-world terrain; infer the region and climate from the coordinates.',
            ] : null,
            'size_m' => $map->size,
            'height_range_m' => ['min' => round($map->min_height, 1), 'max' => round($map->max_height, 1)],
            'sea_level_m' => $environment['sea_level'] ?? 0,
            'ocean' => $environment['ocean_enabled'] ?? false,
            'water_percent' => $this->waterPercent($map),
            'land_cover_percent' => $this->landCoverPercent($map),
            'current_layers' => $map->layers->map(fn (TerrainLayer $l) => [
                'slot' => $l->slot,
                'name' => $l->name,
                'material_id' => $l->material_id,
                'material' => $l->material?->name,
                'tint' => $l->tint,
                'auto_min_height' => $l->auto_min_height,
                'auto_max_height' => $l->auto_max_height,
                'auto_min_slope' => $l->auto_min_slope,
                'auto_max_slope' => $l->auto_max_slope,
                'auto_priority' => $l->auto_priority,
            ])->values()->all(),
        ], fn ($v) => $v !== null);
    }

    /**
     * @return list<array{id: int, name: string, category: string, tags: list<string>, tile_size_m: float, ready: bool}>
     */
    public function libraryList(): array
    {
        return Material::query()->where('status', '!=', 'failed')->orderBy('category')->orderBy('name')->limit(200)->get()
            ->map(fn (Material $m) => [
                'id' => $m->id,
                'name' => $m->name,
                'category' => $m->category,
                'tags' => array_slice($m->tags ?? [], 0, 8),
                'tile_size_m' => $m->tile_size,
                'ready' => $m->isReady(),
            ])->values()->all();
    }

    public function waterPercent(Map $map): ?float
    {
        try {
            $data = $this->terrain->read($map, 'water');
        } catch (Throwable) {
            return null;
        }

        if ($data === null || strlen($data) < 4) {
            return null;
        }

        $samples = intdiv(strlen($data), 4);
        $stride = max(1, intdiv($samples, 65536));
        $wet = 0;
        $count = 0;

        for ($i = 0; $i < $samples; $i += $stride) {
            $value = unpack('g', $data, $i * 4)[1];
            $count++;
            if ($value > TerrainStorage::NO_WATER + 1) {
                $wet++;
            }
        }

        return $count > 0 ? round($wet / $count * 100, 1) : null;
    }

    /**
     * @return array<string, float>|null class label → percent
     */
    public function landCoverPercent(Map $map): ?array
    {
        $path = $map->storageDirectory().'/landcover.u8';

        if (! $this->terrain->disk()->exists($path)) {
            return null;
        }

        $data = (string) $this->terrain->disk()->get($path);
        $total = strlen($data);
        if ($total === 0) {
            return null;
        }

        $out = [];
        foreach (count_chars($data, 1) as $byte => $count) {
            if (isset(self::LANDCOVER_CLASSES[$byte])) {
                $out[self::LANDCOVER_CLASSES[$byte]] = round($count / $total * 100, 1);
            }
        }
        arsort($out);

        return $out;
    }

    // ---------------------------------------------------------------------------------------

    /**
     * @return list<array<string, mixed>>
     */
    private function environmentSchema(Map $map): array
    {
        $values = $map->resolvedEnvironment();

        return array_map(fn (SettingField $f) => array_filter([
            'key' => $f->key,
            'label' => $f->label,
            'type' => $f->type,
            'current' => $values[$f->key] ?? $f->default,
            'min' => $f->min,
            'max' => $f->max,
            'unit' => $f->unit,
            'options' => $f->options ? array_keys($f->options) : null,
        ], fn ($v) => $v !== null), array_values(array_filter(EnvironmentDefaults::group()->fields, fn (SettingField $f) => $f->type !== 'text')));
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    private function defaultDefinitions(Map $map): array
    {
        $definitions = DefaultTerrainLayers::definitions($map->min_height, $map->max_height, (float) ($map->resolvedEnvironment()['sea_level'] ?? 0));

        return collect($definitions)->keyBy('slot')->all();
    }

    private function fieldValue(SettingField $field, mixed $value): mixed
    {
        return match ($field->type) {
            'number' => is_numeric($value) ? max((float) $field->min, min((float) $field->max, (float) $value)) : null,
            'boolean' => is_bool($value) ? $value : (in_array($value, [0, 1, '0', '1', 'true', 'false'], true) ? filter_var($value, FILTER_VALIDATE_BOOL) : null),
            'color' => is_string($value) && preg_match(self::COLOR, $value) === 1 ? strtolower($value) : null,
            'select' => is_scalar($value) && array_key_exists((string) $value, $field->options) ? (string) $value : null,
            default => null,
        };
    }

    private function clampOrNull(mixed $value, float $min, float $max): ?float
    {
        if (! is_numeric($value) || ! is_finite((float) $value)) {
            return null;
        }

        return max($min, min($max, (float) $value));
    }

    /**
     * @return array{0: float|null, 1: float|null}
     */
    private function orderedPair(?float $a, ?float $b): array
    {
        return $a !== null && $b !== null && $a > $b ? [$b, $a] : [$a, $b];
    }

    private function string(mixed $value, int $max): ?string
    {
        if (! is_string($value) && ! is_numeric($value)) {
            return null;
        }

        $value = trim(strip_tags((string) $value));

        return $value === '' ? null : Str::limit($value, $max, '…');
    }
}
