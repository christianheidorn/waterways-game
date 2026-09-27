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
            $values[$key] = $group->merge(self::upgrade($key, $groupValues));
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

        if ($groupKey === 'graphics') {
            // Keep the legacy switch in sync for clients that still read it.
            $merged['antialias'] = $merged['anti_aliasing'] === 'msaa';
        }

        GameSetting::query()->updateOrCreate(['group' => $groupKey], ['values' => $merged]);

        return $merged;
    }

    /**
     * Map values saved by older versions onto newer fields before the defaults fill the gaps.
     *
     * @param  array<string, mixed>  $values
     * @return array<string, mixed>
     */
    private static function upgrade(string $groupKey, array $values): array
    {
        // The graphics group used a boolean MSAA switch before `anti_aliasing` existed: keep the look.
        if ($groupKey === 'graphics' && $values !== [] && ! array_key_exists('anti_aliasing', $values) && array_key_exists('antialias', $values)) {
            $values['anti_aliasing'] = filter_var($values['antialias'], FILTER_VALIDATE_BOOL) ? 'msaa' : 'off';
            $values['quality_preset'] ??= 'custom';
        }

        return $values;
    }

    public function reset(string $groupKey): void
    {
        GameSetting::query()->where('group', $groupKey)->delete();
    }
}
