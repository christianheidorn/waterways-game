<?php

namespace App\Enums;

enum FoliageKind: string
{
    case Conifer = 'conifer';
    case Broadleaf = 'broadleaf';
    case Palm = 'palm';
    case Bush = 'bush';
    case Grass = 'grass';
    case Flower = 'flower';
    case Reed = 'reed';
    case Rock = 'rock';

    public function label(): string
    {
        return ucfirst($this->value);
    }
}
