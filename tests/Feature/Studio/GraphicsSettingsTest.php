<?php

namespace Tests\Feature\Studio;

use App\Models\GameSetting;
use App\Support\GameSettingsRepository;
use App\Support\GameSettingsSchema;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Inertia\Testing\AssertableInertia as Assert;
use Tests\TestCase;

class GraphicsSettingsTest extends TestCase
{
    use RefreshDatabase;

    public function test_graphics_schema_defines_the_scalability_fields_with_high_preset_defaults(): void
    {
        $defaults = GameSettingsSchema::group('graphics')->defaults();

        $this->assertSame('high', $defaults['quality_preset']);
        $this->assertSame('taa', $defaults['anti_aliasing']);
        $this->assertTrue($defaults['auto_exposure']);
        $this->assertSame('medium', $defaults['god_rays']);
        $this->assertSame('off', $defaults['depth_of_field']);
        $this->assertEquals(8, $defaults['anisotropy']);
        $this->assertEquals(1, $defaults['saturation']);
        $this->assertEquals(1, $defaults['contrast']);
        $this->assertEquals(0, $defaults['sharpen']);
        $this->assertEquals(0, $defaults['vignette']);
        $this->assertFalse($defaults['dynamic_resolution']);
        $this->assertEquals(60, $defaults['target_fps']);
        $this->assertSame('auto', $defaults['frame_rate_target']);
        $this->assertEquals(0, $defaults['max_fps']);
        $this->assertEquals(120, $defaults['foliage_shadow_distance']);
        $this->assertEquals(1, $defaults['foliage_lod_bias']);
        $this->assertSame('high', $defaults['effects_quality']);
        $this->assertSame('medium', $defaults['cloud_quality']);
        $this->assertSame('medium', $defaults['ao_quality']);
        $this->assertArrayHasKey('bloom_intensity', $defaults);
        // Legacy switch stays for compatibility.
        $this->assertArrayHasKey('antialias', $defaults);
    }

    public function test_graphics_settings_are_validated_and_saved(): void
    {
        $this->put('/settings/game/graphics', [
            'quality_preset' => 'epic',
            'anti_aliasing' => 'msaa',
            'anisotropy' => 16,
            'saturation' => 1.2,
            'dynamic_resolution' => true,
            'target_fps' => 90,
            'frame_rate_target' => '120',
            'max_fps' => 120,
            'effects_quality' => 'epic',
            'cloud_quality' => 'high',
            'ao_quality' => 'high',
        ])->assertRedirect()->assertSessionHasNoErrors();

        $values = app(GameSettingsRepository::class)->get('graphics');
        $this->assertSame('epic', $values['quality_preset']);
        $this->assertSame('msaa', $values['anti_aliasing']);
        $this->assertTrue($values['antialias'], 'legacy switch follows anti_aliasing');
        $this->assertEquals(16, $values['anisotropy']);
        $this->assertTrue($values['dynamic_resolution']);
        $this->assertEquals(120, $values['max_fps']);
        $this->assertSame('120', $values['frame_rate_target']);

        foreach ([
            ['quality_preset' => 'ultra'],
            ['anti_aliasing' => 'dlss'],
            ['god_rays' => 'ultra'],
            ['ssr' => 'epic'],
            ['depth_of_field' => 'medium'],
            ['anisotropy' => 32],
            ['anisotropy' => 0],
            ['saturation' => 2],
            ['contrast' => 0.2],
            ['sharpen' => 1.5],
            ['vignette' => -0.1],
            ['target_fps' => 20],
            ['frame_rate_target' => '90'],
            ['max_fps' => 500],
            ['foliage_shadow_distance' => 5000],
            ['foliage_lod_bias' => 0.1],
            ['effects_quality' => 'cinematic'],
            ['cloud_quality' => 'epic'],
            ['ao_quality' => 'ultra'],
        ] as $invalid) {
            $this->put('/settings/game/graphics', $invalid)->assertSessionHasErrors(array_key_first($invalid));
        }
    }

    public function test_settings_saved_before_the_new_fields_get_defaults_and_keep_their_msaa_choice(): void
    {
        GameSetting::query()->create([
            'group' => 'graphics',
            'values' => ['shadow_quality' => 'low', 'antialias' => false, 'bloom' => false],
        ]);

        $values = app(GameSettingsRepository::class)->get('graphics');

        $this->assertSame('low', $values['shadow_quality']);
        $this->assertSame('off', $values['anti_aliasing']);
        $this->assertSame('custom', $values['quality_preset']);
        $this->assertEquals(8, $values['anisotropy']);
        $this->assertEquals(60, $values['target_fps']);
        $this->assertSame('medium', $values['cloud_quality']);

        GameSetting::query()->where('group', 'graphics')->firstOrFail()->update(['values' => ['antialias' => true]]);
        $this->assertSame('msaa', app(GameSettingsRepository::class)->get('graphics')['anti_aliasing']);
    }

    public function test_graphics_page_and_manifest_expose_the_new_fields(): void
    {
        $this->get('/settings/game/graphics')->assertInertia(fn (Assert $page) => $page
            ->component('game-settings/edit')
            ->where('values.quality_preset', 'high')
            ->where('values.anti_aliasing', 'taa')
            ->has('group.fields', count(GameSettingsSchema::group('graphics')->fields)));
    }
}
