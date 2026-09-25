<?php

namespace App\Enums;

enum TerrainStatus: string
{
    case Ready = 'ready';
    case Queued = 'queued';
    case Importing = 'importing';
    case Failed = 'failed';
}
