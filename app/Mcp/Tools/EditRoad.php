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

#[Name('edit_road')]
#[Description(<<<'MD'
Roads, paths and tracks as editable splines, like the editor's Roads tool (live in the open editor, one undo step each; saved unless save is false).
- list: the map's roads as saved (id, name, profile, width, layer, length, control points); needs no editor.
- create: a road through `points` (2+ control points in world metres, a smooth curve runs through them). It grades an even road bed (the grade evened out over `smoothing` m) with soft banks (`shoulder` m each side) into the terrain, leans into curves (`bank` 0-1), paints `layer` along it with soft edges (slot or name; null = no paint; default: a layer named like road / gravel / dirt) and clears placed foliage along it (clear_foliage, default true). `profile` sets the look and defaults: path (2.5 m, follows the ground), road (8 m, crowned, even grade), track (4.5 m, wheel ruts).
- update: change any of these for road `id` (e.g. move `points`, width, layer); the road is re-carved: its old height change is taken out first (sculpting done since stays), the paint it replaced comes back.
- delete: removes road `id` and takes its terrain change and paint out again (cleared foliage does not come back).
Painting a layer without ground cover along the road also keeps grass off it.
MD)]
class EditRoad extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        $point = fn () => $schema->object(['x' => $schema->number()->required(), 'z' => $schema->number()->required()]);

        return [
            'map' => $this->mapArgument($schema),
            'action' => $schema->string()->enum(['list', 'create', 'update', 'delete'])->required(),
            'id' => $schema->string()->description('update / delete: the road id (see list).'),
            'points' => $schema->array()->items($point())->description('create / update: control points of the course (2-200), in order.'),
            'profile' => $schema->string()->enum(['path', 'road', 'track'])->description('create / update: surface profile (default road).'),
            'width' => $schema->number()->min(0.5)->max(60)->description('Road bed width in m.'),
            'shoulder' => $schema->number()->min(0.5)->max(80)->description('Soft banks blending into the terrain on each side, m.'),
            'bank' => $schema->number()->min(0)->max(1)->description('How much the bed leans into curves (0-1).'),
            'smoothing' => $schema->number()->min(0)->max(500)->description('Length (m) over which the grade is evened out; 0 follows the ground.'),
            'layer' => $schema->string()->description('Terrain layer painted along the road: slot (0-7) or name; "none" for no paint.'),
            'clear_foliage' => $schema->boolean()->description('Remove placed foliage along the road (default true).'),
            'name' => $schema->string()->description('Display name.'),
            'save' => $schema->boolean()->description('Save the map after the edit (default true).'),
        ];
    }

    protected function run(Request $request): Response
    {
        $input = $request->all();
        $data = Validator::make($input, [
            'action' => ['required', 'in:list,create,update,delete'],
            'id' => ['required_if:action,update,delete', 'string'],
            'points' => ['required_if:action,create', 'array', 'min:2', 'max:200'],
            'points.*.x' => ['required', 'numeric'],
            'points.*.z' => ['required', 'numeric'],
            'profile' => ['sometimes', 'in:path,road,track'],
            'width' => ['sometimes', 'numeric', 'between:0.5,60'],
            'shoulder' => ['sometimes', 'numeric', 'between:0.5,80'],
            'bank' => ['sometimes', 'numeric', 'between:0,1'],
            'smoothing' => ['sometimes', 'numeric', 'between:0,500'],
            'layer' => ['sometimes', 'nullable'],
            'clear_foliage' => ['sometimes', 'boolean'],
            'name' => ['sometimes', 'string', 'max:80'],
        ])->validate();
        $map = $this->map($request);

        if ($data['action'] === 'list') {
            return $this->json(['map' => $map->slug, ...self::listSplines($map, 'roads')]);
        }

        $road = [];

        foreach (['profile', 'name'] as $key) {
            if (isset($data[$key])) {
                $road[$key] = $data[$key];
            }
        }

        foreach (['width', 'shoulder', 'bank', 'smoothing'] as $key) {
            if (isset($data[$key])) {
                $road[$key] = (float) $data[$key];
            }
        }

        if (isset($data['clear_foliage'])) {
            $road['clear_foliage'] = (bool) $data['clear_foliage'];
        }

        if (isset($data['points'])) {
            $road['points'] = array_map(fn (array $p) => ['x' => (float) $p['x'], 'z' => (float) $p['z']], $data['points']);
        }

        if (array_key_exists('layer', $input)) {
            $road['layer'] = $this->layerSlot($map, $input['layer']);
        }

        if ($data['action'] === 'update' && $road === []) {
            throw new ToolError('Nothing to change: give points, profile, width, shoulder, bank, smoothing, layer, clear_foliage or name.');
        }

        return $this->worldEdit($map, $request, "edit_road {$data['action']}", array_filter([
            'kind' => 'road',
            'action' => $data['action'],
            'id' => $data['id'] ?? null,
            'road' => $road === [] ? null : $road,
        ], fn ($v) => $v !== null));
    }

    private function layerSlot(Map $map, mixed $ref): ?int
    {
        if ($ref === null || $ref === '' || (is_string($ref) && strtolower($ref) === 'none')) {
            return null;
        }

        $layer = is_numeric($ref)
            ? $map->layers()->where('slot', (int) $ref)->first()
            : $map->layers()->whereRaw('lower(name) = ?', [mb_strtolower((string) $ref)])->first();

        return $layer?->slot ?? throw new ToolError("No layer \"{$ref}\" on this map. get_map lists the layer slots and names.");
    }

    /**
     * The saved roads or rivers of a map, without their footprints.
     *
     * @return array<string, mixed>
     */
    public static function listSplines(Map $map, string $kind): array
    {
        $file = json_decode((string) app(TerrainStorage::class)->read($map, 'splines'), true);
        $items = is_array($file) && is_array($file[$kind] ?? null) ? $file[$kind] : [];

        return [
            'count' => count($items),
            $kind => array_map(function (array $s) {
                unset($s['footprint']);
                $s['length_m'] = (int) round(self::length($s['points'] ?? []));

                return $s;
            }, $items),
            'note' => 'As saved; unsaved changes in the open editor are not listed.',
        ];
    }

    /** @param  array<int, array{x: float|int, z: float|int}>  $points */
    private static function length(array $points): float
    {
        $sum = 0.0;

        for ($k = 1; $k < count($points); $k++) {
            $sum += hypot($points[$k]['x'] - $points[$k - 1]['x'], $points[$k]['z'] - $points[$k - 1]['z']);
        }

        return $sum;
    }
}
