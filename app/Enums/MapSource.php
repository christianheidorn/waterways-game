<?php

namespace App\Enums;

enum MapSource: string
{
    case Flat = 'flat';
    case Procedural = 'procedural';
    case RealWorld = 'real_world';

    public function label(): string
    {
        return match ($this) {
            self::Flat => 'Flat',
            self::Procedural => 'Procedural',
            self::RealWorld => 'Real world',
        };
    }
}
