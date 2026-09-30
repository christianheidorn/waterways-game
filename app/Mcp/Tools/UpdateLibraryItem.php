<?php

namespace App\Mcp\Tools;

use App\Enums\FoliageKind;
use App\Mcp\ToolError;
use App\Models\FoliageAsset;
use App\Models\FoliageType;
use App\Models\Material;
use App\Services\Foliage\FoliageTypeDefaults;
use App\Services\Materials\MaterialLibrary;
use App\Services\Materials\MaterialStorage;
use App\Support\StarterBiomes;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\Validator;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;

#[Name('update_library_item')]
#[Description(<<<'TXT'
Edits items of the studio libraries, as the Materials and Foliage pages do (foliage types: save_foliage_type; maps: update_map; characters: manage_character; deleting: delete_library_item).
- kind "material" (id): action "update" sets `values` name, category, tile_size (m), tint (#rrggbb), roughness_scale, normal_strength, height_contrast (0-3), tags; "duplicate" copies it (e.g. to try variations).
- kind "foliage_asset" (id): "update" sets `values` name, kind, style, target_height (m), license, author (a new size or kind re-optimises the model: bake_foliage_asset); "rebake" queues it for optimising again; "create_type" makes a foliage type that uses it.
- kind "biome": "install_starters" adds the starter biomes that are missing from the library.
Live editors pick up the changes.
TXT)]
class UpdateLibraryItem extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        return [
            'kind' => $schema->string()->enum(['material', 'foliage_asset', 'biome'])->required(),
            'action' => $schema->string()->enum(['update', 'duplicate', 'rebake', 'create_type', 'install_starters'])->required(),
            'id' => $schema->integer(),
            'values' => $schema->object()->description('update: field → new value.'),
        ];
    }

    protected function run(Request $request): Response
    {
        $data = $request->validate([
            'kind' => ['required', 'in:material,foliage_asset,biome'],
            'action' => ['required', 'in:update,duplicate,rebake,create_type,install_starters'],
            'id' => ['sometimes', 'integer'],
            'values' => ['sometimes', 'array'],
        ]);
        $allowed = [
            'material' => ['update', 'duplicate'],
            'foliage_asset' => ['update', 'rebake', 'create_type'],
            'biome' => ['install_starters'],
        ][$data['kind']];

        if (! in_array($data['action'], $allowed, true)) {
            throw new ToolError("Action \"{$data['action']}\" does not apply to kind \"{$data['kind']}\" (use ".implode(', ', $allowed).').');
        }

        if ($data['kind'] === 'biome') {
            $count = StarterBiomes::install();
            $this->bridge()->notifyAll('refresh', ['parts' => ['layers']]);

            return $this->json(['installed' => $count, 'message' => $count > 0 ? "Added {$count} starter biomes." : 'All starter biomes are already in the library.']);
        }

        $id = $data['id'] ?? throw new ToolError('Give the item\'s `id`.');
        $values = (array) ($data['values'] ?? []);

        return $data['kind'] === 'material'
            ? $this->material(Material::query()->find($id) ?? throw new ToolError("No material {$id}. See list_materials."), $data['action'], $values)
            : $this->foliageAsset(FoliageAsset::query()->find($id) ?? throw new ToolError("No foliage asset {$id}."), $data['action'], $values);
    }

    /**
     * @param  array<string, mixed>  $values
     */
    private function material(Material $material, string $action, array $values): Response
    {
        if ($action === 'duplicate') {
            $copy = app(MaterialLibrary::class)->duplicate($material, app(MaterialStorage::class));

            return $this->json(['duplicated' => $copy->only('id', 'name')]);
        }

        $rules = [
            'name' => ['sometimes', 'required', 'string', 'max:120'],
            'category' => ['sometimes', 'required', Rule::in(array_keys(Material::CATEGORIES))],
            'tile_size' => ['sometimes', 'required', 'numeric', 'between:0.1,100'],
            'tint' => ['sometimes', 'required', 'string', 'regex:/^#[0-9a-fA-F]{6}$/'],
            'roughness_scale' => ['sometimes', 'required', 'numeric', 'between:0,3'],
            'normal_strength' => ['sometimes', 'required', 'numeric', 'between:0,3'],
            'height_contrast' => ['sometimes', 'required', 'numeric', 'between:0,3'],
            'tags' => ['sometimes', 'nullable', 'array', 'max:30'],
            'tags.*' => ['nullable', 'string', 'max:40'],
        ];
        $clean = $this->validValues($values, $rules);

        if (array_key_exists('tags', $clean)) {
            $clean['tags'] = array_values(array_unique(array_filter(array_map(fn ($t) => trim((string) $t), $clean['tags'] ?? []))));
        }

        $material->update($clean);
        $this->bridge()->notifyAll('refresh', ['parts' => ['layers']]);

        return $this->json(['updated' => $material->only('id', 'name', ...array_keys($clean))]);
    }

    /**
     * @param  array<string, mixed>  $values
     */
    private function foliageAsset(FoliageAsset $asset, string $action, array $values): Response
    {
        if ($action === 'create_type') {
            $type = FoliageType::query()->create([
                ...app(FoliageTypeDefaults::class)->forKind($asset->kind),
                'name' => Str::limit($asset->name, 60, ''),
                'foliage_asset_id' => $asset->id,
            ]);
            $this->bridge()->notifyAll('refresh', ['parts' => ['foliage_types']]);

            return $this->json(['foliage_type' => $type->only('id', 'name'), 'tip' => 'Tune it with save_foliage_type; place it with edit_foliage or as ground cover.']);
        }

        if ($action === 'rebake') {
            if (! $asset->canBake()) {
                throw new ToolError('This asset has no source model to optimise again.');
            }

            $asset->forceFill(['status' => 'awaiting_bake', 'status_message' => 'Waiting to be optimised in the studio.'])->save();

            return $this->json(['id' => $asset->id, 'status' => $asset->status, 'tip' => 'Run bake_foliage_asset to optimise it in the open editor.']);
        }

        $clean = $this->validValues($values, [
            'name' => ['sometimes', 'required', 'string', 'max:80'],
            'kind' => ['sometimes', 'required', Rule::enum(FoliageKind::class)],
            'style' => ['sometimes', 'required', Rule::in(array_keys(FoliageAsset::STYLES))],
            'target_height' => ['sometimes', 'nullable', 'numeric', 'between:0.02,150'],
            'license' => ['sometimes', 'nullable', 'string', 'max:120'],
            'author' => ['sometimes', 'nullable', 'string', 'max:120'],
        ]);
        $heightChanged = array_key_exists('target_height', $clean) && ($clean['target_height'] !== null
            ? abs((float) $clean['target_height'] - (float) ($asset->meta['height'] ?? 0)) > 0.005
            : $asset->target_height !== null);
        $kindChanged = isset($clean['kind']) && $asset->kind->value !== $clean['kind'];
        $asset->fill($clean);

        if (($heightChanged || $kindChanged) && $asset->canBake() && in_array($asset->status, ['ready', 'failed'], true)) {
            $asset->forceFill(['status' => 'awaiting_bake', 'status_message' => 'Re-optimising with the new settings…']);
        }

        $asset->save();
        $this->bridge()->notifyAll('refresh', ['parts' => ['foliage_types']]);

        return $this->json([
            'updated' => $asset->only('id', 'name', 'status'),
            ...($asset->status === 'awaiting_bake' ? ['tip' => 'The model needs optimising again: run bake_foliage_asset.'] : []),
        ]);
    }

    /**
     * @param  array<string, mixed>  $values
     * @param  array<string, list<mixed>>  $rules
     * @return array<string, mixed>
     */
    private function validValues(array $values, array $rules): array
    {
        $unknown = array_diff(array_keys($values), array_filter(array_keys($rules), fn ($k) => ! str_contains($k, '.')));

        if ($unknown !== []) {
            throw new ToolError('Unknown fields: '.implode(', ', $unknown).'.');
        }

        if ($values === []) {
            throw new ToolError('Pass the fields to change in `values`.');
        }

        return Validator::make($values, $rules)->validate();
    }
}
