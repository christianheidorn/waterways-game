<?php

namespace Tests\Feature\Mcp;

use App\Jobs\GenerateFoliageAsset;
use App\Jobs\GenerateMaterial as GenerateMaterialJob;
use App\Jobs\GenerateMeshyAsset;
use App\Jobs\GenerateMeshyProp;
use App\Mcp\Assets\GltfInspector;
use App\Mcp\EditorBridge;
use App\Mcp\Servers\WaterwaysServer;
use App\Mcp\Tools\BakeFoliageAsset;
use App\Mcp\Tools\GenerateImage;
use App\Mcp\Tools\GenerateMaterial;
use App\Mcp\Tools\GenerateModel;
use App\Mcp\Tools\GetAssetStatus;
use App\Mcp\Tools\ImportModel;
use App\Mcp\Tools\ListPropModels;
use App\Models\FoliageAsset;
use App\Models\FoliageType;
use App\Models\Map;
use App\Models\Material;
use App\Models\PropModel;
use App\Support\AiSettings;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request as HttpRequest;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Sleep;
use Tests\Concerns\FakesOpenRouter;
use Tests\TestCase;

class AssetToolsTest extends TestCase
{
    use FakesOpenRouter;
    use RefreshDatabase;

    private string $dir;

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('public');
        Http::preventStrayRequests();
        Sleep::fake();
        $this->dir = sys_get_temp_dir().'/ww-asset-test-'.uniqid();
        mkdir($this->dir);
    }

    protected function tearDown(): void
    {
        foreach (glob($this->dir.'/*') ?: [] as $file) {
            unlink($file);
        }
        rmdir($this->dir);
        parent::tearDown();
    }

    /**
     * A tiny valid GLB: one triangle spanning 1 × 2 × 0.5 m, under a node scaled by 2 (so 2 × 4 × 1 m).
     */
    private function glb(): string
    {
        $bin = pack('g*', 0, 0, 0, 1, 0, 0, 0, 2, 0.5);
        $json = json_encode([
            'asset' => ['version' => '2.0', 'generator' => 'test'],
            'scene' => 0,
            'scenes' => [['nodes' => [0]]],
            'nodes' => [['children' => [1], 'scale' => [2, 2, 2]], ['mesh' => 0, 'translation' => [5, 0, 0]]],
            'meshes' => [['primitives' => [['attributes' => ['POSITION' => 0]]]]],
            'accessors' => [['bufferView' => 0, 'componentType' => 5126, 'count' => 3, 'type' => 'VEC3', 'min' => [0, 0, 0], 'max' => [1, 2, 0.5]]],
            'bufferViews' => [['buffer' => 0, 'byteLength' => strlen($bin)]],
            'buffers' => [['byteLength' => strlen($bin)]],
        ]);
        $json .= str_repeat(' ', (4 - strlen($json) % 4) % 4);
        $body = pack('V2', strlen($json), 0x4E4F534A).$json.pack('V2', strlen($bin), 0x004E4942).$bin;

        return 'glTF'.pack('V2', 2, 12 + strlen($body)).$body;
    }

    /**
     * A GLB whose JSON describes a heavy model (the inspector reads only the JSON): 12 meshes with 10
     * materials, 30k triangles in all.
     */
    private function heavyGlb(): string
    {
        $bin = str_repeat("\0", 12);
        $primitives = array_map(fn ($i) => ['attributes' => ['POSITION' => 0], 'indices' => 1, 'material' => $i % 10], range(0, 11));
        $json = json_encode([
            'asset' => ['version' => '2.0'],
            'scene' => 0,
            'scenes' => [['nodes' => [0]]],
            'nodes' => [['mesh' => 0]],
            'meshes' => [['primitives' => $primitives]],
            'materials' => array_fill(0, 10, ['name' => 'm']),
            'accessors' => [
                ['bufferView' => 0, 'componentType' => 5126, 'count' => 1, 'type' => 'VEC3', 'min' => [0, 0, 0], 'max' => [1, 12, 1]],
                ['bufferView' => 0, 'componentType' => 5125, 'count' => 7500, 'type' => 'SCALAR'],
            ],
            'bufferViews' => [['buffer' => 0, 'byteLength' => strlen($bin)]],
            'buffers' => [['byteLength' => strlen($bin)]],
        ]);
        $json .= str_repeat(' ', (4 - strlen($json) % 4) % 4);
        $body = pack('V2', strlen($json), 0x4E4F534A).$json.pack('V2', strlen($bin), 0x004E4942).$bin;

        return 'glTF'.pack('V2', 2, 12 + strlen($body)).$body;
    }

    private function file(string $name, string $contents): string
    {
        file_put_contents($this->dir.'/'.$name, $contents);

        return $this->dir.'/'.$name;
    }

    private function png(int $size = 32): string
    {
        $image = imagecreatetruecolor($size, $size);
        imagefill($image, 0, 0, (int) imagecolorallocate($image, 90, 120, 60));
        ob_start();
        imagepng($image);

        return (string) ob_get_clean();
    }

    public function test_dimensions_follow_the_node_hierarchy(): void
    {
        $doc = GltfInspector::document($this->glb());

        $this->assertNotNull($doc);
        $this->assertSame(['x' => 2.0, 'y' => 4.0, 'z' => 1.0], GltfInspector::dimensions($doc));
        $this->assertNull(GltfInspector::document('not a model'));
    }

    public function test_stats_count_triangles_meshes_and_materials_through_the_hierarchy(): void
    {
        $this->assertSame(['triangles' => 1, 'meshes' => 1, 'materials' => 1], GltfInspector::stats(GltfInspector::document($this->glb()) ?? []));

        $doc = [
            'asset' => ['version' => '2.0'],
            'scenes' => [['nodes' => [0, 3]]],
            'nodes' => [
                ['children' => [1, 2]],
                ['mesh' => 0],
                // The same mesh again: drawn twice.
                ['mesh' => 0, 'translation' => [3, 0, 0]],
                ['mesh' => 1, 'extensions' => ['EXT_mesh_gpu_instancing' => ['attributes' => ['TRANSLATION' => 4]]]],
                // Not in the scene.
                ['mesh' => 0],
            ],
            'meshes' => [
                ['primitives' => [
                    ['attributes' => ['POSITION' => 0], 'indices' => 1, 'material' => 0],
                    ['attributes' => ['POSITION' => 0], 'material' => 1],
                    ['attributes' => ['POSITION' => 0], 'mode' => 1],
                ]],
                ['primitives' => [['attributes' => ['POSITION' => 2], 'indices' => 3, 'mode' => 5, 'material' => 0]]],
            ],
            'accessors' => [['count' => 30], ['count' => 300], ['count' => 12], ['count' => 12], ['count' => 5]],
        ];

        // Mesh 0: 100 + 10 triangles (+ lines) twice; mesh 1: a 12-index strip (10) × 5 instances.
        $this->assertSame(['triangles' => 270, 'meshes' => 7, 'materials' => 3], GltfInspector::stats($doc));
    }

    public function test_import_model_warns_about_props_over_budget(): void
    {
        WaterwaysServer::tool(ImportModel::class, ['kind' => 'prop', 'path' => $this->file('pine_tree.glb', $this->heavyGlb()), 'category' => 'nature'])
            ->assertOk()
            ->assertSee(['"triangles": 30000', '"materials": 10', 'warnings', 'decimate', 'Merge materials', 'import trees, bushes and plants as foliage', 'profile_performance']);

        $prop = PropModel::query()->sole();
        $this->assertSame([30000, 12, 10], [$prop->triangles, $prop->meshes, $prop->materials]);
        $this->assertSame(30000, $prop->toGameArray()['triangles']);

        // Models from before triangles were recorded are measured from their file on first look.
        $prop->forceFill(['triangles' => null, 'meshes' => null, 'materials' => null])->save();
        WaterwaysServer::tool(ListPropModels::class, [])->assertOk()->assertSee(['"triangles": 30000', 'budget_warnings']);
        $this->assertSame(30000, $prop->refresh()->triangles);
    }

    public function test_import_model_stores_a_prop_from_a_local_glb(): void
    {
        $path = $this->file('fishing_hut.glb', $this->glb());

        WaterwaysServer::tool(ImportModel::class, ['kind' => 'prop', 'path' => $path, 'category' => 'building', 'target_height' => 4.5, 'tags' => ['wood']])
            ->assertOk()
            ->assertSee(['"status": "ready"', 'Fishing Hut', 'place_props']);

        $prop = PropModel::query()->sole();
        $this->assertSame("props/{$prop->id}/model.glb", $prop->model_path);
        $this->assertSame(['x' => 2, 'y' => 4, 'z' => 1], $prop->dimensions);
        $this->assertSame(4.5, $prop->target_height);
        $this->assertSame(['wood'], $prop->tags);
        $this->assertSame($this->glb(), Storage::disk('public')->get($prop->model_path));

        WaterwaysServer::tool(ListPropModels::class, ['search' => 'wood'])->assertOk()->assertSee('Fishing Hut');
        WaterwaysServer::tool(GetAssetStatus::class, ['type' => 'prop_model', 'id' => $prop->id])->assertOk()->assertSee('"dimensions_m"');
    }

    public function test_import_model_rejects_bad_sources(): void
    {
        WaterwaysServer::tool(ImportModel::class, ['kind' => 'prop', 'path' => $this->dir.'/missing.glb'])
            ->assertHasErrors(['No file at']);
        WaterwaysServer::tool(ImportModel::class, ['kind' => 'prop', 'path' => $this->file('hut.obj', 'v 0 0 0')])
            ->assertHasErrors(['Only .glb and .gltf']);
        WaterwaysServer::tool(ImportModel::class, ['kind' => 'prop', 'path' => $this->file('fake.glb', 'hello world, not a model')])
            ->assertHasErrors(['not a binary glTF']);
        WaterwaysServer::tool(ImportModel::class, ['kind' => 'prop'])
            ->assertHasErrors(['exactly one of path']);

        $big = $this->file('huge.glb', '');
        $handle = fopen($big, 'r+');
        ftruncate($handle, 101 * 1024 * 1024);
        fclose($handle);
        WaterwaysServer::tool(ImportModel::class, ['kind' => 'prop', 'path' => $big])
            ->assertHasErrors(['limited to 100 MB']);

        $gltf = $this->file('embedded.gltf', json_encode(['asset' => ['version' => '2.0']]));
        WaterwaysServer::tool(ImportModel::class, ['kind' => 'prop', 'path' => $gltf])
            ->assertHasErrors(['Props must be binary glTF']);

        WaterwaysServer::tool(ImportModel::class, ['kind' => 'prop', 'url' => 'file:///etc/passwd'])
            ->assertHasErrors(['Only http(s) URLs']);

        $this->assertSame(0, PropModel::query()->count());
    }

    public function test_import_model_downloads_urls_and_accepts_base64(): void
    {
        Http::fake([
            'models.example.com/bridge.glb' => Http::response($this->glb()),
            'models.example.com/gone.glb' => Http::response('nope', 404),
        ]);

        WaterwaysServer::tool(ImportModel::class, ['kind' => 'prop', 'url' => 'https://models.example.com/bridge.glb', 'category' => 'structure'])
            ->assertOk()->assertSee(['Bridge', '"source": "url"']);
        WaterwaysServer::tool(ImportModel::class, ['kind' => 'prop', 'url' => 'https://models.example.com/gone.glb'])
            ->assertHasErrors(['HTTP 404']);
        WaterwaysServer::tool(ImportModel::class, ['kind' => 'prop', 'base64' => base64_encode($this->glb()), 'file_name' => 'crate.glb', 'name' => 'Crate'])
            ->assertOk()->assertSee('"name": "Crate"');
        WaterwaysServer::tool(ImportModel::class, ['kind' => 'prop', 'base64' => '###'])
            ->assertHasErrors(['not valid base64']);

        $this->assertSame(2, PropModel::query()->where('status', 'ready')->count());
    }

    public function test_import_model_creates_a_foliage_asset_and_type_waiting_for_a_bake(): void
    {
        $path = $this->file('old_oak.glb', $this->glb());

        WaterwaysServer::tool(ImportModel::class, ['kind' => 'foliage', 'path' => $path, 'foliage_kind' => 'broadleaf', 'target_height' => 12, 'create_type' => true])
            ->assertOk()
            ->assertSee(['"status": "awaiting_bake"', 'bake_foliage_asset']);

        $asset = FoliageAsset::query()->sole();
        $this->assertSame('broadleaf', $asset->kind->value);
        $this->assertSame(12.0, $asset->target_height);
        Storage::disk('public')->assertExists($asset->source_path);
        $this->assertSame($asset->id, FoliageType::query()->sole()->foliage_asset_id);
    }

    public function test_a_gltf_with_external_files_is_imported_as_foliage(): void
    {
        $bin = pack('g*', 0, 0, 0, 1, 0, 0, 0, 1, 0);
        $this->file('fern.bin', $bin);
        $gltf = $this->file('fern.gltf', json_encode([
            'asset' => ['version' => '2.0'],
            'buffers' => [['uri' => 'fern.bin', 'byteLength' => strlen($bin)]],
        ]));

        WaterwaysServer::tool(ImportModel::class, ['kind' => 'foliage', 'path' => $gltf, 'name' => 'Fern', 'bake' => false])
            ->assertOk()->assertSee('"name": "Fern"');

        $asset = FoliageAsset::query()->sole();
        $this->assertStringEndsWith('fern.gltf', $asset->source_path);
        Storage::disk('public')->assertExists(dirname($asset->source_path).'/fern.bin');

        unlink($this->dir.'/fern.bin');
        WaterwaysServer::tool(ImportModel::class, ['kind' => 'foliage', 'path' => $gltf])
            ->assertHasErrors(['references "fern.bin", which is missing']);
    }

    public function test_foliage_assets_are_baked_in_the_open_editor(): void
    {
        $map = Map::factory()->create();
        $editor = new FakeEditor($map, function (string $type, array $payload) {
            // The editor bakes and uploads the result (see bakeFoliageAsset.ts).
            FoliageAsset::query()->whereKey($payload['asset_id'])->update(['status' => 'ready', 'model_path' => 'foliage/x/model.glb', 'status_message' => null]);

            return ['started' => true];
        });
        $this->app->instance(EditorBridge::class, $editor);

        WaterwaysServer::tool(ImportModel::class, ['kind' => 'foliage', 'path' => $this->file('pine.glb', $this->glb()), 'foliage_kind' => 'conifer'])
            ->assertOk()
            ->assertSee(['"status": "ready"', 'save_foliage_type']);

        $this->assertSame('bake_foliage_asset', $editor->ran[0]['type']);
        $payload = $editor->ran[0]['payload'];
        $asset = FoliageAsset::query()->sole();
        $this->assertSame('conifer', $payload['kind']);
        $this->assertSame('model', $payload['source_type']);
        $this->assertSame('/storage/'.$asset->source_path, $payload['source_url']);
        $this->assertSame("/api/foliage/assets/{$asset->id}/bake", $payload['bake_url']);

        WaterwaysServer::tool(BakeFoliageAsset::class, ['asset_id' => $asset->id])
            ->assertHasErrors(['is ready, not waiting']);
    }

    public function test_bake_foliage_asset_needs_an_open_editor(): void
    {
        $asset = FoliageAsset::query()->create(['name' => 'Reed', 'kind' => 'reed', 'source' => 'upload', 'source_type' => 'model',
            'source_path' => 'foliage/1/source/model.glb', 'status' => 'awaiting_bake']);
        Storage::disk('public')->put($asset->source_path, $this->glb());

        WaterwaysServer::tool(BakeFoliageAsset::class, ['asset_id' => $asset->id])
            ->assertHasErrors(['No editor is open']);
    }

    public function test_generate_image_stores_and_returns_the_image_without_leaking_the_key(): void
    {
        WaterwaysServer::tool(GenerateImage::class, ['prompt' => 'a hut'])
            ->assertHasErrors(['OpenRouter is not configured']);

        $this->configureAi();
        $this->fakeOpenRouter(png: $this->png());

        WaterwaysServer::tool(GenerateImage::class, ['prompt' => 'a wooden fishing hut', 'purpose' => 'reference', 'aspect_ratio' => '16:9'])
            ->assertOk()
            ->assertSee(['agent-images/', 'Reference image for 3D modelling', '"cost_usd": 0.039'])
            ->assertDontSee('secretabcd');

        $files = Storage::disk('public')->files('agent-images');
        $this->assertCount(1, $files);
        $this->assertSame($this->png(), Storage::disk('public')->get($files[0]));
        Http::assertSent(fn (HttpRequest $r) => str_ends_with($r->url(), '/images') && $r['aspect_ratio'] === '16:9'
            && str_contains($r['prompt'], 'wooden fishing hut'));

        // A stored image can guide the next one.
        WaterwaysServer::tool(GenerateImage::class, ['prompt' => 'same hut at night', 'reference_images' => [$files[0]]])->assertOk();
        Http::assertSent(fn (HttpRequest $r) => str_ends_with($r->url(), '/images') && count($r['input_references'] ?? []) === 1);
    }

    public function test_generate_image_reports_openrouter_failures(): void
    {
        $this->configureAi();
        $this->fakeOpenRouter(extra: ['openrouter.ai/api/v1/images' => Http::response(['error' => ['message' => 'Insufficient credits']], 402)]);

        WaterwaysServer::tool(GenerateImage::class, ['prompt' => 'a hut'])
            ->assertHasErrors(['Image generation failed', 'Insufficient credits']);
        $this->assertSame([], Storage::disk('public')->files('agent-images'));
    }

    public function test_generate_material_queues_ai_generation_or_builds_from_an_image(): void
    {
        Queue::fake();

        WaterwaysServer::tool(GenerateMaterial::class, ['prompt' => 'mossy forest floor'])
            ->assertHasErrors(['OpenRouter is not configured']);

        $this->configureAi();
        WaterwaysServer::tool(GenerateMaterial::class, ['prompt' => 'mossy forest floor', 'category' => 'forest', 'tile_size' => 3, 'name' => 'Moss'])
            ->assertOk()
            ->assertSee(['"name": "Moss"', '"status": "processing"', 'get_asset_status'])
            ->assertDontSee('secretabcd');
        Queue::assertPushed(GenerateMaterialJob::class, fn ($job) => $job->options['prompt'] === 'mossy forest floor' && $job->options['category'] === 'forest');

        Storage::disk('public')->put('agent-images/0b8a4c52-1111-4c2d-9d6f-000000000001.png', $this->png(64));
        WaterwaysServer::tool(GenerateMaterial::class, ['image_path' => 'agent-images/0b8a4c52-1111-4c2d-9d6f-000000000001.png', 'category' => 'grass', 'name' => 'Painted grass'])
            ->assertOk()
            ->assertSee(['"status": "ready"', 'update_terrain_layer']);
        $this->assertTrue(Material::query()->where('name', 'Painted grass')->sole()->isReady());

        WaterwaysServer::tool(GenerateMaterial::class, ['prompt' => 'x', 'image_path' => 'y'])
            ->assertHasErrors(['either prompt']);
    }

    public function test_generate_model_queues_meshy_props_and_foliage(): void
    {
        Queue::fake();

        WaterwaysServer::tool(GenerateModel::class, ['kind' => 'prop', 'prompt' => 'stone bridge'])
            ->assertHasErrors(['Meshy is not configured']);

        app(AiSettings::class)->update(['meshy_api_key' => 'msy_secret_key_9876']);

        WaterwaysServer::tool(GenerateModel::class, ['kind' => 'prop', 'prompt' => 'stone bridge', 'category' => 'structure', 'target_height' => 3])
            ->assertOk()
            ->assertSee(['"status": "processing"', 'Queued for Meshy'])
            ->assertDontSee('9876');
        Queue::assertPushed(GenerateMeshyProp::class, fn ($job) => $job->options['route'] === 'text' && $job->options['prompt'] === 'stone bridge');

        WaterwaysServer::tool(GenerateModel::class, ['kind' => 'prop', 'prompt' => 'hut', 'engine' => 'meshy_image'])
            ->assertHasErrors(['needs image_path']);

        WaterwaysServer::tool(GenerateModel::class, ['kind' => 'foliage', 'prompt' => 'Scots pine', 'foliage_kind' => 'conifer'])
            ->assertOk()->assertSee('"status": "queued"');
        Queue::assertPushed(GenerateMeshyAsset::class);

        WaterwaysServer::tool(GenerateModel::class, ['kind' => 'foliage', 'prompt' => 'boulder', 'foliage_kind' => 'rock', 'engine' => 'card', 'target_height' => 1])
            ->assertHasErrors(['Rocks cannot be flat cards']);

        $this->configureAi();
        WaterwaysServer::tool(GenerateModel::class, ['kind' => 'foliage', 'prompt' => 'daisies', 'foliage_kind' => 'flower', 'engine' => 'card', 'target_height' => 0.4])
            ->assertOk();
        Queue::assertPushed(GenerateFoliageAsset::class);
    }

    public function test_the_meshy_prop_job_stores_a_measured_glb(): void
    {
        app(AiSettings::class)->update(['meshy_api_key' => 'msy_secret_key_9876']);
        Http::fake([
            'api.meshy.ai/openapi/v2/text-to-3d/prev-1' => Http::response(['id' => 'prev-1', 'status' => 'SUCCEEDED', 'progress' => 100]),
            'api.meshy.ai/openapi/v2/text-to-3d/ref-1' => Http::response(['id' => 'ref-1', 'status' => 'SUCCEEDED', 'progress' => 100,
                'model_urls' => ['glb' => 'https://assets.meshy.ai/tasks/ref-1/model.glb']]),
            'api.meshy.ai/openapi/v2/text-to-3d' => fn (HttpRequest $r) => Http::response(['result' => $r['mode'] === 'preview' ? 'prev-1' : 'ref-1']),
            'assets.meshy.ai/*' => Http::response($this->glb()),
        ]);

        $prop = PropModel::query()->create(['name' => 'Bridge', 'category' => 'structure', 'source' => 'meshy', 'status' => 'processing']);
        dispatch_sync(new GenerateMeshyProp($prop, ['route' => 'text', 'prompt' => 'stone bridge', 'style' => 20]));

        $prop->refresh();
        $this->assertTrue($prop->isReady(), (string) $prop->status_message);
        $this->assertSame("props/{$prop->id}/model.glb", $prop->model_path);
        $this->assertSame(['x' => 2, 'y' => 4, 'z' => 1], $prop->dimensions);
        $this->assertSame(1, $prop->triangles);
        $this->assertNull($prop->status_message, 'Within budget: no warning');
        Http::assertSent(fn (HttpRequest $r) => $r->url() === 'https://api.meshy.ai/openapi/v2/text-to-3d' && $r['mode'] === 'preview'
            && str_contains($r['prompt'], 'stone bridge') && str_contains($r['prompt'], 'game-ready 3D prop')
            && $r['target_polycount'] === GenerateMeshyProp::POLYCOUNT);
    }

    public function test_get_asset_status_reports_materials_and_unknown_ids(): void
    {
        $material = Material::query()->create(['name' => 'Mud', 'slug' => 'mud', 'category' => 'mud', 'tile_size' => 2, 'status' => 'failed', 'status_message' => 'Generation failed: boom']);

        WaterwaysServer::tool(GetAssetStatus::class, ['type' => 'material', 'id' => $material->id])
            ->assertOk()->assertSee(['"status": "failed"', 'boom']);
        WaterwaysServer::tool(GetAssetStatus::class, ['type' => 'prop_model', 'id' => 999])
            ->assertHasErrors(['No prop model 999']);
    }
}
