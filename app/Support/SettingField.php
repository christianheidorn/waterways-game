<?php

namespace App\Support;

/**
 * Describes one configurable value so the studio can render a form for it and validate it.
 */
final readonly class SettingField
{
    /**
     * @param  'number'|'boolean'|'select'|'color'|'text'  $type
     * @param  array<string, string>  $options
     */
    public function __construct(
        public string $key,
        public string $label,
        public string $type,
        public mixed $default,
        public ?float $min = null,
        public ?float $max = null,
        public ?float $step = null,
        public array $options = [],
        public ?string $description = null,
        public ?string $unit = null,
        public bool $nullable = false,
    ) {}

    public static function number(string $key, string $label, float $default, float $min, float $max, float $step = 0.1, ?string $unit = null, ?string $description = null): self
    {
        return new self($key, $label, 'number', $default, $min, $max, $step, unit: $unit, description: $description);
    }

    public static function boolean(string $key, string $label, bool $default, ?string $description = null): self
    {
        return new self($key, $label, 'boolean', $default, description: $description);
    }

    /**
     * @param  array<string, string>  $options
     */
    public static function select(string $key, string $label, string $default, array $options, ?string $description = null): self
    {
        return new self($key, $label, 'select', $default, options: $options, description: $description);
    }

    public static function color(string $key, string $label, string $default, ?string $description = null): self
    {
        return new self($key, $label, 'color', $default, description: $description);
    }

    public static function text(string $key, string $label, ?string $default, ?string $description = null): self
    {
        return new self($key, $label, 'text', $default, description: $description, nullable: true);
    }

    /**
     * @return list<mixed>
     */
    public function rules(): array
    {
        $rules = [$this->nullable ? 'nullable' : 'required'];

        return match ($this->type) {
            'number' => [...$rules, 'numeric', "min:{$this->min}", "max:{$this->max}"],
            'boolean' => [...$rules, 'boolean'],
            'select' => [...$rules, 'string', 'in:'.implode(',', array_keys($this->options))],
            'color' => [...$rules, 'string', 'regex:/^#[0-9a-fA-F]{6}$/'],
            default => [...$rules, 'string', 'max:2048'],
        };
    }

    public function cast(mixed $value): mixed
    {
        if ($value === null && $this->nullable) {
            return null;
        }

        return match ($this->type) {
            'number' => (float) $value,
            'boolean' => filter_var($value, FILTER_VALIDATE_BOOL),
            default => (string) $value,
        };
    }

    /**
     * @return array<string, mixed>
     */
    public function toArray(): array
    {
        return array_filter([
            'key' => $this->key,
            'label' => $this->label,
            'type' => $this->type,
            'default' => $this->default,
            'min' => $this->min,
            'max' => $this->max,
            'step' => $this->step,
            'options' => $this->options ?: null,
            'description' => $this->description,
            'unit' => $this->unit,
        ], fn ($v) => $v !== null);
    }
}
