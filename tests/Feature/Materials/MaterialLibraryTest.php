<?php

namespace Tests\Feature\Materials;

use App\Models\Material;
use App\Services\Materials\MaterialLibrary;
use App\Services\Materials\Sources\UploadSource;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Inertia\Testing\AssertableInertia as Assert;
use Tests\Concerns\CreatesTestImages;
use Tests\TestCase;

class MaterialLibraryTest extends TestCase
{
    use CreatesTestImages;
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('public');
    }

    public function test_map_detection_from_file_names(): void
    {
        $cases = [
            'rock_face_03_diff_1k.jpg' => 'albedo',
            'Ground_BaseColor.png' => 'albedo',
            'grass_base_color.jpg' => 'albedo',
            'Grass005_1K-JPG_Color.jpg' => 'albedo',
            'albedo.png' => 'albedo',
            'rock_nor_gl_1k.jpg' => 'normal',
            'Grass005_1K-JPG_NormalGL.jpg' => 'normal',
            'Grass005_1K-JPG_NormalDX.jpg' => 'normal_dx',
            'mud_normal_directx.png' => 'normal_dx',
            'mud_nrm.png' => 'normal',
            'sand_rough_1k.jpg' => 'roughness',
            'Sand_Roughness.jpg' => 'roughness',
            'sand_rgh.jpg' => 'roughness',
            'rock_ao_1k.jpg' => 'ao',
            'Rock_AmbientOcclusion.jpg' => 'ao',
            'rock_occlusion.png' => 'ao',
            'rock_disp_1k.png' => 'height',
            'Rock_Displacement.jpg' => 'height',
            'rock_height.png' => 'height',
            'rock_bump.png' => 'height',
            'rock_arm_1k.jpg' => 'arm',
            'rock_ORM.png' => 'arm',
            'farm_field_photo.jpg' => null,
        ];

        foreach ($cases as $name => $expected) {
            $this->assertSame($expected, UploadSource::detectMap($name), $name);
        }
    }

    public function test_uploading_a_full_set_detects_maps_and_flips_directx_normals(): void
    {
        $files = [
            UploadedFile::fake()->createWithContent('Mud_BaseColor.jpg', $this->jpeg($this->noiseImage(300, 300))),
            // DirectX normal with a strong green bias: stored as OpenGL (green inverted).
            UploadedFile::fake()->createWithContent('Mud_NormalDX.png', $this->png($this->solidImage(300, 300, 0x8032FF))),
            UploadedFile::fake()->createWithContent('Mud_Roughness.jpg', $this->jpeg($this->solidImage(300, 300, 0x404040))),
        ];

        $this->post('/materials/upload', [
            'name' => 'River mud', 'category' => 'mud', 'tile_size' => 1.5, 'files' => $files,
        ])->assertRedirect()->assertSessionHasNoErrors();

        $material = Material::query()->sole();
        $this->assertSame('ready', $material->status);
        $this->assertSame('upload', $material->source);
        $this->assertSame(256, $material->resolution);
        $this->assertSame(1.5, $material->tile_size);
        $this->assertSame('river-mud', $material->slug);

        $disk = Storage::disk('public');
        foreach (['albedo', 'normal', 'roughness', 'ao', 'height'] as $map) {
            $this->assertSame("materials/{$material->id}/{$map}.jpg", $material->{$map.'_path'});
            $disk->assertExists($material->{$map.'_path'});
        }
        $disk->assertExists("materials/{$material->id}/thumb.jpg");

        [$r, $g, $b] = $this->meanRgb($disk->get($material->normal_path));
        $this->assertEqualsWithDelta(128, $r, 6);
        $this->assertEqualsWithDelta(205, $g, 6, 'DX green (50) is flipped to GL (205).');
        $this->assertEqualsWithDelta(255, $b, 6);

        $this->assertEqualsWithDelta(64, $this->meanRgb($disk->get($material->roughness_path))[0], 4, 'Uploaded roughness is kept.');
    }

    public function test_a_single_photo_upload_derives_every_map(): void
    {
        $this->post('/materials/upload', [
            'name' => 'Meadow photo', 'category' => 'grass', 'tile_size' => 3, 'make_seamless' => true,
            'files' => [UploadedFile::fake()->createWithContent('IMG_2041.jpg', $this->jpeg($this->noiseImage(640, 480)))],
        ])->assertSessionHasNoErrors();

        $material = Material::query()->sole();
        $this->assertTrue($material->isReady());
        $this->assertSame(256, $material->resolution);
        foreach (Material::MAPS as $map) {
            $image = imagecreatefromstring(Storage::disk('public')->get($material->{$map.'_path'}));
            $this->assertSame([256, 256], [imagesx($image), imagesy($image)], $map);
        }
    }

    public function test_upload_validation(): void
    {
        $this->post('/materials/upload', ['name' => '', 'category' => 'lava', 'tile_size' => 500, 'files' => []])
            ->assertSessionHasErrors(['name', 'category', 'tile_size', 'files']);

        $this->assertSame(0, Material::query()->count());
    }

    public function test_index_update_duplicate_and_delete(): void
    {
        $material = app(MaterialLibrary::class)->create(['name' => 'Granite', 'category' => 'rock', 'status' => 'processing']);
        app(UploadSource::class)->import($material, [['name' => 'granite.jpg', 'bytes' => $this->jpeg($this->noiseImage(256, 256))]]);

        $this->get('/materials')->assertOk()->assertInertia(fn (Assert $page) => $page
            ->component('materials/index')
            ->has('materials', 1)
            ->where('materials.0.name', 'Granite')
            ->where('materials.0.status', 'ready')
            ->where('materials.0.layers_count', 0)
            ->where('materials.0.maps.normal', fn ($url) => str_starts_with($url, "/storage/materials/{$material->id}/normal.jpg?v="))
            ->has('categories', count(Material::CATEGORIES))
            ->where('categories.0', ['value' => 'grass', 'label' => 'Grass'])
            ->where('ai.configured', false));

        $this->put("/materials/{$material->id}", [
            'name' => 'Grey granite', 'tint' => '#ddeeff', 'roughness_scale' => 1.2, 'normal_strength' => 2,
            'height_contrast' => 0.5, 'tile_size' => 4, 'tags' => ['cliff', ' alpine ', ''],
        ])->assertSessionHasNoErrors();
        $material->refresh();
        $this->assertSame(['Grey granite', '#ddeeff', 1.2, 2.0, 0.5, 4.0, ['cliff', 'alpine']], [
            $material->name, $material->tint, $material->roughness_scale, $material->normal_strength,
            $material->height_contrast, $material->tile_size, $material->tags,
        ]);

        $this->put("/materials/{$material->id}", ['tint' => 'red', 'roughness_scale' => 5])->assertSessionHasErrors(['tint', 'roughness_scale']);

        $this->post("/materials/{$material->id}/duplicate")->assertRedirect();
        $copy = Material::query()->whereKeyNot($material->id)->sole();
        $this->assertSame('Grey granite (copy)', $copy->name);
        $this->assertTrue($copy->isReady());
        Storage::disk('public')->assertExists("materials/{$copy->id}/albedo.jpg");
        Storage::disk('public')->assertExists("materials/{$copy->id}/thumb.jpg");

        $this->getJson("/api/materials/{$copy->id}")->assertOk()->assertJsonPath('name', 'Grey granite (copy)')->assertJsonPath('status', 'ready');

        $this->delete("/materials/{$material->id}")->assertRedirect();
        $this->assertModelMissing($material);
        Storage::disk('public')->assertMissing("materials/{$material->id}/albedo.jpg");
        Storage::disk('public')->assertExists("materials/{$copy->id}/albedo.jpg");
    }
}
