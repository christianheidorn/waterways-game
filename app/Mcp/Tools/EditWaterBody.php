<?php

namespace App\Mcp\Tools;

use App\Mcp\ToolError;
use App\Models\Map;
use App\Services\Terrain\TerrainStorage;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\Validator;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;

#[Name('edit_water_body')]
#[Description(<<<'MD'
Water bodies: the connected pieces of the map's water (lake, pond, river, sea, classified automatically), each with its own wave and look settings. They are derived from the water (edit_water) and keep their ids across edits. Same as the editor's Water › Bodies tool.
- list: every body (id, name, kind, area, level, deepest point, centroid, bounds, fetch along the current wind, current wave height and settings). Live from the open editor, else as last saved.
- get: one body by `id`, or the body at `point` {x, z}.
- update: changes body `id` (or the one at `point`): `settings` with any of name, kind (lake/pond/river/sea, null = automatic), wind_exposure (0-2: how much wind reaches it; sheltered 0.3, open 1), fetch (m the wind blows over it; null = from its size along the wind), wave_height (0-4 ×), choppiness (0-2: horizontal sharpness of crests), shallow_color / deep_color ('#rrggbb', null = environment), clarity (0.3-40 m, null = environment), surf (true/false: surf on its shores). Live in the open editor (one step, saved unless save is false).
Wind waves grow with the environment's wind_strength and each body's fetch (fetch-limited JONSWAP spectrum): a 50 m pond only ripples, a 2 km lake builds ~0.2-0.5 m waves in a stiff breeze, the sea more.
MD)]
class EditWaterBody extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        return [
            'map' => $this->mapArgument($schema),
            'action' => $schema->string()->enum(['list', 'get', 'update'])->required(),
            'id' => $schema->string()->description('get / update: the body id (see list), e.g. "wb2".'),
            'point' => $schema->object(['x' => $schema->number()->required(), 'z' => $schema->number()->required()])->description('get / update: a point on the body instead of its id.'),
            'settings' => $schema->object([
                'name' => $schema->string(),
                'kind' => $schema->string()->enum(['lake', 'pond', 'river', 'sea'])->nullable(),
                'wind_exposure' => $schema->number()->min(0)->max(2),
                'fetch' => $schema->number()->min(5)->max(200000)->nullable(),
                'wave_height' => $schema->number()->min(0)->max(4),
                'choppiness' => $schema->number()->min(0)->max(2),
                'shallow_color' => $schema->string()->nullable(),
                'deep_color' => $schema->string()->nullable(),
                'clarity' => $schema->number()->min(0.3)->max(40)->nullable(),
                'surf' => $schema->boolean(),
            ])->description('update: the settings to change (others stay).'),
            'save' => $schema->boolean()->description('update: save the map after the change (default true).'),
        ];
    }

    protected function run(Request $request): Response
    {
        $input = $request->all();
        $data = Validator::make($input, [
            'action' => ['required', 'in:list,get,update'],
            'id' => ['sometimes', 'string', 'max:40'],
            'point' => ['sometimes', 'array'],
            'point.x' => ['required_with:point', 'numeric'],
            'point.z' => ['required_with:point', 'numeric'],
            'settings' => ['required_if:action,update', 'array'],
            'settings.name' => ['sometimes', 'string', 'max:80'],
            'settings.kind' => ['sometimes', 'nullable', 'in:lake,pond,river,sea'],
            'settings.wind_exposure' => ['sometimes', 'numeric', 'between:0,2'],
            'settings.fetch' => ['sometimes', 'nullable', 'numeric', 'between:5,200000'],
            'settings.wave_height' => ['sometimes', 'numeric', 'between:0,4'],
            'settings.choppiness' => ['sometimes', 'numeric', 'between:0,2'],
            'settings.shallow_color' => ['sometimes', 'nullable', 'regex:/^#[0-9a-fA-F]{6}$/'],
            'settings.deep_color' => ['sometimes', 'nullable', 'regex:/^#[0-9a-fA-F]{6}$/'],
            'settings.clarity' => ['sometimes', 'nullable', 'numeric', 'between:0.3,40'],
            'settings.surf' => ['sometimes', 'boolean'],
        ])->validate();
        $action = $data['action'];
        $map = $this->map($request);

        if ($action !== 'list' && ! isset($data['id']) && ! isset($data['point'])) {
            return Response::error('Give the body id (see action "list") or a point {x, z} on it.');
        }

        $target = array_filter([
            'id' => $data['id'] ?? null,
            'point' => isset($data['point']) ? ['x' => (float) $data['point']['x'], 'z' => (float) $data['point']['z']] : null,
        ], fn ($v) => $v !== null);

        if ($action === 'update') {
            $settings = array_intersect_key($input['settings'] ?? [], array_flip([
                'name', 'kind', 'wind_exposure', 'fetch', 'wave_height', 'choppiness', 'shallow_color', 'deep_color', 'clarity', 'surf',
            ]));

            if ($settings === []) {
                return Response::error('Nothing to change: give settings (name, kind, wind_exposure, fetch, wave_height, choppiness, shallow_color, deep_color, clarity, surf).');
            }

            return $this->worldEdit($map, $request, 'edit_water_body update', [
                'kind' => 'water_body',
                'action' => 'update',
                ...$target,
                'params' => $settings,
            ]);
        }

        // Reads: live from an open editor (unsaved edits included), else the saved file.
        if ($this->bridge()->session($map) === null) {
            $saved = self::saved($map);

            if ($saved !== null) {
                return $this->json(['map' => $map->slug, 'source' => 'saved', ...self::pick($saved, $action, $target)]);
            }
        }

        $result = $this->bridge()->run($map, 'world_edit', ['kind' => 'water_body', 'action' => $action, ...$target, 'save' => false]);

        return $this->json(['map' => $map->slug, 'source' => 'editor', ...($result['result'] ?? $result)]);
    }

    /**
     * The saved bodies (water_bodies.json), or null when the map has none saved yet.
     *
     * @return list<array<string, mixed>>|null
     */
    public static function saved(Map $map): ?array
    {
        $file = json_decode((string) app(TerrainStorage::class)->read($map, 'water_bodies'), true);

        return is_array($file) && is_array($file['bodies'] ?? null) ? array_values($file['bodies']) : null;
    }

    /**
     * @param  list<array<string, mixed>>  $bodies
     * @param  array<string, mixed>  $target
     * @return array<string, mixed>
     */
    private static function pick(array $bodies, string $action, array $target): array
    {
        $bodies = array_map(self::describe(...), $bodies);

        if ($action === 'list') {
            return ['count' => count($bodies), 'bodies' => $bodies];
        }

        if (isset($target['id'])) {
            foreach ($bodies as $body) {
                if ($body['id'] === $target['id']) {
                    return ['body' => $body];
                }
            }

            throw new ToolError("There is no water body \"{$target['id']}\". Action \"list\" lists them.");
        }

        // By point: the saved file only knows centroids; the nearest one.
        usort($bodies, fn ($a, $b) => self::distance($a, $target['point']) <=> self::distance($b, $target['point']));

        return $bodies === [] ? throw new ToolError('The map has no water bodies.') : ['body' => $bodies[0], 'note' => 'Nearest saved body (open the editor for an exact lookup).'];
    }

    /**
     * @param  array<string, mixed>  $body
     * @param  array{x: float, z: float}  $point
     */
    private static function distance(array $body, array $point): float
    {
        [$x, $z] = $body['centroid'] ?? [$body['seed']['x'] ?? 0, $body['seed']['z'] ?? 0];

        return hypot($x - $point['x'], $z - $point['z']);
    }

    /**
     * A stored record as agents see it.
     *
     * @param  array<string, mixed>  $record
     * @return array<string, mixed>
     */
    public static function describe(array $record): array
    {
        $settings = array_intersect_key($record, array_flip([
            'name', 'kind', 'wind_exposure', 'fetch', 'wave_height', 'choppiness', 'shallow_color', 'deep_color', 'clarity', 'surf',
        ]));
        $kind = $record['kind'] ?? null ?: ($record['kind_auto'] ?? 'lake');

        return [
            'id' => $record['id'] ?? null,
            'name' => ($record['name'] ?? '') !== '' ? $record['name'] : ucfirst((string) $kind).' '.($record['id'] ?? ''),
            'kind' => $kind,
            'auto_kind' => $record['kind_auto'] ?? null,
            'area_m2' => $record['area'] ?? null,
            'level' => $record['level'] ?? null,
            'centroid' => $record['centroid'] ?? null,
            'seed' => isset($record['seed']) ? ['x' => $record['seed'][0], 'z' => $record['seed'][1]] : null,
            'settings' => $settings,
        ];
    }
}
