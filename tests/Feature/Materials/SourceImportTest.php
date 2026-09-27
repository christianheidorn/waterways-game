<?php

namespace Tests\Feature\Materials;

use App\Models\Material;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Storage;
use Tests\Concerns\CreatesTestImages;
use Tests\TestCase;
use ZipArchive;

class SourceImportTest extends TestCase
{
    use CreatesTestImages;
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('public');
    }

    /**
     * @param  list<string>  $keys  Poly Haven file keys to offer
     */
    private function fakePolyHaven(string $ref, array $keys = ['Diffuse', 'nor_gl', 'Rough', 'AO', 'Displacement', 'arm']): void
    {
        $files = [];
        foreach ($keys as $key) {
            foreach (['1k', '2k'] as $res) {
                $files[$key][$res] = [
                    'jpg' => ['url' => "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/{$res}/{$ref}/{$ref}_{$key}_{$res}.jpg", 'size' => 1],
                    'png' => ['url' => "https://dl.polyhaven.org/file/ph-assets/Textures/png/{$res}/{$ref}/{$ref}_{$key}_{$res}.png", 'size' => 1],
                ];
            }
        }

        $images = [
            'Diffuse' => $this->jpeg($this->noiseImage(64, 64)),
            'nor_gl' => $this->jpeg($this->solidImage(64, 64, 0x8080FF)),
            'Rough' => $this->jpeg($this->solidImage(64, 64, 0xB0B0B0)),
            'AO' => $this->jpeg($this->solidImage(64, 64, 0xF0F0F0)),
            'Displacement' => $this->jpeg($this->solidImage(64, 64, 0x707070)),
            // R = AO 100, G = roughness 200, B = metal 0
            'arm' => $this->png($this->solidImage(64, 64, 0x64C800)),
        ];

        Http::fake([
            'api.polyhaven.com/assets*' => Http::response([
                'rock_face_03' => ['name' => 'Rock Face 03', 'tags' => ['cliff'], 'categories' => ['rock', 'terrain'], 'download_count' => 50, 'dimensions' => [2700, 2700], 'authors' => ['Rob' => 'All'], 'max_resolution' => [8192, 8192]],
                'leafy_grass' => ['name' => 'Leafy Grass', 'tags' => ['leaves'], 'categories' => ['outdoor'], 'download_count' => 900, 'dimensions' => [2000, 2000], 'authors' => ['Rico' => 'All'], 'max_resolution' => [8192, 8192]],
                'grass_path_2' => ['name' => 'Grass Path 2', 'tags' => ['path'], 'categories' => ['terrain'], 'download_count' => 300, 'dimensions' => [1000, 1000], 'authors' => ['Rob' => 'All'], 'max_resolution' => [4096, 4096]],
                'brick_wall' => ['name' => 'Brick Wall', 'tags' => ['wall'], 'categories' => ['man made'], 'download_count' => 5000, 'dimensions' => [3000, 3000], 'authors' => ['Rob' => 'All'], 'max_resolution' => [4096, 4096]],
            ]),
            "api.polyhaven.com/info/{$ref}" => Http::response([
                'name' => 'Rock Face 03', 'tags' => ['cliff', 'mossy'], 'categories' => ['rock', 'terrain'],
                'dimensions' => [2699.99, 2699.99], 'authors' => ['Rob Tuytel' => 'All'],
            ]),
            "api.polyhaven.com/files/{$ref}" => Http::response($files),
            'dl.polyhaven.org/*' => function (Request $request) use ($images) {
                foreach ($images as $key => $bytes) {
                    if (str_contains($request->url(), "_{$key}_")) {
                        return Http::response($bytes);
                    }
                }

                return Http::response('', 404);
            },
        ]);
    }

    public function test_poly_haven_search_filters_sorts_and_paginates(): void
    {
        $this->fakePolyHaven('rock_face_03');

        $this->getJson('/api/materials/browse/polyhaven')
            ->assertOk()
            ->assertJsonPath('page', 1)
            ->assertJsonPath('has_more', false)
            ->assertJsonPath('items.0.ref', 'brick_wall')
            ->assertJsonPath('items.1.ref', 'leafy_grass')
            ->assertJsonCount(4, 'items');

        $this->getJson('/api/materials/browse/polyhaven?q=grass')
            ->assertJsonCount(2, 'items')
            ->assertJsonPath('items.0.ref', 'leafy_grass')
            ->assertJsonPath('items.0.thumbnail_url', 'https://cdn.polyhaven.com/asset_img/thumbs/leafy_grass.png?width=256&height=256')
            ->assertJsonPath('items.0.license', 'CC0')
            ->assertJsonPath('items.0.source_url', 'https://polyhaven.com/a/leafy_grass')
            ->assertJsonPath('items.0.author', 'Rico')
            ->assertJsonPath('items.0.max_resolution', 8192)
            ->assertJsonPath('items.0.tile_size', 2)
            ->assertJsonPath('items.0.imported_material_id', null);

        $this->getJson('/api/materials/browse/polyhaven?category=rock')->assertJsonCount(1, 'items')->assertJsonPath('items.0.ref', 'rock_face_03');
        $this->getJson('/api/materials/browse/polyhaven?page=2')->assertJsonCount(0, 'items');
        $this->getJson('/api/materials/browse/nowhere')->assertNotFound();
    }

    public function test_importing_from_poly_haven(): void
    {
        $this->fakePolyHaven('rock_face_03');

        $this->post('/materials/import', ['source' => 'polyhaven', 'ref' => 'rock_face_03', 'resolution' => '1k'])
            ->assertRedirect()->assertSessionHasNoErrors();

        $material = Material::query()->sole();
        $this->assertSame('ready', $material->status, (string) $material->status_message);
        $this->assertSame('Rock Face 03', $material->name);
        $this->assertSame('rock', $material->category);
        $this->assertSame('polyhaven', $material->source);
        $this->assertSame('rock_face_03', $material->source_ref);
        $this->assertSame('https://polyhaven.com/a/rock_face_03', $material->source_url);
        $this->assertSame('Rob Tuytel', $material->author);
        $this->assertSame('CC0', $material->license);
        $this->assertSame(2.7, $material->tile_size);
        $this->assertSame(1024, $material->resolution);
        $this->assertContains('mossy', $material->tags);

        $disk = Storage::disk('public');
        $this->assertEqualsWithDelta(0xB0, $this->meanRgb($disk->get($material->roughness_path))[0], 3);
        $this->assertEqualsWithDelta(0xF0, $this->meanRgb($disk->get($material->ao_path))[0], 3);
        $this->assertSame([1024, 1024], [imagesx($img = imagecreatefromstring($disk->get($material->albedo_path))), imagesy($img)]);

        Http::assertNotSent(fn (Request $r) => str_contains($r->url(), '_arm_'));
        Http::assertSent(fn (Request $r) => str_contains($r->url(), 'jpg/1k/rock_face_03/rock_face_03_Diffuse_1k.jpg'));

        // The browser marks it as imported.
        $this->getJson('/api/materials/browse/polyhaven?q=rock')->assertJsonPath('items.0.imported_material_id', $material->id);
    }

    public function test_poly_haven_arm_is_split_when_ao_and_roughness_are_missing(): void
    {
        $this->fakePolyHaven('rock_face_03', ['Diffuse', 'nor_gl', 'Displacement', 'arm']);

        $this->post('/materials/import', ['source' => 'polyhaven', 'ref' => 'rock_face_03', 'resolution' => '2k', 'name' => 'My rock', 'category' => 'gravel']);

        $material = Material::query()->sole();
        $this->assertSame('ready', $material->status, (string) $material->status_message);
        $this->assertSame(['My rock', 'gravel', 2048], [$material->name, $material->category, $material->resolution]);
        $disk = Storage::disk('public');
        $this->assertEqualsWithDelta(100, $this->meanRgb($disk->get($material->ao_path))[0], 3);
        $this->assertEqualsWithDelta(200, $this->meanRgb($disk->get($material->roughness_path))[0], 3);
        $disk->assertExists($material->height_path);
    }

    public function test_a_failed_import_marks_the_material_failed_and_can_be_retried(): void
    {
        $online = false;
        Http::fake(['api.polyhaven.com/*' => function () use (&$online) {
            return $online ? null : Http::response(['error' => 'nope'], 404);
        }]);

        $this->post('/materials/import', ['source' => 'polyhaven', 'ref' => 'missing_thing', 'resolution' => '1k'])->assertRedirect();

        $material = Material::query()->sole();
        $this->assertSame('failed', $material->status);
        $this->assertStringContainsString('missing_thing', (string) $material->status_message);

        $online = true;
        $this->fakePolyHaven('missing_thing');
        $this->post("/materials/{$material->id}/retry")->assertRedirect();
        $this->assertSame('ready', $material->refresh()->status);
    }

    public function test_importing_from_ambientcg_zip_derives_missing_maps(): void
    {
        $zipPath = tempnam(sys_get_temp_dir(), 'zip');
        $zip = new ZipArchive;
        $zip->open($zipPath, ZipArchive::OVERWRITE);
        $zip->addFromString('Ground054_1K-JPG_Color.jpg', $this->jpeg($this->noiseImage(64, 64, 5, 0x806040)));
        $zip->addFromString('Ground054_1K-JPG_NormalDX.jpg', $this->jpeg($this->solidImage(64, 64, 0x8040FF)));
        $zip->addFromString('Ground054.usdc', 'binary');
        $zip->close();
        $zipBytes = (string) file_get_contents($zipPath);
        unlink($zipPath);

        Http::fake([
            'ambientcg.com/api/v2/full_json*' => Http::response(['foundAssets' => [[
                'assetId' => 'Ground054', 'displayName' => 'Ground 054', 'displayCategory' => 'Ground',
                'tags' => ['ground', 'dirt', 'brown'], 'dimensionX' => 250,
                'previewImage' => ['256-PNG' => 'https://acg-media.struffelproductions.com/file/ambientCG-Web/media/thumbnail/256-PNG/Ground054.png'],
            ]], 'numberOfResults' => 30]),
            'ambientcg.com/get*' => Http::response($zipBytes, 200, ['Content-Type' => 'application/zip']),
        ]);

        $this->getJson('/api/materials/browse/ambientcg?q=ground')
            ->assertOk()
            ->assertJsonPath('items.0.ref', 'Ground054')
            ->assertJsonPath('items.0.thumbnail_url', 'https://acg-media.struffelproductions.com/file/ambientCG-Web/media/thumbnail/256-PNG/Ground054.png')
            ->assertJsonPath('items.0.source_url', 'https://ambientcg.com/view?id=Ground054')
            ->assertJsonPath('items.0.license', 'CC0')
            ->assertJsonPath('has_more', true);

        $this->post('/materials/import', ['source' => 'ambientcg', 'ref' => 'Ground054', 'resolution' => '1k'])->assertSessionHasNoErrors();

        $material = Material::query()->sole();
        $this->assertSame('ready', $material->status, (string) $material->status_message);
        $this->assertSame(['Ground 054', 'soil', 'ambientcg', 'CC0', 2.5], [$material->name, $material->category, $material->source, $material->license, $material->tile_size]);
        Http::assertSent(fn (Request $r) => str_contains($r->url(), 'ambientcg.com/get') && str_contains(urldecode($r->url()), 'file=Ground054_1K-JPG.zip'));

        $disk = Storage::disk('public');
        [, $g] = $this->meanRgb($disk->get($material->normal_path));
        $this->assertEqualsWithDelta(0xBF, $g, 4, 'NormalDX green is flipped to OpenGL.');
        foreach (['roughness', 'ao', 'height'] as $map) {
            $disk->assertExists($material->{$map.'_path'});
        }
    }
}
