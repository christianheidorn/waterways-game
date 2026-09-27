<?php

namespace Tests\Feature\Foliage;

use App\Enums\FoliageKind;
use App\Jobs\GenerateFoliageAsset;
use App\Jobs\ImportFoliageAsset;
use App\Models\FoliageAsset;
use App\Models\FoliageType;
use App\Models\Map;
use App\Services\Ai\FoliagePrompts;
use App\Services\Ai\OpenRouterClient;
use App\Support\AiSettings;
use App\Support\GameManifest;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Storage;
use Inertia\Testing\AssertableInertia as Assert;
use Tests\Concerns\FakesOpenRouter;
use Tests\TestCase;
use ZipArchive;

class FoliageAssetTest extends TestCase
{
    use FakesOpenRouter;
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('public');
        Storage::fake('local');
        Http::preventStrayRequests();
    }

    private function fakePolyHaven(int $binBytes = 1200): void
    {
        Http::fake([
            'api.polyhaven.com/assets*' => Http::response([
                'fern_02' => ['name' => 'Fern 02', 'categories' => ['plants', 'nature', 'collection: pine_forest'], 'tags' => ['fern', 'jungle', 'pine'], 'polycount' => 6232, 'download_count' => 50, 'authors' => ['Rico Cilliers' => 'All']],
                'island_tree_02' => ['name' => 'Island Tree 02', 'categories' => ['nature', 'plants', 'trees'], 'tags' => ['tree'], 'polycount' => 1762064, 'download_count' => 90],
                'pine_tree_01' => ['name' => 'Pine Tree 01', 'categories' => ['nature', 'trees'], 'tags' => ['pine', 'needles'], 'polycount' => 17427094, 'download_count' => 999],
                'boulder_01' => ['name' => 'Boulder 01', 'categories' => ['rocks', 'nature'], 'tags' => ['rock'], 'polycount' => 123976, 'download_count' => 10],
                'food_apple_01' => ['name' => 'Food Apple 01', 'categories' => ['food', 'nature', 'plants'], 'tags' => ['fruit'], 'polycount' => 7012],
                'moon_rock_01' => ['name' => 'Moon Rock 01', 'categories' => ['rocks', 'collection: moon'], 'tags' => [], 'polycount' => 1000],
                'office_chair' => ['name' => 'Office Chair', 'categories' => ['furniture'], 'tags' => [], 'polycount' => 1000],
            ]),
            'api.polyhaven.com/info/fern_02' => Http::response(['name' => 'Fern 02', 'categories' => ['plants', 'nature'], 'tags' => ['fern'], 'polycount' => 6232, 'authors' => ['Rico Cilliers' => 'All']]),
            'api.polyhaven.com/files/fern_02' => Http::response(['Alpha' => ['1k' => ['jpg' => ['url' => 'https://dl.polyhaven.org/fern_02_alpha_1k.jpg'], 'png' => ['url' => 'https://dl.polyhaven.org/fern_02_alpha_1k.png']]], 'gltf' => ['1k' => ['gltf' => [
                'url' => 'https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/fern_02/fern_02_1k.gltf',
                'include' => [
                    'fern_02.bin' => ['size' => $binBytes, 'url' => 'https://dl.polyhaven.org/fern_02.bin'],
                    'textures/fern_02_diff_1k.jpg' => ['size' => 10, 'url' => 'https://dl.polyhaven.org/fern_02_diff_1k.jpg'],
                    '../../evil.txt' => ['size' => 1, 'url' => 'https://dl.polyhaven.org/evil.txt'],
                ],
            ]]]]),
            'dl.polyhaven.org/file/*' => Http::response('{"asset":{"version":"2.0"}}'),
            'dl.polyhaven.org/fern_02.bin' => Http::response(str_repeat('b', 64)),
            'dl.polyhaven.org/fern_02_diff_1k.jpg' => Http::response('jpeg'),
            'dl.polyhaven.org/evil.txt' => Http::response('evil'),
            'dl.polyhaven.org/fern_02_alpha_1k.jpg' => Http::response('alpha'),
        ]);
    }

    private function glb(): string
    {
        return 'glTF'.pack('V', 2).pack('V', 12);
    }

    public function test_browse_lists_only_foliage_models_with_kinds_and_heavy_flags(): void
    {
        $this->fakePolyHaven();
        FoliageAsset::query()->create(['name' => 'Fern', 'kind' => 'bush', 'source' => 'polyhaven', 'source_ref' => 'fern_02', 'status' => 'ready']);

        $items = collect($this->getJson('/api/foliage/browse/polyhaven')->assertOk()->json('items'))->keyBy('ref');

        $this->assertEqualsCanonicalizing(['fern_02', 'island_tree_02', 'pine_tree_01', 'boulder_01'], $items->keys()->all());
        $this->assertSame('bush', $items['fern_02']['kind'], 'Name beats the "pine" tag of the collection');
        $this->assertSame('broadleaf', $items['island_tree_02']['kind']);
        $this->assertSame('conifer', $items['pine_tree_01']['kind']);
        $this->assertSame('rock', $items['boulder_01']['kind']);
        $this->assertTrue($items['pine_tree_01']['too_heavy']);
        $this->assertFalse($items['island_tree_02']['too_heavy']);
        $this->assertNotNull($items['fern_02']['imported_asset_id']);
        $this->assertSame('pine_tree_01', $items->keys()->last(), 'Too heavy models sort last');

        $this->getJson('/api/foliage/browse/polyhaven?kind=rock')->assertOk()->assertJsonPath('total', 1);
        $this->getJson('/api/foliage/browse/polyhaven?q=island')->assertOk()->assertJsonPath('items.0.ref', 'island_tree_02');
    }

    public function test_import_downloads_the_gltf_with_its_files_and_waits_for_the_bake(): void
    {
        $this->fakePolyHaven();

        $this->post('/foliage/assets/import', ['refs' => ['fern_02']])->assertRedirect();

        $asset = FoliageAsset::query()->sole();
        $this->assertSame('polyhaven', $asset->source);
        $this->assertSame(FoliageKind::Bush, $asset->kind);
        $this->assertSame('awaiting_bake', $asset->status, (string) $asset->status_message);
        $this->assertSame("foliage/{$asset->id}/source/fern_02_1k.gltf", $asset->source_path);
        $this->assertSame('CC0', $asset->license);
        $this->assertSame('Rico Cilliers', $asset->author);
        $this->assertSame(6232, $asset->meta['source_polycount']);

        $disk = Storage::disk('public');
        $disk->assertExists("foliage/{$asset->id}/source/fern_02.bin");
        $disk->assertExists("foliage/{$asset->id}/source/textures/fern_02_diff_1k.jpg");
        $this->assertSame('alpha', $disk->get("foliage/{$asset->id}/source/textures/fern_02_alpha_1k.jpg"));
        $this->assertSame(str_repeat('b', 64), $disk->get("foliage/{$asset->id}/source/fern_02.bin"));
        Http::assertNotSent(fn (Request $r) => str_contains($r->url(), 'evil.txt'));

        // Importing again reuses the asset.
        $this->post('/foliage/assets/import', ['refs' => ['fern_02']])->assertRedirect();
        $this->assertSame(1, FoliageAsset::query()->count());

        $this->getJson("/api/foliage/assets/{$asset->id}")->assertOk()
            ->assertJsonPath('source_file_url', "/storage/foliage/{$asset->id}/source/fern_02_1k.gltf")
            ->assertJsonPath('model_url', null);
    }

    public function test_import_refuses_models_that_are_too_heavy(): void
    {
        $this->fakePolyHaven(binBytes: 400 * 1024 * 1024);

        $this->post('/foliage/assets/import', ['refs' => ['fern_02']])->assertRedirect();

        $asset = FoliageAsset::query()->sole();
        $this->assertSame('failed', $asset->status);
        $this->assertStringContainsString('too heavy', $asset->status_message);
        Http::assertNotSent(fn (Request $r) => str_contains($r->url(), 'fern_02.bin'));
    }

    public function test_upload_glb_and_zip_kits(): void
    {
        $this->post('/foliage/assets/upload', [
            'files' => [UploadedFile::fake()->createWithContent('Tree_Birch-02.glb', $this->glb())],
            'style' => 'stylized',
            'target_height' => 12,
        ])->assertRedirect()->assertSessionHasNoErrors();

        $birch = FoliageAsset::query()->sole();
        $this->assertSame('Tree Birch 02', $birch->name);
        $this->assertSame(FoliageKind::Broadleaf, $birch->kind);
        $this->assertSame('stylized', $birch->style);
        $this->assertSame(12.0, $birch->target_height);
        $this->assertSame('awaiting_bake', $birch->status);
        Storage::disk('public')->assertExists($birch->source_path);

        // A kit: glTF with external files, a GLB duplicate of the same model, a broken glTF and junk.
        $zipPath = tempnam(sys_get_temp_dir(), 'kit').'.zip';
        $zip = new ZipArchive;
        $zip->open($zipPath, ZipArchive::CREATE);
        $zip->addFromString('kit/glTF/Bush_1.gltf', json_encode(['buffers' => [['uri' => 'Bush_1.bin']], 'images' => [['uri' => '../Textures/Leaves%20A.png'], ['uri' => 'data:image/png;base64,AAAA']]]));
        $zip->addFromString('kit/glTF/Bush_1.bin', 'bin');
        $zip->addFromString('kit/Textures/Leaves A.png', 'png');
        $zip->addFromString('kit/glTF/Rock_Big.gltf', json_encode(['buffers' => [['uri' => 'missing.bin']]]));
        $zip->addFromString('kit/glb/Rock_Big.glb', $this->glb());
        $zip->addFromString('kit/glb/Pine_3.glb', $this->glb());
        $zip->addFromString('__MACOSX/kit/._Pine_3.glb', 'junk');
        $zip->addFromString('kit/readme.txt', 'CC0');
        $zip->close();

        $this->post('/foliage/assets/upload', [
            'files' => [new UploadedFile($zipPath, 'Stylized Nature.zip', 'application/zip', null, true)],
            'style' => 'stylized',
        ])->assertRedirect()->assertSessionHasNoErrors();

        $assets = FoliageAsset::query()->whereKeyNot($birch->id)->get()->keyBy('name');
        $this->assertEqualsCanonicalizing(['Bush 1', 'Rock Big', 'Pine 3'], $assets->keys()->all());
        $this->assertSame(FoliageKind::Rock, $assets['Rock Big']->kind);
        $this->assertSame(FoliageKind::Conifer, $assets['Pine 3']->kind);
        $this->assertStringEndsWith('.glb', $assets['Rock Big']->source_path, 'The GLB variant wins over the broken glTF');

        $bush = $assets['Bush 1'];
        $disk = Storage::disk('public');
        $this->assertSame("foliage/{$bush->id}/source/kit/glTF/Bush_1.gltf", $bush->source_path);
        $disk->assertExists("foliage/{$bush->id}/source/kit/glTF/Bush_1.bin");
        $this->assertSame('png', $disk->get("foliage/{$bush->id}/source/kit/Textures/Leaves A.png"));
        $this->assertSame(['foliage/'.$bush->id.'/source/kit'], $disk->directories("foliage/{$bush->id}/source"), 'Only the model\'s own files are extracted');
        $disk->assertMissing("foliage/{$bush->id}/source/kit/readme.txt");
    }

    public function test_upload_rejects_non_models(): void
    {
        $this->post('/foliage/assets/upload', [
            'files' => [UploadedFile::fake()->createWithContent('tree.glb', 'not a glb')],
            'style' => 'realistic',
        ])->assertSessionHasErrors('files');

        $this->post('/foliage/assets/upload', [
            'files' => [UploadedFile::fake()->createWithContent('tree.gltf', json_encode(['buffers' => [['uri' => 'tree.bin']]]))],
            'style' => 'realistic',
        ])->assertSessionHasErrors('files');

        $this->assertSame(0, FoliageAsset::query()->count());
    }

    public function test_bake_upload_makes_the_asset_ready_and_feeds_the_game(): void
    {
        $asset = FoliageAsset::query()->create(['name' => 'Fern', 'kind' => 'bush', 'source' => 'upload', 'status' => 'awaiting_bake', 'source_path' => 'foliage/1/source/model.glb']);
        $type = FoliageType::query()->create([
            'name' => 'Fern', 'kind' => 'bush', 'color' => '#335522', 'color_secondary' => '#443322', 'foliage_asset_id' => $asset->id,
        ]);
        $this->assertNull($type->toGameArray()['model_url'], 'No model until baked');

        $this->post("/api/foliage/assets/{$asset->id}/bake", [
            'model' => UploadedFile::fake()->createWithContent('model.glb', 'nope'),
            'thumbnail' => UploadedFile::fake()->image('thumb.png', 64, 64),
            'meta' => '{}',
        ], ['Accept' => 'application/json'])->assertStatus(422);

        $this->post("/api/foliage/assets/{$asset->id}/bake", [
            'model' => UploadedFile::fake()->createWithContent('model.glb', $this->glb()),
            'thumbnail' => UploadedFile::fake()->image('thumb.png', 64, 64),
            'meta' => json_encode(['height' => 1.234, 'width' => 900, 'triangles' => [8000, 2000, 6, 'x'], 'lod_distances' => [0, 0.25, 7], 'evil' => '<script>']),
        ], ['Accept' => 'application/json'])->assertOk()->assertJsonPath('status', 'ready');

        $asset->refresh();
        $this->assertSame('ready', $asset->status);
        $this->assertSame(1.234, $asset->meta['height']);
        $this->assertEquals(200, $asset->meta['width']);
        $this->assertSame([8000, 2000, 6], $asset->meta['triangles']);
        $this->assertEquals([0, 0.25, 1], $asset->meta['lod_distances']);
        $this->assertArrayNotHasKey('evil', $asset->meta);
        Storage::disk('public')->assertExists($asset->model_path);

        $map = Map::factory()->create();
        $game = collect(app(GameManifest::class)->build($map)['foliage_types'])->firstWhere('id', $type->id);
        $this->assertStringStartsWith("/storage/foliage/{$asset->id}/model-", $game['model_url']);
        $this->assertSame($asset->id, $game['asset']['id']);
        $this->assertSame([8000, 2000, 6], $game['asset']['triangles']);
        $this->assertSame('#ffffff', $game['tint']);

        $this->postJson("/api/foliage/assets/{$asset->id}/bake-failed", ['message' => 'WebGL context lost'])->assertOk();
        $this->assertSame('failed', $asset->refresh()->status);
        $this->assertStringContainsString('WebGL context lost', $asset->status_message);
    }

    public function test_editing_height_or_kind_rebakes_and_deleting_unlinks_types(): void
    {
        $asset = FoliageAsset::query()->create(['name' => 'Oak', 'kind' => 'broadleaf', 'source' => 'upload', 'status' => 'ready', 'meta' => ['height' => 10]]);
        $asset->update(['source_path' => "foliage/{$asset->id}/source/model.glb", 'model_path' => "foliage/{$asset->id}/model.glb"]);
        Storage::disk('public')->put($asset->source_path, $this->glb());

        $this->put("/foliage/assets/{$asset->id}", ['name' => 'Oak', 'kind' => 'broadleaf', 'style' => 'realistic', 'target_height' => 10])->assertRedirect();
        $this->assertSame('ready', $asset->refresh()->status, 'Same height: nothing to re-bake');

        $this->put("/foliage/assets/{$asset->id}", ['name' => 'English oak', 'kind' => 'broadleaf', 'style' => 'realistic', 'target_height' => 22])->assertRedirect();
        $this->assertSame('awaiting_bake', $asset->refresh()->status);
        $this->assertSame(22.0, $asset->target_height);

        $this->post("/foliage/assets/{$asset->id}/create-type")->assertRedirect();
        $type = FoliageType::query()->sole();
        $this->assertSame('English oak', $type->name);
        $this->assertSame($asset->id, $type->foliage_asset_id);
        $this->assertSame('broadleaf', $type->kind->value);

        $this->delete("/foliage/assets/{$asset->id}")->assertRedirect();
        $this->assertNull($type->refresh()->foliage_asset_id);
        Storage::disk('public')->assertMissing("foliage/{$asset->id}/source/model.glb");
    }

    public function test_generation_is_queued_and_the_job_stores_a_card(): void
    {
        Queue::fake();
        $this->post('/foliage/assets/generate', ['prompt' => 'heather', 'kind' => 'flower', 'style' => 80, 'target_height' => 0.4, 'variants' => 2])
            ->assertSessionHasErrors('ai');

        $this->configureAi();
        $this->post('/foliage/assets/generate', ['prompt' => 'boulder', 'kind' => 'rock', 'style' => 10, 'target_height' => 1, 'variants' => 1])
            ->assertSessionHasErrors('kind');

        $this->post('/foliage/assets/generate', ['prompt' => 'Purple heather in bloom', 'kind' => 'flower', 'style' => 80, 'target_height' => 0.4, 'variants' => 2])
            ->assertRedirect()->assertSessionHasNoErrors();

        $this->assertSame(2, FoliageAsset::query()->count());
        Queue::assertPushed(GenerateFoliageAsset::class, 2);
        $asset = FoliageAsset::query()->first();
        $this->assertSame('stylized', $asset->style);
        $this->assertSame('card', $asset->source_type);
        $this->assertSame(0.4, $asset->target_height);
    }

    public function test_generation_job_uses_a_transparent_background_when_the_model_supports_it(): void
    {
        $this->configureAi();
        $png = base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');
        $models = $this->imageModelsResponse();
        $models['data'][] = [
            'id' => 'openai/gpt-image-2', 'name' => 'GPT Image',
            'supported_parameters' => [
                'background' => ['type' => 'enum', 'values' => ['auto', 'transparent', 'opaque']],
                'aspect_ratio' => ['type' => 'enum', 'values' => ['1:1', '2:3', '3:4']],
                'quality' => ['type' => 'enum', 'values' => ['low', 'high']],
            ],
        ];
        $this->fakeOpenRouter(png: $png, extra: ['openrouter.ai/api/v1/images/models' => Http::response($models)]);

        $conifer = FoliageAsset::query()->create(['name' => 'Pine', 'kind' => 'conifer', 'source' => 'ai', 'status' => 'queued', 'target_height' => 20]);
        (new GenerateFoliageAsset($conifer, ['prompt' => 'Scots pine', 'model' => 'openai/gpt-image-2', 'style' => 10]))->handle(
            app(OpenRouterClient::class), app(AiSettings::class), app(FoliagePrompts::class),
        );

        $conifer->refresh();
        $this->assertSame('awaiting_bake', $conifer->status);
        $this->assertSame("foliage/{$conifer->id}/source/card.png", $conifer->source_path);
        $this->assertFalse($conifer->bake_options['key_background']);
        $this->assertStringContainsString('transparent background', $conifer->ai_prompt);
        Http::assertSent(fn (Request $r) => str_ends_with($r->url(), '/images')
            && $r['background'] === 'transparent' && $r['aspect_ratio'] === '2:3' && $r['quality'] === 'high');

        // A model without background support: white background, keyed out by the baker.
        $grass = FoliageAsset::query()->create(['name' => 'Grass', 'kind' => 'grass', 'source' => 'ai', 'status' => 'queued', 'target_height' => 0.5]);
        (new GenerateFoliageAsset($grass, ['prompt' => 'dry grass']))->handle(
            app(OpenRouterClient::class), app(AiSettings::class), app(FoliagePrompts::class),
        );
        $grass->refresh();
        $this->assertTrue($grass->bake_options['key_background']);
        $this->assertStringContainsString('pure white', $grass->ai_prompt);
    }

    public function test_foliage_page_lists_types_assets_and_maps(): void
    {
        FoliageAsset::query()->create(['name' => 'Fern', 'kind' => 'bush', 'source' => 'upload', 'status' => 'ready', 'model_path' => 'foliage/1/model.glb', 'meta' => ['height' => 1.1, 'triangles' => [900, 200]]]);
        Map::factory()->realWorld(46.3, 14.1)->create(['name' => 'Alps']);

        $this->get('/foliage')->assertOk()->assertInertia(fn (Assert $page) => $page
            ->component('foliage/index')
            ->has('assets', 1)
            ->where('assets.0.height', 1.1)
            ->where('assets.0.status', 'ready')
            ->has('maps', 1)
            ->where('maps.0.real_world', true)
            ->has('ai.configured')
            ->missing('ai.api_key')
        );
    }

    public function test_type_form_links_an_asset_and_tint(): void
    {
        $asset = FoliageAsset::query()->create(['name' => 'Fern', 'kind' => 'bush', 'source' => 'upload', 'status' => 'ready']);

        $this->post('/foliage', [
            'name' => 'Fern', 'kind' => 'bush', 'color' => '#335522', 'color_secondary' => '#443322',
            'min_scale' => 0.8, 'max_scale' => 1.2, 'density' => 2, 'min_slope' => 0, 'max_slope' => 30,
            'align_to_normal' => false, 'random_yaw' => true, 'cast_shadows' => true, 'cull_distance' => 300, 'allow_underwater' => false,
            'foliage_asset_id' => $asset->id, 'tint' => '#eeffee',
        ])->assertRedirect()->assertSessionHasNoErrors();

        $type = FoliageType::query()->sole();
        $this->assertSame($asset->id, $type->foliage_asset_id);
        $this->assertSame('#eeffee', $type->tint);
    }

    public function test_import_job_is_queued(): void
    {
        Queue::fake();
        $this->fakePolyHaven();

        $this->post('/foliage/assets/import', ['refs' => ['fern_02', 'boulder_01']])->assertRedirect();

        Queue::assertPushed(ImportFoliageAsset::class, 2);
        $this->assertSame(FoliageKind::Rock, FoliageAsset::query()->where('source_ref', 'boulder_01')->sole()->kind);
    }
}
