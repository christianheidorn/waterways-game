<?php

namespace Tests\Feature\Studio;

use App\Models\Map;
use App\Services\Terrain\TerrainStorage;
use App\Support\DefaultTerrainLayers;
use App\Support\EnvironmentDefaults;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

class WeatherEnvironmentTest extends TestCase
{
    use RefreshDatabase;

    /**
     * The weather presets from resources/js/lib/weather-presets.ts (a representative subset of fields).
     *
     * @return array<string, array{array<string, mixed>}>
     */
    public static function presets(): array
    {
        return [
            'clear' => [['weather' => 'clear', 'cloud_coverage' => 0.15, 'turbidity' => 2.2, 'fog_density' => 0.00015, 'height_fog_height' => 0, 'height_fog_density' => 0.012, 'precipitation' => 0, 'lightning_frequency' => 0, 'wind_strength' => 0.35, 'wetness' => 0, 'exposure' => 0.5]],
            'fog' => [['weather' => 'fog', 'cloud_coverage' => 0.8, 'turbidity' => 7, 'fog_density' => 0.0008, 'height_fog_height' => 80, 'height_fog_density' => 0.014, 'precipitation' => 0, 'lightning_frequency' => 0, 'wind_strength' => 0.1, 'wetness' => 0.25, 'exposure' => 0.55]],
            'rain' => [['weather' => 'rain', 'cloud_coverage' => 0.92, 'turbidity' => 8, 'fog_density' => 0.0007, 'height_fog_height' => 40, 'height_fog_density' => 0.008, 'precipitation' => 0.65, 'lightning_frequency' => 0, 'wind_strength' => 0.8, 'wetness' => 0.6, 'exposure' => 0.6]],
            'storm' => [['weather' => 'storm', 'cloud_coverage' => 1, 'turbidity' => 10, 'fog_density' => 0.0009, 'height_fog_height' => 60, 'height_fog_density' => 0.01, 'precipitation' => 1, 'lightning_frequency' => 6, 'wind_strength' => 1.4, 'wetness' => 0.9, 'exposure' => 0.6]],
            'snow' => [['weather' => 'snow', 'cloud_coverage' => 0.88, 'turbidity' => 6, 'fog_density' => 0.001, 'height_fog_height' => 0, 'height_fog_density' => 0.012, 'precipitation' => 0.6, 'lightning_frequency' => 0, 'wind_strength' => 0.3, 'wetness' => 0, 'exposure' => 0.5]],
            'autumn' => [['weather' => 'autumn', 'cloud_coverage' => 0.45, 'turbidity' => 3.5, 'fog_density' => 0.0003, 'height_fog_height' => 20, 'height_fog_density' => 0.01, 'precipitation' => 0, 'falling_leaves' => 0.6, 'lightning_frequency' => 0, 'wind_strength' => 0.9, 'wetness' => 0.15, 'exposure' => 0.52]],
        ];
    }

    public function test_environment_defaults_include_the_weather_fields(): void
    {
        $defaults = EnvironmentDefaults::group()->defaults();

        $this->assertSame('clear', $defaults['weather']);
        $this->assertSame(0.0, $defaults['precipitation']);
        $this->assertSame(0.0, $defaults['falling_leaves']);
        $this->assertSame(0.0, $defaults['lightning_frequency']);
        $this->assertSame(0.7, $defaults['thunder_volume']);
        $this->assertSame(45.0, $defaults['wind_direction']);
        $this->assertSame(0.0, $defaults['height_fog_height']);
        $this->assertSame(0.012, $defaults['height_fog_density']);
        $this->assertSame(0.0, $defaults['wetness']);

        $weather = collect(EnvironmentDefaults::group()->fields)->firstWhere('key', 'weather');
        $this->assertSame(['clear', 'cloudy', 'overcast', 'fog', 'rain', 'storm', 'snow', 'autumn'], array_keys($weather->options));
    }

    public function test_maps_saved_before_weather_existed_get_defaults_in_the_manifest(): void
    {
        Storage::fake('local');
        Storage::fake('public');
        $map = Map::factory()->create(['resolution' => 65, 'size' => 256, 'environment' => ['time_of_day' => 9.5, 'fog_density' => 0.001]]);
        DefaultTerrainLayers::createFor($map);
        app(TerrainStorage::class)->write($map, 'heightmap', TerrainStorage::packFloats(array_fill(0, 65 * 65, 12.5)));

        $this->getJson("/api/maps/{$map->slug}/manifest")
            ->assertOk()
            ->assertJsonPath('environment.time_of_day', 9.5)
            ->assertJsonPath('environment.weather', 'clear')
            ->assertJsonPath('environment.precipitation', 0)
            ->assertJsonPath('environment.thunder_volume', 0.7)
            ->assertJsonPath('environment.height_fog_height', 0);
    }

    /**
     * @param  array<string, mixed>  $preset
     */
    #[DataProvider('presets')]
    public function test_weather_presets_validate_and_persist(array $preset): void
    {
        $map = Map::factory()->create();

        $this->put("/maps/{$map->slug}/environment", [...$preset, 'wind_direction' => 270, 'thunder_volume' => 0.4])
            ->assertSessionHasNoErrors()
            ->assertRedirect();

        $env = $map->fresh()->resolvedEnvironment();
        $this->assertSame($preset['weather'], $env['weather']);
        $this->assertSame((float) $preset['precipitation'], $env['precipitation']);
        $this->assertSame((float) $preset['height_fog_height'], $env['height_fog_height']);
        $this->assertSame(270.0, $env['wind_direction']);
        $this->assertSame(0.4, $env['thunder_volume']);
        // Untouched fields keep their values.
        $this->assertSame(15.5, $env['time_of_day']);
    }

    public function test_gusts_cloud_shadows_and_fog_shafts_are_saved_and_range_checked(): void
    {
        $map = Map::factory()->create();

        $this->put("/maps/{$map->slug}/environment", [
            'gust_strength' => 1.2, 'gust_scale' => 120, 'gust_speed' => 0.5, 'cloud_shadow_strength' => 0.3, 'fog_shaft_intensity' => 1.6,
        ])->assertSessionHasNoErrors()->assertRedirect();

        $env = $map->fresh()->resolvedEnvironment();
        $this->assertSame(1.2, $env['gust_strength']);
        $this->assertSame(120.0, $env['gust_scale']);
        $this->assertSame(0.5, $env['gust_speed']);
        $this->assertSame(0.3, $env['cloud_shadow_strength']);
        $this->assertSame(1.6, $env['fog_shaft_intensity']);

        $this->put("/maps/{$map->slug}/environment", [
            'gust_strength' => -0.1, 'gust_scale' => 1000, 'gust_speed' => 9, 'cloud_shadow_strength' => 2, 'fog_shaft_intensity' => -1,
        ])->assertSessionHasErrors(['gust_strength', 'gust_scale', 'gust_speed', 'cloud_shadow_strength', 'fog_shaft_intensity']);
    }

    public function test_weather_values_are_range_checked(): void
    {
        $map = Map::factory()->create();

        $this->put("/maps/{$map->slug}/environment", [
            'weather' => 'hurricane',
            'precipitation' => 1.5,
            'lightning_frequency' => 50,
            'wind_direction' => 400,
            'height_fog_height' => -5,
            'wetness' => 2,
        ])->assertSessionHasErrors(['weather', 'precipitation', 'lightning_frequency', 'wind_direction', 'height_fog_height', 'wetness']);
    }
}
