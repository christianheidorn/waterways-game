<?php

namespace App\Services\Materials;

use App\Models\Map;
use App\Models\Material;
use App\Models\TerrainLayer;
use App\Services\Materials\Sources\PolyHavenSource;
use Closure;
use Illuminate\Support\Collection;
use Throwable;

/**
 * The curated CC0 starter library (Poly Haven) and its assignment to the default terrain layers.
 */
class StarterMaterials
{
    /**
     * Poly Haven asset id → category (+ the default layer it is preferred for).
     *
     * @var array<string, array{category: string, layer?: string}>
     */
    public const SET = [
        'leafy_grass' => ['category' => 'grass', 'layer' => 'Grass'],
        'sparse_grass' => ['category' => 'grass', 'layer' => 'Meadow'],
        'forrest_ground_01' => ['category' => 'forest', 'layer' => 'Forest floor'],
        'forest_leaves_02' => ['category' => 'forest'],
        'rock_face_03' => ['category' => 'rock', 'layer' => 'Rock'],
        'sand_01' => ['category' => 'sand', 'layer' => 'Sand'],
        'brown_mud_02' => ['category' => 'mud', 'layer' => 'Mud'],
        'rocky_trail' => ['category' => 'gravel', 'layer' => 'Gravel'],
        'snow_02' => ['category' => 'snow', 'layer' => 'Snow'],
        'brown_mud_dry' => ['category' => 'soil'],
    ];

    /** Default layer name → material category. */
    public const LAYER_CATEGORIES = [
        'Grass' => 'grass', 'Meadow' => 'grass', 'Forest floor' => 'forest', 'Rock' => 'rock',
        'Sand' => 'sand', 'Mud' => 'mud', 'Gravel' => 'gravel', 'Snow' => 'snow',
    ];

    public function __construct(
        private readonly PolyHavenSource $polyHaven,
        private readonly MaterialLibrary $library,
    ) {}

    /**
     * Import every starter texture that is not in the library yet (synchronously).
     *
     * @param  (Closure(string, string): void)|null  $log  receives (level, message)
     * @return array{imported: list<string>, skipped: list<string>, failed: array<string, string>}
     */
    public function import(string $resolution = '1k', ?Closure $log = null): array
    {
        $log ??= fn () => null;
        $result = ['imported' => [], 'skipped' => [], 'failed' => []];

        try {
            $available = $this->polyHaven->assets();
        } catch (Throwable $e) {
            $log('warn', 'Poly Haven is unreachable: '.$e->getMessage());
            $result['failed']['*'] = $e->getMessage();

            return $result;
        }

        foreach (self::SET as $ref => $meta) {
            if (Material::query()->where('source', 'polyhaven')->where('source_ref', $ref)->where('status', 'ready')->exists()) {
                $result['skipped'][] = $ref;

                continue;
            }

            if (! array_key_exists($ref, $available)) {
                $log('warn', "Poly Haven no longer lists \"{$ref}\" — skipped.");
                $result['failed'][$ref] = 'not found';

                continue;
            }

            // Replace a previous failed / half-finished attempt.
            Material::query()->where('source', 'polyhaven')->where('source_ref', $ref)->get()->each->delete();

            $material = $this->library->create([
                'name' => (string) ($available[$ref]['name'] ?? $ref),
                'category' => $meta['category'],
                'source' => 'polyhaven',
                'source_ref' => $ref,
                'status' => 'processing',
            ]);

            try {
                $this->polyHaven->import($material, $ref, $resolution, ['category' => $meta['category']]);
                $result['imported'][] = $ref;
                $log('info', "Imported {$material->name} ({$ref}).");
            } catch (Throwable $e) {
                $material->delete();
                $result['failed'][$ref] = $e->getMessage();
                $log('warn', "Failed to import {$ref}: ".$e->getMessage());
            }
        }

        return $result;
    }

    /**
     * The best ready material for a default layer name: the curated one, else any of its category
     * (Meadow prefers a different grass than Grass).
     */
    public static function materialForLayer(string $layerName): ?Material
    {
        $category = self::LAYER_CATEGORIES[$layerName] ?? null;
        if ($category === null) {
            return null;
        }

        $preferred = collect(self::SET)->filter(fn ($meta) => ($meta['layer'] ?? null) === $layerName)->keys()->first();

        /** @var Collection<int, Material> $candidates */
        $candidates = Material::query()
            ->where('status', 'ready')
            ->whereNotNull('albedo_path')
            ->where('category', $category)
            ->orderBy('id')
            ->get();

        if ($candidates->isEmpty()) {
            return null;
        }

        if ($preferred !== null && ($match = $candidates->first(fn (Material $m) => $m->source === 'polyhaven' && $m->source_ref === $preferred))) {
            return $match;
        }

        // Meadow: take the second grass so it differs from the Grass layer.
        if ($layerName === 'Meadow' && $candidates->count() > 1) {
            return $candidates->get(1);
        }

        return $candidates->first();
    }

    /**
     * Give every default-named layer without a material its starter material. Returns the number of layers updated.
     */
    public function assignToMap(Map $map): int
    {
        $count = 0;

        /** @var TerrainLayer $layer */
        foreach ($map->layers()->whereNull('material_id')->get() as $layer) {
            $material = self::materialForLayer($layer->name);
            if ($material !== null) {
                $layer->update(['material_id' => $material->id, 'texture_scale' => $material->tile_size]);
                $count++;
            }
        }

        return $count;
    }

    public function assignToAllMaps(): int
    {
        return Map::query()->get()->sum(fn (Map $map) => $this->assignToMap($map));
    }
}
