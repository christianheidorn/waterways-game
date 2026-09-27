<?php

namespace Tests\Feature\Foliage;

use App\Jobs\GenerateFoliageAsset;
use App\Jobs\ImportFoliageAsset;
use App\Models\FoliageAsset;
use App\Models\FoliageType;
use App\Models\Map;
use App\Services\Terrain\TerrainStorage;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Storage;
use Tests\Concerns\FakesOpenRouter;
use Tests\TestCase;

class FoliagePlanTest extends TestCase
{
    use FakesOpenRouter;
    use RefreshDatabase;

    private Map $map;

    private FoliageType $spruce;

    private FoliageType $palm;

    private FoliageType $grass;

    private FoliageAsset $fern;

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('public');
        Storage::fake('local');
        Http::preventStrayRequests();

        $this->map = Map::factory()->realWorld(57.1, -4.7)->create(['name' => 'Glen Affric', 'min_height' => 200, 'max_height' => 1100, 'revision' => random_int(1000, 999_999)]);
        $base = ['color' => '#335522', 'color_secondary' => '#443322', 'min_scale' => 0.8, 'max_scale' => 1.2, 'density' => 1, 'max_slope' => 35, 'cull_distance' => 1500];
        $this->spruce = FoliageType::query()->create([...$base, 'name' => 'Spruce', 'kind' => 'conifer']);
        $this->palm = FoliageType::query()->create([...$base, 'name' => 'Palm', 'kind' => 'palm']);
        $this->grass = FoliageType::query()->create([...$base, 'name' => 'Meadow grass', 'kind' => 'grass', 'density' => 40, 'cull_distance' => 140]);
        $this->fern = FoliageAsset::query()->create(['name' => 'Bracken', 'kind' => 'bush', 'style' => 'realistic', 'source' => 'upload', 'status' => 'ready', 'model_path' => 'foliage/1/model.glb', 'meta' => ['height' => 0.8]]);

