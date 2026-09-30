<?php

namespace App\Mcp\Assets;

use App\Models\PropModel;

/**
 * Rendering budget of one prop model. Props draw every mesh of every placed instance in each pass
 * (view, shadow cascades, water reflection) with the full model, so heavy models placed many times
 * are the quickest way to slow the game down. Vegetation belongs in foliage types instead: those get
 * LODs, impostors and GPU culling.
 */
class PropBudget
{
    /** Triangles per instance above which a prop counts as heavy. */
    public const TRIANGLES = 20000;

    /** Materials per instance (each one at least a draw call per pass). */
    public const MATERIALS = 8;

    /** Mesh primitives per instance (each one a draw call per pass). */
    public const MESHES = 16;

    /** Triangles of all placements of one model above which placing more is worth a warning. */
    public const PLACED_TRIANGLES = 2000000;

    /**
     * Plain-language warnings for a model over budget (empty when within it or not measured).
     *
     * @return list<string>
     */
    public static function warnings(PropModel $model): array
    {
        $warnings = [];
        $name = $model->name;

        if ($model->triangles !== null && $model->triangles > self::TRIANGLES) {
            $warnings[] = sprintf(
                'Prop "%s" has %s triangles (budget %s per prop). Every placed copy draws all of them in the view, the shadows and water reflections: use a lighter model (decimate it in Blender, e.g. a Decimate modifier to about %s triangles, then import_model again) or place it only a few times.',
                $name, number_format($model->triangles), number_format(self::TRIANGLES), number_format(self::TRIANGLES / 2),
            );
        }
        if ($model->materials !== null && $model->materials > self::MATERIALS) {
            $warnings[] = sprintf(
                'Prop "%s" uses %d materials (budget %d): each is a separate draw call per copy and pass. Merge materials / bake textures into one atlas in Blender.',
                $name, $model->materials, self::MATERIALS,
            );
        } elseif ($model->meshes !== null && $model->meshes > self::MESHES) {
            $warnings[] = sprintf(
                'Prop "%s" consists of %d mesh parts (budget %d): each is a separate draw call per copy and pass. Join the parts in Blender (Ctrl+J) before exporting.',
                $name, $model->meshes, self::MESHES,
            );
        }
        if ($warnings !== [] && self::looksLikeVegetation($model)) {
            $warnings[] = 'It looks like vegetation: import trees, bushes and plants as foliage instead (import_model kind "foliage" with create_type, or generate_model kind "foliage"); foliage gets LODs, impostors and GPU culling and can grow as ground cover.';
        }

        return $warnings;
    }

    /**
     * Warning for placing `$count` more copies of a model (null when that stays reasonable).
     */
    public static function placementWarning(PropModel $model, int $count, int $existing = 0): ?string
    {
        if ($model->triangles === null) {
            return null;
        }

        $total = $model->triangles * ($count + $existing);
        $vegetation = self::looksLikeVegetation($model);

        if ($total <= self::PLACED_TRIANGLES && ! ($vegetation && $count + $existing > 50)) {
            return null;
        }

        return sprintf(
            '%s copies of prop "%s" (%s triangles each) draw %s triangles per pass (view, shadows and reflection each draw them again). %s Check the cost with profile_performance.',
            number_format($count + $existing), $model->name, number_format($model->triangles), number_format($total),
            $vegetation
                ? 'Trees and plants in numbers belong in foliage types (LODs, impostors, GPU culling): import the model as foliage, or use a biome\'s ground cover.'
                : 'Use a lighter model, or fewer copies.',
        );
    }

    public static function looksLikeVegetation(PropModel $model): bool
    {
        $text = mb_strtolower($model->name.' '.implode(' ', $model->tags ?? []));

        return preg_match('/\b(tree|trees|pine|fir|spruce|oak|birch|maple|palm|conifer|bush|bushes|shrub|hedge|fern|grass|flower|plant|foliage|sapling|willow|cypress|cedar|beech|poplar)\b/u', $text) === 1;
    }
}
