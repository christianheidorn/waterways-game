<?php

namespace App\Services\LandCover;

/**
 * Resolves which terrain layer slot each WorldCover class is painted with, by matching layer
 * names / material categories to material "roles" (falling back to the default layer slots).
 */
final class LandCoverMapping
{
    /** Keywords (layer name, material name or category) per role, strongest first. */
    public const ROLE_KEYWORDS = [
        'grass' => ['grass', 'lawn', 'turf'],
        'meadow' => ['meadow', 'shrub', 'heath', 'scrub', 'steppe', 'prairie'],
        'forest' => ['forest', 'woodland', 'leaf', 'litter', 'needle'],
        'rock' => ['rock', 'cliff', 'granite', 'limestone', 'boulder', 'stone'],
        'sand' => ['sand', 'beach', 'dune'],
        'mud' => ['mud', 'swamp', 'marsh', 'bog', 'wet', 'clay'],
        'gravel' => ['gravel', 'pebble', 'scree'],
        'snow' => ['snow', 'ice', 'glacier'],
        'field' => ['field', 'crop', 'farm', 'plough', 'plow', 'soil', 'dirt'],
        'urban' => ['urban', 'asphalt', 'concrete', 'pave', 'road', 'cobble', 'tarmac'],
    ];

    /** Slot of each role in DefaultTerrainLayers (roles without one need a matching layer). */
    public const DEFAULT_SLOTS = [
        'grass' => 0, 'meadow' => 1, 'forest' => 2, 'rock' => 3, 'sand' => 4, 'mud' => 5, 'gravel' => 6, 'snow' => 7,
    ];

    /** Preferred roles per WorldCover class; the first role available on the map wins. */
    public const CLASS_ROLES = [
        0 => ['grass'],
        10 => ['forest'],
        20 => ['meadow', 'grass'],
        30 => ['grass'],
        40 => ['field', 'meadow', 'grass'],
        50 => ['urban', 'gravel'],
        60 => ['rock', 'gravel'],
        70 => ['snow'],
        80 => ['mud', 'sand'],
        90 => ['mud'],
        95 => ['mud'],
        100 => ['meadow', 'grass'],
    ];

    /**
     * Slot per role for a map's layers.
     *
     * @param  array<int, string>  $slots  slot → searchable text (layer name, material name / category)
     * @return array<string, int>
     */
    public static function roles(array $slots): array
    {
        $texts = array_map(fn (string $text) => mb_strtolower($text), $slots);
        ksort($texts);
        $roles = [];

        foreach (self::ROLE_KEYWORDS as $role => $keywords) {
            $default = self::DEFAULT_SLOTS[$role] ?? null;
            $match = null;

            // The default slot wins when its name fits the role.
            if ($default !== null && isset($texts[$default]) && self::matches($texts[$default], $keywords)) {
                $match = $default;
            }

            foreach ($keywords as $keyword) {
                if ($match !== null) {
                    break;
                }
                foreach ($texts as $slot => $text) {
                    if (str_contains($text, $keyword)) {
                        $match = $slot;
                        break;
                    }
                }
            }

            // Otherwise the default slot, unless its layer is clearly something else.
            if ($match === null && $default !== null && isset($texts[$default]) && ! self::matchesAnyRole($texts[$default])) {
                $match = $default;
            }

            if ($match !== null) {
                $roles[$role] = $match;
            }
        }

        return $roles;
    }

    /**
     * Default class → slot mapping for a map's layers.
     *
     * @param  array<int, string>  $slots
     * @return array<int, int>
     */
    public static function defaults(array $slots): array
    {
        $roles = self::roles($slots);
        $fallback = $roles['grass'] ?? (array_key_first($slots) ?? 0);
        $mapping = [];

        foreach (self::CLASS_ROLES as $class => $preferred) {
            $mapping[$class] = $fallback;
            foreach ($preferred as $role) {
                if (isset($roles[$role])) {
                    $mapping[$class] = $roles[$role];
                    break;
                }
            }
        }

        return $mapping;
    }

    /**
     * Defaults overridden by the (valid) entries of a user mapping.
     *
     * @param  array<int, string>  $slots
     * @param  array<int|string, int|null>|null  $user
     * @return array<int, int>
     */
    public static function resolve(array $slots, ?array $user): array
    {
        $mapping = self::defaults($slots);

        foreach ($user ?? [] as $class => $slot) {
            if (isset($mapping[(int) $class]) && $slot !== null && isset($slots[(int) $slot])) {
                $mapping[(int) $class] = (int) $slot;
            }
        }

        return $mapping;
    }

    private static function matchesAnyRole(string $text): bool
    {
        foreach (self::ROLE_KEYWORDS as $keywords) {
            if (self::matches($text, $keywords)) {
                return true;
            }
        }

        return false;
    }

    /**
     * @param  list<string>  $keywords
     */
    private static function matches(string $text, array $keywords): bool
    {
        foreach ($keywords as $keyword) {
            if (str_contains($text, $keyword)) {
                return true;
            }
        }

        return false;
    }
}
