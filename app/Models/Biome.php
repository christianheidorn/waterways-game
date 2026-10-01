<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;

/**
 * A reusable terrain layer: its look (material or procedural colours) plus the foliage that grows
 * on it (ground cover). Applying a biome to a layer slot turns painting that layer into painting
 * the whole biome: ground, grass, flowers, bushes, rocks and trees.
 *
 * @property int $id
 * @property string $name
 * @property string|null $description
 * @property string|null $starter_key
 * @property array<string, mixed> $look
 * @property list<array<string, mixed>> $ground_cover
 */
#[Fillable(['name', 'description', 'starter_key', 'look', 'ground_cover'])]
class Biome extends Model
{
    /** Terrain layer fields a biome carries (height / slope auto-paint rules stay with the map). */
    public const LOOK = [
        'material_id', 'color', 'color_secondary', 'roughness', 'noise_scale', 'variation', 'bump',
        'texture_scale', 'tint', 'roughness_scale', 'normal_strength', 'macro_variation',
    ];

    protected function casts(): array
    {
        return [
            'look' => 'array',
            'ground_cover' => 'array',
        ];
    }

    /** Captures a terrain layer's look and ground cover. */
    public static function attributesFromLayer(TerrainLayer $layer): array
    {
        return [
            'look' => $layer->only(self::LOOK),
            'ground_cover' => $layer->groundCover(),
        ];
    }

    /** Applies this biome to a terrain layer (keeps its slot and auto-paint rules). */
    public function applyTo(TerrainLayer $layer): void
    {
        $look = array_intersect_key($this->look ?? [], array_flip(self::LOOK));

        // A material deleted from the library since: fall back to the procedural colours.
        if (isset($look['material_id']) && ! Material::query()->whereKey($look['material_id'])->exists()) {
            $look['material_id'] = null;
        }

        $types = FoliageType::query()->pluck('id')->all();
        $cover = array_values(array_filter(
            $this->groundCover(),
            fn (array $entry) => in_array($entry['foliage_type_id'], $types, true),
        ));

        $layer->update([...$look, 'name' => mb_substr($this->name, 0, 60), 'ground_cover' => $cover]);
    }

    /** @return list<array{foliage_type_id: int, density: float, clustering: float, spacing: float}> */
    public function groundCover(): array
    {
        return (new TerrainLayer(['ground_cover' => $this->ground_cover]))->groundCover();
    }

    /**
     * @return array<string, mixed>
     */
    public function toStudioArray(): array
    {
        $look = $this->look ?? [];
        $material = isset($look['material_id']) ? Material::query()->find($look['material_id']) : null;
        $names = FoliageType::query()->pluck('name', 'id');

        return [
            'id' => $this->id,
            'name' => $this->name,
            'description' => $this->description,
            'starter' => $this->starter_key !== null,
            'color' => $look['color'] ?? '#6d7f35',
            'color_secondary' => $look['color_secondary'] ?? '#8e9443',
            'material' => $material ? ['id' => $material->id, 'name' => $material->name, 'thumbnail_url' => $material->toGameArray()['thumbnail_url'] ?? null] : null,
            'ground_cover' => array_map(fn (array $entry) => [
                ...$entry,
                'name' => $names[$entry['foliage_type_id']] ?? null,
            ], $this->groundCover()),
        ];
    }
}
