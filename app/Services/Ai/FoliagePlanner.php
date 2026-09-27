<?php

namespace App\Services\Ai;

use App\Enums\FoliageKind;
use App\Enums\MapSource;
use App\Models\FoliageAsset;
use App\Models\FoliageType;
use App\Models\Map;
use App\Services\Foliage\FoliageAssetQueue;
use App\Services\Foliage\FoliageLibrary;
use App\Services\Foliage\FoliageTypeDefaults;
use App\Services\Foliage\PolyHavenModels;
use App\Services\LandCover\LandCoverService;
use App\Services\LandCover\WorldCoverClasses;
use App\Services\Terrain\TerrainStorage;
use App\Support\AiSettings;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Throwable;

/**
 * AI foliage planning: a region- and style-specific foliage palette (keep / change / remove / add),
 * each type with a model (library → free CC0 Poly Haven import → AI generated card → procedural) and
 * realistic settings, plus applying the (user-reviewed) subset of that plan.
 *
 * Sizes are planned in metres (size_min_m / size_max_m = real instance heights) and converted to the
 * per-type scale of whichever model is used, so a 25 m spruce is 25 m tall whatever the source.
 *
 * Everything the model or the browser sends is untrusted: unknown keys are dropped, numbers are
 * clamped to the foliage form ranges and only existing types / assets / offered imports are kept.
 */
class FoliagePlanner
{
    public const ACTIONS = ['keep', 'change', 'remove', 'add'];

    public const ASSET_TYPES = ['current', 'library', 'import', 'generate', 'procedural'];

    public const MAX_TYPES = 24;

    /** Ranges of the foliage type form (FoliageTypeController::validated). */
    public const RANGES = [
        'density' => [0.01, 500],
        'min_slope' => [0, 90],
        'max_slope' => [0, 90],
        'cull_distance' => [20, 5000],
        'size_min_m' => [0.03, 120],
        'size_max_m' => [0.03, 120],
    ];

    public const BOOLEAN_KEYS = ['align_to_normal', 'random_yaw', 'cast_shadows', 'allow_underwater'];

    public const COLOR_KEYS = ['color', 'color_secondary', 'tint'];

    public const GENERATION_NOTE = 'charged to your OpenRouter credits';

    private const COLOR = '/^#[0-9a-fA-F]{6}$/';

    private const REF = '/^[A-Za-z0-9_.-]{1,120}$/';

    public function __construct(
        private readonly OpenRouterClient $client,
        private readonly AiSettings $settings,
        private readonly MapAiAssistant $assistant,
        private readonly TerrainAnalysis $analysis,
        private readonly LandCoverService $landCover,
        private readonly PolyHavenModels $polyHaven,
        private readonly FoliageAssetQueue $queue,
        private readonly FoliageTypeDefaults $defaults,
        private readonly TerrainStorage $terrain,
    ) {}

    // ---------------------------------------------------------------------------------------
    // Planning
    // ---------------------------------------------------------------------------------------