        // The palm is placed 3 times on the map.
        app(TerrainStorage::class)->write($this->map, 'foliage', json_encode(['version' => 1, 'instances' => [
            (string) $this->palm->id => array_fill(0, 21, 1.0),
        ]]));
    }

    private function fakeCatalogue(): void
    {
        Http::fake([
            'api.polyhaven.com/assets*' => Http::response([
                'fir_sapling' => ['name' => 'Fir Sapling', 'categories' => ['nature', 'trees'], 'tags' => ['fir', 'needles'], 'polycount' => 433021],
                'boulder_01' => ['name' => 'Boulder 01', 'categories' => ['rocks'], 'tags' => ['rock', 'lichen'], 'polycount' => 123976],
                'pine_tree_01' => ['name' => 'Pine Tree 01', 'categories' => ['trees'], 'tags' => ['pine'], 'polycount' => 17427094],
            ]),
        ]);
    }

    private function plan(array $overrides = []): array
    {
        return [
            'summary' => 'Caledonian pinewood: Scots pine, birch, heather and bracken over granite.',
            'notes' => ['Consider a stylized kit from Quaternius.', 42],
            'types' => [
                ['action' => 'change', 'type_id' => $this->spruce->id, 'name' => 'Scots pine', 'kind' => 'conifer', 'reason' => 'Native pine.',
                    'asset' => ['type' => 'import', 'source' => 'polyhaven', 'ref' => 'fir_sapling'],
                    'settings' => ['size_min_m' => 15, 'size_max_m' => 25, 'density' => 0.5, 'max_slope' => 38, 'max_height' => 650, 'cull_distance' => 99999, 'color' => '#2F4A2A', 'tint' => 'red']],
                ['action' => 'remove', 'type_id' => $this->palm->id, 'reason' => 'No palms in Scotland.'],
                ['action' => 'add', 'name' => 'Bracken', 'kind' => 'bush', 'reason' => 'Understorey.',
                    'asset' => ['type' => 'library', 'asset_id' => $this->fern->id],
                    'settings' => ['size_min_m' => 0.6, 'size_max_m' => 1.2, 'density' => 3, 'min_slope' => 30, 'max_slope' => 5]],
                ['action' => 'add', 'name' => 'Heather', 'kind' => 'flower', 'reason' => 'Moorland.',
                    'asset' => ['type' => 'generate', 'prompt' => 'Purple ling heather clump'],
                    'settings' => ['size_min_m' => 0.2, 'size_max_m' => 0.5, 'density' => 10]],
                ['action' => 'add', 'name' => 'Granite boulder', 'kind' => 'rock', 'reason' => 'Glacial erratics.',
                    'asset' => ['type' => 'generate', 'prompt' => 'granite'], 'settings' => ['size_min_m' => 0.5, 'size_max_m' => 3]],
                ['action' => 'add', 'name' => 'Giant pine', 'kind' => 'conifer', 'asset' => ['type' => 'import', 'ref' => 'pine_tree_01'], 'settings' => []],
                ['action' => 'change', 'type_id' => 9999, 'name' => 'Ghost'],
                ['action' => 'change', 'type_id' => $this->spruce->id, 'name' => 'Duplicate'],
                ...$overrides,
            ],
        ];
    }

    public function test_plan_is_validated_and_every_type_gets_a_row(): void
    {
        $this->configureAi();
        $this->fakeCatalogue();
        $this->fakeOpenRouter(chat: $this->plan());

        $response = $this->postJson('/api/foliage/ai/plan', ['map_id' => $this->map->id, 'style' => 15, 'region' => 'Scottish Highlands'])->assertOk();
        $rows = collect($response->json('types'));

        $spruce = $rows->firstWhere('type_id', $this->spruce->id);
        $this->assertSame('change', $spruce['action']);
        $this->assertSame('Scots pine', $spruce['name']);
        $this->assertSame('import', $spruce['asset']['type']);
        $this->assertSame('fir_sapling', $spruce['asset']['ref']);
        $this->assertEquals(5000, $spruce['settings']['cull_distance'], 'clamped');
        $this->assertSame('#2f4a2a', $spruce['settings']['color']);
        $this->assertSame('#ffffff', $spruce['settings']['tint'], 'invalid colours are ignored');
        $this->assertEquals(650, $spruce['settings']['max_height']);
        $this->assertSame('Spruce', $spruce['current']['name']);

        $palm = $rows->firstWhere('type_id', $this->palm->id);
        $this->assertSame('remove', $palm['action']);
        $this->assertSame(['maps' => 1, 'instances' => 3], $palm['usage']);

        $grass = $rows->firstWhere('type_id', $this->grass->id);
        $this->assertSame('keep', $grass['action'], 'Types the plan does not mention are kept');

        $adds = $rows->where('action', 'add')->keyBy('name');
        $this->assertSame(['library', $this->fern->id], [$adds['Bracken']['asset']['type'], $adds['Bracken']['asset']['asset_id']]);
        $this->assertEquals([5, 30], [$adds['Bracken']['settings']['min_slope'], $adds['Bracken']['settings']['max_slope']], 'ordered');
        $this->assertSame('generate', $adds['Heather']['asset']['type']);
        $this->assertSame('procedural', $adds['Granite boulder']['asset']['type'], 'Rocks cannot be generated');
        $this->assertSame('procedural', $adds['Giant pine']['asset']['type'], 'Too heavy imports are dropped');
        $this->assertFalse($rows->contains('name', 'Ghost'));
        $this->assertFalse($rows->contains('name', 'Duplicate'));

        $this->assertSame(1, $response->json('estimate.imports'));
        $this->assertSame(1, $response->json('estimate.generations'));
        $this->assertSame(['Consider a stylized kit from Quaternius.'], $response->json('notes'));
        $this->assertSame('Glen Affric', $response->json('brief.map_name'));

        $prompt = Http::recorded(fn (Request $r) => str_ends_with($r->url(), '/chat/completions'))->first()[0]->data()['messages'];
        $user = is_string($prompt[1]['content']) ? $prompt[1]['content'] : $prompt[1]['content'][0]['text'];
        $this->assertStringContainsString('Scottish Highlands', $user);
        $this->assertStringContainsString('"lat": 57.1', $user);
        $this->assertStringContainsString('fir_sapling | Fir Sapling | conifer', $user);
        $this->assertStringNotContainsString('pine_tree_01 |', $user, 'Too heavy models are not offered');
        $this->assertStringContainsString('placed=3 instances on 1 map(s)', $user);
    }

    public function test_generation_can_be_disallowed(): void
    {
        $this->configureAi();
        $this->fakeCatalogue();
        $this->fakeOpenRouter(chat: $this->plan());

        $rows = collect($this->postJson('/api/foliage/ai/plan', ['region' => 'Scotland', 'style' => 80, 'allow_generation' => false])->assertOk()->json('types'));

        $this->assertSame('procedural', $rows->firstWhere('name', 'Heather')['asset']['type']);
    }

    public function test_plan_needs_a_map_or_region_and_a_key(): void
    {
        $this->postJson('/api/foliage/ai/plan', ['style' => 10])->assertStatus(422);
        $this->postJson('/api/foliage/ai/plan', ['style' => 10, 'region' => 'Alps'])->assertStatus(422)->assertJsonPath('configured', false);
    }

    public function test_apply_creates_changes_and_removes_with_real_world_sizes(): void
    {
        Queue::fake();
        $this->configureAi();
        $this->fakeCatalogue();

        $this->post('/foliage/ai/apply', ['style' => 15, 'types' => [
            ['action' => 'change', 'type_id' => $this->spruce->id, 'name' => 'Scots pine', 'kind' => 'conifer',
                'asset' => ['type' => 'import', 'ref' => 'fir_sapling'],
                'settings' => ['size_min_m' => 15, 'size_max_m' => 25, 'density' => 0.5, 'max_slope' => 38, 'cull_distance' => 1800, 'tint' => '#f0f4ea']],
            ['action' => 'remove', 'type_id' => $this->palm->id],
            ['action' => 'add', 'name' => 'Bracken', 'kind' => 'bush', 'asset' => ['type' => 'library', 'asset_id' => $this->fern->id],
                'settings' => ['size_min_m' => 0.6, 'size_max_m' => 1.2, 'density' => 3]],
            ['action' => 'add', 'name' => 'Heather', 'kind' => 'flower', 'asset' => ['type' => 'generate', 'prompt' => 'Purple heather'],
                'settings' => ['size_min_m' => 0.2, 'size_max_m' => 0.6, 'density' => 10]],
            ['action' => 'add', 'name' => 'Granite', 'kind' => 'rock', 'asset' => ['type' => 'procedural'],
                'settings' => ['size_min_m' => 0.45, 'size_max_m' => 2.7, 'align_to_normal' => true]],
            ['action' => 'change', 'type_id' => 424242, 'name' => 'Ghost'],
        ]])->assertRedirect()->assertSessionHasNoErrors();

        $this->assertModelMissing($this->palm);

        // Import: the asset is baked to the mean planned height, so the scales straddle 1.
        $pine = $this->spruce->refresh();
        $import = FoliageAsset::query()->where('source_ref', 'fir_sapling')->sole();
        $this->assertSame('Scots pine', $pine->name);
        $this->assertSame($import->id, $pine->foliage_asset_id);
        $this->assertSame(20.0, $import->target_height);
        $this->assertEqualsWithDelta(0.75, $pine->min_scale, 0.001);
        $this->assertEqualsWithDelta(1.25, $pine->max_scale, 0.001);
        $this->assertSame('#f0f4ea', $pine->tint);
        $this->assertSame(1800.0, $pine->cull_distance);
        Queue::assertPushed(ImportFoliageAsset::class, 1);

        // Library asset of known height (0.8 m).
        $bracken = FoliageType::query()->where('name', 'Bracken')->sole();
        $this->assertSame($this->fern->id, $bracken->foliage_asset_id);
        $this->assertEqualsWithDelta(0.75, $bracken->min_scale, 0.001);
        $this->assertEqualsWithDelta(1.5, $bracken->max_scale, 0.001);

        // Generated card: queued, linked, sized.
        $heather = FoliageType::query()->where('name', 'Heather')->sole();
        $card = FoliageAsset::query()->where('source', 'ai')->sole();
        $this->assertSame($card->id, $heather->foliage_asset_id);
        $this->assertSame(0.4, $card->target_height);
        $this->assertSame('realistic', $card->style);
        Queue::assertPushed(GenerateFoliageAsset::class, 1);

        // Procedural rock: scale relative to the built-in mesh (0.9 m).
        $granite = FoliageType::query()->where('name', 'Granite')->sole();
        $this->assertNull($granite->foliage_asset_id);
        $this->assertEqualsWithDelta(0.5, $granite->min_scale, 0.001);
        $this->assertEqualsWithDelta(3.0, $granite->max_scale, 0.001);
        $this->assertTrue($granite->align_to_normal);
        $this->assertTrue($granite->allow_underwater, 'kind defaults fill what the plan leaves out');

        $this->assertSame(5, FoliageType::query()->count());
    }

    public function test_apply_without_ai_falls_back_to_procedural(): void
    {
        Queue::fake();

        $this->post('/foliage/ai/apply', ['style' => 90, 'types' => [
            ['action' => 'add', 'name' => 'Heather', 'kind' => 'flower', 'asset' => ['type' => 'generate', 'prompt' => 'heather'],
                'settings' => ['size_min_m' => 0.2, 'size_max_m' => 0.6]],
        ]])->assertRedirect();

        $heather = FoliageType::query()->where('name', 'Heather')->sole();
        $this->assertNull($heather->foliage_asset_id);
        Queue::assertNothingPushed();
        $this->assertStringContainsString('not configured', session('inertia.flash_data.toast.message') ?? json_encode(session()->all()));
    }
}
