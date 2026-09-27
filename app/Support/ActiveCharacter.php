<?php

namespace App\Support;

use App\Models\Character;
use App\Models\GameSetting;

/**
 * Which library character is the player (game_settings row "character", outside the schema-driven groups).
 */
final class ActiveCharacter
{
    public const GROUP = 'character';

    public function id(): ?int
    {
        $values = GameSetting::query()->where('group', self::GROUP)->value('values');
        $id = is_array($values) ? ($values['character_id'] ?? null) : null;

        return is_numeric($id) ? (int) $id : null;
    }

    public function get(): ?Character
    {
        $id = $this->id();
        $character = $id !== null ? Character::query()->find($id) : null;

        return $character?->isReady() ? $character : null;
    }

    public function set(?Character $character): void
    {
        GameSetting::query()->updateOrCreate(['group' => self::GROUP], ['values' => ['character_id' => $character?->id]]);
    }
}
