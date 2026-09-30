<?php

namespace App\Mcp\Tools;

use App\Models\Biome;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;

#[Name('save_layer_as_biome')]
#[Description('Stores a terrain layer\'s look and ground cover as a new biome in the library, reusable on any map.')]
class SaveLayerAsBiome extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        return [
            'map' => $this->mapArgument($schema),
            'slot' => $schema->integer()->min(0)->max(7)->required(),
            'name' => $schema->string()->required(),
            'description' => $schema->string(),
        ];
    }

    protected function run(Request $request): Response
    {
        $data = $request->validate([
            'slot' => ['required', 'integer'],
            'name' => ['required', 'string', 'max:60'],
            'description' => ['nullable', 'string', 'max:200'],
        ]);
        $layer = $this->map($request)->layers()->where('slot', $data['slot'])->first();

        if ($layer === null) {
            return Response::error("No layer in slot {$data['slot']}.");
        }

        $biome = Biome::query()->create([
            'name' => $data['name'],
            'description' => $data['description'] ?? null,
            ...Biome::attributesFromLayer($layer),
        ]);

        return $this->json($biome->toStudioArray());
    }
}
