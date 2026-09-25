<?php

namespace Database\Factories;

use App\Enums\MapSource;
use App\Enums\TerrainStatus;
use App\Models\Map;
use Illuminate\Database\Eloquent\Factories\Factory;
use Illuminate\Support\Str;

/**
 * @extends Factory<Map>
 */
class MapFactory extends Factory
{
    public function definition(): array
    {
        $name = fake()->unique()->words(2, true);

        return [
            'name' => Str::title($name),
            'slug' => Str::slug($name),
            'source' => MapSource::Flat,
            'resolution' => 257,
            'size' => 1024,
            'seed' => fake()->numberBetween(1, 99999),
            'terrain_status' => TerrainStatus::Ready,
            'min_height' => 0,
            'max_height' => 10,
        ];
    }

    public function realWorld(float $lat = 47.27, float $lng = 11.39): static
    {
        return $this->state(fn () => [
            'source' => MapSource::RealWorld,
            'center_lat' => $lat,
            'center_lng' => $lng,
        ]);
    }
}
