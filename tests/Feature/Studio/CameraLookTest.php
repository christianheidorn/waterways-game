<?php

namespace Tests\Feature\Studio;

use App\Models\Map;
use App\Support\EnvironmentDefaults;
use App\Support\GameManifest;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class CameraLookTest extends TestCase
{
    use RefreshDatabase;

    public function test_environment_defaults_include_the_camera_look(): void
    {
        $defaults = EnvironmentDefaults::merge([]);

        $this->assertSame('filmic', $defaults['color_grade']);
        $this->assertEquals(5.6, $defaults['dof_aperture']);
        $this->assertEquals(0, $defaults['dof_focus_distance'], 'autofocus by default');
        $this->assertEquals(0, $defaults['letterbox']);

        // Maps saved before the look existed get the defaults in the manifest.
        $map = Map::factory()->create(['environment' => ['time_of_day' => 9]]);
        $env = app(GameManifest::class)->build($map)['environment'];
        $this->assertEquals(9, $env['time_of_day']);
        $this->assertSame('filmic', $env['color_grade']);
        $this->assertEquals(4.5, $env['bloom_threshold']);
    }

    public function test_look_values_are_validated(): void
    {
        $map = Map::factory()->create();

        $this->put("/maps/{$map->slug}/environment", ['color_grade' => 'teal_orange', 'letterbox' => 2.39, 'dof_aperture' => 1.4, 'film_grain' => 0.3])
            ->assertSessionHasNoErrors();
        $this->assertSame('teal_orange', $map->refresh()->resolvedEnvironment()['color_grade']);

        foreach ([['color_grade' => 'sepia'], ['dof_aperture' => 0.5], ['letterbox' => 5], ['exposure_compensation' => 9]] as $invalid) {
            $this->put("/maps/{$map->slug}/environment", $invalid)->assertSessionHasErrors(array_key_first($invalid));
        }
    }
}
