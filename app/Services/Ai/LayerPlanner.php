<?php

namespace App\Services\Ai;

use App\Enums\MapSource;
use App\Enums\TerrainStatus;
use App\Jobs\ApplyLandCover;
use App\Jobs\GenerateMaterial;
use App\Jobs\ImportMaterial;
use App\Models\Map;
use App\Models\Material;
use App\Models\TerrainLayer;
use App\Services\LandCover\LandCoverMapping;
use App\Services\LandCover\LandCoverService;
use App\Services\LandCover\WorldCoverClasses;
use App\Services\Materials\MaterialLibrary;
use App\Services\Terrain\TerrainStorage;
use App\Support\AiSettings;
use App\Support\DefaultTerrainLayers;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Throwable;

/**
 * AI terrain layer planning: a full plan for all 8 layer slots (keep / change / remove / add),
 * each with a material (library → free CC0 import → AI generation) and realistic settings, plus
 * applying the (user-reviewed) subset of that plan.
 *
 * Everything the model or the browser sends is untrusted: unknown keys are dropped, numbers are
 * clamped to the layer form ranges, slots are unique and only existing materials / offered
 * import candidates are kept.
 */
class LayerPlanner
{
    public const ACTIONS = ['keep', 'change', 'remove', 'add'];

    public const MATERIAL_TYPES = ['library', 'import', 'generate', 'procedural'];

    public const REPAINT = ['none', 'auto_rules', 'landcover'];

    public const IMPORT_RESOLUTIONS = ['1k', '2k'];

    /** Ranges of the layer form (TerrainLayerController::validated). */
    public const RANGES = [
        'texture_scale' => [0.1, 200],
        'roughness_scale' => [0, 3],
        'normal_strength' => [0, 3],
        'auto_min_slope' => [0, 90],
        'auto_max_slope' => [0, 90],
        'auto_priority' => [0, 10],
    ];

    public const SETTING_KEYS = [
        'texture_scale', 'tint', 'roughness_scale', 'normal_strength',
        'auto_min_height', 'auto_max_height', 'auto_min_slope', 'auto_max_slope', 'auto_priority',
    ];

    /** Realistic tile size (metres per repeat) per category when nothing better is known. */
    public const CATEGORY_TILE_SIZE = [
        'grass' => 2.0, 'forest' => 2.5, 'soil' => 2.0, 'rock' => 5.0, 'gravel' => 1.5, 'sand' => 3.0,
        'mud' => 2.0, 'snow' => 3.0, 'field' => 3.0, 'urban' => 2.0, 'other' => 2.5,
    ];

    /** Coverage above which removing a slot needs a conscious decision in the UI. */
    public const PAINTED_THRESHOLD = 5.0;

    public const GENERATION_NOTE = 'charged to your OpenRouter credits';

    private const COLOR = '/^#[0-9a-fA-F]{6}$/';

    private const REF = '/^[A-Za-z0-9_.-]{1,120}$/';

    public function __construct(
        private readonly OpenRouterClient $client,
        private readonly AiSettings $settings,
        private readonly MapAiAssistant $assistant,
        private readonly MaterialCandidates $candidates,
        private readonly TerrainAnalysis $analysis,
        private readonly LandCoverService $landCover,
        private readonly MaterialLibrary $library,
        private readonly TerrainStorage $terrain,
    ) {}

    // ---------------------------------------------------------------------------------------
    // Planning
    // ---------------------------------------------------------------------------------------

