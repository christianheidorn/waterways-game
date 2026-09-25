<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;

/**
 * @property int $id
 * @property string $group
 * @property array<string, mixed> $values
 */
#[Fillable(['group', 'values'])]
class GameSetting extends Model
{
    protected function casts(): array
    {
        return ['values' => 'array'];
    }
}
