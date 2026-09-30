<?php

namespace App\Mcp\Tools;

use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\JsonSchema\Types\Type;
use Illuminate\Support\Facades\Validator;
use Illuminate\Validation\ValidationException;

/**
 * The `shape` argument of the world-editing tools: where an edit applies, in world metres.
 */
trait ShapeArgument
{
    protected function shapeSchema(JsonSchema $schema): Type
    {
        $point = fn () => $schema->object(['x' => $schema->number()->required(), 'z' => $schema->number()->required()]);

        return $schema->object([
            'type' => $schema->string()->enum(['circle', 'rect', 'polygon', 'path', 'map'])->required(),
            'center' => $point()->description('circle'),
            'radius' => $schema->number()->description('circle, m'),
            'min' => $point()->description('rect: north-west corner (smallest x and z)'),
            'max' => $point()->description('rect: south-east corner'),
            'points' => $schema->array()->items($point())->description('polygon: outline (3+ points); path: centre line (2+ points, in order; rivers flow from the first to the last)'),
            'width' => $schema->number()->description('path: full width, m'),
            'falloff' => $schema->number()->description('Soft edge outside the shape, m (default 0). Use generous falloffs (10-50 m) for natural transitions.'),
        ])->description('Where the edit applies (world metres; x west → east, z north → south, map centre 0, 0; see get_map_image for coordinates). Full effect inside, fading out over `falloff` metres outside. circle {center, radius} · rect {min, max} · polygon {points} · path {points, width} · map (everything).');
    }

    /**
     * Validation rules of the shape argument.
     *
     * @return array<string, list<mixed>>
     */
    protected function shapeRules(string $key = 'shape', bool $required = true): array
    {
        return [
            $key => [$required ? 'required' : 'sometimes', 'array'],
            "{$key}.type" => ["required_with:{$key}", 'in:circle,rect,polygon,path,map'],
            "{$key}.center" => ["required_if:{$key}.type,circle", 'array'],
            "{$key}.center.x" => ["required_with:{$key}.center", 'numeric'],
            "{$key}.center.z" => ["required_with:{$key}.center", 'numeric'],
            "{$key}.radius" => ["required_if:{$key}.type,circle", 'numeric', 'between:0.5,50000'],
            "{$key}.min" => ["required_if:{$key}.type,rect", 'array'],
            "{$key}.min.x" => ["required_with:{$key}.min", 'numeric'],
            "{$key}.min.z" => ["required_with:{$key}.min", 'numeric'],
            "{$key}.max" => ["required_if:{$key}.type,rect", 'array'],
            "{$key}.max.x" => ["required_with:{$key}.max", 'numeric', "gt:{$key}.min.x"],
            "{$key}.max.z" => ["required_with:{$key}.max", 'numeric', "gt:{$key}.min.z"],
            "{$key}.points" => ["required_if:{$key}.type,polygon,path", 'array', 'max:1000'],
            "{$key}.points.*.x" => ['required', 'numeric'],
            "{$key}.points.*.z" => ['required', 'numeric'],
            "{$key}.width" => ["required_if:{$key}.type,path", 'numeric', 'between:0.5,5000'],
            "{$key}.falloff" => ['sometimes', 'numeric', 'between:0,5000'],
        ];
    }

    /**
     * The validated, normalised shape argument (null when optional and absent).
     *
     * @param  array<string, mixed>  $input
     * @return array<string, mixed>|null
     *
     * @throws ValidationException
     */
    protected function validatedShape(array $input, string $key = 'shape', bool $required = true): ?array
    {
        $data = Validator::make($input, $this->shapeRules($key, $required))->validate();
        $shape = $data[$key] ?? null;

        if ($shape === null) {
            return null;
        }

        $min = ['polygon' => 3, 'path' => 2][$shape['type']] ?? 0;

        if ($min > 0 && count($shape['points'] ?? []) < $min) {
            throw ValidationException::withMessages(["{$key}.points" => "A {$shape['type']} needs at least {$min} points."]);
        }

        return $this->normalizeShape($shape);
    }

    /**
     * Keeps only the shape fields the editor uses (numbers as floats).
     *
     * @param  array<string, mixed>  $shape
     * @return array<string, mixed>
     */
    protected function normalizeShape(array $shape): array
    {
        $point = fn (array $p) => ['x' => (float) $p['x'], 'z' => (float) $p['z']];

        return array_filter([
            'type' => $shape['type'],
            'center' => isset($shape['center']) ? $point($shape['center']) : null,
            'radius' => isset($shape['radius']) ? (float) $shape['radius'] : null,
            'min' => isset($shape['min']) ? $point($shape['min']) : null,
            'max' => isset($shape['max']) ? $point($shape['max']) : null,
            'points' => isset($shape['points']) ? array_map($point, array_values($shape['points'])) : null,
            'width' => isset($shape['width']) ? (float) $shape['width'] : null,
            'falloff' => isset($shape['falloff']) ? (float) $shape['falloff'] : null,
        ], fn ($v) => $v !== null);
    }
}
