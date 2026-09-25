<?php

namespace App\Support;

/**
 * A named collection of SettingFields, e.g. "player" or "environment".
 */
final readonly class SettingGroup
{
    /**
     * @param  list<SettingField>  $fields
     */
    public function __construct(
        public string $key,
        public string $title,
        public string $description,
        public array $fields,
    ) {}

    /**
     * @return array<string, mixed>
     */
    public function defaults(): array
    {
        $values = [];

        foreach ($this->fields as $field) {
            $values[$field->key] = $field->default;
        }

        return $values;
    }

    /**
     * Merge stored values over the defaults, dropping unknown keys and casting types.
     *
     * @param  array<string, mixed>  $values
     * @return array<string, mixed>
     */
    public function merge(array $values): array
    {
        $merged = [];

        foreach ($this->fields as $field) {
            $merged[$field->key] = array_key_exists($field->key, $values)
                ? $field->cast($values[$field->key])
                : $field->default;
        }

        return $merged;
    }

    /**
     * Validation rules for a (partial) update, prefixed with the given key.
     *
     * @return array<string, list<mixed>>
     */
    public function rules(string $prefix = ''): array
    {
        $rules = [];

        foreach ($this->fields as $field) {
            $rules[$prefix.$field->key] = ['sometimes', ...$field->rules()];
        }

        return $rules;
    }

    /**
     * @return array<string, mixed>
     */
    public function toArray(): array
    {
        return [
            'key' => $this->key,
            'title' => $this->title,
            'description' => $this->description,
            'fields' => array_map(fn (SettingField $f) => $f->toArray(), $this->fields),
        ];
    }
}
