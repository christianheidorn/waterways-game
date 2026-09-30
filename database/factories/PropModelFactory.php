<?php

namespace Database\Factories;

use App\Models\PropModel;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<PropModel>
 */
class PropModelFactory extends Factory
{
    protected $model = PropModel::class;

    public function definition(): array
    {
        return [
            'name' => fake()->words(2, true),
            'category' => 'building',
            'source' => 'upload',
            'status' => 'ready',
            'model_path' => 'props/1/model.glb',
            'target_height' => 4,
        ];
    }
}