    /**
     * @param  array{map_id?: int|null, region?: string|null, style?: int, direction?: string|null, allow_generation?: bool}  $input
     * @return array<string, mixed>
     */
    public function plan(array $input): array
    {
        if (! $this->settings->configured()) {
            throw new AiNotConfiguredException;
        }

        $map = isset($input['map_id']) ? Map::query()->find($input['map_id']) : null;
        $style = max(0, min(100, (int) ($input['style'] ?? 20)));
        $region = $this->string($input['region'] ?? null, 200);
        $direction = $this->string($input['direction'] ?? null, 600);
        $allowGeneration = (bool) ($input['allow_generation'] ?? true);

        [$candidates, $unavailable] = $this->candidates();

        $user = "BRIEF\n".json_encode(array_filter([
            'region' => $region,
            'style' => $style,
            'style_meaning' => self::styleText($style),
            'ai_generation_allowed' => $allowGeneration,
            'map' => $map ? $this->mapFacts($map) : null,
        ], fn ($v) => $v !== null), JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
            ."\n\nCURRENT FOLIAGE TYPES (global palette shared by all maps)\n".$this->currentText()
            ."\n\nASSET LIBRARY\n".$this->libraryText()
            ."\n\nPOLY HAVEN IMPORT CANDIDATES (CC0, photoreal scans; ref | name | kind | triangles | tags)\n"
            .($candidates !== [] ? implode("\n", array_map(fn ($c) => "{$c['ref']} | {$c['name']} | {$c['kind']} | ".number_format($c['polycount']).' | '.implode(', ', array_slice($c['tags'], 0, 6)), $candidates)) : '(unavailable)')
            ."\n\nPROCEDURAL KINDS (built-in low-poly meshes, natural height at scale 1): "
            .implode(', ', array_map(fn ($k, $h) => "{$k} {$h} m", array_keys(FoliageLibrary::PROCEDURAL_HEIGHT), FoliageLibrary::PROCEDURAL_HEIGHT))
            .($direction !== null ? "\n\nDIRECTION FROM THE USER (follow it where sensible):\n".$direction : '');

        $raw = $this->client->chatJson($this->settings->textModel(), self::systemPrompt(), $user, 7000);

        $plan = $this->sanitizePlan($raw, $allowGeneration, true);
        $plan['brief'] = ['region' => $region, 'style' => $style, 'map_id' => $map?->id, 'map_name' => $map?->name];
        $plan['unavailable_sources'] = $unavailable;

        return $plan;
    }

    public static function systemPrompt(): string
    {
        return <<<'TXT'
You are a senior environment artist building the vegetation palette (foliage types) of an open-world game for a specific
place on Earth and a given visual style. Foliage types are global: every map uses the same palette, and the in-game brush
and auto-population place them (auto-population uses the kind together with ESA WorldCover land cover: trees in forest,
bushes in shrubland, grass / flowers in grassland, reeds in wetlands, rocks on bare ground).

Build a palette that makes the region instantly recognisable: its characteristic tree species, understorey shrubs,
grasses, flowers or reeds along water, and rocks typical for its geology. Typically 6-12 types. Cover the layers a
player sees: canopy trees (1-3 species), shrubs (1-2), ground cover grass (1-2), accents (flowers, ferns, reeds near
water, dead wood), rocks (1-2). Decide for EVERY current type: "keep" (only if it fits and nothing changes), "change"
(fix settings, rename to the regional species, swap its model) or "remove" (implausible for this region / style, or a
duplicate). Add missing types with "add". Never exceed 24 types in total.

Style (0 = photoreal, 100 = stylized):
- 0-35: prefer photoreal models - Poly Haven imports or realistic library assets; natural, slightly muted colours.
- 36-65: mix - realistic imports for rocks and trees, AI generated cards or procedural meshes for grass / flowers.
- 66-100: stylized - prefer procedural low-poly meshes, stylized library assets and AI cards with a stylized prompt;
  avoid photoreal scans; saturated, harmonious colours.

Models ("asset"), in this order of preference:
1. {"type":"library","asset_id":ID} - an existing library asset of a fitting species and style
2. {"type":"import","source":"polyhaven","ref":REF} - ONLY refs from the candidate list; check the tags: many
   Poly Haven plants are South African karoo / desert species - only use them where they are plausible
3. {"type":"generate","prompt":"<=30 words: species, shape, colours, season"} - an AI generated plant image baked into
   crossed cards. Great for grass, flowers, reeds and shrubs; acceptable for distant trees; NOT possible for rocks.
   Only if generation is allowed and nothing in the library or import list fits; it costs money - say why in "reason".
4. {"type":"procedural"} - built-in procedural mesh of the kind, tinted by color / color_secondary. Cheap and robust;
   the right choice for stylized looks and when nothing else fits.
For "change" rows omit "asset" (or use {"type":"current"}) to keep the current model.

Settings (all required for change / add):
- size_min_m / size_max_m: REAL heights of instances in metres (e.g. Norway spruce 18-35, Scots pine 15-30, birch
  10-20, oak 15-25, olive 4-8, date palm 12-20, hazel shrub 2-5, heather 0.2-0.6, meadow grass 0.3-0.8, tall reeds
  1.5-3, boulders 0.5-3). They are converted to the model's scale automatically.
- density: instances per 100 m2 at full brush strength (trees 0.2-1.5, shrubs 0.5-4, grass 20-80, flowers 2-12,
  reeds 8-25, rocks 0.05-1).
- min_slope / max_slope in degrees (trees rarely above 35-40, rocks up to 70); min_height / max_height in metres
  (absolute, same datum as the map height range; null = unlimited) - e.g. tree line, beach grass only near sea level.
- cull_distance in metres (trees 1200-2500, shrubs 300-700, grass 100-200, flowers 80-150, reeds 150-300, rocks 500-1200).
- color / color_secondary "#rrggbb": leaf / needle / petal / rock colour and trunk / stem / moss colour (used by
  procedural meshes and the placement preview); tint "#rrggbb" multiplied onto model textures (#ffffff = unchanged; only
  subtle seasonal / harmonising tints).
- align_to_normal (grass, flowers, rocks true; trees false), random_yaw true, cast_shadows (trees, shrubs, rocks true;
  grass / flowers false), allow_underwater (reeds, rocks true).
- kind: one of conifer, broadleaf, palm, bush, grass, flower, reed, rock (drives wind stiffness, LOD and land cover).

If a stylized look is requested and the library has no stylized models, add a note recommending the free CC0 packs the
user can upload as a zip: Quaternius "Stylized Nature MegaKit" (quaternius.com) and Kenney "Nature Kit" (kenney.nl).

Answer with a single JSON object only, no prose:
{"summary": "2-4 sentences on the vegetation of this place and the look", "notes": ["short hints for the user"],
 "types": [{"action": "keep"|"change"|"remove"|"add", "type_id": ID (keep/change/remove only), "name": "species name",
   "kind": "...", "reason": "one sentence", "asset": {...} (change/add), "settings": {...} (change/add)}]}
TXT;
    }

    public static function styleText(int $style): string
    {
        return match (true) {
            $style <= 35 => 'photoreal',
            $style <= 65 => 'in between: realistic shapes, slightly painterly',
            default => 'stylized',
        };
    }

    /**
     * @return array<string, mixed>
     */
    public function mapFacts(Map $map): array
    {
        $stats = $map->source === MapSource::RealWorld ? $this->landCover->stats($map) : null;
        $landCover = null;
        if ($stats) {
            $landCover = [];
            foreach ($stats as $code => $percent) {
                if ($code !== WorldCoverClasses::NO_DATA && $percent >= 0.1) {
                    $landCover[WorldCoverClasses::SHORT[$code] ?? "class {$code}"] = $percent;
                }
            }
        }
        $environment = $map->resolvedEnvironment();

        return array_filter([
            'name' => $map->name,
            'description' => $map->description,
            'source' => $map->source->value,
            'location' => $map->center_lat !== null && $map->center_lng !== null ? [
                'lat' => round($map->center_lat, 4),
                'lng' => round($map->center_lng, 4),
                'climate_hint' => LayerPlanner::climateHint($map->center_lat),
                'note' => 'Real-world terrain: infer the region, climate and native vegetation from the coordinates.',
            ] : null,
            'size_m' => $map->size,
            'height_range_m' => ['min' => round($map->min_height, 1), 'max' => round($map->max_height, 1)],
            'relief' => $this->analysis->relief($map),
            'sea_level_m' => $environment['sea_level'] ?? 0,
            'ocean' => $environment['ocean_enabled'] ?? false,
            'water_percent' => $this->assistant->waterPercent($map),
            'land_cover_percent' => $landCover,
        ], fn ($v) => $v !== null);
    }

    /**
     * Import candidates (without models too heavy for the browser bake) and unavailable sources.
     *
     * @return array{0: list<array<string, mixed>>, 1: list<string>}
     */
    public function candidates(): array
    {
        try {
            $items = collect($this->polyHaven->catalogue())
                ->map(fn ($asset, $ref) => $this->polyHaven->summary((string) $ref, $asset))
                ->reject(fn ($item) => $item['too_heavy'])
                ->sortBy('ref')
                ->values()
                ->all();

            return [$items, []];
        } catch (Throwable $e) {
            report($e);

            return [[], ['Poly Haven']];
        }
    }

    private function currentText(): string
    {
        $usage = $this->usage();
        $types = FoliageType::query()->with('asset')->orderBy('name')->get();
        if ($types->isEmpty()) {
            return '(none)';
        }

        return $types->map(function (FoliageType $t) use ($usage) {
            $model = $t->asset
                ? "library asset id={$t->asset->id} \"{$t->asset->name}\" ({$t->asset->style}, {$t->asset->source}".($t->asset->isReady() ? '' : ', '.$t->asset->status).')'
                : ($t->model_path ? 'uploaded GLB' : 'procedural');
            $base = $this->baseHeight($t);
            $size = $base !== null ? sprintf('%.2f-%.2f m', $t->min_scale * $base, $t->max_scale * $base) : "scale {$t->min_scale}-{$t->max_scale}";
            $u = $usage[$t->id] ?? null;

            return sprintf(
                'id=%d "%s" kind=%s model=%s size=%s density=%s slope=%s-%s height=%s-%s cull=%s colors=%s/%s placed=%s',
                $t->id, $t->name, $t->kind->value, $model, $size, $t->density, $t->min_slope, $t->max_slope,
                $t->min_height ?? '-', $t->max_height ?? '-', $t->cull_distance, $t->color, $t->color_secondary,
                $u ? "{$u['instances']} instances on {$u['maps']} map(s)" : 'nowhere',
            );
        })->implode("\n");
    }

    private function libraryText(): string
    {
        $assets = FoliageAsset::query()->whereIn('status', ['ready', 'awaiting_bake', 'queued', 'processing'])->orderBy('name')->get();
        if ($assets->isEmpty()) {
            return '(empty)';
        }

        return $assets->map(fn (FoliageAsset $a) => sprintf(
            'id=%d "%s" kind=%s style=%s source=%s height=%s%s',
            $a->id, $a->name, $a->kind->value, $a->style, $a->source,
            ($h = $this->assetHeight($a)) !== null ? round($h, 2).' m' : 'unknown',
            $a->isReady() ? '' : ' ('.$a->status.')',
        ))->implode("\n");
    }

    /**
     * Placed instances per foliage type across all maps.
     *
     * @return array<int, array{maps: int, instances: int}>
     */
    public function usage(): array
    {
        $usage = [];

        foreach (Map::query()->get() as $map) {
            try {
                $json = $this->terrain->read($map, 'foliage');
            } catch (Throwable) {
                $json = null;
            }
            $data = $json ? json_decode($json, true) : null;
            foreach (is_array($data['instances'] ?? null) ? $data['instances'] : [] as $typeId => $flat) {
                $count = is_array($flat) ? intdiv(count($flat), 7) : 0;
                if ($count > 0) {
                    $usage[(int) $typeId] ??= ['maps' => 0, 'instances' => 0];
                    $usage[(int) $typeId]['maps']++;
                    $usage[(int) $typeId]['instances'] += $count;
                }
            }
        }

        return $usage;
    }

    // ---------------------------------------------------------------------------------------
    // Sanitising
    // ---------------------------------------------------------------------------------------

    /**
     * @param  array<string, mixed>  $raw
     * @return array<string, mixed>
     */
    public function sanitizePlan(array $raw, bool $allowGeneration = true, bool $strict = true): array
    {
        $existing = FoliageType::query()->with('asset')->orderBy('name')->get()->keyBy('id');
        $usage = $this->usage();
        $rows = [];
        $seen = [];

        foreach (is_array($raw['types'] ?? null) ? array_values($raw['types']) : [] as $entry) {
            if (! is_array($entry)) {
                continue;
            }
            $typeId = isset($entry['type_id']) && is_numeric($entry['type_id']) ? (int) $entry['type_id'] : null;
            $type = $typeId !== null ? $existing->get($typeId) : null;

            if ($typeId !== null && $type === null) {
                continue; // Hallucinated id.
            }
            if ($type !== null && isset($seen[$type->id])) {
                continue;
            }

            $row = $this->row($type, $entry, $strict, $allowGeneration);
            if ($row === null) {
                continue;
            }
            if ($type !== null) {
                $seen[$type->id] = true;
            }
            $rows[] = $row;
        }

        // Types the plan did not mention stay as they are.
        foreach ($existing as $type) {
            if (! isset($seen[$type->id])) {
                $rows[] = $this->row($type, ['action' => 'keep', 'reason' => 'Not part of the plan — left as it is.'], $strict, $allowGeneration);
            }
        }

        $adds = 0;
        $kept = collect($rows)->filter(fn ($r) => $r['action'] !== 'add' && $r['action'] !== 'remove')->count();
        $rows = array_values(array_filter($rows, function ($r) use (&$adds, $kept) {
            if ($r['action'] !== 'add') {
                return true;
            }

            return $kept + (++$adds) <= self::MAX_TYPES;
        }));

        foreach ($rows as &$row) {
            if ($row['type_id'] !== null) {
                $row['current'] = $this->current($existing->get($row['type_id']));
                $row['usage'] = $usage[$row['type_id']] ?? ['maps' => 0, 'instances' => 0];
            } else {
                $row['current'] = null;
                $row['usage'] = null;
            }
        }
        unset($row);

        $active = collect($rows)->filter(fn ($r) => in_array($r['action'], ['change', 'add'], true));

        return [
            'summary' => $this->string($raw['summary'] ?? null, 1500) ?? '',
            'notes' => collect(is_array($raw['notes'] ?? null) ? $raw['notes'] : [])
                ->map(fn ($n) => $this->string($n, 300))->filter()->take(8)->values()->all(),
            'types' => $rows,
            'estimate' => [
                'imports' => $active->filter(fn ($r) => ($r['asset']['type'] ?? null) === 'import')->unique(fn ($r) => $r['asset']['ref'])->count(),
                'generations' => $active->filter(fn ($r) => ($r['asset']['type'] ?? null) === 'generate')->count(),
                'generation_note' => self::GENERATION_NOTE,
            ],
        ];
    }

    /**
     * One plan row. $strict (model output): import refs must be offered candidates and a "change"
     * that changes nothing becomes "keep".
     *
     * @param  array<string, mixed>  $entry
     * @return array<string, mixed>|null
     */
    public function row(?FoliageType $type, array $entry, bool $strict, bool $allowGeneration = true): ?array
    {
        $action = is_string($entry['action'] ?? null) && in_array($entry['action'], self::ACTIONS, true)
            ? $entry['action']
            : ($type ? 'change' : 'add');

        if ($type === null && $action !== 'add') {
            return null;
        }
        if ($type !== null && $action === 'add') {
            $action = 'change';
        }

        $kind = FoliageLibrary::validKind($entry['kind'] ?? null, $type?->kind ?? FoliageKind::Bush);
        $name = $this->string($entry['name'] ?? null, 60) ?? $type?->name ?? Str::headline($kind->value);
        $reason = $this->string($entry['reason'] ?? null, 400) ?? '';

        $base = [
            'action' => $action,
            'type_id' => $type?->id,
            'name' => $type && in_array($action, ['keep', 'remove'], true) ? $type->name : $name,
            'kind' => $type && in_array($action, ['keep', 'remove'], true) ? $type->kind->value : $kind->value,
            'reason' => $reason,
            'asset' => null,
            'settings' => null,
        ];

        if ($action === 'keep' || $action === 'remove') {
            return $base;
        }

        $asset = $this->asset(is_array($entry['asset'] ?? null) ? $entry['asset'] : null, $kind, $strict, $allowGeneration, $type !== null);
        if ($asset === null) {
            $asset = $type ? ['type' => 'current'] : ['type' => 'procedural'];
        }

        $settings = $this->settings(is_array($entry['settings'] ?? null) ? $entry['settings'] : [], $type, $kind, $asset);

        $row = [...$base, 'asset' => $asset, 'settings' => $settings];

        if ($strict && $action === 'change' && $asset['type'] === 'current' && $type !== null
            && $name === $type->name && $kind === $type->kind && self::sameSettings($settings, $this->settingsOf($type))) {
            $row['action'] = 'keep';
            $row['asset'] = null;
            $row['settings'] = null;
        }

        return $row;
    }

    /**
     * @param  array<string, mixed>|null  $input
     * @return array<string, mixed>|null
     */
    public function asset(?array $input, FoliageKind $kind, bool $strict, bool $allowGeneration = true, bool $hasCurrent = false): ?array
    {
        $type = is_string($input['type'] ?? null) ? $input['type'] : null;

        switch ($type) {
            case 'current':
                return $hasCurrent ? ['type' => 'current'] : null;

            case 'library':
                $asset = isset($input['asset_id']) && is_numeric($input['asset_id'])
                    ? FoliageAsset::query()->whereKey((int) $input['asset_id'])->where('status', '!=', 'failed')->first()
                    : null;

                return $asset ? $this->libraryRef($asset) : null;

            case 'import':
                $ref = is_string($input['ref'] ?? null) && preg_match(self::REF, $input['ref']) === 1 ? $input['ref'] : null;
                if ($ref === null) {
                    return null;
                }
                $existing = FoliageAsset::query()->where('source', 'polyhaven')->where('source_ref', $ref)->where('status', '!=', 'failed')->first();
                if ($existing) {
                    return $this->libraryRef($existing);
                }
                $summary = null;
                try {
                    $catalogue = $this->polyHaven->catalogue();
                    $summary = isset($catalogue[$ref]) ? $this->polyHaven->summary($ref, $catalogue[$ref]) : null;
                } catch (Throwable) {
                    $summary = null;
                }
                if ($strict && ($summary === null || $summary['too_heavy'])) {
                    return null;
                }

                return [
                    'type' => 'import',
                    'source' => 'polyhaven',
                    'ref' => $ref,
                    'name' => $summary['name'] ?? Str::headline($ref),
                    'thumbnail_url' => $summary['thumbnail_url'] ?? null,
                    'polycount' => $summary['polycount'] ?? null,
                    'source_url' => "https://polyhaven.com/a/{$ref}",
                ];

            case 'generate':
                $prompt = $this->string($input['prompt'] ?? null, 600);
                if ($prompt === null || $kind === FoliageKind::Rock || ! $allowGeneration) {
                    return null;
                }

                return ['type' => 'generate', 'prompt' => $prompt];

            case 'procedural':
                return ['type' => 'procedural'];
        }

        return null;
    }

    /**
     * @param  array<string, mixed>  $input
     * @param  array<string, mixed>  $asset
     * @return array<string, mixed>
     */
    public function settings(array $input, ?FoliageType $type, FoliageKind $kind, array $asset): array
    {
        $base = $type ? $this->settingsOf($type) : $this->defaultSettings($kind);
        $out = $base;

        foreach (self::RANGES as $key => [$min, $max]) {
            if (array_key_exists($key, $input) && is_numeric($input[$key])) {
                $out[$key] = round(min($max, max($min, (float) $input[$key])), 3);
            }
        }
        foreach (['min_height', 'max_height'] as $key) {
            if (array_key_exists($key, $input)) {
                $out[$key] = is_numeric($input[$key]) ? round(min(20000, max(-2000, (float) $input[$key])), 1) : null;
            }
        }
        foreach (self::BOOLEAN_KEYS as $key) {
            if (array_key_exists($key, $input) && is_bool($input[$key])) {
                $out[$key] = $input[$key];
            }
        }
        foreach (self::COLOR_KEYS as $key) {
            if (is_string($input[$key] ?? null) && preg_match(self::COLOR, $input[$key]) === 1) {
                $out[$key] = strtolower($input[$key]);
            }
        }

        [$out['min_slope'], $out['max_slope']] = $this->orderedPair($out['min_slope'], $out['max_slope']);
        [$out['size_min_m'], $out['size_max_m']] = $this->orderedPair($out['size_min_m'], $out['size_max_m']);
        if ($out['min_height'] !== null && $out['max_height'] !== null) {
            [$out['min_height'], $out['max_height']] = $this->orderedPair($out['min_height'], $out['max_height']);
        }

        return $out;
    }

    // ---------------------------------------------------------------------------------------
    // Applying
    // ---------------------------------------------------------------------------------------

    /**
     * Apply the reviewed rows (only the ones the user ticked are sent).
     *
     * @param  list<array<string, mixed>>  $entries
     * @return array{created: int, updated: int, removed: int, imports: int, generations: int, skipped: list<string>}
     */
    public function apply(array $entries, int $style = 20): array
    {
        $result = ['created' => 0, 'updated' => 0, 'removed' => 0, 'imports' => 0, 'generations' => 0, 'skipped' => []];
        $aiConfigured = $this->settings->configured();
        $existing = FoliageType::query()->with('asset')->get()->keyBy('id');
        $importedRefs = [];

        DB::transaction(function () use ($entries, $style, $existing, $aiConfigured, &$result, &$importedRefs) {
            foreach ($entries as $entry) {
                if (! is_array($entry)) {
                    continue;
                }
                $typeId = isset($entry['type_id']) && is_numeric($entry['type_id']) ? (int) $entry['type_id'] : null;
                $type = $typeId !== null ? $existing->get($typeId) : null;
                if ($typeId !== null && $type === null) {
                    $result['skipped'][] = 'A foliage type in the plan no longer exists.';

                    continue;
                }

                $row = $this->row($type, $entry, false, $aiConfigured);
                if ($row === null || $row['action'] === 'keep') {
                    continue;
                }

                if ($row['action'] === 'remove') {
                    $this->deleteLegacyModel($type);
                    $type->delete();
                    $result['removed']++;

                    continue;
                }

                $wanted = is_array($entry['asset'] ?? null) ? ($entry['asset']['type'] ?? null) : null;
                if ($wanted === 'generate' && ! $aiConfigured) {
                    $result['skipped'][] = "{$row['name']}: AI is not configured — using the procedural mesh instead.";
                }

                $settings = $row['settings'];
                $kind = FoliageKind::from($row['kind']);
                $meanSize = ($settings['size_min_m'] + $settings['size_max_m']) / 2;

                // Resolve the model.
                $asset = $type?->asset;
                $assetId = $type?->foliage_asset_id;
                $clearLegacy = false;
                switch ($row['asset']['type']) {
                    case 'library':
                        $asset = FoliageAsset::query()->find($row['asset']['asset_id']);
                        $assetId = $asset?->id;
                        break;
                    case 'import':
                        $ref = $row['asset']['ref'];
                        $asset = $importedRefs[$ref] ??= $this->queue->importPolyHaven($ref, $kind->value, round($meanSize, 2));
                        $assetId = $asset->id;
                        $result['imports']++;
                        break;
                    case 'generate':
                        $asset = $this->queue->generate(
                            Str::limit($row['name'], 60, ''), $kind, $style, round(max(0.05, $meanSize), 2), $row['asset']['prompt'],
                        );
                        $assetId = $asset->id;
                        $result['generations']++;
                        break;
                    case 'procedural':
                        $asset = null;
                        $assetId = null;
                        $clearLegacy = true;
                        break;
                }

                $baseHeight = $asset ? $this->assetHeight($asset) : ($type && $type->model_path && ! $clearLegacy ? null : FoliageLibrary::PROCEDURAL_HEIGHT[$kind->value]);
                $attributes = [
                    'name' => Str::limit($row['name'], 60, ''),
                    'kind' => $kind->value,
                    'foliage_asset_id' => $assetId,
                    ...$this->typeAttributes($settings, $baseHeight, $type),
                ];

                if ($type === null) {
                    FoliageType::query()->create([...$this->defaults->forKind($kind), ...$attributes]);
                    $result['created']++;
                } else {
                    if ($clearLegacy) {
                        $this->deleteLegacyModel($type);
                        $attributes['model_path'] = null;
                    }
                    $type->update($attributes);
                    $result['updated']++;
                }
            }
        });

        return $result;
    }

    /**
     * @param  array{created: int, updated: int, removed: int, imports: int, generations: int, skipped: list<string>}  $result
     */
    public static function message(array $result): string
    {
        $parts = [];
        foreach (['created' => 'added', 'updated' => 'changed', 'removed' => 'removed'] as $key => $label) {
            if ($result[$key] > 0) {
                $parts[] = "{$result[$key]} {$label}";
            }
        }
        $message = $parts === [] ? 'Nothing to change.' : 'Foliage palette updated: '.implode(', ', $parts).'.';

        $pending = [];
        if ($result['imports'] > 0) {
            $pending[] = $result['imports'].' Poly Haven '.Str::plural('import', $result['imports']);
        }
        if ($result['generations'] > 0) {
            $pending[] = $result['generations'].' AI '.Str::plural('generation', $result['generations']);
        }
        if ($pending !== []) {
            $message .= ' '.ucfirst(implode(' and ', $pending)).' running — keep the foliage page open so they can be optimised; types use procedural meshes until then.';
        }
        if ($result['skipped'] !== []) {
            $message .= ' '.implode(' ', array_slice($result['skipped'], 0, 3));
        }

        return $message;
    }

    // ---------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------

    /**
     * Metres of the model a type renders at scale 1 (null = unknown legacy upload).
     */
    public function baseHeight(FoliageType $type): ?float
    {
        if ($type->asset) {
            return $this->assetHeight($type->asset);
        }

        return $type->model_path ? null : FoliageLibrary::PROCEDURAL_HEIGHT[$type->kind->value];
    }

    public function assetHeight(FoliageAsset $asset): ?float
    {
        $height = $asset->meta['height'] ?? $asset->target_height;

        return is_numeric($height) && $height > 0 ? (float) $height : null;
    }

    /**
     * @return array<string, mixed>
     */
    public function current(FoliageType $type): array
    {
        return [
            'name' => $type->name,
            'kind' => $type->kind->value,
            'asset' => $type->asset ? $this->libraryRef($type->asset) : ($type->model_path ? ['type' => 'upload'] : ['type' => 'procedural']),
            'settings' => $this->settingsOf($type),
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function libraryRef(FoliageAsset $asset): array
    {
        return [
            'type' => 'library',
            'asset_id' => $asset->id,
            'name' => $asset->name,
            'style' => $asset->style,
            'source' => $asset->source,
            'status' => $asset->status,
            'thumbnail_url' => $asset->toGameArray()['thumbnail_url'],
            'height' => $this->assetHeight($asset),
        ];
    }

    /**
     * A type's settings in plan terms (sizes in metres where the model height is known).
     *
     * @return array<string, mixed>
     */
    public function settingsOf(FoliageType $type): array
    {
        $base = $this->baseHeight($type) ?? 1.0;

        return [
            'size_min_m' => round($type->min_scale * $base, 3),
            'size_max_m' => round($type->max_scale * $base, 3),
            'density' => $type->density,
            'min_slope' => $type->min_slope,
            'max_slope' => $type->max_slope,
            'min_height' => $type->min_height,
            'max_height' => $type->max_height,
            'cull_distance' => $type->cull_distance,
            'color' => strtolower($type->color),
            'color_secondary' => strtolower($type->color_secondary),
            'tint' => strtolower($type->tint ?? '#ffffff'),
            'align_to_normal' => $type->align_to_normal,
            'random_yaw' => $type->random_yaw,
            'cast_shadows' => $type->cast_shadows,
            'allow_underwater' => $type->allow_underwater,
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function defaultSettings(FoliageKind $kind): array
    {
        $d = $this->defaults->forKind($kind);
        $h = FoliageLibrary::KIND_HEIGHT[$kind->value];

        return [
            'size_min_m' => round($h * 0.8, 3),
            'size_max_m' => round($h * 1.2, 3),
            'density' => (float) $d['density'],
            'min_slope' => (float) $d['min_slope'],
            'max_slope' => (float) $d['max_slope'],
            'min_height' => null,
            'max_height' => null,
            'cull_distance' => (float) $d['cull_distance'],
            'color' => $d['color'],
            'color_secondary' => $d['color_secondary'],
            'tint' => '#ffffff',
            'align_to_normal' => (bool) $d['align_to_normal'],
            'random_yaw' => true,
            'cast_shadows' => (bool) $d['cast_shadows'],
            'allow_underwater' => (bool) ($d['allow_underwater'] ?? false),
        ];
    }

    /**
     * Plan settings → FoliageType columns.
     *
     * @param  array<string, mixed>  $settings
     * @return array<string, mixed>
     */
    private function typeAttributes(array $settings, ?float $baseHeight, ?FoliageType $type): array
    {
        if ($baseHeight !== null && $baseHeight > 0) {
            $minScale = round(min(20, max(0.05, $settings['size_min_m'] / $baseHeight)), 3);
            $maxScale = round(min(20, max($minScale, $settings['size_max_m'] / $baseHeight)), 3);
        } else {
            $minScale = $type->min_scale ?? 0.8;
            $maxScale = $type->max_scale ?? 1.2;
        }

        return [
            'min_scale' => $minScale,
            'max_scale' => $maxScale,
            'density' => $settings['density'],
            'min_slope' => $settings['min_slope'],
            'max_slope' => $settings['max_slope'],
            'min_height' => $settings['min_height'],
            'max_height' => $settings['max_height'],
            'cull_distance' => $settings['cull_distance'],
            'color' => $settings['color'],
            'color_secondary' => $settings['color_secondary'],
            'tint' => $settings['tint'],
            'align_to_normal' => $settings['align_to_normal'],
            'random_yaw' => $settings['random_yaw'],
            'cast_shadows' => $settings['cast_shadows'],
            'allow_underwater' => $settings['allow_underwater'],
        ];
    }

    private function deleteLegacyModel(?FoliageType $type): void
    {
        if ($type?->model_path) {
            Storage::disk('public')->delete($type->model_path);
        }
    }

    /**
     * @param  array<string, mixed>  $a
     * @param  array<string, mixed>  $b
     */
    private static function sameSettings(array $a, array $b): bool
    {
        foreach ($a as $key => $value) {
            $other = $b[$key] ?? null;
            if (is_float($value) || is_int($value) || is_float($other) || is_int($other)) {
                if ($value === null || $other === null ? $value !== $other : abs((float) $value - (float) $other) > max(0.01, abs((float) $other) * 0.02)) {
                    return false;
                }
            } elseif ($value !== $other) {
                return false;
            }
        }

        return true;
    }

    /**
     * @return array{0: float, 1: float}
     */
    private function orderedPair(float|int|null $a, float|int|null $b): array
    {
        $a = (float) $a;
        $b = (float) $b;

        return $a <= $b ? [$a, $b] : [$b, $a];
    }

    private function string(mixed $value, int $max): ?string
    {
        if (! is_string($value)) {
            return null;
        }
        $value = trim(preg_replace('/\s+/', ' ', $value) ?? '');

        return $value === '' ? null : Str::limit($value, $max, '');
    }
}
