<?php

namespace Tests\Feature\Materials;

use App\Models\Map;
use App\Models\Material;
use App\Services\Materials\StarterMaterials;
use App\Support\DefaultTerrainLayers;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Storage;
use Tests\Concerns\CreatesTestImages;
use Tests\TestCase;

class StarterMaterialsTest extends TestCase
{
    use CreatesTestImages;
    use RefreshDatabase;

    /** Refs the fake API lists (the rest of the starter set is "missing"). */
    private const LISTED = ['leafy_grass', 'sparse_grass', 'rock_face_03', 'snow_02'];

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('public');

        $albedo = $this->jpeg($this->noiseImage(32, 32));
        $grey = $this->jpeg($this->solidImage(32, 32, 0x808080));
        $normal = $this->jpeg($this->solidImage(32, 32, 0x8080FF));

        Http::fake([
            'api.polyhaven.com/assets*' => Http::response(collect(self::LISTED)->mapWithKeys(fn ($ref) => [$ref => [
                'name' => ucwords(str_replace('_', ' ', $ref)), 'categories' => ['terrain'], 'tags' => [], 'download_count' => 1, 'dimensions' => [2000, 2000],
            ]])->all()),
            'api.polyhaven.com/info/*' => fn (Request $r) => Http::response([
                'name' => ucwords(str_replace('_', ' ', basename($r->url()))), 'tags' => ['ground'], 'categories' => ['terrain'],
                'dimensions' => [basename($r->url()) === 'rock_face_03' ? 2700 : 2000, 2000], 'authors' => ['Poly Haven' => 'All'],
            ]),
            'api.polyhaven.com/files/*' => function (Request $r) {
                $ref = basename($r->url());
                $files = [];
                foreach (['Diffuse', 'nor_gl', 'Rough', 'AO', 'Displacement'] as $key) {
                    $files[$key]['1k']['jpg']['url'] = "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/{$ref}/{$ref}_{$key}_1k.jpg";
                }

                return Http::response($files);
            },
            'dl.polyhaven.org/*' => fn (Request $r) => Http::response(match (true) {
                str_contains($r->url(), '_Diffuse_') => $albedo,
                str_contains($r->url(), '_nor_gl_') => $normal,
                default => $grey,
            }),
        ]);
    }

    public function test_the_command_imports_the_set_and_assigns_it_to_default_layers(): void
    {
        $map = Map::factory()->create();
        DefaultTerrainLayers::createFor($map);

        $this->artisan('waterways:starter-materials', ['--resolution' => '1k'])
            ->expectsOutputToContain('Starter materials: 4 imported, 0 already present, 6 failed')
            ->assertSuccessful();

        $this->assertSame(self::LISTED, Material::query()->orderBy('id')->pluck('source_ref')->all());
        $this->assertTrue(Material::query()->get()->every(fn (Material $m) => $m->isReady() && $m->license === 'CC0'));

        $layers = $map->layers()->get()->keyBy('name');
        $byRef = Material::query()->pluck('id', 'source_ref');
        $this->assertSame($byRef['leafy_grass'], $layers['Grass']->material_id);
        $this->assertSame($byRef['sparse_grass'], $layers['Meadow']->material_id, 'Meadow gets the other grass.');
        $this->assertSame($byRef['rock_face_03'], $layers['Rock']->material_id);
        $this->assertSame(2.7, $layers['Rock']->texture_scale, 'texture_scale follows the tile size.');
        $this->assertSame($byRef['snow_02'], $layers['Snow']->material_id);
        $this->assertNull($layers['Sand']->material_id, 'No sand material was available.');

        // Second run: nothing to download.
        $downloads = fn () => Http::recorded(fn (Request $r) => str_contains($r->url(), 'dl.polyhaven.org'))->count();
        $before = $downloads();
        $this->artisan('waterways:starter-materials')->expectsOutputToContain('0 imported, 4 already present')->assertSuccessful();
        $this->assertSame($before, $downloads(), 'Nothing is downloaded again.');

        // New maps get the starter materials right away.
        $second = Map::factory()->create();
        DefaultTerrainLayers::createFor($second);
        $this->assertSame($byRef['leafy_grass'], $second->layers()->where('name', 'Grass')->value('material_id'));
        $this->assertSame(2.0, $second->layers()->where('name', 'Grass')->value('texture_scale'));
    }

    public function test_the_command_survives_being_offline(): void
    {
        Http::fake(['*' => Http::failedConnection()]);
        $this->app->forgetInstance(StarterMaterials::class);

        $this->artisan('waterways:starter-materials')
            ->expectsOutputToContain('Poly Haven is unreachable')
            ->assertSuccessful();

        $this->assertSame(0, Material::query()->count());
    }
}