    /**
     * @return array<string, mixed>
     */
    public function plan(Map $map, ?string $direction = null): array
    {
        if (! $this->settings->configured()) {
            throw new AiNotConfiguredException;
        }

        $coverage = $this->analysis->coverage($map);
        $facts = $this->facts($map, $coverage);
        $direction = $this->string($direction, 500);

        $user = "MAP FACTS\n".json_encode($facts, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
            ."\n\nMATERIAL CANDIDATES\n".$this->candidates->promptText()
            ."\n\nMaterial categories: ".implode(', ', array_keys(Material::CATEGORIES))
            .($direction !== null ? "\n\nDIRECTION FROM THE USER (follow it where sensible):\n".$direction : '');

        $raw = $this->client->chatJson($this->settings->textModel(), self::systemPrompt(), $user, 6000);

        $plan = $this->sanitizePlan($raw, $map, $coverage);
        $plan['unavailable_sources'] = $this->candidates->catalogue()['unavailable'];

        return $plan;
    }

    public static function systemPrompt(): string
    {
        return <<<'TXT'
You are a senior environment / terrain artist setting up the terrain layers of a realistic open-world game map for its
first start. The map has 8 layer slots (0-7); each used slot is one splat channel with a PBR material. Every layer costs
GPU work, so choose the MINIMAL set of layers that covers this landscape convincingly (typically 4-6) and remove layers
that are unused, redundant or implausible for this place (e.g. snow on a map that never reaches the snow line, sand far
from any water). Decide for EVERY currently used slot: "keep" (only when nothing at all changes), "change", or "remove";
use "add" for new layers in free slots.

How the terrain is painted: slot 0 is the base layer covering everything no rule claims. Other layers auto-paint by
height (absolute metres, same datum as the map's height range) and slope (degrees 0-90). Where rules overlap, the higher
auto_priority (0-10) wins. Use coherent rules derived from the facts (height and slope percentiles, water, land cover):
rock high priority (6-8) on steep slopes (typically > 30-40 deg, use the slope distribution), scree/gravel at the foot of
cliffs or on moderately steep high ground, snow above the snow line only if the terrain reaches it (priority 7-9, max
slope ~40), beach sand only just above sea / water level on gentle slopes, forest floor / meadow / mud where the land cover
or climate suggests it. Leave rule fields null when a layer should not auto-paint (e.g. a hand-painting layer).

Materials, in this order of preference:
1. an existing library material {"type":"library","material_id":ID}
2. a free CC0 material to import {"type":"import","source":"polyhaven"|"ambientcg","ref":REF,"resolution":"2k"} - only
   refs from the candidate list
3. AI generation {"type":"generate","prompt":"<=40 words describing the ground surface","category":CATEGORY} - costs
   money, only when nothing in the library or the import list fits; explain why in "reason"
4. {"type":"procedural"} - plain procedural colours, rarely useful.

Settings - make them right for a realistic first impression:
- texture_scale = real-world metres per texture repeat. Realistic sizes: grass / ground 1.5-3, forest floor 2-3, gravel
  1-2, sand 2-4, mud 1.5-3, snow 2-4, rock / cliff 3-8. For import candidates with a measured size use it, unless it is
  marked AERIAL / very large - then pick a ground-level size from these ranges. Library materials list their measured
  size; keep it unless it is unrealistic for terrain.
- tint "#rrggbb" is multiplied onto the albedo (#ffffff = unchanged): use subtle tints (e.g. #f2f5ea) to harmonise the
  palette with the biome and season; never strong colours.
- roughness_scale 0-3 (1 = as authored; wet mud/snow may go lower, dry rock/sand a bit higher), normal_strength 0-3
  (1 = as authored; 1.2-1.5 for rock, 0.6-0.9 for sand/snow).
- auto_min_height / auto_max_height in metres, auto_min_slope / auto_max_slope in degrees, auto_priority integer 0-10.

For real-world maps with land cover percentages, also return "landcover_mapping": an object mapping ESA WorldCover class
codes ("10","20","30","40","50","60","70","80","90","95","100") to the slot that should paint them, consistent with the
new slots (never a removed slot). Otherwise return null.

Answer with a single JSON object only, no prose:
{"summary": "2-4 sentences on the look and why", "notes": ["short extra hints for the user"],
 "layers": [{"slot": 0, "action": "keep"|"change"|"remove"|"add", "name": "short name", "reason": "one sentence",
   "material": {...} (omit for keep/remove),
   "settings": {"texture_scale": number, "tint": "#rrggbb", "roughness_scale": number, "normal_strength": number,
     "auto_min_height": number|null, "auto_max_height": number|null, "auto_min_slope": number|null,
     "auto_max_slope": number|null, "auto_priority": int} (omit for keep/remove)}],
 "landcover_mapping": {"10": 2, ...} | null}
TXT;
    }

    /**
     * Everything the model needs to know about the map.
     *
     * @param  array<int, float>|null  $coverage
     * @return array<string, mixed>
     */
    public function facts(Map $map, ?array $coverage): array
    {
        $environment = $map->resolvedEnvironment();
        $stats = $map->source === MapSource::RealWorld ? $this->landCover->stats($map) : null;

        $landCover = null;
        if ($stats) {
            $landCover = [];
            foreach ($stats as $code => $percent) {
                if ($code !== WorldCoverClasses::NO_DATA && $percent >= 0.1) {
                    $landCover[$code.' '.(WorldCoverClasses::SHORT[$code] ?? 'class')] = $percent;
                }
            }
        }

        return array_filter([
            'name' => $map->name,
            'description' => $map->description,
            'source' => $map->source->value,
            'location' => $map->center_lat !== null && $map->center_lng !== null ? [
                'lat' => round($map->center_lat, 4),
                'lng' => round($map->center_lng, 4),
                'climate_hint' => self::climateHint($map->center_lat),
                'note' => 'Real-world terrain: infer region, climate, vegetation and geology from the coordinates.',
            ] : null,
            'size_m' => $map->size,
            'height_range_m' => ['min' => round($map->min_height, 1), 'max' => round($map->max_height, 1)],
            'relief' => $this->analysis->relief($map),
            'sea_level_m' => $environment['sea_level'] ?? 0,
            'ocean' => $environment['ocean_enabled'] ?? false,
            'water_percent' => $this->assistant->waterPercent($map),
            'land_cover_percent' => $landCover,
            'current_landcover_mapping' => $stats ? $this->landCover->mapping($map) : null,
            'current_layers' => $map->layers()->get()->map(fn (TerrainLayer $l) => array_filter([
                'slot' => $l->slot,
                'name' => $l->name,
                'material' => $l->material ? "id={$l->material->id} {$l->material->name} ({$l->material->category}, {$l->material->tile_size} m)" : 'procedural colours',
                'painted_percent' => $coverage[$l->slot] ?? null,
                'settings' => $this->settingsOf($l),
            ], fn ($v) => $v !== null))->values()->all(),
            'free_slots' => array_values(array_diff(range(0, TerrainLayer::MAX_LAYERS - 1), $map->layers()->pluck('slot')->all())),
        ], fn ($v) => $v !== null);
    }

    public static function climateHint(float $lat): string
    {
        $abs = abs($lat);
        $zone = match (true) {
            $abs < 23.5 => 'tropical',
            $abs < 35 => 'subtropical',
            $abs < 55 => 'temperate',
            $abs < 66.5 => 'boreal / subarctic',
            default => 'polar',
        };

        return $zone.', '.($lat >= 0 ? 'northern' : 'southern').' hemisphere';
    }

    // ---------------------------------------------------------------------------------------
    // Sanitising
    // ---------------------------------------------------------------------------------------

    /**
     * Normalise the model's plan into one row per used / added slot.
     *
     * @param  array<string, mixed>  $raw
     * @param  array<int, float>|null  $coverage
     * @return array<string, mixed>
     */
    public function sanitizePlan(array $raw, Map $map, ?array $coverage = null): array
    {
        $existing = $map->layers()->get()->keyBy('slot');
        $entries = [];

        foreach (is_array($raw['layers'] ?? null) ? array_values($raw['layers']) : [] as $entry) {
            if (! is_array($entry) || ! isset($entry['slot']) || ! is_numeric($entry['slot'])) {
                continue;
            }
            $slot = (int) $entry['slot'];
            if ($slot >= 0 && $slot < TerrainLayer::MAX_LAYERS && ! isset($entries[$slot])) {
                $entries[$slot] = $entry;
            }
        }

        $rows = [];
        for ($slot = 0; $slot < TerrainLayer::MAX_LAYERS; $slot++) {
            /** @var TerrainLayer|null $layer */
            $layer = $existing->get($slot);
            $entry = $entries[$slot] ?? null;

            if ($entry === null) {
                if ($layer) {
                    $rows[$slot] = $this->row($map, $slot, $layer, ['action' => 'keep', 'reason' => 'Not part of the plan — left as it is.'], true);
                }

                continue;
            }

            $row = $this->row($map, $slot, $layer, $entry, true);
            if ($row !== null) {
                $rows[$slot] = $row;
            }
        }

        // Never plan away the last layer: keep the most painted one.
        if ($rows !== [] && collect($rows)->every(fn ($r) => $r['action'] === 'remove')) {
            $slot = collect($rows)->sortByDesc(fn ($r) => $coverage[$r['slot']] ?? 0)->keys()->first();
            $rows[$slot] = $this->row($map, $slot, $existing->get($slot), ['action' => 'keep', 'reason' => 'A map needs at least one layer.'], true);
        }

        foreach ($rows as $slot => &$row) {
            $row['current'] = $existing->has($slot) ? $this->current($existing->get($slot), $coverage) : null;
        }
        unset($row);

        $rows = array_values($rows);
        $active = collect($rows)->filter(fn ($r) => in_array($r['action'], ['change', 'add'], true));

        return [
            'summary' => $this->string($raw['summary'] ?? null, 1500) ?? '',
            'notes' => collect(is_array($raw['notes'] ?? null) ? $raw['notes'] : [])
                ->map(fn ($n) => $this->string($n, 300))->filter()->take(8)->values()->all(),
            'layers' => $rows,
            'landcover_mapping' => $this->planMapping($raw['landcover_mapping'] ?? null, $map, $rows),
            'current_landcover_mapping' => $this->hasLandCover($map) ? $this->landCover->mapping($map) : null,
            'estimate' => [
                'imports' => $active->filter(fn ($r) => ($r['material']['type'] ?? null) === 'import')
                    ->unique(fn ($r) => $r['material']['source'].':'.$r['material']['ref'])->count(),
                'generations' => $active->filter(fn ($r) => ($r['material']['type'] ?? null) === 'generate')->count(),
                'generation_note' => self::GENERATION_NOTE,
            ],
            'painted_threshold' => self::PAINTED_THRESHOLD,
        ];
    }

    /**
     * One plan row. $strict (model output): import refs must be offered candidates and a
     * "change" that changes nothing becomes "keep".
     *
     * @param  array<string, mixed>  $entry
     * @return array<string, mixed>|null
     */
    public function row(Map $map, int $slot, ?TerrainLayer $layer, array $entry, bool $strict): ?array
    {
        $action = is_string($entry['action'] ?? null) && in_array($entry['action'], self::ACTIONS, true)
            ? $entry['action']
            : ($layer ? 'change' : 'add');

        $action = match (true) {
            $layer === null && in_array($action, ['remove', 'keep'], true) => null,
            $layer === null => 'add',
            $action === 'add' => 'change',
            default => $action,
        };

        if ($action === null) {
            return null;
        }

        $reason = $this->string($entry['reason'] ?? null, 400) ?? '';

        if ($action === 'remove') {
            return ['slot' => $slot, 'action' => 'remove', 'name' => $layer->name, 'reason' => $reason, 'material' => null, 'settings' => null];
        }

        $currentMaterial = $layer ? $this->currentMaterial($layer) : ['type' => 'procedural'];
        $currentSettings = $layer ? $this->settingsOf($layer) : null;

        if ($action === 'keep') {
            return ['slot' => $slot, 'action' => 'keep', 'name' => $layer->name, 'reason' => $reason, 'material' => $currentMaterial, 'settings' => $currentSettings];
        }

        $name = $this->string($entry['name'] ?? null, 60) ?? $layer?->name ?? (self::defaults($map)[$slot]['name'] ?? 'Layer '.($slot + 1));
        $material = $this->material(is_array($entry['material'] ?? null) ? $entry['material'] : null, $strict, $name) ?? $currentMaterial;
        $materialChanged = ! $this->sameMaterial($material, $currentMaterial);

        $base = $currentSettings ?? $this->defaultSettings($map, $slot);
        if ($materialChanged || $layer === null) {
            $base['texture_scale'] = $this->naturalTileSize($material, $base['texture_scale']);
        }
        $settings = $this->settings(is_array($entry['settings'] ?? null) ? $entry['settings'] : [], $map, $base);

        if ($strict && $layer && ! $materialChanged && $name === $layer->name && self::sameSettings($settings, $currentSettings)) {
            $action = 'keep';
        }

        return ['slot' => $slot, 'action' => $action, 'name' => $name, 'reason' => $reason, 'material' => $material, 'settings' => $settings];
    }

    /**
     * @param  array<string, mixed>|null  $input
     * @return array<string, mixed>|null null when invalid / missing
     */
    public function material(?array $input, bool $strict, string $layerName = ''): ?array
    {
        $type = $input['type'] ?? null;

        if ($type === 'library') {
            $id = is_numeric($input['material_id'] ?? null) ? (int) $input['material_id'] : null;
            $material = $id ? Material::query()->whereKey($id)->where('status', '!=', 'failed')->first() : null;

            return $material ? $this->libraryRef($material) : null;
        }

        if ($type === 'import') {
            $source = $input['source'] ?? null;
            $ref = is_string($input['ref'] ?? null) ? trim($input['ref']) : '';
            if (! in_array($source, ImportMaterial::SOURCES, true) || preg_match(self::REF, $ref) !== 1) {
                return null;
            }

            // Already in the library → just use it.
            $existing = Material::query()->where('source', $source)->where('source_ref', $ref)->where('status', '!=', 'failed')->latest('id')->first();
            if ($existing) {
                return $this->libraryRef($existing);
            }

            $candidate = $strict ? $this->candidates->findImport($source, $ref) : null;
            if ($strict && $candidate === null) {
                return null;
            }

            $resolution = in_array($input['resolution'] ?? null, self::IMPORT_RESOLUTIONS, true) ? $input['resolution'] : '2k';
            $name = $candidate['name'] ?? $this->string($input['name'] ?? null, 120) ?? Str::headline($ref);

            return [
                'type' => 'import',
                'source' => $source,
                'ref' => $ref,
                'resolution' => $resolution,
                'name' => $name,
                'category' => $candidate['category'] ?? MaterialLibrary::validCategory(is_string($input['category'] ?? null) ? $input['category'] : null, MaterialLibrary::guessCategory([$ref, $name])),
                'thumbnail_url' => $candidate['thumbnail_url'] ?? $this->safeUrl($input['thumbnail_url'] ?? null),
                'tile_size' => $candidate['tile_size'] ?? (is_numeric($input['tile_size'] ?? null) ? round(max(0.1, min(100, (float) $input['tile_size'])), 2) : null),
                'aerial' => (bool) ($candidate['aerial'] ?? ($input['aerial'] ?? false)),
                'license' => 'CC0',
                'source_url' => $source === 'polyhaven' ? "https://polyhaven.com/a/{$ref}" : "https://ambientcg.com/view?id={$ref}",
            ];
        }

        if ($type === 'generate') {
            $prompt = $this->string($input['prompt'] ?? null, 500);
            if ($prompt === null) {
                return null;
            }

            return [
                'type' => 'generate',
                'prompt' => $prompt,
                'category' => MaterialLibrary::validCategory(
                    is_string($input['category'] ?? null) ? $input['category'] : null,
                    MaterialLibrary::guessCategory([$layerName, $prompt]),
                ),
            ];
        }

        if ($type === 'procedural') {
            return ['type' => 'procedural'];
        }

        return null;
    }

    /**
     * @param  array<string, mixed>  $input
     * @param  array<string, mixed>  $base  values for missing keys
     * @return array<string, mixed>
     */
    public function settings(array $input, Map $map, array $base): array
    {
        $out = $base;
        $minH = $map->min_height - 1000;
        $maxH = $map->max_height + 1000;

        foreach (['texture_scale', 'roughness_scale', 'normal_strength'] as $key) {
            if (array_key_exists($key, $input) && ($v = $this->clampOrNull($input[$key], ...self::RANGES[$key])) !== null) {
                $out[$key] = round($v, 3);
            }
        }

        if (is_string($input['tint'] ?? null) && preg_match(self::COLOR, $input['tint']) === 1) {
            $out['tint'] = strtolower($input['tint']);
        }

        foreach (['auto_min_height', 'auto_max_height'] as $key) {
            if (array_key_exists($key, $input)) {
                $v = $this->clampOrNull($input[$key], $minH, $maxH);
                $out[$key] = $v === null ? null : round($v, 1);
            }
        }
        foreach (['auto_min_slope', 'auto_max_slope'] as $key) {
            if (array_key_exists($key, $input)) {
                $v = $this->clampOrNull($input[$key], 0, 90);
                $out[$key] = $v === null ? null : round($v, 1);
            }
        }
        if (array_key_exists('auto_priority', $input) && ($v = $this->clampOrNull($input['auto_priority'], 0, 10)) !== null) {
            $out['auto_priority'] = (int) round($v);
        }

        [$out['auto_min_height'], $out['auto_max_height']] = $this->orderedPair($out['auto_min_height'], $out['auto_max_height']);
        [$out['auto_min_slope'], $out['auto_max_slope']] = $this->orderedPair($out['auto_min_slope'], $out['auto_max_slope']);

        return $out;
    }

    /**
     * Class → slot for the planned layers (model entries over name-based defaults), or null when
     * the map has no land cover.
     *
     * @param  list<array<string, mixed>>|array<int, array<string, mixed>>  $rows
     * @return array<int, int>|null
     */
    public function planMapping(mixed $raw, Map $map, array $rows): ?array
    {
        if (! $this->hasLandCover($map)) {
            return null;
        }

        $texts = [];
        foreach ($rows as $row) {
            if ($row['action'] !== 'remove') {
                $material = $row['material'] ?? [];
                $texts[$row['slot']] = trim($row['name'].' '.($material['name'] ?? '').' '.($material['category'] ?? ''));
            }
        }
        ksort($texts);

        $mapping = LandCoverMapping::resolve($texts, $map->landcover_mapping);
        foreach (is_array($raw) ? $raw : [] as $class => $slot) {
            if (is_numeric($class) && isset($mapping[(int) $class]) && is_numeric($slot) && isset($texts[(int) $slot])) {
                $mapping[(int) $class] = (int) $slot;
            }
        }
        ksort($mapping);

        return $mapping;
    }

    // ---------------------------------------------------------------------------------------
    // Applying
    // ---------------------------------------------------------------------------------------

    /**
     * Apply reviewed plan rows.
     *
     * @param  list<array<string, mixed>>  $entries  raw rows from the request
     * @param  array<int|string, mixed>|null  $mapping
     * @return array{updated: int, added: int, removed: int, kept_last: bool, importing: int, generating: int, skipped_generation: int, mapping: bool, repaint: string, repaint_skipped: string|null}
     */
    public function apply(Map $map, array $entries, ?array $mapping, string $repaint): array
    {
        $result = [
            'updated' => 0, 'added' => 0, 'removed' => 0, 'kept_last' => false, 'importing' => 0,
            'generating' => 0, 'skipped_generation' => 0, 'mapping' => false, 'repaint' => 'none', 'repaint_skipped' => null,
        ];
        $jobs = [];
        $aiConfigured = $this->settings->configured();

        DB::transaction(function () use ($map, $entries, $mapping, &$result, &$jobs, $aiConfigured) {
            /** @var Collection<int, TerrainLayer> $existing */
            $existing = $map->layers()->get()->keyBy('slot');
            $removals = [];
            $imported = [];

            foreach ($entries as $entry) {
                $slot = (int) $entry['slot'];
                /** @var TerrainLayer|null $layer */
                $layer = $existing->get($slot);
                $row = $this->row($map, $slot, $layer, $entry, false);

                if ($row === null || $row['action'] === 'keep') {
                    continue;
                }
                if ($row['action'] === 'remove') {
                    $removals[] = $layer;

                    continue;
                }

                $attributes = ['name' => $row['name'], ...$row['settings']];
                $material = $row['material'];

                switch ($material['type']) {
                    case 'library':
                        $attributes['material_id'] = $material['material_id'];
                        break;
                    case 'procedural':
                        $attributes['material_id'] = null;
                        break;
                    case 'import':
                        $key = $material['source'].':'.$material['ref'];
                        if (! isset($imported[$key])) {
                            $created = $this->library->create([
                                'name' => $material['name'],
                                'category' => $material['category'],
                                'source' => $material['source'],
                                'source_ref' => $material['ref'],
                                'source_url' => $material['source_url'],
                                'license' => 'CC0',
                                'tile_size' => $material['tile_size'] ?? $row['settings']['texture_scale'],
                                'status' => 'processing',
                                'status_message' => 'Queued for download…',
                            ]);
                            $imported[$key] = $created->id;
                            $jobs[] = new ImportMaterial($created, $material['source'], $material['ref'], $material['resolution'], [
                                'name' => $material['name'],
                                'category' => $material['category'],
                            ]);
                            $result['importing']++;
                        }
                        $attributes['material_id'] = $imported[$key];
                        break;
                    case 'generate':
                        if (! $aiConfigured) {
                            $result['skipped_generation']++;
                            break;
                        }
                        $created = $this->library->create([
                            'name' => MaterialPrompts::summary($material['prompt']),
                            'category' => $material['category'],
                            'source' => 'ai',
                            'license' => 'AI generated',
                            'tile_size' => $row['settings']['texture_scale'],
                            'status' => 'processing',
                            'status_message' => 'Queued…',
                            'ai_prompt' => $material['prompt'],
                            'ai_model' => $this->settings->imageModel(),
                        ]);
                        $attributes['material_id'] = $created->id;
                        $jobs[] = new GenerateMaterial($created, ['prompt' => $material['prompt'], 'category' => $material['category']]);
                        $result['generating']++;
                        break;
                }

                if ($layer) {
                    $layer->update($attributes);
                    $result['updated']++;
                } else {
                    $defaults = self::defaults($map)[$slot] ?? self::defaults($map)[0];
                    $map->layers()->create([...$defaults, ...$attributes, 'slot' => $slot]);
                    $result['added']++;
                }
            }

            // Removals last, so layers added in the same plan count towards "at least one".
            foreach ($removals as $layer) {
                if ($map->layers()->count() <= 1) {
                    $result['kept_last'] = true;

                    continue;
                }
                $layer->delete();
                $result['removed']++;
            }

            if ($mapping !== null && $this->hasLandCover($map)) {
                $texts = $this->landCover->slotTexts($map);
                $resolved = $this->landCover->mapping($map, $texts);
                foreach ($mapping as $class => $slot) {
                    if (is_numeric($class) && isset($resolved[(int) $class]) && is_numeric($slot) && isset($texts[(int) $slot])) {
                        $resolved[(int) $class] = (int) $slot;
                    }
                }
                $map->update(['landcover_mapping' => $resolved]);
                $result['mapping'] = true;
            }
        });

        foreach ($jobs as $job) {
            try {
                dispatch($job);
            } catch (Throwable $e) {
                // Only reachable with the sync queue: the job already marked its material as failed.
                report($e);
            }
        }

        $map->refresh();

        if ($repaint === 'auto_rules') {
            // Without a splat map the game auto-paints from the layer rules on its next load.
            $this->terrain->delete($map, 'splatmap');
            $map->forceFill(['revision' => $map->revision + 1])->save();
            $result['repaint'] = 'auto_rules';
        } elseif ($repaint === 'landcover') {
            if ($map->source !== MapSource::RealWorld) {
                $result['repaint_skipped'] = 'Land cover is only available for real-world maps.';
            } elseif ($map->terrain_status !== TerrainStatus::Ready) {
                $result['repaint_skipped'] = 'Terrain is still being generated.';
            } else {
                try {
                    ApplyLandCover::dispatch($map);
                } catch (Throwable $e) {
                    report($e);
                }
                $result['repaint'] = 'landcover';
            }
        }

        return $result;
    }

    /**
     * Human summary for the toast, e.g. "Updated 5 layers, removed 2, importing 2 materials, generating 1."
     *
     * @param  array<string, mixed>  $result
     */
    public static function message(array $result): string
    {
        $parts = [];
        $changed = $result['updated'] + $result['added'];
        if ($result['updated'] > 0) {
            $parts[] = 'updated '.$result['updated'].' '.Str::plural('layer', $result['updated']);
        }
        if ($result['added'] > 0) {
            $parts[] = 'added '.$result['added'];
        }
        if ($result['removed'] > 0) {
            $parts[] = 'removed '.$result['removed'];
        }
        if ($result['importing'] > 0) {
            $parts[] = 'importing '.$result['importing'].' '.Str::plural('material', $result['importing']);
        }
        if ($result['generating'] > 0) {
            $parts[] = 'generating '.$result['generating'];
        }

        $message = $parts === [] ? 'No layer changes.' : Str::ucfirst(implode(', ', $parts)).'.';

        if ($result['mapping']) {
            $message .= ' Land cover mapping saved.';
        }
        if ($result['repaint'] === 'auto_rules') {
            $message .= ' Terrain will be repainted from the new rules next time the studio opens.';
        } elseif ($result['repaint'] === 'landcover') {
            $message .= ' Repainting terrain from land cover…';
        }
        if ($result['repaint_skipped']) {
            $message .= ' Not repainted: '.$result['repaint_skipped'];
        }
        if ($result['kept_last']) {
            $message .= ' The last layer was kept — a map needs at least one.';
        }
        if ($result['skipped_generation'] > 0) {
            $message .= " {$result['skipped_generation']} material(s) not generated: AI is not configured.";
        }
        if ($result['importing'] + $result['generating'] > 0 && $changed > 0) {
            $message .= ' New materials appear in the game when ready.';
        }

        return $message;
    }

    // ---------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------

    /**
     * @param  array<int, float>|null  $coverage
     * @return array<string, mixed>
     */
    public function current(TerrainLayer $layer, ?array $coverage): array
    {
        return [
            'name' => $layer->name,
            'color' => $layer->color,
            'color_secondary' => $layer->color_secondary,
            'material' => $this->currentMaterial($layer),
            'settings' => $this->settingsOf($layer),
            'coverage' => $coverage[$layer->slot] ?? null,
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function currentMaterial(TerrainLayer $layer): array
    {
        return $layer->material ? $this->libraryRef($layer->material) : ['type' => 'procedural'];
    }

    /**
     * @return array<string, mixed>
     */
    private function libraryRef(Material $material): array
    {
        return [
            'type' => 'library',
            'material_id' => $material->id,
            'name' => $material->name,
            'category' => $material->category,
            'source' => $material->source,
            'status' => $material->status,
            'tile_size' => $material->tile_size,
            'thumbnail_url' => $material->toGameArray()['thumbnail_url'] ?? null,
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function settingsOf(TerrainLayer $layer): array
    {
        return [
            'texture_scale' => $layer->texture_scale,
            'tint' => $layer->tint ?? '#ffffff',
            'roughness_scale' => $layer->roughness_scale ?? 1.0,
            'normal_strength' => $layer->normal_strength ?? 1.0,
            'auto_min_height' => $layer->auto_min_height,
            'auto_max_height' => $layer->auto_max_height,
            'auto_min_slope' => $layer->auto_min_slope,
            'auto_max_slope' => $layer->auto_max_slope,
            'auto_priority' => $layer->auto_priority,
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function defaultSettings(Map $map, int $slot): array
    {
        $d = self::defaults($map)[$slot] ?? [];

        return [
            'texture_scale' => 2.5,
            'tint' => '#ffffff',
            'roughness_scale' => 1.0,
            'normal_strength' => 1.0,
            'auto_min_height' => null,
            'auto_max_height' => null,
            'auto_min_slope' => null,
            'auto_max_slope' => null,
            'auto_priority' => 0,
            ...array_intersect_key($d, array_flip(['auto_min_height', 'auto_max_height', 'auto_min_slope', 'auto_max_slope', 'auto_priority'])),
        ];
    }

    /**
     * Ground-level metres per repeat for a newly assigned material.
     *
     * @param  array<string, mixed>  $material
     */
    private function naturalTileSize(array $material, float $fallback): float
    {
        $category = $material['category'] ?? null;
        $categorySize = self::CATEGORY_TILE_SIZE[$category] ?? null;

        return (float) match ($material['type']) {
            'library' => $material['tile_size'] ?? $categorySize ?? $fallback,
            'import' => ! $material['aerial'] && $material['tile_size'] !== null ? $material['tile_size'] : ($categorySize ?? $fallback),
            'generate' => $categorySize ?? $fallback,
            default => $fallback,
        };
    }

    /**
     * @param  array<string, mixed>  $a
     * @param  array<string, mixed>  $b
     */
    private function sameMaterial(array $a, array $b): bool
    {
        return $a['type'] === $b['type'] && ($a['type'] !== 'library' || $a['material_id'] === $b['material_id']);
    }

    /**
     * @param  array<string, mixed>  $a
     * @param  array<string, mixed>  $b
     */
    private static function sameSettings(array $a, array $b): bool
    {
        foreach (self::SETTING_KEYS as $key) {
            $x = $a[$key] ?? null;
            $y = $b[$key] ?? null;
            $same = match (true) {
                $x === null || $y === null => $x === $y,
                is_numeric($x) && is_numeric($y) => abs((float) $x - (float) $y) < 1e-6,
                default => strtolower((string) $x) === strtolower((string) $y),
            };
            if (! $same) {
                return false;
            }
        }

        return true;
    }

    private function hasLandCover(Map $map): bool
    {
        return $map->source === MapSource::RealWorld && $this->landCover->stats($map) !== null;
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    private static function defaults(Map $map): array
    {
        return collect(DefaultTerrainLayers::definitions($map->min_height, $map->max_height, (float) ($map->resolvedEnvironment()['sea_level'] ?? 0)))
            ->keyBy('slot')->all();
    }

    private function safeUrl(mixed $url): ?string
    {
        return is_string($url) && preg_match('#^https://[^\s"<>]+$#', $url) === 1 ? Str::limit($url, 500, '') : null;
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
