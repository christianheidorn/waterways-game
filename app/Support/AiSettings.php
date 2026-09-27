<?php

namespace App\Support;

use App\Models\GameSetting;
use Illuminate\Contracts\Encryption\DecryptException;
use Illuminate\Support\Facades\Crypt;

/**
 * OpenRouter credentials and model choices, stored as the "ai" row of game_settings.
 *
 * Deliberately NOT part of GameSettingsSchema: these values never reach the game, and the API key
 * is stored encrypted and never sent to the browser (only a hint such as "sk-or-…a1b2").
 */
final class AiSettings
{
    public const GROUP = 'ai';

    public const DEFAULT_IMAGE_MODEL = 'google/gemini-3.1-flash-image';

    public const DEFAULT_TEXT_MODEL = 'anthropic/claude-sonnet-5';

    public const RESOLUTIONS = ['1K', '2K'];

    public const MODEL_PATTERN = '/^[a-z0-9._-]+\/[a-zA-Z0-9._:-]+$/';

    /**
     * @return array<string, mixed>
     */
    private function stored(): array
    {
        /** @var array<string, mixed>|null $values */
        $values = GameSetting::query()->where('group', self::GROUP)->value('values');

        return is_array($values) ? $values : [];
    }

    private function storedKey(): ?string
    {
        $encrypted = $this->stored()['openrouter_api_key'] ?? null;

        if (! is_string($encrypted) || $encrypted === '') {
            return null;
        }

        try {
            return Crypt::decryptString($encrypted);
        } catch (DecryptException) {
            return null;
        }
    }

    private function envKey(): ?string
    {
        $key = config('services.openrouter.key');

        return is_string($key) && trim($key) !== '' ? trim($key) : null;
    }

    public function apiKey(): ?string
    {
        return $this->storedKey() ?? $this->envKey();
    }

    public function configured(): bool
    {
        return $this->apiKey() !== null;
    }

    /**
     * @return 'studio'|'env'|null
     */
    public function keySource(): ?string
    {
        return match (true) {
            $this->storedKey() !== null => 'studio',
            $this->envKey() !== null => 'env',
            default => null,
        };
    }

    /**
     * A recognisable but useless fragment of the key, e.g. "sk-or-…a1b2".
     */
    public function keyHint(): ?string
    {
        $key = $this->apiKey();

        if ($key === null) {
            return null;
        }

        $prefix = str_starts_with($key, 'sk-or-') ? 'sk-or-' : substr($key, 0, min(3, max(0, strlen($key) - 8)));

        return $prefix.'…'.(strlen($key) > 8 ? substr($key, -4) : '');
    }

    public function imageModel(): string
    {
        $model = $this->stored()['image_model'] ?? null;

        return is_string($model) && $model !== '' ? $model : self::DEFAULT_IMAGE_MODEL;
    }

    public function textModel(): string
    {
        $model = $this->stored()['text_model'] ?? null;

        return is_string($model) && $model !== '' ? $model : self::DEFAULT_TEXT_MODEL;
    }

    /**
     * @return '1K'|'2K'
     */
    public function imageResolution(): string
    {
        $resolution = $this->stored()['image_resolution'] ?? null;

        return in_array($resolution, self::RESOLUTIONS, true) ? $resolution : '1K';
    }

    /**
     * @param  array{openrouter_api_key?: string|null, clear_key?: bool, image_model?: string|null, text_model?: string|null, image_resolution?: string|null}  $input
     */
    public function update(array $input): void
    {
        $values = $this->stored();

        if (! empty($input['clear_key'])) {
            unset($values['openrouter_api_key']);
        }

        $key = trim((string) ($input['openrouter_api_key'] ?? ''));
        if ($key !== '') {
            $values['openrouter_api_key'] = Crypt::encryptString($key);
        }

        foreach (['image_model', 'text_model', 'image_resolution'] as $field) {
            if (array_key_exists($field, $input) && $input[$field] !== null && $input[$field] !== '') {
                $values[$field] = $input[$field];
            }
        }

        GameSetting::query()->updateOrCreate(['group' => self::GROUP], ['values' => $values]);
    }

    /**
     * Safe to send to the browser (never contains the key).
     *
     * @return array{configured: bool, key_hint: string|null, key_source: string|null, image_model: string, text_model: string, image_resolution: string}
     */
    public function toFrontend(): array
    {
        return [
            'configured' => $this->configured(),
            'key_hint' => $this->keyHint(),
            'key_source' => $this->keySource(),
            'image_model' => $this->imageModel(),
            'text_model' => $this->textModel(),
            'image_resolution' => $this->imageResolution(),
        ];
    }
}
