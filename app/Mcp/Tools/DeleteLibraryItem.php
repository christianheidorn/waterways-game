<?php

namespace App\Mcp\Tools;

use App\Mcp\ToolError;
use App\Models\AgentRequest;
use App\Models\Biome;
use App\Models\Character;
use App\Models\FoliageAsset;
use App\Models\FoliageType;
use App\Models\Map;
use App\Models\Material;
use App\Support\ActiveCharacter;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\Storage;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;
use Laravel\Mcp\Server\Tools\Annotations\IsDestructive;

#[Name('delete_library_item')]
#[IsDestructive]
#[Description(<<<'TXT'
Deletes an item for good, as the studio's delete buttons do. Cannot be undone: confirm with the user first.
- "foliage_type": placed instances of it stop rendering, layers lose it as ground cover.
- "foliage_asset": foliage types using it fall back to procedural meshes.
- "material": terrain layers using it fall back to procedural colours.
- "biome": only the library entry (layers it was applied to keep their look).
- "character": if it was the player character, the default one is used again.
- "request": a build request (map editor Request tool), with its images. To only close it, use update_request status "dismissed".
- "map": the map with its terrain, layers, props and snapshots (snapshots cannot bring it back). Needs `confirm` = the map's slug and no editor open on it.
TXT)]
class DeleteLibraryItem extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        return [
            'kind' => $schema->string()->enum(['map', 'foliage_type', 'foliage_asset', 'material', 'biome', 'character', 'request'])->required(),
            'id' => $schema->string()->description('The item id (a map: slug or id).')->required(),
            'confirm' => $schema->string()->description('map: the map\'s slug, to confirm.'),
        ];
    }

    protected function run(Request $request): Response
    {
        $data = $request->validate([
            'kind' => ['required', 'in:map,foliage_type,foliage_asset,material,biome,character,request'],
            'id' => ['required'],
            'confirm' => ['sometimes', 'nullable', 'string'],
        ]);
        $id = (string) $data['id'];
        $missing = fn () => throw new ToolError("No {$data['kind']} \"{$id}\".");

        switch ($data['kind']) {
            case 'map':
                $map = Map::query()->where('slug', $id)->first() ?? (is_numeric($id) ? Map::query()->find((int) $id) : null) ?? $missing();

                if (($data['confirm'] ?? null) !== $map->slug) {
                    throw new ToolError("Deleting map \"{$map->name}\" removes its terrain, layers, props and snapshots for good. Ask the user, then pass confirm: \"{$map->slug}\".");
                }

                if ($this->bridge()->session($map) !== null) {
                    throw new ToolError("\"{$map->name}\" is open in an editor. Close it first (close_editor for a hidden one, or ask the user to close the tab).");
                }

                $map->delete();

                if (! Map::query()->where('is_default', true)->exists()) {
                    Map::query()->oldest()->first()?->update(['is_default' => true]);
                }

                return $this->json(['deleted' => 'map', 'name' => $map->name]);
            case 'foliage_type':
                $type = FoliageType::query()->find((int) $id) ?? $missing();

                if ($type->model_path) {
                    Storage::disk('public')->delete($type->model_path);
                }

                $type->delete();
                $this->bridge()->notifyAll('refresh', ['parts' => ['foliage_types', 'layers']]);

                return $this->json(['deleted' => 'foliage_type', 'name' => $type->name, 'note' => 'Placed instances of it no longer render.']);
            case 'foliage_asset':
                $asset = FoliageAsset::query()->find((int) $id) ?? $missing();
                $types = $asset->types()->count();
                $asset->delete();
                $this->bridge()->notifyAll('refresh', ['parts' => ['foliage_types']]);

                return $this->json(['deleted' => 'foliage_asset', 'name' => $asset->name, 'types_fell_back' => $types]);
            case 'material':
                $material = Material::query()->find((int) $id) ?? $missing();
                $layers = $material->layers()->count();
                $material->delete();
                $this->bridge()->notifyAll('refresh', ['parts' => ['layers']]);

                return $this->json(['deleted' => 'material', 'name' => $material->name, 'layers_fell_back' => $layers]);
            case 'biome':
                $biome = Biome::query()->find((int) $id) ?? $missing();
                $biome->delete();

                return $this->json(['deleted' => 'biome', 'name' => $biome->name]);
            case 'character':
                $character = Character::query()->find((int) $id) ?? $missing();
                $active = app(ActiveCharacter::class);
                $wasActive = $active->id() === $character->id;

                if ($wasActive) {
                    $active->set(null);
                }

                $character->delete();

                return $this->json(['deleted' => 'character', 'name' => $character->name, 'was_player_character' => $wasActive]);
            default:
                $agentRequest = AgentRequest::query()->with('map')->find((int) $id) ?? $missing();
                $agentRequest->delete();
                $this->bridge()->notify($agentRequest->map, 'refresh', ['parts' => ['requests']]);

                return $this->json(['deleted' => 'request', 'id' => $agentRequest->id]);
        }
    }
}
