<?php

namespace App\Support;

use App\Models\GameSetting;
use InvalidArgumentException;

final class GameSettingsRepository
{
    /**
     * Resolved values for every group.
     *
     * @return array<string, array<string, mixed>>
     */
    public function all(): array
    {
        $stored = GameSetting::query()->pluck('values', 'group');
        $values = [];

        foreach (GameSettingsSchema::groups() as $key => $group) {
            /** @var array<string, mixed> $groupValues */
            $groupValues = $stored[$key] ?? [];
            $values[$key] = $group->merge($groupValues);
        }

        return $values;
    }

    /**
     * @return array<string, mixed>
     */
    public function get(string $groupKey): array
    {
        return $this->all()[$groupKey] ?? throw new InvalidArgumentException("Unknown settings group [{$groupKey}].");
    }

    /**
     * @param  array<string, mixed>  $values
     * @return array<string, mixed>
     */
    public function update(string $groupKey, array $values): array
    {
        $group = GameSettingsSchema::group($groupKey)
            ?? throw new InvalidArgumentException("Unknown settings group [{$groupKey}].");

        $merged = $group->merge([...$this->get($groupKey), ...$values]);

        GameSetting::query()->updateOrCreate(['group' => $groupKey], ['values' => $merged]);

        return $merged;
    }

    public function reset(string $groupKey): void
    {
        GameSetting::query()->where('group', $groupKey)->delete();
    }
}
