<?php

namespace App\Services\LandCover;

/**
 * ESA WorldCover 10 m v200 (2021) land cover classes.
 */
final class WorldCoverClasses
{
    public const ATTRIBUTION = 'ESA WorldCover 2021 v200, © ESA, CC-BY 4.0';

    public const NO_DATA = 0;

    public const TREE = 10;

    public const SHRUB = 20;

    public const GRASS = 30;

    public const CROP = 40;

    public const BUILT = 50;

    public const BARE = 60;

    public const SNOW = 70;

    public const WATER = 80;

    public const WETLAND = 90;

    public const MANGROVE = 95;

    public const MOSS = 100;

    /** Every value a class grid can hold (0 = no data). */
    public const CODES = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100];

    public const LABELS = [
        0 => 'No data',
        10 => 'Tree cover',
        20 => 'Shrubland',
        30 => 'Grassland',
        40 => 'Cropland',
        50 => 'Built-up',
        60 => 'Bare / sparse vegetation',
        70 => 'Snow and ice',
        80 => 'Permanent water',
        90 => 'Herbaceous wetland',
        95 => 'Mangroves',
        100 => 'Moss and lichen',
    ];

    /** Short lower-case names used in terrain messages. */
    public const SHORT = [
        0 => 'no data',
        10 => 'forest',
        20 => 'shrubland',
        30 => 'grassland',
        40 => 'cropland',
        50 => 'built-up',
        60 => 'bare ground',
        70 => 'snow/ice',
        80 => 'water',
        90 => 'wetland',
        95 => 'mangroves',
        100 => 'moss/lichen',
    ];

    /** Official WorldCover legend colours. */
    public const COLORS = [
        0 => '#000000',
        10 => '#006400',
        20 => '#ffbb22',
        30 => '#ffff4c',
        40 => '#f096ff',
        50 => '#fa0000',
        60 => '#b4b4b4',
        70 => '#f0f0f0',
        80 => '#0064c8',
        90 => '#0096a0',
        95 => '#00cf75',
        100 => '#fae6a0',
    ];

    /**
     * @return list<array{code: int, label: string, color: string}>
     */
    public static function legend(): array
    {
        return array_map(fn (int $code) => [
            'code' => $code,
            'label' => self::LABELS[$code],
            'color' => self::COLORS[$code],
        ], self::CODES);
    }
}
